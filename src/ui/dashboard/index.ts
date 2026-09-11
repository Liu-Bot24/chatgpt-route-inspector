import { buildMarkdownReport, sanitizedExport } from '../../core/privacy';
import { isStaleState } from '../../core/state';
import type { CaptureMode, InspectorState, RouteTurn, RouteVerdict, UiLanguage } from '../../core/types';
import {
  captureModeLabel,
  escapeHtml,
  formatDuration,
  formatTime,
  getState,
  modelLabel,
  recordedModelLabel,
  requestedModelLabel,
  routeSourcesLabel,
  send,
  subscribe,
  turnResultLabel,
  verdictTone
} from '../shared/client';
import { applyStaticTranslations, bindLanguageSwitch, t, type TranslationKey } from '../shared/i18n';

let state: InspectorState;
let filter: RouteVerdict | 'all' = 'all';
let modeFilter: CaptureMode | 'all' = 'all';
let selectedId: string | null = null;

const evidenceFieldHints: Partial<Record<TranslationKey, string>> = {
  'detail.assistantMetadataLabel': 'assistant.metadata.model_slug',
  'detail.renderedAssistantLabel': 'assistant[data-message-model-slug]',
  'detail.resolvedModel': 'resolved_model_slug',
  'detail.serverModel': 'server_ste_metadata.model_slug',
  'detail.deepResearchRemaining': 'limits_progress[feature_name=deep_research].remaining',
  'detail.deepResearchResetAt': 'limits_progress[feature_name=deep_research].reset_after',
  'detail.imageGenRemaining': 'limits_progress[feature_name=image_gen].remaining',
  'detail.imageGenResetAt': 'limits_progress[feature_name=image_gen].reset_after'
};

function quotaTime(value: string | null | undefined, language: UiLanguage): string {
  if (!value || !Number.isFinite(Date.parse(value))) return t(language, 'quota.notCaptured');
  const formatted = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(value));
  return `${formatted} ${language === 'zh' ? '（北京时间）' : '(UTC+08:00)'}`;
}

