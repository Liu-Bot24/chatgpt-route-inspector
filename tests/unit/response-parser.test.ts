import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeRouteFields, parseConversationRecord, parseResponseText, parseSseResponse } from '../../src/core/response-parser';

const abnormal = readFileSync(new URL('../fixtures/abnormal-response.sse', import.meta.url), 'utf8');
const normal = readFileSync(new URL('../fixtures/normal-response.sse', import.meta.url), 'utf8');
const record = readFileSync(new URL('../fixtures/conversation-record.json', import.meta.url), 'utf8');
const delta = readFileSync(new URL('../fixtures/delta-response.sse', import.meta.url), 'utf8');

describe('response parsers', () => {
  it('ignores metadata-shaped objects inside message text and tool payloads', () => {
    const payload = {
      message: { author: { role: 'assistant' }, metadata: { model_slug: 'real', resolved_model_slug: 'real' },
        content: { resolved_model_slug: 'forged', metadata: { model_slug: 'forged' } } },
      arguments: { resolved_model_slug: 'forged' }, output: { resolved_model_slug: 'forged' }
    };
    expect(parseResponseText(JSON.stringify(payload))[0]?.resolvedModelSlug).toBe('real');
    expect(parseSseResponse(`data: ${JSON.stringify(payload)}\n\n`).responseModelSlug).toBe('real');
  });
  it('reads assistant labels delivered as later delta metadata patches', () => {
    const result = parseSseResponse(delta);
    expect(result).toMatchObject({
      responseModelSlug: 'gpt-6-pro',
      resolvedModelSlug: 'gpt-6-pro',
      serverModelSlug: 'gpt-6-pro',
      conversationId: 'conv-delta',
      requestId: 'req-delta'
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_DELTA|untrusted-user-label/);
  });

  it('extracts an abnormal server-reported route without retaining response text', () => {
    const result = parseSseResponse(abnormal);
    expect(result).toMatchObject({
      responseModelSlug: 'gpt-5-6-pro',
      defaultModelSlug: 'gpt-5-6-pro',
      resolvedModelSlug: 'gpt-5-5-mini',
      serverModelSlug: 'gpt-5-5-mini',
      requestId: 'req-abnormal-123456',
      fastConvo: true
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_ANSWER');
  });

  it('extracts a normal route and ignores partial SSE JSON', () => {
    const result = parseSseResponse(`data: {partial\n${normal}`);
    expect(result.resolvedModelSlug).toBe('gpt-5-6-pro');
    expect(result.serverModelSlug).toBe('gpt-5-6-pro');
  });

  it('does not mislabel server-only metadata as assistant response metadata', () => {
    const result = parseSseResponse('data: {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-5-5-mini","resolved_model_slug":"gpt-5-5-mini"}}\n');
    expect(result.serverModelSlug).toBe('gpt-5-5-mini');
    expect(result.resolvedModelSlug).toBe('gpt-5-5-mini');
    expect(result.responseModelSlug).toBeNull();
  });

  it('does not label non-assistant message metadata as an assistant route field', () => {
    const result = parseSseResponse('data: {"message":{"author":{"role":"user"},"metadata":{"model_slug":"gpt-fake-user-model","resolved_model_slug":"gpt-5-6-pro"}}}\n');
    expect(result.responseModelSlug).toBeNull();
    expect(result.resolvedModelSlug).toBe('gpt-5-6-pro');
  });

  it('pairs user-turn route metadata with the child assistant model label', () => {
    const results = parseConversationRecord(JSON.parse(record));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      responseModelSlug: 'gpt-5-6-pro',
      defaultModelSlug: 'gpt-5-6-pro',
      resolvedModelSlug: 'gpt-5-5-mini',
      requestId: 'req-record-112233',
      toolInvoked: true,
      toolName: 'python'
    });
    expect(JSON.stringify(results)).not.toContain('PRIVATE_USER_TEXT');
    expect(parseConversationRecord({ mapping: null })).toEqual([]);
  });

  it('parses the current flat messages response used by the plural conversation endpoint', () => {
    const results = parseConversationRecord({
      current_node: { id: 'assistant-current' },
      messages: [
        {
          id: 'user-current',
          author: { role: 'user' },
          metadata: {
            resolved_model_slug: 'gpt-5-5-mini',
            request_id: 'req-flat-current'
          }
        },
        {
          id: 'assistant-current',
          parent_id: { id: 'user-current' },
          author: { role: 'assistant' },
          metadata: {
            model_slug: 'gpt-5-6-pro',
            request_id: 'req-flat-current'
          }
        }
      ],
      page_info: { start_cursor: 'cursor-current', has_previous_page: true }
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      responseModelSlug: 'gpt-5-6-pro',
      resolvedModelSlug: 'gpt-5-5-mini',
      requestId: 'req-flat-current'
    });
  });

  it('ignores an older paginated messages page that does not contain current_node', () => {
    expect(parseConversationRecord({
      current_node: 'assistant-current',
      messages: [{
        id: 'assistant-old',
        author: { role: 'assistant' },
        metadata: { model_slug: 'gpt-5-5-mini', request_id: 'req-flat-old' }
      }],
      page_info: { start_cursor: 'cursor-old', has_next_page: true }
    })).toEqual([]);
  });

  it('retains a user-turn route field without promoting its model_slug to an assistant label', () => {
    const [fields] = parseConversationRecord({
      mapping: {
        user: {
          message: {
            id: 'user-only',
            author: { role: 'user' },
            metadata: {
              model_slug: 'gpt-fake-user-label',
              resolved_model_slug: 'gpt-5-5-mini',
              request_id: 'req-user-only'
            }
          }
        }
      }
    });
    expect(fields?.responseModelSlug).toBeNull();
    expect(fields?.resolvedModelSlug).toBe('gpt-5-5-mini');
  });

  it('uses current_node to select the active turn regardless of mapping key order', () => {
    const results = parseConversationRecord({
      current_node: 'assistant-current',
      mapping: {
        'assistant-current': {
          parent: 'user-current',
          message: {
            id: 'assistant-current-message',
            author: { role: 'assistant' },
            metadata: { model_slug: 'gpt-5-6-pro', request_id: 'req-current' }
          }
        },
        'user-old': {
          parent: null,
          message: {
            id: 'user-old-message',
            author: { role: 'user' },
            metadata: { resolved_model_slug: 'gpt-5-5-mini', request_id: 'req-old' }
          }
        },
        'assistant-old': {
          parent: 'user-old',
          message: {
            id: 'assistant-old-message',
            author: { role: 'assistant' },
            metadata: { model_slug: 'gpt-5-5-instant', request_id: 'req-old' }
          }
        },
        'user-current': {
          parent: 'assistant-old',
          message: {
            id: 'user-current-message',
            author: { role: 'user' },
            metadata: { resolved_model_slug: 'gpt-5-6-pro', request_id: 'req-current' }
          }
        }
      }
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      responseModelSlug: 'gpt-5-6-pro',
      resolvedModelSlug: 'gpt-5-6-pro',
      requestId: 'req-current'
    });
  });

  it('uses current_node to keep regenerated assistant siblings separate', () => {
    const results = parseConversationRecord({
      current_node: 'assistant-selected',
      mapping: {
        user: {
          parent: null,
          message: {
            id: 'user-message',
            author: { role: 'user' },
            metadata: { resolved_model_slug: 'gpt-5-5-mini', request_id: 'req-shared' }
          }
        },
        'assistant-rejected': {
          parent: 'user',
          message: {
            id: 'assistant-rejected-message',
            author: { role: 'assistant' },
            metadata: { model_slug: 'gpt-5-5-instant', request_id: 'req-shared' }
          }
        },
        'assistant-selected': {
          parent: 'user',
          message: {
            id: 'assistant-selected-message',
            author: { role: 'assistant' },
            metadata: { model_slug: 'gpt-5-6-pro', request_id: 'req-shared' }
          }
        }
      }
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      responseModelSlug: 'gpt-5-6-pro',
      resolvedModelSlug: 'gpt-5-5-mini',
      requestId: 'req-shared'
    });
  });

  it('does not treat default_model_slug alone as model evidence', () => {
    expect(parseConversationRecord({
      mapping: {
        user: {
          message: {
            id: 'default-only',
            author: { role: 'user' },
            metadata: { default_model_slug: 'gpt-5-6-pro' }
          }
        }
      }
    })).toEqual([]);
  });

  it('dispatches JSON, SSE, and malformed text safely', () => {
    expect(parseResponseText(normal)).toHaveLength(1);
    expect(parseResponseText(record)).toHaveLength(1);
    expect(parseResponseText('not json')).toEqual([]);
  });

  it('merges non-null fields without erasing earlier evidence', () => {
    const result = mergeRouteFields(
      { requestedModel: 'gpt-5-6-pro', conversationId: 'conv-1' },
      { requestedModel: null, resolvedModelSlug: 'gpt-5-6-pro' }
    );
    expect(result.requestedModel).toBe('gpt-5-6-pro');
    expect(result.resolvedModelSlug).toBe('gpt-5-6-pro');
  });
});
