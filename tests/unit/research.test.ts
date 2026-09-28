import { describe, expect, it } from 'vitest';
import { parseResponseValue, parseConversationRecord, ResponseStreamParser } from '../../src/core/response-parser';
import { createTurn, mergeTurn } from '../../src/core/turns';
import { parseResearchUpdates, projectResearchWidgetState } from '../../src/core/research';
import { TaskCaptures as ResearchCaptures } from '../../src/core/task-captures';
import { normalizeObservation } from '../../src/core/observation';
import { sanitizeTurn } from '../../src/core/privacy';
import type { RouteObservation } from '../../src/core/types';

const base: RouteObservation = {
  captureId: 'capture', captureContextId: 'context', captureMode: 'live', source: 'page_fetch',
  phase: 'completed', observedAt: '2026-09-28T06:00:00Z', startedAt: '2026-09-28T05:59:00Z',
  conversationId: 'conversation', requestedModel: 'gpt-6-pro'
};
const report = { author: { role: 'assistant' }, metadata: { resolved_model_slug: 'gpt-5-thinking' }, content: { parts: ['PRIVATE_REPORT'] } };
const widgetMetadata = {
  resolved_model_slug: 'gpt-5-6-instant', model_slug: 'gpt-5-6-instant',
  chatgpt_sdk: { resource_name: 'Deep Research App_start', widget_session_id: 'widget', widget_state: JSON.stringify({ status: 'completed', report_message: report }) }
};
const frame = (messageId = 'tool', conversationId = 'conversation') => JSON.stringify({
  type: 'conversation-update', payload: { conversation_id: conversationId, update_type: 'update-widget-state',
    update_content: { updates: [{ message_id: messageId, widget_state: { status: 'completed', report_message: report } }] } }
});
const research: RouteObservation = { ...base, taskKind: 'deep_research', researchWidgetId: 'widget', researchMessageId: 'tool' };

