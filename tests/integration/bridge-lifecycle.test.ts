import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CaptureContext, type InspectorState } from '../../src/core/types';
import type { RuntimeRequest } from '../../src/shared/messages';
import { createTurn } from '../../src/core/turns';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

async function bridge(failInitialState: false | 'throw' | 'reject' | 'missing-tab' = false, enabled = true) {
  vi.useFakeTimers();
  const listeners = new Map<string, (event: unknown) => void>();
  let state: InspectorState = { settings: { ...DEFAULT_SETTINGS, overlayEnabled: false, autoCaptureEnabled: enabled }, turns: [], powReadings: [],
    parserHealth: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 } };
  const nodes = [{ isConnected: true, getAttribute: (key: string) => ({
    'data-message-id': 'old-message', 'data-message-model-slug': 'old-dom'
  })[key] ?? null }];
  const send = vi.fn(async (request: RuntimeRequest) => {
    if (request.type === 'route:context') state = { ...state, captureContexts: { 1: request.context } };
    return { ok: true, state, tabId: 1 };
  });
  if (failInitialState === 'throw') send.mockRejectedValueOnce(new Error('worker restarting'));
  if (failInitialState === 'reject') send.mockResolvedValueOnce({ ok: false, state, tabId: 1 });
  if (failInitialState === 'missing-tab') send.mockResolvedValueOnce({ ok: true, state, tabId: undefined as never });
  const windowMock = { postMessage: vi.fn(), addEventListener: vi.fn((name, fn) => listeners.set(name, fn)), setTimeout, clearTimeout };
  vi.stubGlobal('window', windowMock);
  vi.stubGlobal('location', { origin: 'https://chatgpt.com', pathname: '/c/a' });
  const clicks = new Map<string, () => unknown>();
  const root = { innerHTML: '', getElementById: (id: string) => ({ addEventListener: (type: string, fn: () => unknown) => {
    if (type === 'click') clicks.set(id, fn);
  } }) };
  const host = { id: '', isConnected: true, shadowRoot: root, attachShadow: () => root, remove: vi.fn() };
  vi.stubGlobal('document', { documentElement: { append: vi.fn() }, querySelectorAll: () => nodes, createElement: () => host });
  let mutation!: MutationCallback;
  vi.stubGlobal('MutationObserver', class { constructor(callback: MutationCallback) { mutation = callback; } observe() {} });
  let stateListener!: (message: unknown) => void;
  vi.stubGlobal('chrome', { runtime: { sendMessage: send, onMessage: { addListener: (fn: typeof stateListener) => { stateListener = fn; } } } });
  await import('../../src/content/bridge');
  await Promise.resolve();
  const context: CaptureContext = { id: 'visit-1', documentId: 'doc-1', documentStartedAt: 1, visitStartedAt: 1,
    pageUrl: 'https://chatgpt.com/c/a', revision: 0, reloadEligible: true };
  return {
    send, context, nodes, root, host, click: (id: string) => clicks.get(id)?.(), mutate: () => mutation([], {} as MutationObserver),
    observe: () => listeners.get('message')?.({ source: windowMock, origin: 'https://chatgpt.com', data: {
      source: 'chatgpt-route-inspector', version: 1, observation: {
        captureId: 'startup', source: 'page_fetch', captureMode: 'live', phase: 'completed',
        observedAt: new Date().toISOString(), resolvedModelSlug: 'startup-route'
      }
    } }),
    networkConflict: () => {
      state = { ...state, turns: [createTurn({ captureId: 'network', captureContextId: context.id,
        tabId: 1, conversationId: 'a', source: 'conversation_record', captureMode: 'reload', phase: 'completed',
        observedAt: new Date().toISOString(), resolvedModelSlug: 'gpt-5-6-thinking', serverModelSlug: 'gpt-5-4-thinking'
      })] };
      stateListener({ type: 'route:state-changed', state });
    },
    showLive: () => {
      state = { ...state, settings: { ...state.settings, overlayEnabled: true }, turns: [createTurn({
        captureId: 'live', captureContextId: context.id, tabId: 1, source: 'page_fetch', captureMode: 'live',
        phase: 'completed', observedAt: new Date().toISOString(), conversationId: 'a', resolvedModelSlug: 'recovered-route'
      })] };
      stateListener({ type: 'route:state-changed', state });
    },
    update: (settings: Partial<typeof state.settings>, clearedAt?: string) => {
      state = { ...state, settings: { ...state.settings, ...settings }, ...(clearedAt ? { clearedAt } : {}) };
      stateListener({ type: 'route:state-changed', state });
    },
    receive: (next: CaptureContext) => listeners.get('message')?.({ source: windowMock, origin: 'https://chatgpt.com',
      data: { source: 'chatgpt-route-inspector-context', context: next } }),
    records: () => send.mock.calls.filter(([request]) => request.type === 'route:observation'),
    contexts: () => send.mock.calls.filter(([request]) => request.type === 'route:context')
  };
}

