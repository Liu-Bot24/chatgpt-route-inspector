import { afterEach, expect, it, vi } from 'vitest';
import {
  bindSuspectedDowngradeHint,
  currentSuspectedDowngradeHint,
  suspectedDowngradeHintMarkup
} from '../../src/ui/shared/suspected-downgrade-hint';
import { UPGRADE_NOTICE_URL } from '../../src/shared/upgrade-notice';

afterEach(() => vi.unstubAllGlobals());

it.each(['throw', 'reject', 'not-ok', 'ok'])('reports announcement open failures: %s', async (mode) => {
  let click!: (event: { preventDefault: () => void }) => Promise<void>;
  const showError = vi.fn();
  const hint = { addEventListener: vi.fn() };
  const root = { getElementById: (id: string) => id === 'suspect-hint' ? hint : id === 'suspect-error'
    ? { removeAttribute: showError } : id === 'suspect-link'
      ? { addEventListener: (_type: string, listener: typeof click) => { click = listener; } } : null };
  vi.stubGlobal('chrome', { runtime: { sendMessage: () => {
    if (mode === 'throw') throw new Error('Extension context invalidated');
    if (mode === 'reject') return Promise.reject(new Error('Worker unavailable'));
    return Promise.resolve({ ok: mode === 'ok', error: 'Open failed' });
  } } });
  bindSuspectedDowngradeHint(root as unknown as ShadowRoot);
  await expect(Promise.resolve().then(() => click({ preventDefault: vi.fn() }))).resolves.toBeUndefined();
  await Promise.resolve();
  expect(showError).toHaveBeenCalledTimes(mode === 'ok' ? 0 : 1);
});

it.each(['zh', 'en'] as const)('anchors the tooltip to the suspected-downgrade label in %s', (language) => {
  const url = UPGRADE_NOTICE_URL;
  const html = suspectedDowngradeHintMarkup(language, url);
  expect(html).toContain('id="suspect-trigger"');
  expect(html).toContain('aria-controls="suspect-popover"');
  expect(html).toContain(`href="${url}"`);
  expect(html).toContain('resolved_model_slug');
  expect(html).toContain('80%');
  expect(html).not.toContain(language === 'zh' ? '（生图例外）' : '(image generation excepted)');
  expect(html).not.toMatch(/notice-star|notice-source-label|\*>|[★☆✱✳]/);
  if (language === 'zh') expect(html).toContain('疑似降级');
  else expect(html).not.toMatch(/[\u4e00-\u9fff]/);
});

it('uses the public notice URL without requesting extension URL access', () => {
  const getURL = vi.fn((page: string) => `chrome-extension://example/${page}`);
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.0.8' }), getURL } });
  expect(currentSuspectedDowngradeHint('zh')).toContain('疑似降级');
  expect(currentSuspectedDowngradeHint('zh')).toContain(`href="${UPGRADE_NOTICE_URL}"`);
  expect(getURL).not.toHaveBeenCalled();
});