function toast(message: string): void {
  const element = document.querySelector<HTMLElement>('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  window.setTimeout(() => element.classList.remove('show'), 1800);
}

function download(name: string, content: string, type: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function selectedTurn(turns: RouteTurn[]): RouteTurn | null {
  return turns.find((turn) => turn.captureId === selectedId) ?? turns[0] ?? null;
}

function renderDetail(turn: RouteTurn | null, language: UiLanguage): void {
  const detail = document.querySelector<HTMLElement>('#detail');
  const tag = document.querySelector<HTMLElement>('#detail-tag');
  if (!detail || !tag) return;
  if (!turn) {
    detail.innerHTML = `<div class="panel-empty">${escapeHtml(t(language, 'dashboard.selectRecord'))}</div>`;
    tag.textContent = t(language, 'result.unknown');
    return;
  }
  const tone = verdictTone(turn.verdict);
  tag.className = `tag ${tone}`;
  tag.textContent = turnResultLabel(turn, language);
  const items: Array<[TranslationKey, string | number | boolean | null]> = [
    ['detail.captureMode', captureModeLabel(turn.captureMode, language)],
    ['detail.captureStatus', t(language, ({
      requested: 'phase.requested', responding: 'phase.responding', completed: 'phase.completed', failed: 'phase.failed'
    } as const)[turn.phase])],
    ['detail.errorCode', turn.errorCode],
    ['detail.requestedModel', turn.requestedModel ?? requestedModelLabel(turn, language)],
    ['detail.responseRoute', turn.verdict === 'conflict' ? t(language, 'result.routeConflict') : turn.routeModel],
    ['detail.routeFieldSource', routeSourcesLabel(turn, language)],
    ['detail.resolvedModel', turn.resolvedModelSlug],
    ['detail.serverModel', turn.serverModelSlug],
    ['detail.assistantMetadataLabel', turn.responseModelSlug],
    ['detail.modelLabelSource', turn.responseModelSlug ? 'assistant.metadata.model_slug' : null],
    ['detail.renderedAssistantLabel', turn.domModelSlug],
    ['detail.thinkingEffort', turn.thinkingEffort],
    ['detail.fastConvo', turn.fastConvo],
    ['detail.planType', turn.planType],
    ['detail.deepResearchRemaining', turn.deepResearchRemaining ?? t(language, 'quota.notCaptured')],
    ['detail.deepResearchResetAt', quotaTime(turn.deepResearchResetAt, language)],
    ['detail.imageGenRemaining', turn.imageGenRemaining ?? t(language, 'quota.notCaptured')],
    ['detail.imageGenResetAt', quotaTime(turn.imageGenResetAt, language)],
    ['detail.requestId', turn.requestId],
    ['detail.networkId', turn.networkRequestId],
    ['detail.duration', formatDuration(turn.durationMs)],
    ['detail.adapters', turn.sources.join(' + ')]
  ];
  const availableItems = items.filter(([, value]) => value !== null && value !== '');
  detail.innerHTML = `<div class="evidence-list">${availableItems.map(([label, value]) => {
    const isAssistantLabel = label === 'detail.assistantMetadataLabel';
    const quotaHint = evidenceFieldHints[label]?.startsWith('limits_progress')
      ? `${evidenceFieldHints[label]}\n${t(language, 'quota.snapshotHint', { time: quotaTime(turn.quotaObservedAt, language) })}` : null;
    const hint = isAssistantLabel ? t(language, 'detail.assistantReferenceHint') : quotaHint ?? evidenceFieldHints[label];
    const name = `<small${hint ? ` title="${escapeHtml(hint)}"` : ''}>${escapeHtml(t(language, label))}</small>`;
    const labelHtml = isAssistantLabel
      ? `<div class="evidence-label">${name}<sup class="evidence-note" tabindex="0" title="${escapeHtml(hint)}" aria-label="${escapeHtml(hint)}">*</sup></div>`
      : name;
    return `<div class="evidence">${labelHtml}<code>${escapeHtml(value)}</code></div>`;
  }).join('')}</div>`;
}

function render(next: InspectorState): void {
  if (isStaleState(state, next)) return;
  state = next;
  const language = state.settings.uiLanguage;
  applyStaticTranslations(language);
  const total = state.turns.length;
  const live = state.turns.filter((turn) => turn.captureMode === 'live').length;
  const reload = state.turns.filter((turn) => turn.captureMode === 'reload').length;
  const anomaly = state.turns.filter((turn) => turn.verdict === 'mismatch' || turn.verdict === 'conflict').length;
  document.querySelector<HTMLElement>('#summary')!.innerHTML = `<div class="readout"><small>${escapeHtml(t(language, 'summary.total'))}</small><b>${total}</b></div><div class="readout"><small>${escapeHtml(t(language, 'summary.live'))}</small><b class="signal-text">${live}</b></div><div class="readout"><small>${escapeHtml(t(language, 'summary.reload'))}</small><b class="amber-text">${reload}</b></div><div class="readout"><small>${escapeHtml(t(language, 'summary.anomalies'))}</small><b class="danger-text">${anomaly}</b></div>`;

  const verdictFilters: Array<[RouteVerdict | 'all', TranslationKey]> = [['all', 'filter.allVerdicts'], ['normal', 'filter.normal'], ['auto_reasoning', 'filter.autoReasoning'], ['mismatch', 'filter.mismatch'], ['conflict', 'filter.conflict'], ['unknown', 'filter.unknown']];
  const modeFilters: Array<[CaptureMode | 'all', TranslationKey]> = [['all', 'filter.allModes'], ['live', 'mode.live'], ['reload', 'mode.reload']];
  document.querySelector<HTMLElement>('#filters')!.innerHTML = verdictFilters.map(([value, label]) => `<button class="filter-button ${filter === value ? 'active' : ''}" data-filter="${value}">${escapeHtml(t(language, label))}</button>`).join('');
  document.querySelector<HTMLElement>('#mode-filters')!.innerHTML = modeFilters.map(([value, label]) => `<button class="filter-button ${modeFilter === value ? 'active' : ''}" data-mode-filter="${value}">${escapeHtml(t(language, label))}</button>`).join('');

  const visible = state.turns.filter((turn) =>
    (filter === 'all' || turn.verdict === filter) &&
    (modeFilter === 'all' || turn.captureMode === modeFilter)
  );
  if (!visible.some((turn) => turn.captureId === selectedId)) selectedId = visible[0]?.captureId ?? null;
  const rows = document.querySelector<HTMLElement>('#rows');
  const empty = document.querySelector<HTMLElement>('#empty');
  if (rows) rows.innerHTML = visible.map((turn) => `<tr data-id="${escapeHtml(turn.captureId)}" class="${selectedId === turn.captureId ? 'selected' : ''}"><td class="mono">${escapeHtml(formatTime(turn.observedAt, language))}</td><td><span class="tag ${turn.captureMode === 'live' ? 'signal' : 'amber'}">${escapeHtml(captureModeLabel(turn.captureMode, language))}</span></td><td>${escapeHtml(requestedModelLabel(turn, language))}</td><td>${escapeHtml(recordedModelLabel(turn, language))}</td><td>${escapeHtml(turn.verdict === 'conflict' ? t(language, 'result.routeConflict') : turn.routeModel ? modelLabel(turn.routeModel, language) : t(language, 'value.unavailable'))}</td><td><span class="tag ${verdictTone(turn.verdict)}">${escapeHtml(turnResultLabel(turn, language))}</span></td><td class="mono muted">${escapeHtml(routeSourcesLabel(turn, language))}</td></tr>`).join('');
  if (empty) empty.style.display = visible.length ? 'none' : 'block';
  renderDetail(selectedTurn(visible), language);
  document.querySelector<HTMLElement>('#health')!.innerHTML = `<div class="timeline"><div class="timeline-item signal"><strong>${escapeHtml(t(language, 'health.lastSuccess'))}</strong><p>${escapeHtml(formatTime(state.parserHealth.lastSuccessAt, language))}</p></div><div class="timeline-item ${state.parserHealth.consecutiveFailures ? 'danger' : ''}"><strong>${escapeHtml(t(language, 'health.lastFailure'))}</strong><p>${escapeHtml(formatTime(state.parserHealth.lastFailureAt, language))} · ${escapeHtml(t(language, 'health.failures', { count: state.parserHealth.consecutiveFailures }))}</p></div><div class="timeline-item"><strong>${escapeHtml(t(language, 'health.activeMode'))}</strong><p>${escapeHtml(captureModeLabel(state.settings.captureMode, language))}</p></div></div>`;
  document.querySelectorAll<HTMLElement>('[data-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter as RouteVerdict | 'all'; render(state); }));
  document.querySelectorAll<HTMLElement>('[data-mode-filter]').forEach((button) => button.addEventListener('click', () => { modeFilter = button.dataset.modeFilter as CaptureMode | 'all'; render(state); }));
  document.querySelectorAll<HTMLElement>('[data-id]').forEach((row) => row.addEventListener('click', () => { selectedId = row.dataset.id ?? null; render(state); }));
}

bindLanguageSwitch(async (uiLanguage) => {
  if (state?.settings.uiLanguage === uiLanguage) return;
  const response = await send({ type: 'route:update-settings', settings: { uiLanguage } });
  if (!response.ok) return;
  if (response.state) render(response.state);
});
document.querySelector('#export-json')?.addEventListener('click', () => download(`route-inspector-${Date.now()}.json`, JSON.stringify(sanitizedExport(state), null, 2), 'application/json'));
document.querySelector('#export-md')?.addEventListener('click', () => download(`route-inspector-${Date.now()}.md`, buildMarkdownReport(state, state.settings.uiLanguage), 'text/markdown'));
document.querySelector('#clear')?.addEventListener('click', async () => {
  if (!confirm(t(state.settings.uiLanguage, 'confirm.clearAll'))) return;
  const response = await send({ type: 'route:clear' });
  if (!response.ok) return;
  if (response.state) render(response.state);
  toast(t(state.settings.uiLanguage, 'toast.cleared'));
});

subscribe(render);
void getState().then(render);
