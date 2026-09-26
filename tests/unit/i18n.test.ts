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
  it('provides complete Chinese and English copy for the upgrade announcement', () => {
    const html = readFileSync(new URL('../../src/ui/announcement/index.html', import.meta.url), 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)].map((match) => match[1]!);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(TRANSLATION_KEYS).toContain(key);
      const translatedKey = key as (typeof TRANSLATION_KEYS)[number];
      expect(t('zh', translatedKey)).not.toBe(key);
      expect(t('en', translatedKey)).not.toBe(key);
      expect(t('en', translatedKey)).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(t('zh', 'notice.badge')).toBe('版本公告');
    expect(t('zh', 'notice.pollBefore')).toBe('根据此前');
    expect(t('zh', 'notice.subtitle')).toBe('1.0.9 · 版本公告');
    expect(t('zh', 'notice.release109')).toContain('新建会话');
    expect(t('zh', 'notice.pollLink')).toBe('投票');
    expect(t('zh', 'notice.pollResult')).toContain('约 80% 未降级');
    expect(t('zh', 'notice.pollResult')).toContain('约 80% 发生了降级');
    expect(t('en', 'notice.pollResult')).toContain('about 80% reported no downgrade');
    expect(t('zh', 'notice.suspectAfter')).toContain('疑似降级');
    expect(t('zh', 'notice.suspectEnding')).toBe('提醒。');
    expect(t('zh', 'notice.imageLead')).toBe('单纯');
    expect(t('zh', 'notice.imageAfter')).toContain('请自行辨别');
    expect(t('zh', 'notice.release108')).toBe('新增“疑似降级”标记。');
    expect(t('zh', 'notice.scopeCopy')).toContain('Codex');
  });

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

  it('renders the limited-sample warning in both languages', () => {
    const suspected = createTurn({
      captureId: 'suspected', source: 'page_fetch', captureMode: 'live', phase: 'completed',
      observedAt: '2026-09-25T00:00:00.000Z', requestedModel: 'gpt-5-6-pro',
      serverModelSlug: 'gpt-5-6-pro'
    });
    expect(suspected.verdict).toBe('suspected_downgrade');
    expect(turnResultLabel(suspected, 'zh')).toBe('疑似降级');
    expect(turnResultLabel(suspected, 'en')).toBe('Possible downgrade');
    expect(assessmentReasons(suspected, 'zh').join('\n')).toContain('单纯图片生成例外');
    expect(assessmentReasons(suspected, 'en').join('\n')).toContain('image-only generation is an exception');
  });

  it('renders the Work-mode inconclusive status and reason in both languages', () => {
    const work = createTurn({ captureId: 'work', source: 'conversation_record', captureMode: 'reload',
      phase: 'completed', observedAt: '2026-09-25T00:00:00Z', responseModelSlug: 'gpt-6-astra-wm' });
    expect(turnResultLabel(work, 'zh')).toBe('无法判断');
    expect(turnResultLabel(work, 'en')).toBe('Cannot determine');
    expect(assessmentReasons(work, 'zh').join('\n')).toContain('Codex');
    expect(assessmentReasons(work, 'en').join('\n')).toContain('Codex');
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
      'result.suspectedDowngrade',
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
      'Possible downgrade',
      'Route mismatch',
      'Route conflict',
      'Route captured',
      'Label only',
      'Route missing'
    ]);
    expect(Math.max(...labels.map((label) => label.length))).toBeLessThanOrEqual(18);
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
      if (page === 'dashboard') {
        expect(html).toContain('id="dashboard-version"');
        expect(html).toContain('href="https://rinotice.liu-qi.cn/"');
        expect(html).toContain('https://github.com/Liu-Bot24/chatgpt-route-inspector');
        expect(html).not.toContain('Created by @liuqi');
      } else {
        expect(html).toContain('Created by @liuqi');
        expect(html).toContain('https://blog.liu-qi.cn/tools/');
      }
    }
  });
});
