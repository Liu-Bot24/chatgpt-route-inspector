import type { CaptureMode, RouteTurn, UiLanguage } from '../../core/types';
import { t } from './i18n';

export interface OverlayVerdictCopy {
  label: string;
  tone: 'idle' | 'normal' | 'danger' | 'warn' | 'auto';
}

export function overlayVerdictCopy(
  turn: RouteTurn | null,
  mode: CaptureMode,
  language: UiLanguage
): OverlayVerdictCopy {
  if (!turn) return { label: t(language, mode === 'live' ? 'result.waitingNext' : 'result.waitingReload'), tone: 'idle' };
  if (turn.verdict === 'auto_reasoning') return { label: t(language, 'result.autoReasoning'), tone: 'auto' };
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
