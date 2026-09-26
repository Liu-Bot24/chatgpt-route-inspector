import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleInstallation, isNoticeUpgrade, UPGRADE_NOTICE_KEY, UPGRADE_NOTICE_URL } from '../../src/background/upgrade-notice';

const details = (reason: string, previousVersion?: string) => ({ reason, ...(previousVersion ? { previousVersion } : {}) }) as chrome.runtime.InstalledDetails;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

function setup(version = '1.0.9') {
  const disk: Record<string, unknown> = {};
  const create = vi.fn(async () => ({ id: 1 }));
  const get = vi.fn(async () => structuredClone(disk));
  const set = vi.fn(async (value: object) => { Object.assign(disk, value); });
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version }), getURL: (path: string) => `chrome-extension://test/${path}` },
    storage: { local: { get, set } }, tabs: { create }, i18n: { getUILanguage: () => 'en' }
  });
  return { disk, create, get, set };
}

it.each(['1.0.8', '1.0.7', '1.0.6', '0.9', '1.0.8.9'])('allows upgrades from %s to the exact notice version', (previous) => {
  expect(isNoticeUpgrade('1.0.9', details('update', previous))).toBe(true);
});

it.each([
  ['1.0.9', 'update', '1.0.9'], ['1.0.9', 'update', '1.0.9.0'], ['1.0.9', 'update', '1.0.10'],
  ['1.0.10', 'update', '1.0.8'], ['1.0.9', 'install', '1.0.8'], ['1.0.9', 'chrome_update', '1.0.8'],
  ['1.0.9', 'shared_module_update', '1.0.8'], ['1.0.9', 'update', ''], ['1.0.9', 'update', 'bad']
])('does not announce current=%s reason=%s previous=%s', (current, reason, previous) => {
  expect(isNoticeUpgrade(current, details(reason, previous))).toBe(false);
});

it('opens one public notice for concurrent events and persists the marker across worker restarts', async () => {
  const { create, disk } = setup();
  disk.routeInspectorNotice108Shown = true;
  await Promise.all([handleInstallation(details('update', '1.0.7')), handleInstallation(details('update', '1.0.7'))]);
  expect(create).toHaveBeenCalledExactlyOnceWith({ url: UPGRADE_NOTICE_URL, active: true });
  expect(disk[UPGRADE_NOTICE_KEY]).toBe(true);
  vi.resetModules();
  const restarted = await import('../../src/background/upgrade-notice');
  await restarted.handleInstallation(details('update', '1.0.7'));
  expect(create).toHaveBeenCalledTimes(1);
  const { clearState } = await import('../../src/background/storage');
  await clearState();
  expect(disk[UPGRADE_NOTICE_KEY]).toBe(true);
  await restarted.handleInstallation(details('update', '1.0.7'));
  expect(create).toHaveBeenCalledTimes(1);
});

it('keeps fresh-install onboarding, without showing or marking the upgrade announcement', async () => {
  const { create, disk } = setup();
  await handleInstallation(details('install'));
  expect(create).toHaveBeenCalledExactlyOnceWith({ url: 'chrome-extension://test/ui/onboarding/index.html' });
  expect(disk[UPGRADE_NOTICE_KEY]).toBeUndefined();
});

it('later versions and same-version development reloads do not read storage or open a notice', async () => {
  const { create, get } = setup('1.0.10');
  await handleInstallation(details('update', '1.0.9'));
  expect(create).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  setup();
  expect(isNoticeUpgrade('1.0.9', details('update', '1.0.9'))).toBe(false);
});

it('does not mark a failed open as shown and permits a retry', async () => {
  const { create, disk } = setup();
  create.mockRejectedValueOnce(new Error('tab unavailable'));
  await expect(handleInstallation(details('update', '1.0.7'))).rejects.toThrow('tab unavailable');
  expect(disk[UPGRADE_NOTICE_KEY]).toBeUndefined();
  await handleInstallation(details('update', '1.0.7'));
  expect(disk[UPGRADE_NOTICE_KEY]).toBe(true);
});

it('storage read failure does not open a tab or change the seen marker', async () => {
  const { get, create, disk } = setup();
  get.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(handleInstallation(details('update', '1.0.7'))).rejects.toThrow('storage unavailable');
  expect(create).not.toHaveBeenCalled();
  expect(disk[UPGRADE_NOTICE_KEY]).toBeUndefined();
});

it('ships the numbered version notice with an inline poll link, image exception footnote and release links', () => {
  const html = readFileSync(new URL('../../src/ui/announcement/index.html', import.meta.url), 'utf8');
  const pollUrl = 'https://x.com/liu_9982/status/2100132495455043829?s=20';
  expect(html).toContain('1.0.9 · 版本公告');
  expect(html).toContain('data-i18n="notice.pollBefore">根据此前');
  expect(html).toContain('data-i18n="notice.release109">修复新建会话');
  expect(html).toContain('data-i18n="notice.badge">版本公告</span>');
  expect(html).not.toContain('id="notice-title"');
  expect(html).toContain(`href="${pollUrl}"`);
  expect(html).toContain('data-i18n="notice.pollLink">投票</a>');
  expect(html).not.toContain(`>${pollUrl}</a>`);
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('约 80% 未降级');
  expect(html).toContain('约 80% 发生了降级');
  expect(html).toContain('新增“疑似降级”标记</span><span class="announcement-note-anchor"><span data-i18n="notice.suspectEnding">提醒。</span><sup class="announcement-note-ref">*</sup></span>');
  expect(html).toContain('data-i18n="notice.imageLead">单纯</span></span><span data-i18n="notice.imageBefore">图片生成任务响应结果中不带 ');
  expect(html).toContain('网页版 Work 模式');
  expect(html.indexOf('本扩展的正确应用范围')).toBeLessThan(html.indexOf('notice.imageLead'));
  expect(html).toContain('data-i18n="notice.release108">新增“疑似降级”标记。');
  expect(html).not.toContain('为什么新增');
  expect(html).not.toContain('共 91 票');
  for (let minor = 1; minor <= 7; minor++) {
    expect(html).toContain(`https://github.com/Liu-Bot24/chatgpt-route-inspector/releases/tag/v1.0.${minor}`);
  }
  expect(html).not.toMatch(/<(script|iframe|img)[^>]+(?:src|href)="https?:/);
  expect(html).toContain('id="notice-close"');
});