describe('Deep Research stages', () => {
  it('identifies a hint-only planner as research without making it the report owner', () => {
    const metadata = { system_hints: ['plugin:connector_openai_deep_research'], resolved_model_slug: 'planner-model' };
    const fields = parseResponseValue({ message: { id: 'planner', author: { role: 'assistant' }, metadata } })[0]!;
    expect(fields).toMatchObject({ taskKind: 'deep_research', resolvedModelSlug: 'planner-model',
      researchMessageId: null, researchWidgetId: null, researchReportModel: null });
    const tracker = new ResearchCaptures();
    tracker.observe({ ...base, ...fields, conversationId: base.conversationId ?? null }, 'context', 1000);
    expect(tracker.consume(frame('planner'), 'context', 1001)).toEqual([]);
  });

  it.each([
    { invoked_resource: { app_name: 'Deep Research App' } },
    { system_hints: ['plugin:connector_openai_deep_research'], chatgpt_sdk: { widget_session_id: 'widget' } }
  ])('retains explicit research resource/widget ownership without relying on a hint alone: %j', metadata => {
    const fields = parseResponseValue({ message: { id: 'tool', author: { role: 'tool' }, metadata } })[0]!;
    expect(fields).toMatchObject({ taskKind: 'deep_research', researchMessageId: 'tool' });
    const tracker = new ResearchCaptures();
    tracker.observe({ ...base, ...fields, conversationId: base.conversationId ?? null }, 'context', 1000);
    expect(tracker.consume(frame('tool'), 'context', 1001)[0]?.researchReportModel).toBe('gpt-5-thinking');
  });

  it('retains an available research message ID independently of a missing widget ID', () => {
    const metadata = { chatgpt_sdk: { resource_name: 'Deep Research App_start' } };
    const fields = parseResponseValue({ message: { id: 'tool', author: { role: 'tool' }, metadata } })[0]!;
    expect(fields).toMatchObject({ taskKind: 'deep_research', researchMessageId: 'tool', researchWidgetId: null });
    const tracker = new ResearchCaptures();
    tracker.observe({ ...base, ...fields, conversationId: base.conversationId ?? null }, 'context', 1000);
    expect(tracker.consume(frame('other-tool'), 'context', 1001)).toEqual([]);
    expect(tracker.consume(frame('tool'), 'context', 1002)[0]?.researchReportModel).toBe('gpt-5-thinking');
  });
  it.each([
    [{ server_ste_metadata: { model_slug: 'report-model' } }, 'report-model'],
    [{ model_slug: 'report-model' }, 'report-model'],
    [{ resolved_model_slug: 'report-a', server_ste_metadata: { model_slug: 'report-b' } }, null],
    [{ resolved_model_slug: 'report-a', model_slug: 'report-b' }, null],
    [{}, null]
  ])('uses report-local evidence and fallback without borrowing the planner: %j', (metadata, expected) => {
    const state = { report_message: { ...report, metadata } };
    const sdk = { ...widgetMetadata.chatgpt_sdk, widget_state: state };
    const input = { message: { id: 'tool', author: { role: 'tool' }, metadata: { ...widgetMetadata, chatgpt_sdk: sdk } } };
    const [fields] = parseResponseValue(input);
    expect(fields).toMatchObject({ resolvedModelSlug: 'gpt-5-6-instant', researchReportModel: expected });
    const parser = new ResponseStreamParser();
    parser.push('event: delta_encoding\ndata: "v1"\n\n');
    parser.push(`event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: input })}\n\n`);
    expect(parser.finish().researchReportModel).toBe(expected);
    const envelope = JSON.parse(frame());
    envelope.payload.update_content.updates[0].widget_state = state;
    expect(parseResearchUpdates(JSON.stringify(envelope))[0]?.reportModel).toBe(expected);
    const projected = projectResearchWidgetState(state);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_REPORT');
    if (!('resolved_model_slug' in metadata)) {
      expect(projected).toMatchObject({ report_message: { metadata: { resolved_model_slug: null } } });
    }
  });
  it('preserves task/widget metadata in delta encoding without retaining report text', () => {
    const parser = new ResponseStreamParser();
    parser.push('event: delta_encoding\ndata: "v1"\n\n');
    parser.push(`event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { message: {
      id: 'tool', author: { role: 'tool' }, metadata: widgetMetadata
    } } })}\n\n`);
    expect(parser.finish()).toMatchObject({ taskKind: 'deep_research', researchReportModel: 'gpt-5-thinking', researchMessageId: 'tool' });
    expect(JSON.stringify(parser, (_k, v) => v instanceof Map ? [...v] : v)).not.toContain('PRIVATE_REPORT');
  });
  it.each([true, false])('handles task/model arrival order (task first: %s)', (taskFirst) => {
    const task = { ...base, taskKind: 'deep_research' as const };
    const model = { ...base, resolvedModelSlug: 'gpt-5-6-instant', responseModelSlug: 'gpt-5-6-instant' };
    const first = createTurn(taskFirst ? task : model);
    const identified = mergeTurn(first, { ...(taskFirst ? model : task), observedAt: '2026-09-28T06:00:01Z' });
    expect(identified).toMatchObject({ verdict: 'deep_research', routeModel: 'gpt-5-6-instant', researchReportModel: null });
    const completed = mergeTurn(identified, { ...research, researchReportModel: 'gpt-5-thinking', observedAt: '2026-09-28T06:10:00Z' });
    expect(completed).toMatchObject({ verdict: 'deep_research', routeModel: 'gpt-5-6-instant', researchReportModel: 'gpt-5-thinking' });
    expect(completed.routeModelSources).not.toContain('report_message.metadata.resolved_model_slug');
  });

  it.each([true, false])('extracts the report separately from string/object widget state: %s', (stringState) => {
    const metadata = { ...widgetMetadata, chatgpt_sdk: { ...widgetMetadata.chatgpt_sdk,
      widget_state: stringState ? widgetMetadata.chatgpt_sdk.widget_state : JSON.parse(widgetMetadata.chatgpt_sdk.widget_state) } };
    const [fields] = parseResponseValue({ message: { id: 'tool', author: { role: 'tool' }, metadata } });
    expect(fields).toMatchObject({ taskKind: 'deep_research', resolvedModelSlug: 'gpt-5-6-instant',
      researchReportModel: 'gpt-5-thinking', researchWidgetId: 'widget', researchMessageId: 'tool' });
    expect(JSON.stringify(fields)).not.toContain('PRIVATE_REPORT');
  });

  it('restores both stages on reload using actual metadata.parent_id ancestry', () => {
    const [fields] = parseConversationRecord({ current_node: 'final', messages: [
      { id: 'user', author: { role: 'user' }, metadata: {} },
      { id: 'tool', author: { role: 'tool' }, metadata: { ...widgetMetadata, parent_id: 'user' } },
      { id: 'final', author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5-6-instant', parent_id: 'tool' } }
    ] });
    expect(createTurn({ ...base, ...fields, captureMode: 'reload', source: 'conversation_record' })).toMatchObject({
      verdict: 'deep_research', routeModel: 'gpt-5-6-instant', researchReportModel: 'gpt-5-thinking'
    });
  });

  it('does not interpret a random embedded report or malformed widget JSON as a task/report', () => {
    expect(parseResponseValue({ report_message: report })[0]?.resolvedModelSlug).toBeNull();
    expect(parseResponseValue({ message: { metadata: { chatgpt_sdk: { widget_state: widgetMetadata.chatgpt_sdk.widget_state } } } })[0]?.researchReportModel).toBeNull();
    const [fields] = parseResponseValue({ message: { metadata: { ...widgetMetadata,
      chatgpt_sdk: { ...widgetMetadata.chatgpt_sdk, widget_state: '{partial' } } } });
    expect(fields?.researchReportModel).toBeNull();
    expect(fields?.taskKind).toBe('deep_research');
  });

  it('reads report metadata only from the widget update envelope', () => {
    expect(parseResearchUpdates(frame())).toMatchObject([{ conversationId: 'conversation', correlationIds: ['tool'], reportModel: 'gpt-5-thinking' }]);
    expect(parseResearchUpdates(JSON.stringify({ content: JSON.parse(frame()) }))).toEqual([]);
    expect(parseResearchUpdates('{broken')).toEqual([]);
    expect(JSON.stringify(parseResearchUpdates(frame()))).not.toContain('PRIVATE_REPORT');
  });

  it('only attaches matching research reports; ordinary requests, other tasks and visits stay untouched', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(base, 'context', 1000);
    expect(tracker.consume(frame(), 'context', 1001)).toEqual([]);
    tracker.observe(research, 'context', 1002);
    expect(tracker.consume(frame(), 'context', 1003)).toHaveLength(1);
    expect(tracker.consume(frame(), 'context', 1004)).toEqual([]);
    const clean = new ResearchCaptures();
    clean.observe(research, 'context', 1000);
    expect(clean.consume(frame('other-tool'), 'context', 1001)).toEqual([]);
    expect(clean.consume(frame('tool', 'other-conversation'), 'context', 1001)).toEqual([]);
    expect(clean.consume(frame(), 'other-visit', 1001)).toEqual([]);
    const result = clean.consume(frame(), 'context', 1002);
    expect(result).toMatchObject([{ captureId: 'capture', researchReportModel: 'gpt-5-thinking' }]);
    expect(result[0]?.resolvedModelSlug).toBeUndefined();
  });

  it('does not attach a report based on conversation ID alone', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(research, 'context', 1000);
    const unbound = JSON.parse(frame());
    delete unbound.payload.update_content.updates[0].message_id;
    expect(tracker.consume(JSON.stringify(unbound), 'context', 1001)).toEqual([]);
  });

  it('keeps simultaneous research tasks separate, refuses duplicate ambiguous captures', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(research, 'context', 1000);
    tracker.observe({ ...research, captureId: 'second', researchWidgetId: 'w2', researchMessageId: 'tool2' }, 'context', 1000);
    expect(tracker.consume(frame('tool2'), 'context', 1001)[0]?.captureId).toBe('second');
    tracker.observe({ ...research, captureId: 'duplicate' }, 'context', 1002);
    expect(tracker.consume(frame(), 'context', 1003)).toEqual([]);
  });

  it('retains association beyond short Chat streams, but honors timeout and clear', () => {
    const tracker = new ResearchCaptures();
    tracker.observe(research, 'context', 1000);
    expect(tracker.consume(frame(), 'context', 1000 + 20 * 60_000)).toHaveLength(1);
    tracker.clear();
    expect(tracker.consume(frame(), 'context', 1000 + 21 * 60_000)).toEqual([]);
    const expired = new ResearchCaptures();
    expired.observe(research, 'context', 1000);
    expect(expired.consume(frame(), 'context', 1000 + 121 * 60_000)).toEqual([]);
  });

  it('drops unknown raw fields and redacts research identifiers in exports', () => {
    const normalized = normalizeObservation({ ...research, researchReportModel: 'gpt-5-thinking', content: 'PRIVATE_REPORT' });
    expect(JSON.stringify(normalized)).not.toContain('PRIVATE_REPORT');
    const exported = sanitizeTurn(createTurn(normalized!));
    expect(exported.researchWidgetId).toBe('[redacted:widget]');
    expect(exported.researchMessageId).toBe('[redacted:tool]');
    expect(exported.researchReportModel).toBe('gpt-5-thinking');
  });
});
