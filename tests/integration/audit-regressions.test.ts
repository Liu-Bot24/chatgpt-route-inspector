import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurn, upsertTurn } from '../../src/core/turns';
import { parseResponseText } from '../../src/core/response-parser';
import { sanitizeTurn } from '../../src/core/privacy';
import { classifyEndpoint } from '../../src/core/endpoints';
import type { RouteObservation } from '../../src/core/types';
import type { RuntimeRequest, RuntimeResponse } from '../../src/shared/messages';

const observation: RouteObservation = {
  captureId: 'capture', source: 'page_fetch', captureMode: 'live', phase: 'completed',
  observedAt: '2026-09-11T01:00:10Z', startedAt: '2026-09-11T01:00:00Z',
  requestId: 'req-private-123456', conversationId: 'conv', tabId: 1, resolvedModelSlug: 'new-model'
};

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('audit regressions', () => {
  it('keeps matching request and capture identifiers isolated by tab', () => {
    const initial = [createTurn(observation)];
    expect(upsertTurn(initial, { ...observation, tabId: 2 })).toHaveLength(2);
    expect(upsertTurn(initial, { ...observation, captureId: 'second' })).toHaveLength(1);
  });

  it('does not promote an old capture or overwrite newer evidence with an older packet', () => {
    const newer = createTurn({ ...observation, captureId: 'new', requestId: 'new', startedAt: '2026-09-11T01:01:00Z' });
    const updated = upsertTurn([newer, createTurn(observation)], { ...observation, observedAt: '2026-09-11T01:02:00Z' });
    expect(updated[0]?.captureId).toBe('new');
    const stale = upsertTurn([createTurn(observation)], {
      ...observation, phase: 'responding', observedAt: '2026-09-11T01:00:05Z', resolvedModelSlug: 'old-model'
    });
    expect(stale[0]).toMatchObject({ routeModel: 'new-model', observedAt: observation.observedAt, phase: 'completed' });
  });

  it('does not revive rejected branches or pagination through the generic JSON fallback', () => {
    const old = { id: 'old', author: { role: 'assistant' }, metadata: { model_slug: 'old-model' } };
    expect(parseResponseText(JSON.stringify({ current_node: 'missing', messages: [old] }))).toEqual([]);
    expect(parseResponseText(JSON.stringify({ current_node: 'missing', mapping: { old: { message: old } } }))).toEqual([]);
    expect(parseResponseText(JSON.stringify({ current_node: 'current', mapping: {
      old: { message: old }, current: { message: { author: { role: 'assistant' }, metadata: {} } }
    } }))).toEqual([]);
    expect(parseResponseText(JSON.stringify({ current_node: 'old', messages: [old] }))[0]?.responseModelSlug).toBe('old-model');
  });

  it('redacts embedded identifiers from legacy capture IDs and tolerates malformed URLs', () => {
    const exported = sanitizeTurn(createTurn({ ...observation, captureId: `uuid:${observation.requestId}` }));
    expect(JSON.stringify(exported)).not.toContain(observation.requestId);
    expect(classifyEndpoint('/backend-api/conversation/%broken')).toEqual({ kind: 'other', conversationId: null });
    expect(classifyEndpoint('/backend-api/conversation/valid').conversationId).toBe('valid');
  });

  it('serializes clear with observations and preserves unrelated storage', async () => {
    let listener: (request: RuntimeRequest, sender: object, reply: (value: RuntimeResponse) => void) => void;
    const disk: Record<string, unknown> = { unrelated: 'keep' };
    vi.stubGlobal('__ROUTE_INSPECTOR_ALLOWED_ORIGINS__', ['https://chatgpt.com']);
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'en' },
      storage: { local: {
        get: vi.fn(async () => structuredClone(disk)),
        set: vi.fn(async (next: object) => { await new Promise((resolve) => setTimeout(resolve, 5)); Object.assign(disk, structuredClone(next)); }),
        clear: vi.fn(async () => { for (const key of Object.keys(disk)) delete disk[key]; })
      } },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
      tabs: { query: vi.fn(async () => []), sendMessage: vi.fn() },
      runtime: {
        onInstalled: { addListener: vi.fn() }, sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn((handler) => { listener = handler; }) }
      }
    });
    await import('../../src/background/service-worker');
    const send = (request: RuntimeRequest) => new Promise<RuntimeResponse>((resolve) => listener(request, {}, resolve));
    const beforeClear = send({ type: 'route:observation', observation });
    const clear = send({ type: 'route:clear' });
    await Promise.all([beforeClear, clear]);
    expect((await send({ type: 'route:get-state' })).state?.turns).toEqual([]);
    expect(disk.unrelated).toBe('keep');
  });

  it('does not count a new request as a successful parse', async () => {
    const disk: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'en' }, storage: { local: {
      get: vi.fn(async () => structuredClone(disk)), set: vi.fn(async (next) => { Object.assign(disk, structuredClone(next)); })
    } } });
    const { storeObservation } = await import('../../src/background/storage');
    await storeObservation({ ...observation, phase: 'failed' });
    const next = await storeObservation({ ...observation, captureId: 'next', requestId: 'next', phase: 'requested' });
    expect(next.parserHealth.consecutiveFailures).toBe(1);
    expect(next.parserHealth.lastSuccessAt).toBeNull();
  });

  it('loads once, persists revisions across restarts, and rejects pre-clear captures arriving later', async () => {
    const disk: Record<string, unknown> = {};
    const get = vi.fn(async () => structuredClone(disk));
    const set = vi.fn(async (next) => { Object.assign(disk, structuredClone(next)); });
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'en' }, storage: { local: { get, set } } });
    let storage = await import('../../src/background/storage');
    const before = await storage.storeObservation(observation);
    const cleared = await storage.clearState();
    const late = await storage.storeObservation({ ...observation, observedAt: new Date().toISOString() });
    expect(late.turns).toEqual([]);
    expect(late.revision).toBe(cleared.revision);
    expect(cleared.revision).toBe((before.revision ?? 0) + 1);
    expect(get).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledTimes(2);
    vi.resetModules();
    storage = await import('../../src/background/storage');
    expect((await storage.readState()).revision).toBe(cleared.revision);
    const future = new Date(Date.now() + 1000).toISOString();
    const fresh = await storage.storeObservation({ ...observation, startedAt: future, observedAt: future });
    expect(fresh.turns).toHaveLength(1);
    expect(fresh.revision).toBe((cleared.revision ?? 0) + 1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached state unchanged if persistence fails, then recovers the mutation queue', async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error('disk failed')).mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'en' }, storage: { local: { get: vi.fn(async () => ({})), set } } });
    const storage = await import('../../src/background/storage');
    await expect(storage.storeObservation(observation)).rejects.toThrow('disk failed');
    expect((await storage.readState()).turns).toEqual([]);
    const success = await storage.storeObservation(observation);
    expect(success.turns).toHaveLength(1);
    expect(success.revision).toBe(1);
  });
});
