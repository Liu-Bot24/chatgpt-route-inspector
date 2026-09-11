import { describe, expect, it } from 'vitest';
import { normalizeUsageQuota, parseUsageQuota, projectLimitsProgress } from '../../src/core/usage-quota';
import { parseResponseText, parseSseResponse } from '../../src/core/response-parser';
import { createTurn, mergeTurn } from '../../src/core/turns';
import { migrateStoredTurn } from '../../src/core/migration';
import { normalizeObservation } from '../../src/core/observation';
import { classifyEndpoint } from '../../src/core/endpoints';
import { DEFAULT_SETTINGS, EMPTY_QUOTA_FIELDS } from '../../src/core/types';
import { sanitizedExport } from '../../src/core/privacy';

const payload = { type: 'conversation_detail_metadata', limits_progress: [
  { feature_name: 'private-feature', remaining: 999, token: 'SECRET_QUOTA_TOKEN' },
  { feature_name: 'deep_research', remaining: 0, reset_after: '2026-10-11T12:37:00.123456+00:00', token: 'SECRET_QUOTA_TOKEN' },
  { feature_name: 'image_gen', remaining: 987, reset_after: '2026-09-12T20:37:00+08:00' }
] };
const base = { captureId: 'quota-turn', source: 'page_fetch' as const, captureMode: 'live' as const,
  phase: 'completed' as const, observedAt: '2026-09-11T13:00:00Z', requestedModel: 'gpt-test' };

describe('usage quota allowlist', () => {
  it('reads both requested features, including zero, and normalizes zoned reset times', () => {
    expect(parseUsageQuota(payload)).toEqual({ deepResearchRemaining: 0, deepResearchResetAt: '2026-10-11T12:37:00.123Z',
      imageGenRemaining: 987, imageGenResetAt: '2026-09-12T12:37:00.000Z', quotaObservedAt: null });
    expect(projectLimitsProgress(payload.limits_progress)[0]).toBeNull();
    expect(JSON.stringify(projectLimitsProgress(payload.limits_progress))).not.toContain('SECRET');
  });

  it('does not invent counts or dates from missing, malformed, negative or unzoned inputs', () => {
    expect(parseUsageQuota({})).toEqual(EMPTY_QUOTA_FIELDS);
    expect(parseUsageQuota({ limits_progress: [{ feature_name: 'other', remaining: 250 }] })).toEqual(EMPTY_QUOTA_FIELDS);
    expect(normalizeUsageQuota({ deepResearchRemaining: -1, imageGenRemaining: '1000',
      deepResearchResetAt: 3600, imageGenResetAt: '2026-09-12T20:37:00', quotaObservedAt: 'bad' })).toEqual(EMPTY_QUOTA_FIELDS);
    expect(normalizeUsageQuota({ deepResearchRemaining: Infinity, imageGenRemaining: 1.5,
      deepResearchResetAt: '2026-99-99T00:00:00Z' })).toEqual(EMPTY_QUOTA_FIELDS);
  });

  it('parses JSON and legacy SSE but ignores quota-shaped data in answer text', () => {
    expect(parseResponseText(JSON.stringify(payload))[0]?.imageGenRemaining).toBe(987);
    expect(parseSseResponse(`data: ${JSON.stringify(payload)}\n\n`).deepResearchRemaining).toBe(0);
    expect(parseResponseText(JSON.stringify({ content: payload }))[0]?.imageGenRemaining).toBeNull();
  });

  it('keeps delta array indices intact while discarding unrelated features and tokens', () => {
    const sse = 'event: delta_encoding\ndata: "v1"\n\n' +
      `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: payload })}\n\n` +
      'event: delta\ndata: {"p":"/limits_progress/2/remaining","o":"replace","v":986}\n\n';
    expect(parseSseResponse(sse)).toMatchObject({ deepResearchRemaining: 0, imageGenRemaining: 986 });
    expect(JSON.stringify(parseSseResponse(sse))).not.toContain('SECRET');
  });

  it('attaches root quota to a selected conversation record but never revives a rejected old page', () => {
    const record = { ...payload, current_node: 'answer', messages: [
      { id: 'answer', author: { role: 'assistant' }, metadata: { model_slug: 'gpt-test' } }
    ] };
    expect(parseResponseText(JSON.stringify(record))[0]?.imageGenRemaining).toBe(987);
    expect(parseResponseText(JSON.stringify({ ...record, current_node: 'missing' }))).toEqual([]);
  });

  it('round-trips snapshots through normalization, storage migration, merging and JSON export', () => {
    const observation = normalizeObservation({ ...base, ...parseUsageQuota(payload), quotaObservedAt: base.observedAt,
      token: 'SECRET_QUOTA_TOKEN' })!;
    const turn = createTurn(observation);
    expect(migrateStoredTurn(turn)).toMatchObject({ deepResearchRemaining: 0, imageGenRemaining: 987 });
    expect(mergeTurn(turn, { ...base, observedAt: '2026-09-11T12:00:00Z', imageGenRemaining: 1000 }).imageGenRemaining).toBe(987);
    const exported = sanitizedExport({ turns: [turn], powReadings: [], settings: DEFAULT_SETTINGS,
      parserHealth: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 } });
    expect(exported.turns[0]?.quotaObservedAt).toBe('2026-09-11T13:00:00.000Z');
    expect(JSON.stringify(exported)).not.toContain('SECRET');
    expect(migrateStoredTurn(base)).toMatchObject(EMPTY_QUOTA_FIELDS);
  });

  it('classifies only the observed init endpoint as quota metadata, not as a conversation ID', () => {
    expect(classifyEndpoint('/backend-api/conversation/init')).toEqual({ kind: 'conversation_init', conversationId: null });
    expect(classifyEndpoint('/backend-api/conversation/real-id').kind).toBe('conversation_record');
    expect(classifyEndpoint('/backend-api/conversation/init/unrelated').kind).toBe('other');
  });
});
