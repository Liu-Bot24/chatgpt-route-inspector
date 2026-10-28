import { expect, it } from 'vitest';
import { classifyPageConnection, displayTabId, supportedPageUrl } from '../../src/core/page-scope';
import { DEFAULT_SETTINGS, type InspectorState } from '../../src/core/types';

const origins = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
const state: InspectorState = { turns: [], powReadings: [], settings: DEFAULT_SETTINGS,
  parserHealth: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 },
  captureContexts: { 7: { id: 'a', documentId: 'doc', documentStartedAt: 1, revision: 0,
    pageUrl: 'https://chatgpt.com/c/a', reloadEligible: true } } };

it('requires a supported URL and the matching non-retired visit for popup selection', () => {
  expect(displayTabId(state, { id: 7, url: 'https://chatgpt.com/c/a?x=1#answer' }, origins)).toBe(7);
  for (const url of [undefined, 'https://example.org/', 'https://chatgpt.com/c/b', 'chrome://settings', 'bad-url']) {
    expect(displayTabId(state, { id: 7, url }, origins)).toBeUndefined();
  }
  expect(displayTabId(state, { id: 7, url: 'https://chatgpt.com/c/a', pendingUrl: 'https://example.org/' }, origins)).toBeUndefined();
  expect(displayTabId(state, { id: 7, pendingUrl: 'https://chatgpt.com/c/a' }, origins)).toBeUndefined();
  expect(displayTabId(state, { id: 7, url: 'https://example.org/', pendingUrl: 'https://chatgpt.com/c/a' }, origins)).toBeUndefined();
  expect(displayTabId(state, { id: 7, url: 'https://chatgpt.com/c/b', pendingUrl: 'https://chatgpt.com/c/a' }, origins)).toBeUndefined();
  expect(displayTabId(state, { id: 7, url: 'https://chatgpt.com/c/a', pendingUrl: 'https://chatgpt.com/c/a' }, origins)).toBeUndefined();
  expect(displayTabId(state, undefined, origins)).toBeUndefined();
  expect(displayTabId(state, { id: 8, url: 'https://chatgpt.com/c/a' }, origins)).toBeUndefined();
  expect(displayTabId({ ...state, captureContexts: { 7: { ...state.captureContexts![7]!, invalidated: true } } },
    { id: 7, url: 'https://chatgpt.com/c/a' }, origins)).toBeUndefined();
  expect(supportedPageUrl('https://chat.openai.com/c/a', origins)).toBe('https://chat.openai.com/c/a');
});

it('asks for a reload only when a loaded supported tab has no reachable bridge', () => {
  const tab = { url: 'https://chatgpt.com/c/a', status: 'complete' };
  const reachable = { hostAccess: true, bridgeReachable: true };
  expect(classifyPageConnection(tab, origins, reachable)).toBe('connected');
  expect(classifyPageConnection(tab, origins, { hostAccess: true, bridgeReachable: false })).toBe('needs_refresh');
  expect(classifyPageConnection(tab, origins, { hostAccess: false, bridgeReachable: false })).toBe('site_access_blocked');
  for (const url of [undefined, 'https://example.org/', 'chrome-extension://id/ui/popup/index.html']) {
    expect(classifyPageConnection({ url, status: 'complete' }, origins, { hostAccess: true, bridgeReachable: false })).toBe('unsupported');
  }
  expect(classifyPageConnection(undefined, origins, reachable)).toBe('unsupported');
  expect(classifyPageConnection({ ...tab, status: 'loading' }, origins, { hostAccess: true, bridgeReachable: false })).toBe('loading');
  expect(classifyPageConnection({ ...tab, pendingUrl: 'https://chatgpt.com/c/b' }, origins, { hostAccess: true, bridgeReachable: false })).toBe('loading');
});
