import { describe, expect, it } from 'vitest';
import type { RouteTurn } from '../../src/core/types';
import { overlayVerdictCopy } from '../../src/ui/shared/overlay';

function turn(overrides: Partial<RouteTurn>): RouteTurn {
  return {
    verdict: 'unknown',
    phase: 'responding',
    routeModel: null,
    modelLabel: null,
    modelLabelConflict: false,
    ...overrides
  } as RouteTurn;
}

describe('overlay verdict copy', () => {
  it('distinguishes empty live and reload states', () => {
    expect(overlayVerdictCopy(null, 'live', 'zh')).toEqual({ label: '等待下一次回答', tone: 'idle' });
    expect(overlayVerdictCopy(null, 'reload', 'en')).toEqual({ label: 'Awaiting reload', tone: 'idle' });
  });

  it('maps definitive route verdicts before evidence fallbacks', () => {
    expect(overlayVerdictCopy(turn({ verdict: 'auto_reasoning' }), 'live', 'zh')).toEqual({ label: '自动推理', tone: 'auto' });
    expect(overlayVerdictCopy(turn({ verdict: 'auto_reasoning' }), 'reload', 'en')).toEqual({ label: 'Auto reasoning', tone: 'auto' });
    expect(overlayVerdictCopy(turn({ verdict: 'normal' }), 'live', 'zh')).toEqual({ label: '路由正常', tone: 'normal' });
    expect(overlayVerdictCopy(turn({ verdict: 'mismatch' }), 'live', 'en')).toEqual({ label: 'Route mismatch', tone: 'danger' });
    expect(overlayVerdictCopy(turn({ verdict: 'conflict' }), 'live', 'zh')).toEqual({ label: '路由字段冲突', tone: 'danger' });
  });

  it('reports partial evidence without claiming a verdict', () => {
    expect(overlayVerdictCopy(turn({ routeModel: 'gpt-5-5-mini' }), 'reload', 'en')).toEqual({ label: 'Route captured', tone: 'warn' });
    expect(overlayVerdictCopy(turn({ routeModel: 'gpt-5-6-pro', modelLabel: 'gpt-5-6-pro' }), 'reload', 'zh')).toEqual({ label: '已读取响应路由', tone: 'warn' });
    expect(overlayVerdictCopy(turn({ modelLabelConflict: true }), 'reload', 'en')).toEqual({ label: 'Label only', tone: 'warn' });
  });

  it('treats completed and failed captures as unavailable instead of still capturing', () => {
    expect(overlayVerdictCopy(turn({ phase: 'completed' }), 'live', 'zh')).toEqual({ label: '未取得实际路由', tone: 'warn' });
    expect(overlayVerdictCopy(turn({ phase: 'failed' }), 'live', 'en')).toEqual({ label: 'Route missing', tone: 'warn' });
    expect(overlayVerdictCopy(turn({ phase: 'requested' }), 'live', 'zh')).toEqual({ label: '正在捕获', tone: 'warn' });
  });
});
