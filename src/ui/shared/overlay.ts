import type { CaptureMode, RouteTurn, UiLanguage } from '../../core/types';
import { t } from './i18n';
import { assessRoute } from '../../core/assessment';

export function overlayPrimaryRouteText(turn: RouteTurn, language: UiLanguage): string | null {
  const conflict = turn.verdict === 'conflict' || (turn.taskKind && assessRoute({ ...turn, taskKind: null }).verdict === 'conflict');
  return conflict ? t(language, 'result.routeConflict') : turn.routeModel;
}

/** Research stages stay in order, including a placeholder for an uncaptured stage. */
export function overlayRouteText(turn: RouteTurn | null, language: UiLanguage): string | null {
  if (!turn) return null;
  const route = overlayPrimaryRouteText(turn, language);
  if (turn.taskKind === 'deep_research') return `${route ?? '—'} / ${turn.researchReportModel ?? '—'}`;
  return route ?? t(language, 'value.unavailable');
}

export interface OverlayVerdictCopy {
  label: string;
  tone: 'idle' | 'normal' | 'danger' | 'warn' | 'auto' | 'suspect' | 'neutral' | 'task';
}

export function overlayVerdictCopy(
  turn: RouteTurn | null,
  mode: CaptureMode,
  language: UiLanguage
): OverlayVerdictCopy {
  if (!turn) return { label: t(language, mode === 'live' ? 'result.waitingNext' : 'result.waitingReload'), tone: 'idle' };
  if (turn.verdict === 'image_generation') return { label: t(language, 'result.imageGeneration'), tone: 'task' };
  if (turn.verdict === 'deep_research') return { label: t(language, 'result.deepResearch'), tone: 'task' };
  if (turn.verdict === 'auto_reasoning') return { label: t(language, 'result.autoReasoning'), tone: 'auto' };
  if (turn.verdict === 'suspected_downgrade') return { label: t(language, 'result.suspectedDowngrade'), tone: 'suspect' };
  if (turn.verdict === 'work_unverifiable') return { label: t(language, 'result.workUnverifiable'), tone: 'neutral' };
  if (turn.verdict === 'normal') return { label: t(language, 'result.normal'), tone: 'normal' };
  if (turn.verdict === 'mismatch') return { label: t(language, 'result.mismatchDetected'), tone: 'danger' };
  if (turn.verdict === 'conflict') return { label: t(language, 'result.actualRouteConflict'), tone: 'danger' };
  if (turn.routeModel) return { label: t(language, 'result.routeRead'), tone: 'warn' };
  if (turn.modelLabel || turn.modelLabelConflict) return { label: t(language, 'result.labelOnly'), tone: 'warn' };
  return {
    label: t(language, turn.phase === 'completed' || turn.phase === 'failed' ? 'result.routeMissing' : 'result.capturing'),
    tone: 'warn'
  };
}
