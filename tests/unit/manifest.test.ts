import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function manifest() {
  return JSON.parse(readFileSync(new URL('../../manifest/manifest.json', import.meta.url), 'utf8')) as {
    manifest_version: number;
    version: string;
    permissions: string[];
    host_permissions: string[];
    content_scripts: Array<{ matches: string[]; world: string }>;
    default_locale: string;
    name: string;
    description: string;
    icons: Record<string, string>;
    action: { default_icon: Record<string, string> };
  };
}

function pngDimensions(relativePath: string): { width: number; height: number } {
  const image = readFileSync(new URL(`../../${relativePath}`, import.meta.url));
  expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

describe('extension permissions', () => {
  it('uses one minimal manifest with no browser debugging permission', () => {
    const value = manifest();
    expect(value.manifest_version).toBe(3);
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as {
      version: string; packages: { '': { version: string } };
    };
    expect(value.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(value.version).toBe(packageJson.version);
    expect(lock.version).toBe(packageJson.version);
    expect(lock.packages[''].version).toBe(packageJson.version);
    expect(value.permissions).toEqual(['storage']);
    expect(value.permissions).not.toContain('activeTab');
    expect(value.permissions).not.toContain('debugger');
    expect(value.host_permissions).toEqual(['https://chatgpt.com/*', 'https://chat.openai.com/*']);
    expect(value.content_scripts.map((script) => script.world)).toEqual(['MAIN', 'ISOLATED']);
    expect(value.default_locale).toBe('en');
    expect(value.name).toBe('__MSG_extensionName__');
    expect(value.description).toBe('__MSG_extensionDescription__');
  });

  it('ships generated toolbar icons at every declared size', () => {
    const value = manifest();
    const expected = {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png'
    };
    expect(value.icons).toEqual(expected);
    expect(value.action.default_icon).toEqual(expected);
    for (const [size, relativePath] of Object.entries(expected)) {
      expect(pngDimensions(relativePath)).toEqual({ width: Number(size), height: Number(size) });
    }
  });

  it('ships store metadata for ten selected locales within Chrome limits', () => {
    const expectedLocales = ['de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt_BR', 'zh_CN'];
    const actualLocales = readdirSync(new URL('../../_locales/', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(actualLocales).toEqual([...expectedLocales].sort());

    for (const locale of expectedLocales) {
      const messages = JSON.parse(readFileSync(new URL(`../../_locales/${locale}/messages.json`, import.meta.url), 'utf8')) as Record<string, { message?: string }>;
      const name = messages.extensionName?.message ?? '';
      const description = messages.extensionDescription?.message ?? '';
      expect(name).toContain('ChatGPT');
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(75);
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(132);
    }
  });
});
