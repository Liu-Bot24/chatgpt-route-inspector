import { afterEach, expect, it, vi } from 'vitest';
import { latestInContext } from '../../src/core/capture-context';
import type { RuntimeRequest, RuntimeResponse } from '../../src/shared/messages';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function background() {
  const disk: Record<string, unknown> = {};
  let tab: { id: number; url?: string; pendingUrl?: string } = { id: 7, url: 'https://chatgpt.com/c/a' };
  let badge = '';
  let receive!: (request: RuntimeRequest, sender: chrome.runtime.MessageSender, reply: (value: RuntimeResponse) => void) => void;
  let navigate: ((id: number, change: object, tab: object) => void) | undefined;
  const api = {
    i18n: { getUILanguage: () => 'en' },
    storage: { local: {
      get: async () => structuredClone(disk), set: async (next: object) => Object.assign(disk, structuredClone(next))
    } },
    action: { setBadgeText: async (value: { text: string }) => { badge = value.text; }, setBadgeBackgroundColor: vi.fn() },
    runtime: { onInstalled: { addListener: vi.fn() }, sendMessage: vi.fn(), onMessage: { addListener: (fn: typeof receive) => { receive = fn; } } },
    tabs: { create: vi.fn(async () => ({ id: 9 })), query: async () => [structuredClone(tab)], get: vi.fn(async () => structuredClone(tab)), sendMessage: vi.fn(),
      onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: (fn: typeof navigate) => { navigate = fn; } } }
  };
  vi.stubGlobal('chrome', api);
  vi.stubGlobal('__ROUTE_INSPECTOR_ALLOWED_ORIGINS__', ['https://chatgpt.com', 'https://chat.openai.com']);
  await import('../../src/background/service-worker');
  const send = (request: RuntimeRequest, content = false) => new Promise<RuntimeResponse>((resolve) => receive(request,
    content ? { url: 'https://chatgpt.com/c/a', tab: { id: 7 } as chrome.tabs.Tab } : {}, resolve));
  const context = { id: 'visit-a', documentId: 'doc-a', documentStartedAt: 1, revision: 0,
    pageUrl: 'https://chatgpt.com/c/a', reloadEligible: true };
  const observation = { captureId: 'old', captureContextId: context.id, source: 'page_fetch' as const,
    captureMode: 'live' as const, phase: 'completed' as const, observedAt: new Date().toISOString(),
    conversationId: 'a', requestedModel: 'old-route', resolvedModelSlug: 'old-route' };
  await send({ type: 'route:context', context }, true);
  await send({ type: 'route:observation', observation }, true);
  expect(badge).toBe('OK');
  return { send, context, observation, api, badge: () => badge,
    change: (change: object) => navigate?.(7, change, structuredClone(tab)),
    setTab: (next: typeof tab, notify = true) => {
      tab = next;
      if (notify) navigate?.(7, { status: 'loading' }, structuredClone(tab));
    },
    navigate: (url?: string, notify = true) => {
      tab = { id: 7, ...(url ? { url } : {}) };
      if (notify) navigate?.(7, { status: 'loading', ...(url ? { url } : {}) }, tab);
    }
  };
}

