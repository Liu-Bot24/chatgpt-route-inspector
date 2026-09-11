import { describe, expect, it } from 'vitest';
import { migrateStoredTurn } from '../../src/core/migration';
import { ROUTE_SCHEMA_VERSION } from '../../src/core/types';

const legacyBase = {
  schema: 'chatgpt-route-observation',
  schemaVersion: '1.0.0',
  captureId: 'legacy-1',
  phase: 'completed',
  tabId: 7,
  pageUrl: 'https://chatgpt.com/c/example',
  networkRequestId: null,
  observedAt: '2026-08-10T01:00:00.000Z',
  startedAt: '2026-08-10T01:00:00.000Z',
  completedAt: '2026-08-10T01:00:03.000Z',
  requestedModel: 'gpt-5-6-pro',
  resolvedModelSlug: 'gpt-5-5-mini',
  effectiveModel: 'gpt-5-5-mini',
  confidence: 0.88,
  confidenceLabel: 'high'
};

describe('stored turn migration', () => {
  it('reassesses an old auto-thinking conflict without changing its raw evidence', () => {
    const turn = migrateStoredTurn({
      ...legacyBase, sources: ['page_fetch'], schemaVersion: '1.5.0', verdict: 'conflict',
      requestedModel: 'gpt-5-6', responseModelSlug: 'gpt-5-6-thinking',
      resolvedModelSlug: 'gpt-5-6-auto-thinking', serverModelSlug: 'gpt-5-6-auto-thinking'
    });
    expect(turn).toMatchObject({
      schemaVersion: ROUTE_SCHEMA_VERSION, verdict: 'auto_reasoning', routeModel: 'gpt-5-6-auto-thinking',
      requestedModel: 'gpt-5-6', responseModelSlug: 'gpt-5-6-thinking',
      resolvedModelSlug: 'gpt-5-6-auto-thinking', serverModelSlug: 'gpt-5-6-auto-thinking'
    });
  });
  it('migrates an old stream turn to deterministic live-mode fields', () => {
    const turn = migrateStoredTurn({ ...legacyBase, sources: ['page_fetch'] });
    expect(turn).toMatchObject({
      schemaVersion: ROUTE_SCHEMA_VERSION,
      captureMode: 'live',
      routeModel: 'gpt-5-5-mini',
      routeModelSources: ['resolved_model_slug'],
      verdict: 'mismatch'
    });
    expect(turn).not.toHaveProperty('confidence');
    expect(turn).not.toHaveProperty('effectiveModel');
  });

  it('infers reload mode for a legacy conversation-record observation', () => {
    const turn = migrateStoredTurn({
      ...legacyBase,
      requestedModel: null,
      sources: ['conversation_record'],
      responseModelSlug: 'gpt-5-5-mini'
    });
    expect(turn).toMatchObject({ captureMode: 'reload', routeModel: 'gpt-5-5-mini', modelLabel: 'gpt-5-5-mini', verdict: 'unknown' });
  });

  it('infers reload mode for a stored assistant DOM observation', () => {
    const turn = migrateStoredTurn({
      ...legacyBase,
      requestedModel: null,
      resolvedModelSlug: null,
      sources: ['assistant_dom'],
      domModelSlug: 'gpt-5-6-pro'
    });
    expect(turn).toMatchObject({ captureMode: 'reload', routeModel: 'gpt-5-6-pro', modelLabel: 'gpt-5-6-pro', verdict: 'unknown' });
  });

  it('infers reload mode from a plural conversation record URL', () => {
    const turn = migrateStoredTurn({
      ...legacyBase,
      captureMode: undefined,
      requestedModel: null,
      sources: [],
      pageUrl: 'https://chatgpt.com/backend-api/conversations/private-id',
      responseModelSlug: 'gpt-5-6-pro'
    });
    expect(turn).toMatchObject({ captureMode: 'reload', routeModel: null, verdict: 'conflict' });
  });

  it('keeps WebSocket-enriched live sources during migration', () => {
    const turn = migrateStoredTurn({
      ...legacyBase,
      sources: ['page_fetch', 'page_websocket']
    });
    expect(turn).toMatchObject({
      captureMode: 'live',
      sources: ['page_fetch', 'page_websocket'],
      schemaVersion: ROUTE_SCHEMA_VERSION
    });
  });

  it('rejects malformed stored values', () => {
    expect(migrateStoredTurn(null)).toBeNull();
    expect(migrateStoredTurn({ captureId: 'missing-date', sources: ['page_fetch'] })).toBeNull();
    expect(migrateStoredTurn({ ...legacyBase, sources: ['retired_adapter'] })).toBeNull();
  });
});
