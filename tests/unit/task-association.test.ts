import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseConversationRecord, parseResponseValue, parseSseResponse } from '../../src/core/response-parser';
import { TaskCaptures as ResearchCaptures } from '../../src/core/task-captures';
import { createTurn, upsertTurn } from '../../src/core/turns';
import type { RouteObservation } from '../../src/core/types';

const base: RouteObservation = { captureId: 'a', captureContextId: 'visit', captureMode: 'live', source: 'page_fetch',
  phase: 'completed', conversationId: 'conversation', requestedModel: 'chat-model', resolvedModelSlug: 'chat-model',
  startedAt: '2026-09-28T07:00:00Z', observedAt: '2026-09-28T07:00:01Z' };
const identity = (messageId = 'input', workingTurnId: string | null = null) =>
  ({ messageId, parentId: null, workingTurnId, exchangeId: null });
const message = (id: string, parent: string, turn = 'turn', role = 'tool') => ({ id, author: { role, name: 'dynamic.tool' },
  metadata: { parent_id: parent, working_turn_id: turn, turn_exchange_id: turn, image_gen_title: 'PRIVATE_TITLE' },
  content: { content_type: 'multimodal_text', parts: ['PRIVATE_IMAGE'] } });
const frame = (messages: unknown[], conversation = 'conversation') => JSON.stringify({ type: 'conversation-update',
  payload: { conversation_id: conversation, update_type: 'add-messages', update_content: { messages } } });
const reload = (turn = 'turn') => ({ current_node: 'recap', messages: [
  { id: 'input', author: { role: 'user' }, metadata: { working_turn_id: turn } },
  message('image', 'input'),
  { id: 'recap', author: { role: 'assistant' }, content: { content_type: 'reasoning_recap' },
    metadata: { parent_id: 'missing-parent', working_turn_id: turn, turn_exchange_id: turn, resolved_model_slug: 'recap-model' } }
] });

