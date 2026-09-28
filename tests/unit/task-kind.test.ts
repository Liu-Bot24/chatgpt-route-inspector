import { describe, expect, it } from 'vitest';
import { parseConversationRequest } from '../../src/core/request-parser';
import { parseConversationRecord, parseResponseValue, parseSseResponse } from '../../src/core/response-parser';
import { createTurn, mergeTurn } from '../../src/core/turns';
import { normalizeObservation } from '../../src/core/observation';
import { migrateStoredTurn } from '../../src/core/migration';
import { overlayVerdictCopy } from '../../src/ui/shared/overlay';
import { verdictLabel, verdictTone } from '../../src/ui/shared/client';
import { t } from '../../src/ui/shared/i18n';

const base = {
  captureId: 'task', captureMode: 'live' as const, source: 'page_fetch' as const,
  phase: 'completed' as const, observedAt: '2026-09-28T06:00:00Z'
};
const drMetadata = { system_hints: ['plugin:connector_openai_deep_research'] };

describe('special task classification', () => {
  it.each(['live', 'reload'] as const)('keeps server and answer-label fallback for image routes in %s', captureMode => {
    const fields = { ...base, captureMode, taskKind: 'image_generation' as const };
    expect(createTurn({ ...fields, serverModelSlug: 'server-route' })).toMatchObject({ routeModel: 'server-route', routeModelSources: ['server_ste_metadata.model_slug'] });
    expect(createTurn({ ...fields, responseModelSlug: 'gpt-5-4-auto-thinking' })).toMatchObject({ routeModel: 'gpt-5-4-auto-thinking', routeModelSources: ['assistant.metadata.model_slug'] });
    expect(createTurn(fields).routeModel).toBeNull();
  });
  it('identifies Deep Research from the request metadata, without interpreting prompt text', () => {
    const fields = parseConversationRequest(JSON.stringify({ model: 'gpt-6-pro', messages: [
      { author: { role: 'user' }, metadata: drMetadata, content: { parts: ['PRIVATE_PROMPT'] } }
    ] }));
    expect(fields).toMatchObject({ taskKind: 'deep_research', requestedModel: 'gpt-6-pro' });
    expect(JSON.stringify(fields)).not.toContain('PRIVATE_PROMPT');
  });

  it.each([
    drMetadata,
    { chatgpt_sdk: { resource_name: 'Deep Research App_start' } },
    { invoked_resource: { app_name: 'Deep Research App' } }
  ])('identifies the observed Deep Research response metadata %j', (metadata) => {
    const fields = parseSseResponse(`data: ${JSON.stringify({ message: {
      author: { role: 'assistant' }, metadata: { ...metadata, resolved_model_slug: 'gpt-5-6-instant' }
    } })}\n\n`);
    const turn = createTurn({ ...base, ...fields, requestedModel: 'gpt-6-pro' });
    expect(turn).toMatchObject({ verdict: 'deep_research', routeModel: 'gpt-5-6-instant' });
  });

  it.each([
    { author: { role: 'assistant' }, recipient: 'image_gen.text2im' },
    { author: { role: 'tool', name: 'image_gen' } },
    { author: { role: 'assistant' }, metadata: { tool_name: 'image_gen' } }
  ])('identifies explicit image generation signals %j', (message) => {
    const [fields] = parseResponseValue({ message });
    const turn = createTurn({ ...base, ...fields, serverModelSlug: 'image-route', requestedModel: 'gpt-6-pro' });
    expect(turn).toMatchObject({ taskKind: 'image_generation', verdict: 'image_generation', routeModel: 'image-route' });
  });

  it('recognizes image generation in delta streams, not merely legacy JSON events', () => {
    const fields = parseSseResponse('event: delta_encoding\ndata: "v1"\n\n' +
      `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'image_gen.text2im' } } })}\n\n`);
    expect(fields.taskKind).toBe('image_generation');
  });

  it('retains a tool-only image generation message after reload', () => {
    const [fields] = parseConversationRecord({ current_node: 'image', mapping: {
      user: { message: { id: 'u', author: { role: 'user' }, metadata: {} } },
      image: { parent: 'user', message: { id: 'i', author: { role: 'tool', name: 'image_gen' }, content: { parts: ['PRIVATE_IMAGE'] } } }
    } });
    expect(createTurn({ ...base, ...fields, captureMode: 'reload', source: 'conversation_record' }).verdict).toBe('image_generation');
    expect(JSON.stringify(fields)).not.toContain('PRIVATE_IMAGE');
  });

  it('recognizes reload research from its user ancestor, never a previous turn', () => {
    const messages = [
      { id: 'u', author: { role: 'user' }, metadata: drMetadata },
      { id: 'a', parent_id: 'u', author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5-6-instant' } },
      { id: 'u2', parent_id: 'a', author: { role: 'user' }, metadata: {} },
      { id: 'a2', parent_id: 'u2', author: { role: 'assistant' }, metadata: { model_slug: 'gpt-6-pro' } }
    ];
    const [research] = parseConversationRecord({ current_node: 'a', messages });
    const [ordinary] = parseConversationRecord({ current_node: 'a2', messages });
    expect(createTurn({ ...base, ...research, captureMode: 'reload', source: 'conversation_record' }).verdict).toBe('deep_research');
    expect(ordinary?.taskKind).toBeNull();
    expect(createTurn({ ...base, ...ordinary, captureMode: 'reload', source: 'conversation_record' }).verdict).toBe('suspected_downgrade');
  });

  it.each([
    { message: { author: { role: 'user' }, recipient: 'image_gen.text2im', metadata: { did_prompt_contain_image: true } } },
    { message: { author: { role: 'assistant' }, metadata: { is_search: true, tool_name: 'browser' } } },
    { content: { metadata: drMetadata, recipient: 'image_gen.text2im' }, arguments: { tool_name: 'image_gen' } },
    { message: { author: { role: 'assistant' }, metadata: { tool_name: 'not_image_gen', model_slug: 'gpt-6-pro' } } },
    { limits_progress: [{ feature_name: 'deep_research' }, { feature_name: 'image_gen' }] }
  ])('does not mistake input images, search, quotas or message text for task evidence %j', (payload) => {
    expect(parseResponseValue(payload)[0]?.taskKind).toBeNull();
  });

  it.each(['live', 'reload'] as const)('persists task evidence in %s, even after a later empty observation', (captureMode) => {
    const [fields] = parseResponseValue({ message: { author: { role: 'assistant' }, metadata: drMetadata } });
    const observation = normalizeObservation({ ...base, ...fields, captureMode });
    const turn = createTurn(observation!);
    const merged = mergeTurn(turn, { ...base, captureMode, observedAt: '2026-09-28T06:01:00Z' });
    expect(merged.verdict).toBe('deep_research');
    expect(migrateStoredTurn(merged)?.verdict).toBe('deep_research');
    expect(normalizeObservation({ ...base, taskKind: 'arbitrary' })?.taskKind).toBeNull();
  });

  it.each(['image_generation', 'deep_research'] as const)('uses shared purple tone and localized text for %s', (taskKind) => {
    const turn = createTurn({ ...base, taskKind });
    expect(verdictTone(turn.verdict)).toBe('task');
    expect(overlayVerdictCopy(turn, 'live', 'zh')).toEqual({ label: taskKind === 'image_generation' ? '图片生成' : '深度研究', tone: 'task' });
    expect(verdictLabel(turn.verdict, 'en')).toBe(taskKind === 'image_generation' ? 'Image generation' : 'Deep research');
  });

  it('removes only the image exception from the hover hint, in both languages', () => {
    expect(t('zh', 'notice.hint')).toBe('响应来源字段缺失 resolved_model_slug，根据调研统计，约 80% 可能发生降级。');
    expect(t('en', 'notice.hint')).not.toMatch(/image|except/i);
  });
});
