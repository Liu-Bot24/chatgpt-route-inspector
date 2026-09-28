import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RouteTurn } from '../../src/core/types';
import { overlayRouteText, overlayVerdictCopy } from '../../src/ui/shared/overlay';
import { createTurn } from '../../src/core/turns';

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
  it('limits smaller task model text and wrapping to the response side', () => {
    const source = readFileSync(new URL('../../src/content/bridge.ts', import.meta.url), 'utf8');
    expect(source).toContain('--type-value:14px');
    expect(source).toContain('.model b,.compact .model b{font-size:var(--type-value)}');
    expect(source).toContain('.task .response-model b,.compact.task .response-model b{');
    expect(source).not.toMatch(/\.task \.model b|\.task \.mini-value\{/);
    expect(source.match(/class="model response-model"/g)).toHaveLength(2);
    expect(source.match(/class="model"><small>\$\{escapeHtml\(t\(language, 'field.requested'\)\)\}/g)).toHaveLength(2);
  });
  it('shows conflicting task route evidence without replacing the task category', () => {
    const image = createTurn({ captureId: 'image', captureMode: 'live', source: 'page_fetch', phase: 'completed',
      observedAt: '2026-09-28T06:00:00Z', taskKind: 'image_generation',
      resolvedModelSlug: 'model-a', responseModelSlug: 'model-b' });
    expect(overlayRouteText(image, 'zh')).toBe('路由字段冲突');
    expect(overlayVerdictCopy(image, 'live', 'zh')).toEqual({ label: '图片生成', tone: 'task' });
  });
  it('shows both research stages in the response-route cell without substituting one for the other', () => {
    expect(overlayRouteText(turn({ taskKind: 'deep_research', routeModel: 'gpt-5-6-instant', researchReportModel: 'gpt-6-pro' }), 'zh')).toBe('gpt-5-6-instant / gpt-6-pro');
    expect(overlayRouteText(turn({ taskKind: 'deep_research', routeModel: 'gpt-5-6-instant' }), 'en')).toBe('gpt-5-6-instant / —');
    expect(overlayRouteText(turn({ taskKind: 'deep_research', researchReportModel: 'gpt-6-pro' }), 'zh')).toBe('— / gpt-6-pro');
    expect(overlayRouteText(turn({ taskKind: 'image_generation', routeModel: 'gpt-5-4-auto-thinking' }), 'zh')).toBe('gpt-5-4-auto-thinking');
    expect(overlayRouteText(turn({ verdict: 'normal', routeModel: 'gpt-5-6-thinking' }), 'zh')).toBe('gpt-5-6-thinking');
  });
  it('distinguishes empty live and reload states', () => {
    expect(overlayVerdictCopy(null, 'live', 'zh')).toEqual({ label: '等待下一次回答', tone: 'idle' });
    expect(overlayVerdictCopy(null, 'reload', 'en')).toEqual({ label: 'Awaiting reload', tone: 'idle' });
  });

  it('maps definitive route verdicts before evidence fallbacks', () => {
    expect(overlayVerdictCopy(turn({ verdict: 'auto_reasoning' }), 'live', 'zh')).toEqual({ label: '自动推理', tone: 'auto' });
    expect(overlayVerdictCopy(turn({ verdict: 'auto_reasoning' }), 'reload', 'en')).toEqual({ label: 'Auto reasoning', tone: 'auto' });
    expect(overlayVerdictCopy(turn({ verdict: 'suspected_downgrade' }), 'live', 'zh')).toEqual({ label: '疑似降级', tone: 'suspect' });
    expect(overlayVerdictCopy(turn({ verdict: 'suspected_downgrade' }), 'reload', 'zh')).toEqual({ label: '疑似降级', tone: 'suspect' });
    expect(overlayVerdictCopy(turn({ verdict: 'work_unverifiable' }), 'reload', 'zh')).toEqual({ label: '无法判断', tone: 'neutral' });
    expect(overlayVerdictCopy(turn({ verdict: 'work_unverifiable' }), 'live', 'en')).toEqual({ label: 'Cannot determine', tone: 'neutral' });
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