describe('real image task association', () => {
  it('accepts model-only updates for a known task but not an ordinary capture or a later ordinary round', () => {
    const planner = { id: 'planner', author: { role: 'assistant' }, metadata: { parent_id: 'input', model_slug: 'planner-model', working_turn_id: 'research-turn' } };
    const initial: RouteObservation = { ...base, resolvedModelSlug: null, taskKind: 'deep_research' };
    const tracker = new ResearchCaptures();
    tracker.observe(initial, 'visit', 1000, identity());
    const updates = tracker.consume(frame([planner]), 'visit', 2000);
    expect(updates).toMatchObject([{ taskKind: 'deep_research', responseModelSlug: 'planner-model' }]);
    expect(upsertTurn([createTurn(initial)], updates[0]!)[0]).toMatchObject({ routeModel: 'planner-model', researchReportModel: null });
    expect(tracker.consume(frame([
      { id: 'follow-up', author: { role: 'user' }, metadata: { parent_id: 'planner', working_turn_id: 'new-turn' } },
      { id: 'answer', author: { role: 'assistant' }, metadata: { parent_id: 'follow-up', working_turn_id: 'new-turn', model_slug: 'normal-model' } }
    ]), 'visit', 3000)).toEqual([]);
    const ordinary = new ResearchCaptures();
    ordinary.observe({ ...base, resolvedModelSlug: null }, 'visit', 1000, identity());
    expect(ordinary.consume(frame([planner]), 'visit', 2000)).toEqual([]);
  });

  it.each([false, true])('merges complementary task fields across a batch without clearing the emitted model (reverse: %s)', reverse => {
    const tracker = new ResearchCaptures();
    const initial: RouteObservation = { ...base, resolvedModelSlug: null, taskKind: 'deep_research' };
    tracker.observe(initial, 'visit', 1000, identity());
    const messages = [
      { id: 'planner', author: { role: 'assistant' }, metadata: { parent_id: 'input', resolved_model_slug: 'planner-model', system_hints: ['plugin:connector_openai_deep_research'] } },
      { id: 'tool', author: { role: 'tool' }, metadata: { parent_id: 'planner', chatgpt_sdk: { resource_name: 'Deep Research App_start', widget_session_id: 'widget' } } }
    ];
    const updates = tracker.consume(frame(reverse ? messages.reverse() : messages), 'visit', 2000);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ conversationId: 'conversation', resolvedModelSlug: 'planner-model', researchMessageId: 'tool', researchWidgetId: 'widget' });
    expect(upsertTurn([createTurn(initial)], updates[0]!)[0]).toMatchObject({ routeModel: 'planner-model', researchWidgetId: 'widget' });
    expect(tracker.consume(frame([messages.find(message => message.id === 'tool')!]), 'visit', 3000)).toEqual([]);
  });

  it('replays the sanitized real capture through reload and the shared asynchronous intake', () => {
    const sample = JSON.parse(readFileSync(new URL('../fixtures/image-task-redacted.json', import.meta.url), 'utf8'));
    const user = sample.reload.messages.find((m: { author: { role: string } }) => m.author.role === 'user');
    const tracker = new ResearchCaptures();
    const observation = { ...base, requestedModel: sample.requestedModel, conversationId: sample.reload.conversation_id };
    tracker.observe(observation, 'visit', 1000, identity(user.id));
    const [update] = tracker.consume(JSON.stringify(sample.live), 'visit', 2000);
    expect(update?.taskKind).toBe('image_generation');
    expect(upsertTurn([createTurn(observation)], update!)[0]).toMatchObject({ verdict: 'image_generation', routeModel: 'chat-model' });
    const [fields] = parseConversationRecord(sample.reload);
    expect(createTurn({ ...observation, ...fields, captureMode: 'reload', source: 'conversation_record' }))
      .toMatchObject({ verdict: 'image_generation', routeModel: 'gpt-5-4-auto-thinking' });
  });
  it('does not select one of two contradictory explicit route fields for an image task', () => {
    const tool = message('image', 'input');
    Object.assign(tool.metadata, { resolved_model_slug: 'image-execution-model' });
    const fields = parseResponseValue({ message: tool })[0]!;
    const turn = createTurn({ ...base, ...fields, serverModelSlug: 'chat-model' });
    expect(turn).toMatchObject({ verdict: 'image_generation', routeModel: null });
  });
  it('rejects ambiguous captures and contradicting turn identity', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(base, 'visit', 1000, identity('input', 'other-turn'));
    expect(tracker.consume(frame([message('image', 'input')]), 'visit', 2000)).toEqual([]);
    const ambiguous = new ResearchCaptures();
    ambiguous.observe(base, 'visit', 1000, identity());
    ambiguous.observe({ ...base, captureId: 'duplicate' }, 'visit', 1000, identity());
    expect(ambiguous.consume(frame([message('image', 'input')]), 'visit', 2000)).toEqual([]);
  });
  it.each(['resolved', 'label'] as const)('retains %s evidence from an asynchronous image result', (source) => {
    const tracker = new ResearchCaptures();
    const initial = { ...base, resolvedModelSlug: null };
    tracker.observe(initial, 'visit', 1000, identity());
    const tool = message('image', 'input', 'turn', source === 'label' ? 'assistant' : 'tool');
    Object.assign(tool.metadata, { tool_name: 'image_gen',
      ...(source === 'resolved' ? { resolved_model_slug: 'image-route' } : { model_slug: 'image-route' }) });
    const [update] = tracker.consume(frame([tool]), 'visit', 2000);
    expect(update).toBeDefined();
    const turn = upsertTurn([createTurn(initial)], update!)[0]!;
    expect(turn).toMatchObject({ verdict: 'image_generation', routeModel: 'image-route' });
    expect(turn.routeModelSources).toEqual([source === 'resolved' ? 'resolved_model_slug' : 'assistant.metadata.model_slug']);
  });
  it('handles child-first message batches but never attaches unanchored ordinary messages', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(base, 'visit', 1000, identity());
    const parent = { id: 'bridge', author: { role: 'assistant' }, metadata: { parent_id: 'input', working_turn_id: 'turn' } };
    expect(tracker.consume(frame([message('image', 'bridge'), parent]), 'visit', 2000)[0]?.taskKind).toBe('image_generation');
  });
  it('recognizes an explicit image title on a dynamically named tool, without storing the title/body', () => {
    const fields = parseResponseValue({ message: message('image', 'input') })[0]!;
    expect(fields.taskKind).toBe('image_generation');
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE_/);
  });
  it('preserves the explicit marker through SSE delta projection', () => {
    const fields = parseSseResponse('event: delta_encoding\ndata: "v1"\n\nevent: delta\ndata: ' +
      JSON.stringify({ p: '', o: 'add', v: { message: message('image', 'input') } }) + '\n\n');
    expect(fields.taskKind).toBe('image_generation');
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE_/);
  });
  it.each(['user', 'assistant'])('does not treat %s image/title data as a generated tool result', role => {
    expect(parseResponseValue({ message: message('m', 'input', 'turn', role) })[0]?.taskKind).toBeNull();
  });
  it('detects image tasks through same-turn siblings while retaining the existing response route', () => {
    const fields = parseConversationRecord(reload())[0]!;
    const turn = createTurn({ ...base, ...fields, captureMode: 'reload', source: 'conversation_record' });
    expect(turn).toMatchObject({ verdict: 'image_generation', routeModel: 'recap-model' });
    expect(turn.routeModelSources).toEqual(['resolved_model_slug']);
  });
  it('does not pull a previous round image into an ordinary latest round', () => {
    const fields = parseConversationRecord(reload('new-turn'))[0]!;
    expect(fields.taskKind).toBeNull();
    expect(fields.resolvedModelSlug).toBe('recap-model');
  });
  it('refuses contradictory exchange identity even when working-turn identity matches', () => {
    const data = reload();
    data.messages[1]!.metadata!.turn_exchange_id = 'other-exchange';
    expect(parseConversationRecord(data)[0]?.taskKind).toBeNull();
  });
  it('all ordinary captures can become image tasks after their HTTP stream ends', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(base, 'visit', 1000, identity());
    const updates = tracker.consume(frame([message('image', 'input')]), 'visit', 2000);
    expect(updates).toMatchObject([{ captureId: 'a', taskKind: 'image_generation' }]);
    const turn = upsertTurn([createTurn(base)], updates[0]!)[0]!;
    expect(turn).toMatchObject({ verdict: 'image_generation', routeModel: 'chat-model' });
    expect(JSON.stringify(updates)).not.toMatch(/PRIVATE_/);
    expect(tracker.consume(frame([message('image', 'input')]), 'visit', 3000)).toEqual([]);
  });
  it('learns turn identity only through an anchored message, then matches a sibling', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(base, 'visit', 1000, identity());
    expect(tracker.consume(frame([message('image', 'missing-parent')]), 'visit', 2000)).toEqual([]);
    tracker.consume(frame([{ id: 'input', author: { role: 'user' }, metadata: { working_turn_id: 'turn' } }]), 'visit', 2001);
    expect(tracker.consume(frame([message('image', 'missing-parent')]), 'visit', 2002)[0]?.taskKind).toBe('image_generation');
  });
  it.each(['other-conversation', 'other-visit', 'other-parent', 'clear', 'expired'])('rejects unbound async updates: %s', mode => {
    const tracker = new ResearchCaptures();
    tracker.observe(base, 'visit', 1000, identity());
    if (mode === 'clear') tracker.clear();
    const updates = tracker.consume(frame([message('image', mode === 'other-parent' ? 'unrelated' : 'input')],
      mode === 'other-conversation' ? 'elsewhere' : 'conversation'), mode === 'other-visit' ? 'elsewhere' : 'visit',
      mode === 'expired' ? 1000 + 121 * 60_000 : 2000);
    expect(updates).toEqual([]);
  });
  it('updates an older round without replacing the newer round in the overlay ordering', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(base, 'visit', 1000, identity());
    const second = { ...base, captureId: 'b', startedAt: '2026-09-28T07:01:00Z' };
    tracker.observe(second, 'visit', 2000, identity('second-input'));
    const [update] = tracker.consume(frame([message('image', 'input')]), 'visit', 3000);
    expect(update?.captureId).toBe('a');
    expect(upsertTurn([createTurn(second), createTurn(base)], update!)[0]?.captureId).toBe('b');
  });
  it('recognizes a late research task through the same intake and keeps its stages separate', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(base, 'visit', 1000, identity());
    const tool = { id: 'research', author: { role: 'tool' }, metadata: { parent_id: 'input', resolved_model_slug: 'planner',
      chatgpt_sdk: { resource_name: 'Deep Research App_start', widget_session_id: 'widget' } } };
    expect(tracker.consume(frame([tool]), 'visit', 2000)[0]).toMatchObject({ taskKind: 'deep_research', researchWidgetId: 'widget' });
  });
});
