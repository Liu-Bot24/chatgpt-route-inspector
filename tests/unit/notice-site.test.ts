import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOTICE_TRANSLATIONS, t } from '../../site/notice/i18n';
import { TRANSLATION_KEYS } from '../../src/ui/shared/i18n';

const NOTICE_KEYS = Object.keys(NOTICE_TRANSLATIONS.zh) as Array<keyof typeof NOTICE_TRANSLATIONS.zh>;

describe('public notice site', () => {
  it('provides complete Chinese and English copy for the upgrade announcement', () => {
    const html = readFileSync(new URL('../../site/notice/index.html', import.meta.url), 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)].map((match) => match[1]!);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(NOTICE_KEYS).toContain(key);
      const translatedKey = key as (typeof NOTICE_KEYS)[number];
      expect(t('zh', translatedKey)).not.toBe(key);
      expect(t('en', translatedKey)).not.toBe(key);
      expect(t('en', translatedKey)).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(t('zh', 'notice.badge')).toBe('版本公告');
    expect(t('zh', 'notice.pollBefore')).toBe('根据此前');
    expect(t('zh', 'notice.subtitle')).toBe('1.1.0 · 版本公告');
    expect(t('en', 'notice.subtitle')).toBe('1.1.0 · Version notice');
    expect(t('zh', 'notice.release110')).toBe('新增图片生成、深度研究识别，支持显示规划与报告模型；适配免费账号 Auto 请求。');
    expect(html.indexOf('notice.release110')).toBeLessThan(html.indexOf('notice.release109'));
    expect(t('zh', 'notice.release109')).toContain('新建会话');
    expect(t('zh', 'notice.pollLink')).toBe('投票');
    expect(t('zh', 'notice.comment')).toBe('留言');
    expect(t('en', 'notice.comment')).toBe('Comment');
    expect(html).toContain('href="https://x.com/liu_9982/status/2103986931227123784" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('src="/icons/x-logo.svg"');
    expect(t('zh', 'notice.update110Tasks')).toBe('新增“图片生成”和“深度研究”状态，避免将这两类任务误判为降级或路由错配。');
    expect(t('zh', 'notice.update110Models')).toBe('深度研究支持分别记录和显示规划模型、报告模型。');
    expect(t('zh', 'notice.update110Capture')).toBe('实时请求与会话重载均支持识别图片生成和深度研究，并接收同一任务的后续结果。');
    expect(t('zh', 'notice.update110AutoBefore') + 'Auto' + t('zh', 'notice.update110AutoAfter')).toBe('适配免费账号请求模型为 Auto 的情况，统一显示为“自动推理”。');
    expect(t('zh', 'notice.pollBefore') + t('zh', 'notice.pollLink') + t('zh', 'notice.release108After')).toBe('根据此前投票反馈，新增“疑似降级”标记。');
    expect(html).toContain('href="https://x.com/liu_9982/status/2100132495455043829?s=20"');
    expect(html.indexOf('id="notice-poll"')).toBeGreaterThan(html.indexOf('v1.0.8'));
    expect(html).not.toContain('announcement-footnote');
    expect(html).not.toContain('data-i18n="notice.scopeCopy"');
  });


  it('keeps full announcement copy outside the extension translation bundle', () => {
    expect(TRANSLATION_KEYS).not.toContain('notice.documentTitle');
    expect(TRANSLATION_KEYS).not.toContain('notice.release110');
    for (const key of ['notice.hintLabel', 'notice.hint', 'notice.readMore', 'notice.openFailed']) {
      expect(TRANSLATION_KEYS).toContain(key);
    }
  });
});