it('opens only the fixed public notice URL without forwarding request data', async () => {
  const b = await background();
  const response = await b.send({ type: 'route:open-announcement' }, true);
  expect(response.ok).toBe(true);
  expect(b.api.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://rinotice.liu-qi.cn/' });
  b.api.tabs.create.mockRejectedValueOnce(new Error('Tab unavailable'));
  expect(await b.send({ type: 'route:open-announcement' }, true)).toMatchObject({ ok: false, error: 'Tab unavailable' });
});

it.each(['https://example.org/', undefined])('C1: leaving the supported site clears display, not history (%s)', async (url) => {
  const b = await background();
  b.navigate(url);
  await vi.waitFor(() => expect(b.badge()).toBe(''));
  let state = (await b.send({ type: 'route:get-state', tabId: 7 })).state!;
  expect(latestInContext(state, 7, 'live')).toBeNull();
  expect(state.turns).toHaveLength(1);
  // A delayed old handshake or observation must not restore display eligibility.
  await b.send({ type: 'route:context', context: { ...b.context, revision: 99 } }, true);
  await b.send({ type: 'route:observation', observation: b.observation }, true);
  state = (await b.send({ type: 'route:get-state', tabId: 7 })).state!;
  expect(latestInContext(state, 7, 'live')).toBeNull();
  expect(b.badge()).toBe('');
  b.navigate('https://chatgpt.com/c/a');
  await b.send({ type: 'route:context', context: { ...b.context, revision: 100 } }, true);
  state = (await b.send({ type: 'route:get-state', tabId: 7 })).state!;
  expect(latestInContext(state, 7, 'live')).toBeNull();
  const fresh = { ...b.context, id: 'fresh', documentId: 'new-doc', documentStartedAt: Date.now() };
  await b.send({ type: 'route:context', context: fresh }, true);
  await b.send({ type: 'route:observation', observation: { ...b.observation, captureId: 'new', captureContextId: fresh.id } }, true);
  state = (await b.send({ type: 'route:get-state', tabId: 7 })).state!;
  expect(latestInContext(state, 7, 'live')?.captureId).toBe('new');
  expect(state.turns).toHaveLength(2);
  expect(b.badge()).toBe('OK');
});

it.each(['read', 'broadcast', 'navigation'] as const)('C1-P: pending destination is not a committed page (%s)', async (trigger) => {
  const b = await background();
  const storage = await import('../../src/background/storage');
  // The off-site committed URL is not exposed under the extension's host permissions.
  b.setTab({ id: 7, pendingUrl: b.context.pageUrl }, trigger === 'navigation');
  if (trigger === 'read') await b.send({ type: 'route:get-state', tabId: 7 });
  if (trigger === 'broadcast') await b.send({ type: 'route:update-settings', settings: { uiLanguage: 'zh' } });
  await vi.waitFor(async () => expect(latestInContext(await storage.readState(), 7, 'live')).toBeNull());
  expect(b.badge()).toBe('');
  expect((await storage.readState()).turns).toHaveLength(1);
  expect((await b.send({ type: 'route:context', context: { ...b.context, revision: 2 } }, true)).ok).toBe(false);
});

it.each(['active', 'retired', 'missing'] as const)('C2: delayed off-site read cannot retire a newer document (%s original context)', async (kind) => {
  const b = await background();
  const storage = await import('../../src/background/storage');
  if (kind === 'retired') {
    b.navigate('https://example.org/');
    await vi.waitFor(() => expect(b.badge()).toBe(''));
  } else if (kind === 'missing') {
    await storage.mutateState((state) => ({ ...state, captureContexts: {} }));
  }
  b.navigate('https://example.org/', false);
  let release!: () => void;
  let queried = false;
  b.api.tabs.get.mockImplementationOnce(() => {
    queried = true;
    return new Promise((resolve) => { release = () => resolve({ id: 7 }); });
  });
  const delayed = b.send({ type: 'route:get-state', tabId: 7 });
  await vi.waitFor(() => expect(queried).toBe(true));
  b.navigate(b.context.pageUrl, false);
  const fresh = { ...b.context, id: 'visit-b', documentId: 'doc-b', documentStartedAt: 2 };
  expect((await b.send({ type: 'route:context', context: fresh }, true)).ok).toBe(true);
  await b.send({ type: 'route:observation', observation: { ...b.observation, captureId: 'new', captureContextId: fresh.id } }, true);
  release();
  const result = (await delayed).state!;
  expect(result.captureContexts?.[7]?.invalidated).not.toBe(true);
  expect(latestInContext(result, 7, 'live')?.captureId).toBe('new');
  expect(b.badge()).toBe('OK');
  expect(result.turns).toHaveLength(2);
  expect((await b.send({ type: 'route:context', context: { ...fresh, revision: 1 } }, true)).ok).toBe(true);
});

it('does not permanently retire a committed document when pending navigation is cancelled', async () => {
  const b = await background();
  b.setTab({ id: 7, url: b.context.pageUrl, pendingUrl: 'https://example.org/' });
  await b.send({ type: 'route:update-settings', settings: { uiLanguage: 'zh' } });
  const pending = (await b.send({ type: 'route:get-state', tabId: 7 })).state!;
  expect(pending.captureContexts?.[7]?.invalidated).not.toBe(true);
  expect(b.badge()).toBe('');
  b.navigate(b.context.pageUrl);
  await b.send({ type: 'route:update-settings', settings: { uiLanguage: 'en' } });
  expect(b.badge()).toBe('OK');
  expect((await b.send({ type: 'route:context', context: b.context }, true)).ok).toBe(true);
});

it('C3: cancellation restores the badge without a state write or broadcast', async () => {
  const b = await background();
  const storage = await import('../../src/background/storage');
  b.setTab({ id: 7, url: b.context.pageUrl, pendingUrl: 'https://chatgpt.com/c/b' });
  await b.send({ type: 'route:update-settings', settings: { uiLanguage: 'zh' } });
  expect(b.badge()).toBe('');
  const before = await storage.readState();
  b.api.runtime.sendMessage.mockClear();
  b.api.tabs.sendMessage.mockClear();
  b.setTab({ id: 7, url: b.context.pageUrl }, false);
  b.change({ status: 'complete' });
  await vi.waitFor(() => expect(b.badge()).toBe('OK'));
  expect(await storage.readState()).toEqual(before);
  expect(b.api.runtime.sendMessage).not.toHaveBeenCalled();
  expect(b.api.tabs.sendMessage).not.toHaveBeenCalled();
});

it.each(['pending', 'different-page', 'paused', 'retired', 'empty-mode'] as const)(
  'C3: navigation badge refresh does not expose an ineligible result (%s)', async (kind) => {
    const b = await background();
    const storage = await import('../../src/background/storage');
    if (kind === 'paused') await b.send({ type: 'route:update-settings', settings: { autoCaptureEnabled: false } });
    if (kind === 'empty-mode') await b.send({ type: 'route:update-settings', settings: { captureMode: 'reload' } });
    if (kind === 'retired') await storage.invalidateCaptureContext(7, b.context.id);
    b.setTab({ id: 7, url: kind === 'different-page' ? 'https://chatgpt.com/c/b' : b.context.pageUrl,
      ...(kind === 'pending' ? { pendingUrl: 'https://chatgpt.com/c/b' } : {}) }, false);
    b.api.tabs.get.mockClear();
    b.change({ status: 'complete' });
    await vi.waitFor(() => expect(b.api.tabs.get).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(b.badge()).toBe('');
  }
);

it('C3: title-only updates do not refresh badges or write state', async () => {
  const b = await background();
  const storage = await import('../../src/background/storage');
  const before = await storage.readState();
  b.api.tabs.get.mockClear();
  b.change({ title: 'Updated title' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(b.api.tabs.get).not.toHaveBeenCalled();
  expect(await storage.readState()).toEqual(before);
  expect(b.badge()).toBe('OK');
});

it('C3: cancellation refresh follows an already running broadcast', async () => {
  const b = await background();
  b.setTab({ id: 7, url: b.context.pageUrl, pendingUrl: 'https://chatgpt.com/c/b' }, false);
  let release!: () => void;
  let started = false;
  b.api.action.setBadgeBackgroundColor.mockImplementationOnce(() => {
    started = true;
    return new Promise<void>((resolve) => { release = resolve; });
  });
  const broadcast = b.send({ type: 'route:update-settings', settings: { uiLanguage: 'zh' } });
  await vi.waitFor(() => expect(started).toBe(true));
  b.setTab({ id: 7, url: b.context.pageUrl }, false);
  b.change({ status: 'complete' });
  release();
  await broadcast;
  await vi.waitFor(() => expect(b.badge()).toBe('OK'));
});

it('C2: a delayed navigation-event query cannot retire a newer document', async () => {
  const b = await background();
  const storage = await import('../../src/background/storage');
  let release!: () => void;
  let queried = false;
  b.api.tabs.get.mockImplementationOnce(() => {
    queried = true;
    return new Promise((resolve) => { release = () => resolve({ id: 7 }); });
  });
  b.navigate('https://example.org/');
  await vi.waitFor(() => expect(queried).toBe(true));
  b.navigate(b.context.pageUrl, false);
  const fresh = { ...b.context, id: 'visit-b', documentId: 'doc-b', documentStartedAt: 2 };
  await b.send({ type: 'route:context', context: fresh }, true);
  await b.send({ type: 'route:observation', observation: { ...b.observation, captureId: 'new', captureContextId: fresh.id } }, true);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const state = await storage.readState();
  expect(state.captureContexts?.[7]?.invalidated).not.toBe(true);
  expect(latestInContext(state, 7, 'live')?.captureId).toBe('new');
  expect(b.badge()).toBe('OK');
});

it('ignores an old off-site event snapshot once the current page has returned', async () => {
  const b = await background();
  // The event snapshot says off-site, but tabs.get observes the already returned page.
  b.api.tabs.get.mockResolvedValue({ id: 7, url: b.context.pageUrl });
  b.navigate('https://example.org/');
  b.navigate(b.context.pageUrl, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const state = (await b.send({ type: 'route:get-state', tabId: 7 })).state!;
  expect(state.captureContexts?.[7]?.invalidated).not.toBe(true);
  expect(latestInContext(state, 7, 'live')?.captureId).toBe('old');
});

it('does not acknowledge a retired document handshake as accepted', async () => {
  const b = await background();
  b.navigate('https://example.org/');
  await vi.waitFor(() => expect(b.badge()).toBe(''));
  b.navigate(b.context.pageUrl);
  expect((await b.send({ type: 'route:context', context: { ...b.context, revision: 99 } }, true)).ok).toBe(false);
});

it('C1: popup reads and broadcasts reject off-site context even if the navigation event was missed', async () => {
  const b = await background();
  b.navigate('https://example.org/', false);
  await b.send({ type: 'route:update-settings', settings: { uiLanguage: 'zh' } });
  const state = (await b.send({ type: 'route:get-state', tabId: 7 })).state!;
  expect(latestInContext(state, 7, 'live')).toBeNull();
  expect(b.badge()).toBe('');
  expect(state.turns).toHaveLength(1);
});

it('C1: document retirement survives a storage reload and rejects a delayed same-document handshake', async () => {
  const b = await background();
  b.navigate('https://example.org/');
  await vi.waitFor(() => expect(b.badge()).toBe(''));
  vi.resetModules();
  const storage = await import('../../src/background/storage');
  const retired = await storage.readState();
  expect(retired.captureContexts?.[7]?.invalidated).toBe(true);
  const late = await storage.storeCaptureContext(7, { ...b.context, revision: 999 });
  expect(latestInContext(late, 7, 'live')).toBeNull();
  expect(late.turns).toHaveLength(1);
});
