import { describe, expect, it } from 'vitest';
import { createTurn, mergeTurn, upsertTurn } from '../../src/core/turns';

const request = {
  captureId: 'capture-1', source: 'page_fetch' as const, captureMode: 'live' as const,
  phase: 'requested' as const, observedAt: '2026-08-11T01:00:00.000Z',
  startedAt: '2026-08-11T01:00:00.000Z', requestedModel: 'gpt-5-6-pro',
  conversationId: 'conv-1'
};

describe('route turn correlation', () => {
  it('keeps an auto request as auto reasoning after a free-account mini response completes', () => {
    const autoRequest = createTurn({ ...request, requestedModel: 'auto' });
    expect(autoRequest.verdict).toBe('unknown');
    const response = mergeTurn(autoRequest, {
      captureId: request.captureId, source: 'page_fetch', captureMode: 'live', phase: 'completed',
      observedAt: '2026-08-11T01:00:02.000Z', serverModelSlug: 'gpt-5-6-t-mini',
      responseModelSlug: 'gpt-5-6-t-mini'
    });
    expect(response).toMatchObject({ requestedModel: 'auto', routeModel: 'gpt-5-6-t-mini',
      verdict: 'auto_reasoning', routeModelSources: ['server_ste_metadata.model_slug'] });
  });

  it('marks completed -wm Work responses as unverifiable in live and reload without changing route fields', () => {
    const live = createTurn({ ...request, phase: 'completed', requestedModel: 'gpt-6-astra-wm',
      serverModelSlug: 'gpt-6-astra-wm' });
    expect(live).toMatchObject({ verdict: 'work_unverifiable', routeModel: 'gpt-6-astra-wm' });
    const reload = createTurn({ ...request, source: 'conversation_record', captureMode: 'reload',
      phase: 'completed', requestedModel: null, responseModelSlug: 'GPT-6-ASTRA-WM' });
    expect(reload).toMatchObject({ verdict: 'work_unverifiable', routeModel: 'gpt-6-astra-wm',
      routeModelSources: ['assistant.metadata.model_slug'] });
    expect(createTurn({ ...request, source: 'conversation_record', captureMode: 'reload',
      phase: 'completed', requestedModel: null, responseModelSlug: 'gpt-6-astra-wm-preview',
      resolvedModelSlug: 'gpt-6-astra-wm-preview' }).verdict).toBe('unknown');
    expect(createTurn({ ...request, phase: 'responding', requestedModel: 'gpt-6-astra-wm',
      serverModelSlug: 'gpt-6-astra-wm' }).verdict).toBe('normal');
  });

  it('marks completed live and reload network responses without resolved_model_slug as suspected', () => {
    const evidence = { ...request, phase: 'completed' as const, serverModelSlug: 'gpt-5-6-pro' };
    expect(createTurn(evidence).verdict).toBe('suspected_downgrade');
    expect(createTurn({ ...evidence, phase: 'responding' }).verdict).toBe('normal');
    expect(createTurn({ ...evidence, phase: 'failed' }).verdict).toBe('normal');
    expect(createTurn({ ...evidence, resolvedModelSlug: 'gpt-5-6-pro' }).verdict).toBe('normal');
    expect(createTurn({ ...evidence, source: 'conversation_record', captureMode: 'reload' }).verdict).toBe('suspected_downgrade');
    expect(createTurn({ ...evidence, source: 'conversation_record', captureMode: 'reload', requestedModel: null }).verdict).toBe('suspected_downgrade');
    expect(createTurn({ ...evidence, source: 'conversation_record', captureMode: 'reload', requestedModel: null, resolvedModelSlug: 'gpt-5-6-pro' }).verdict).toBe('unknown');
    expect(createTurn({ ...evidence, source: 'conversation_record', captureMode: 'reload', requestedModel: null, serverModelSlug: null, responseModelSlug: 'gpt-5-6-pro' }).verdict).toBe('suspected_downgrade');
    expect(createTurn({ ...evidence, source: 'conversation_record', captureMode: 'reload', requestedModel: null, serverModelSlug: null }).verdict).toBe('unknown');
    expect(createTurn({ ...evidence, source: 'assistant_dom' }).verdict).toBe('normal');
    expect(createTurn({ ...evidence, requestedModel: null }).verdict).toBe('suspected_downgrade');
    expect(createTurn({ ...request, phase: 'completed' }).verdict).toBe('unknown');
  });

  it('preserves stronger route verdicts and corrects the suspicion if later evidence arrives', () => {
    const evidence = { ...request, phase: 'completed' as const, serverModelSlug: 'gpt-5-6-pro' };
    expect(createTurn({ ...evidence, serverModelSlug: 'gpt-5-5-mini' }).verdict).toBe('mismatch');
    expect(createTurn({ ...evidence, responseModelSlug: 'gpt-5-5-mini' }).verdict).toBe('conflict');
    expect(createTurn({ ...evidence, serverModelSlug: 'gpt-5-6-auto-thinking' }).verdict).toBe('auto_reasoning');
    const suspected = createTurn(evidence);
    expect(mergeTurn(suspected, {
      captureId: request.captureId, source: 'page_websocket', captureMode: 'live', phase: 'completed',
      observedAt: '2026-08-11T01:00:02.000Z', resolvedModelSlug: 'gpt-5-6-pro'
    }).verdict).toBe('normal');
  });

  it('creates a pending unknown turn and calculates duration when completed', () => {
    const initial = createTurn(request);
    expect(initial).toMatchObject({ verdict: 'unknown', phase: 'requested', durationMs: null, captureMode: 'live' });
    const completed = mergeTurn(initial, {
      captureId: 'capture-1', source: 'page_fetch', captureMode: 'live', phase: 'completed',
      observedAt: '2026-08-11T01:00:02.500Z', completedAt: '2026-08-11T01:00:02.500Z',
      resolvedModelSlug: 'gpt-5-5-mini', serverModelSlug: 'gpt-5-5-mini', requestId: 'req-1'
    });
    expect(completed).toMatchObject({
      verdict: 'mismatch', routeModel: 'gpt-5-5-mini', durationMs: 2500, requestId: 'req-1'
    });
  });

  it('keeps live and reload observations separate even when request ids match', () => {
    let turns = upsertTurn([], {
      ...request, captureId: 'stream', requestId: 'req-shared', phase: 'completed',
      completedAt: '2026-08-11T01:00:01.000Z', resolvedModelSlug: 'gpt-5-5-mini'
    });
    turns = upsertTurn(turns, {
      captureId: 'record', source: 'conversation_record', captureMode: 'reload', phase: 'completed',
      observedAt: '2026-08-11T01:00:03.000Z', requestId: 'req-shared', responseModelSlug: 'gpt-5-5-mini'
    });
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.captureMode).sort()).toEqual(['live', 'reload']);
  });

  it('still correlates two live observations by request id', () => {
    const turns = upsertTurn([createTurn({ ...request, requestId: 'req-shared' })], {
      captureId: 'second-live', source: 'page_fetch', captureMode: 'live', phase: 'completed',
      observedAt: '2026-08-11T01:00:01.000Z', requestId: 'req-shared', conversationId: 'conv-1',
      resolvedModelSlug: 'gpt-5-6-pro'
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sources).toEqual(['page_fetch']);
  });

  it('does not merge a shared request id across conversations', () => {
    const turns = upsertTurn([createTurn({ ...request, requestId: 'req-shared' })], {
      captureId: 'other-conversation', source: 'page_fetch', captureMode: 'live', phase: 'completed',
      observedAt: '2026-08-11T01:00:01.000Z', requestId: 'req-shared', conversationId: 'conv-2',
      resolvedModelSlug: 'gpt-5-6-pro'
    });
    expect(turns).toHaveLength(2);
  });

  it('merges WebSocket fields by capture id without regressing a completed phase', () => {
    const completed = createTurn({
      ...request, phase: 'completed', completedAt: '2026-08-11T01:00:01.000Z'
    });
    const merged = mergeTurn(completed, {
      captureId: request.captureId, source: 'page_websocket', captureMode: 'live', phase: 'responding',
      observedAt: '2026-08-11T01:00:02.000Z', resolvedModelSlug: 'gpt-5-5-mini'
    });
    expect(merged).toMatchObject({
      phase: 'completed', routeModel: 'gpt-5-5-mini', verdict: 'mismatch',
      sources: ['page_fetch', 'page_websocket']
    });
  });

  it('keeps unrelated captures separate and handles invalid durations', () => {
    const turns = upsertTurn([createTurn(request)], {
      captureId: 'capture-2', source: 'page_fetch', captureMode: 'live', phase: 'failed',
      observedAt: 'bad-date', completedAt: 'also-bad'
    });
    expect(turns).toHaveLength(2);
    expect(turns.find((turn) => turn.captureId === 'capture-2')?.durationMs).toBeNull();
  });
});