it.each([false, true])('A2: waits for a successful handshake before forwarding (enabled=%s)', async (enabled) => {
  const capture = await bridge('throw', enabled);
  capture.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(capture.records()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(200);
  expect(capture.records()).toHaveLength(enabled ? 1 : 0);
});

it('A2: observations received during a known pause are not replayed after resume', async () => {
  const capture = await bridge('throw', false);
  capture.update({ autoCaptureEnabled: false });
  capture.observe();
  capture.update({ autoCaptureEnabled: true });
  await vi.advanceTimersByTimeAsync(300);
  expect(capture.records()).toHaveLength(0);
  capture.observe();
  await vi.advanceTimersByTimeAsync(1);
  expect(capture.records()).toHaveLength(1);
});

it('A2: a pause invalidates startup observations even if resumed before initialization finishes', async () => {
  const capture = await bridge('throw');
  capture.observe();
  capture.update({ autoCaptureEnabled: false });
  capture.update({ autoCaptureEnabled: true });
  await vi.advanceTimersByTimeAsync(300);
  expect(capture.records()).toHaveLength(0);
});

it('A2: startup observations are bounded while waiting for initialization', async () => {
  const capture = await bridge('throw');
  for (let index = 0; index < 200; index++) capture.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(capture.records()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(200);
  expect(capture.records()).toHaveLength(128);
  capture.observe();
  await vi.advanceTimersByTimeAsync(1);
  expect(capture.records()).toHaveLength(129);
});

it('A3: an explicit network conflict stops DOM fallback even without a model label', async () => {
  const capture = await bridge();
  capture.receive(capture.context);
  capture.networkConflict();
  await vi.advanceTimersByTimeAsync(1300);
  expect(capture.records()).toHaveLength(0);
});

it.each(['throw', 'reject', 'missing-tab'] as const)('N5: recovers the overlay after initial handshake %s', async (failure) => {
  const capture = await bridge(failure);
  capture.receive(capture.context);
  capture.showLive();
  await vi.advanceTimersByTimeAsync(6000);
  expect(capture.send.mock.calls.filter(([r]) => r.type === 'route:get-state')).toHaveLength(2);
  expect(capture.root.innerHTML).toContain('recovered-route');
  const count = capture.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(capture.send.mock.calls).toHaveLength(count);
});

it('N6: paused DOM mutations are not replayed after resume even before MAIN closes eligibility', async () => {
  const capture = await bridge();
  capture.receive(capture.context);
  capture.update({ autoCaptureEnabled: false });
  Object.assign(location, { pathname: '/c/b' });
  capture.receive({ ...capture.context, id: 'visit-b', pageUrl: 'https://chatgpt.com/c/b', revision: 1 });
  capture.nodes.push({ isConnected: true, getAttribute: (key: string) => ({
    'data-message-id': 'paused-message', 'data-message-model-slug': 'paused-dom'
  })[key] ?? null });
  capture.mutate();
  capture.update({ autoCaptureEnabled: true });
  await vi.advanceTimersByTimeAsync(1300);
  expect(capture.records()).toHaveLength(0);
});

it.each(['older', 'newer'])('N2: %s clear is compared to the SPA visit and node, not document creation', async (when) => {
  const capture = await bridge();
  vi.setSystemTime(10_000);
  capture.receive(capture.context);
  Object.assign(location, { pathname: '/c/b' });
  vi.setSystemTime(12_000);
  capture.nodes.push({ isConnected: true, getAttribute: (key: string) => ({
    'data-message-id': 'new-message', 'data-message-model-slug': 'new-dom'
  })[key] ?? null });
  capture.receive({ ...capture.context, id: 'visit-b', visitStartedAt: 12_000, pageUrl: 'https://chatgpt.com/c/b', revision: 1 });
  vi.setSystemTime(13_000);
  capture.update({}, new Date(when === 'older' ? 11_000 : 12_500).toISOString());
  await vi.advanceTimersByTimeAsync(1300);
  expect(capture.records()).toHaveLength(when === 'older' ? 1 : 0);
});

it('N4 boundary: a DOM-first node has no proof of the next conversation and must not be reassigned', async () => {
  const capture = await bridge();
  capture.receive(capture.context);
  await vi.advanceTimersByTimeAsync(1300);
  capture.nodes.push({ isConnected: true, getAttribute: (key: string) => ({
    'data-message-id': 'ambiguous-message', 'data-message-model-slug': 'ambiguous-dom'
  })[key] ?? null });
  capture.mutate();
  // These observations are identical for an old-visit render just before navigation
  // and a new-visit render before URL assignment. No conversation identity is in the DOM.
  Object.assign(location, { pathname: '/c/b' });
  capture.receive({ ...capture.context, id: 'visit-b', pageUrl: 'https://chatgpt.com/c/b', revision: 1 });
  await vi.advanceTimersByTimeAsync(1300);
  expect(capture.records()).toHaveLength(1);
  // Deliberate safety boundary, NOT a fix for Pro N4's potential missed fallback.
  expect(capture.records().some(([r]) => r.type === 'route:observation' && r.observation.conversationId === 'b')).toBe(false);
});

it('R2: retained DOM nodes are not restamped as captures after BFCache restoration', async () => {
  const capture = await bridge();
  capture.receive(capture.context);
  await vi.advanceTimersByTimeAsync(1300);
  expect(capture.records()).toHaveLength(1);
  capture.receive({ ...capture.context, id: 'visit-restored', documentId: 'doc-restored', documentStartedAt: 2 });
  await vi.advanceTimersByTimeAsync(1300);
  expect(capture.records()).toHaveLength(1);
});

it('R2: accepts newly rendered SPA nodes even before the new context message arrives', async () => {
  const capture = await bridge();
  capture.receive(capture.context);
  await vi.advanceTimersByTimeAsync(1300);
  Object.assign(location, { pathname: '/c/b' });
  capture.nodes.push({ isConnected: true, getAttribute: (key: string) => ({
    'data-message-id': 'new-message', 'data-message-model-slug': 'new-dom'
  })[key] ?? null });
  // A mutation can arrive while the bridge still has the old page-hook context.
  capture.mutate();
  capture.receive({ ...capture.context, id: 'visit-b', pageUrl: 'https://chatgpt.com/c/b', revision: 1 });
  await vi.advanceTimersByTimeAsync(1300);
  expect(capture.records()).toHaveLength(2);
  expect(capture.records().at(-1)?.[0]).toMatchObject({ observation: { conversationId: 'b', domModelSlug: 'new-dom' } });
});

it.each(['throw', 'reject'])('R3: retries a context after runtime %s without requiring a new page revision', async (failure) => {
  const capture = await bridge();
  if (failure === 'throw') capture.send.mockRejectedValueOnce(new Error('worker restarting'));
  else capture.send.mockResolvedValueOnce({ ok: false, state: undefined as never, tabId: 1 });
  capture.receive(capture.context);
  await vi.advanceTimersByTimeAsync(6000);
  expect(capture.contexts().length).toBeGreaterThanOrEqual(2);
  expect(capture.contexts().at(-1)?.[0]).toEqual({ type: 'route:context', context: capture.context });
  const count = capture.contexts().length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(capture.contexts()).toHaveLength(count);
});

it('R3: retries only the newest context after navigation during a failed sync', async () => {
  const capture = await bridge();
  capture.send.mockRejectedValueOnce(new Error('worker restarting'));
  capture.receive(capture.context);
  await vi.advanceTimersByTimeAsync(1);
  const next = { ...capture.context, revision: 1, reloadEligible: false };
  capture.receive(next);
  await vi.advanceTimersByTimeAsync(6000);
  expect(capture.contexts().at(-1)?.[0]).toEqual({ type: 'route:context', context: next });
  expect(capture.contexts().slice(1).every(([r]) => r.type === 'route:context' && r.context.revision === 1)).toBe(true);
});

it.each(['missing-runtime', 'invalidated'] as const)('shows a refresh notice instead of dead controls when the extension is %s', async (failure) => {
  const capture = await bridge();
  capture.receive(capture.context);
  capture.showLive();
  await vi.advanceTimersByTimeAsync(1);
  if (failure === 'missing-runtime') Reflect.deleteProperty(chrome, 'runtime');
  else capture.send.mockRejectedValue(new Error('Extension context invalidated.'));
  capture.click('compact');
  await vi.advanceTimersByTimeAsync(1);
  expect(capture.root.innerHTML).toContain('id="reconnect"');
  expect(capture.root.innerHTML).not.toContain('recovered-route');
  const calls = capture.send.mock.calls.length;
  capture.observe();
  capture.receive({ ...capture.context, revision: 2 });
  capture.mutate();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(capture.send).toHaveBeenCalledTimes(calls);
  capture.click('dismiss-disconnected');
  expect(capture.host.remove).toHaveBeenCalled();
  capture.mutate();
  expect(capture.send).toHaveBeenCalledTimes(calls);
});

it('keeps normal controls usable after a transient worker failure', async () => {
  const capture = await bridge();
  capture.receive(capture.context);
  capture.showLive();
  await vi.advanceTimersByTimeAsync(1);
  const alert = vi.fn();
  Object.assign(window, { alert });
  capture.send.mockRejectedValueOnce(new Error('worker restarting'));
  capture.click('dashboard');
  await vi.advanceTimersByTimeAsync(1);
  expect(alert).toHaveBeenCalledOnce();
  expect(capture.root.innerHTML).not.toContain('id="reconnect"');
  capture.click('dashboard');
  await vi.advanceTimersByTimeAsync(1);
  expect(capture.send.mock.calls.at(-1)?.[0]).toEqual({ type: 'route:open-dashboard' });
});
