import type { CaptureMode, InspectorState, PowReading, RouteTurn, RouteVerdict, UiLanguage } from '../../core/types';
import type { RuntimeRequest, RuntimeResponse } from '../../shared/messages';
import { t } from './i18n';

export async function send(request: RuntimeRequest): Promise<RuntimeResponse> {
  try {
    const response = await chrome.runtime.sendMessage<RuntimeRequest, RuntimeResponse>(request);
    if (!response.ok) throw new Error(response.error ?? 'The extension could not complete this action.');
    document.getElementById('route-operation-error')?.remove();
    return response;
  } catch (error) {
    showOperationError(error);
    return { ok: false, error: error instanceof Error ? error.message : 'The extension could not complete this action.' };
  }
}

export function showOperationError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'The extension could not complete this action.';
  let element = document.getElementById('route-operation-error');
  if (!element) {
    element = document.createElement('div');
    element.id = 'route-operation-error';
    element.setAttribute('role', 'alert');
    element.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;z-index:2147483647;padding:12px;background:#471f1a;color:#fff;white-space:pre-wrap';
    document.body.append(element);
  }
  element.textContent = message;
}

export async function getState(): Promise<InspectorState> {
  const response = await send({ type: 'route:get-state' });
  if (!response.ok || !response.state) throw new Error(response.error ?? 'Unable to read extension state.');
  return response.state;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '—').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char] ?? char);
}

export function modelLabel(model: string | null, language: UiLanguage): string {
  if (!model) return t(language, 'value.unresolved');
  return model
    .replace(/^gpt-/, 'GPT ')
    .replace(/-(\d)/g, '.$1')
    .replace(/-pro$/i, ' Pro')
    .replace(/-mini$/i, ' mini')
    .replace(/-sol$/i, ' Sol');
}

export function verdictLabel(verdict: RouteVerdict, language: UiLanguage): string {
  return {
    normal: t(language, 'result.normal'),
    mismatch: t(language, 'result.mismatch'),
    conflict: t(language, 'result.routeConflict'),
    auto_reasoning: t(language, 'result.autoReasoning'),
    unknown: t(language, 'result.unknown')
  }[verdict];
}

export function verdictTone(verdict: RouteVerdict): string {
  if (verdict === 'auto_reasoning') return 'auto';
  if (verdict === 'normal') return 'signal';
  if (verdict === 'mismatch' || verdict === 'conflict') return 'danger';
  return 'amber';
}

export function turnResultLabel(turn: RouteTurn | null, language: UiLanguage): string {
  if (!turn) return t(language, 'result.waiting');
  if (turn.verdict === 'unknown') {
    if (turn.routeModel) return t(language, 'result.routeRead');
    if (turn.modelLabel || turn.modelLabelConflict) return t(language, 'result.labelOnly');
    return turn.phase === 'completed' || turn.phase === 'failed'
      ? t(language, 'result.routeMissing')
      : t(language, 'result.capturing');
  }
  return verdictLabel(turn.verdict, language);
}

export function requestedModelLabel(turn: RouteTurn | null, language: UiLanguage): string {
  if (turn?.requestedModel) return modelLabel(turn.requestedModel, language);
  return turn?.captureMode === 'reload' ? t(language, 'value.reloadNoRequest') : t(language, 'value.unresolved');
}

export function captureModeLabel(mode: CaptureMode, language: UiLanguage): string {
  return mode === 'live' ? t(language, 'mode.live') : t(language, 'mode.reload');
}

export function routeSourcesLabel(turn: RouteTurn | null, language: UiLanguage): string {
  return turn?.routeModelSources.join(' + ') || t(language, 'value.noRouteField');
}

export function recordedModelLabel(turn: RouteTurn | null, language: UiLanguage): string {
  if (turn?.modelLabelConflict) return t(language, 'value.labelConflict');
  return modelLabel(turn?.modelLabel ?? null, language);
}

export function modelLabelSourcesLabel(turn: RouteTurn | null, language: UiLanguage): string {
  return turn?.modelLabelSources.join(' + ') || t(language, 'value.noLabelField');
}

export function assessmentReasons(turn: RouteTurn, language: UiLanguage): string[] {
  const reasons: string[] = [];
  if (turn.requestedModel) reasons.push(t(language, 'reason.requested', { model: turn.requestedModel }));
  const routeValues = {
    resolved_model_slug: turn.resolvedModelSlug,
    'server_ste_metadata.model_slug': turn.serverModelSlug,
    'assistant.metadata.model_slug': turn.responseModelSlug,
    'assistant[data-message-model-slug]': turn.domModelSlug
  } as const;
  for (const source of turn.routeModelSources) {
    const model = routeValues[source];
    if (model) reasons.push(t(language, 'reason.routeField', { source, model }));
  }

  const labelValues = {
    'assistant.metadata.model_slug': turn.responseModelSlug,
    'assistant[data-message-model-slug]': turn.domModelSlug
  } as const;
  for (const source of turn.modelLabelSources) {
    const model = labelValues[source];
    if (model) reasons.push(t(language, 'reason.labelField', { source, model }));
  }

  if (turn.modelLabelConflict) reasons.push(t(language, 'reason.labelConflict'));
  if (turn.verdict === 'auto_reasoning') {
    reasons.push(t(language, 'reason.autoReasoning', { model: turn.routeModel ?? '' }));
    return reasons;
  }
  if (turn.routeModel && turn.modelLabel && turn.routeModel !== turn.modelLabel) {
    reasons.push(t(language, 'reason.labelRouteMismatch', { label: turn.modelLabel, route: turn.routeModel }));
  }
  if (turn.verdict === 'conflict') {
    reasons.push(t(language, 'reason.routeConflict'));
    return reasons;
  }
  if (!turn.routeModel) {
    reasons.push(t(language, turn.modelLabel ? 'reason.labelOnly' : 'reason.noRoute'));
    return reasons;
  }
  reasons.push(t(language, turn.verdict === 'normal' ? 'reason.match' : turn.verdict === 'mismatch' ? 'reason.mismatch' : 'reason.noRequest'));
  return reasons;
}

export function latestForTab(state: InspectorState, tabId?: number, mode = state.settings.captureMode): RouteTurn | null {
  if (tabId === undefined) return null;
  return state.turns.find((turn) => turn.captureMode === mode && turn.tabId === tabId) ?? null;
}

export function latestPowForTab(state: InspectorState, tabId?: number): PowReading | null {
  if (tabId === undefined) return null;
  return state.powReadings.find((reading) => reading.tabId === tabId) ?? null;
}

export function formatTime(value: string | null, language: UiLanguage): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(value));
}

export function formatDuration(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

export function subscribe(handler: (state: InspectorState) => void): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    if (record.type === 'route:state-changed' && record.state) handler(record.state as InspectorState);
  });
}
