import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTurn } from '../../src/core/turns';
import { assessmentReasons, captureModeLabel, turnResultLabel } from '../../src/ui/shared/client';
import { t, TRANSLATION_KEYS } from '../../src/ui/shared/i18n';

const mismatch = createTurn({
  captureId: 'language-mismatch',
  source: 'page_fetch',
  captureMode: 'live',
  phase: 'completed',
  observedAt: '2026-08-11T01:00:00.000Z',
  requestedModel: 'gpt-5-6-pro',
  resolvedModelSlug: 'gpt-5-5-mini'
});

describe('UI translations', () => {
  it('renders auto reasoning as its own bilingual status and reason', () => {
    for (const model of ['gpt-5-6-auto-thinking', 'gpt-5-5-auto-thinking']) {
      const automatic = createTurn({
        captureId: model, source: 'page_fetch', captureMode: 'live', phase: 'completed',
        observedAt: '2026-09-12T00:00:00Z', requestedModel: 'gpt-5-6', resolvedModelSlug: model,
        responseModelSlug: 'gpt-5-6-thinking'
      });
      expect(turnResultLabel(automatic, 'zh')).toBe('自动推理');
      expect(turnResultLabel(automatic, 'en')).toBe('Auto reasoning');
      expect(assessmentReasons(automatic, 'zh').join('\n')).toContain(`响应路由为 ${model}，标记为自动推理`);
      const english = assessmentReasons(automatic, 'en').join('\n');
      expect(english).toContain('labeled as auto reasoning');
      expect(english).not.toContain('no matching requested model');
      expect(english).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
  it('renders the same route result in Chinese and English without changing the underlying verdict', () => {
    expect(mismatch.verdict).toBe('mismatch');
    expect(turnResultLabel(mismatch, 'zh')).toBe('路由错配');
    expect(turnResultLabel(mismatch, 'en')).toBe('Route mismatch');
    expect(captureModeLabel('reload', 'zh')).toBe('会话重载');
    expect(captureModeLabel('reload', 'en')).toBe('Reload session');
  });

  it('localizes reconstructed evidence reasons while preserving exact model fields', () => {
    const chinese = assessmentReasons(mismatch, 'zh').join('\n');
    const english = assessmentReasons(mismatch, 'en').join('\n');
    expect(chinese).toContain('请求模型：gpt-5-6-pro');
    expect(chinese).toContain('请求模型与响应路由模型不一致');
    expect(english).toContain('Requested model: gpt-5-6-pro');
    expect(english).toContain('Requested model and response route do not match');
    expect(english).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('substitutes values and keeps attribution identical in both languages', () => {
    expect(t('zh', 'footer.records', { count: 3 })).toBe('3 条记录');
    expect(t('en', 'footer.records', { count: 3 })).toBe('3 RECORDS');
    expect(t('zh', 'app.author')).toBe('Created by @liuqi');
    expect(t('en', 'app.author')).toBe('Created by @liuqi');
  });

  it('keeps English overlay status and guidance copy compact', () => {
    const statusKeys = [
      'result.waitingNext',
      'result.waitingReload',
      'result.capturing',
      'result.normal',
      'result.autoReasoning',
      'result.mismatchDetected',
      'result.actualRouteConflict',
      'result.routeRead',
      'result.labelOnly',
      'result.routeMissing'
    ] as const;
    const labels = statusKeys.map((key) => t('en', key));
    expect(labels).toEqual([
      'Awaiting answer',
      'Awaiting reload',
      'Capturing',
      'Route normal',
      'Auto reasoning',
      'Route mismatch',
      'Route conflict',
      'Route captured',
      'Label only',
      'Route missing'
    ]);
    expect(Math.max(...labels.map((label) => label.length))).toBeLessThanOrEqual(15);
    expect(t('en', 'overlay.liveHint')).toBe('Send a message to capture its route.');
    expect(t('en', 'overlay.reloadHint')).toBe('Reload to read the response route.');
    expect(t('en', 'pow.inline')).toBe('POW');
  });

  it('defines every translation key referenced by extension HTML', () => {
    const known = new Set<string>(TRANSLATION_KEYS);
    for (const page of ['popup', 'dashboard', 'options', 'onboarding']) {
      const html = readFileSync(new URL(`../../src/ui/${page}/index.html`, import.meta.url), 'utf8');
      const keys = [...html.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)]
        .flatMap((match) => match[1] ? [match[1]] : []);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => !known.has(key))).toEqual([]);
      expect(html).toContain('Created by @liuqi');
      expect(html).toContain('https://blog.liu-qi.cn/tools/');
    }
  });
});
