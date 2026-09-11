import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWebSocketFrame, WebSocketRouteParser } from '../../src/core/websocket-parser';

const frame = readFileSync(new URL('../fixtures/websocket-route-frame.json', import.meta.url), 'utf8');

describe('WebSocket route parser', () => {
  it('keeps delta state across frames and isolates interleaved topics', () => {
    const parser = new WebSocketRouteParser();
    const frame = (topic: string, data: string) => JSON.stringify([{ topic_id: topic, payload: { payload: { encoded_item: data } } }]);
    const start = (role: string, id: string) => 'event: delta\ndata: ' + JSON.stringify({
      p: '', o: 'add', v: { message: { id, parent_id: 'input-delta', author: { role }, metadata: {} }, conversation_id: 'conv-delta' }
    }) + '\n\n';
    parser.parse(frame('assistant-topic', start('assistant', 'assistant-delta')));
    parser.parse(frame('user-topic', start('user', 'user-delta')));
    const patch = 'event: delta\ndata: {"p":"/message/metadata/model_slug","o":"add","v":"gpt-6-pro"}\n\n';
    expect(parser.parse(frame('user-topic', patch))[0]?.fields.responseModelSlug).toBeNull();
    expect(parser.parse(frame('assistant-topic', patch))[0]).toMatchObject({
      fields: { responseModelSlug: 'gpt-6-pro' }, messageIds: ['assistant-delta'], parentIds: ['input-delta']
    });
    // Server metadata can precede the final patches, so it must not discard the delta context.
    parser.parse(frame('assistant-topic', 'data: {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-6-pro"}}\n\n'));
    expect(parser.parse(frame('assistant-topic', 'event: delta\ndata: {"v":"gpt-6-mini"}\n\n'))[0]?.fields.responseModelSlug).toBe('gpt-6-mini');
    expect(parser.parse(frame('assistant-topic', 'data: [DONE]\n\n'))[0]?.streamEnded).toBe(true);
    expect(parser.parse(frame('assistant-topic', patch))[0]?.fields.responseModelSlug).toBeNull();
  });

  it('reports decode failures with known correlation instead of reusing stale model evidence', () => {
    const parser = new WebSocketRouteParser();
    const encode = (data: string) => JSON.stringify([{ topic_id: 'topic', payload: { payload: { encoded_item: data } } }]);
    parser.parse(encode('event: delta\ndata: {"v":{"message":{"id":"assistant","author":{"role":"assistant"},"metadata":{"model_slug":"gpt-6-pro"}},"conversation_id":"conv"}}\n\n'));
    expect(parser.parse(encode('event: delta_encoding\ndata: "v2"\n\n'))[0]).toMatchObject({
      errorCode: 'stream_decode_failed', streamEnded: true, conversationIds: ['conv'], fields: { responseModelSlug: null }
    });
  });

  it('extracts bounded route and correlation evidence from encoded SSE without retaining content', () => {
    const [result] = parseWebSocketFrame(frame);
    expect(result).toBeDefined();
    expect(result?.fields).toMatchObject({
      responseModelSlug: 'gpt-5-6-pro',
      resolvedModelSlug: 'gpt-5-5-mini',
      serverModelSlug: 'gpt-5-5-mini',
      requestId: 'req-ws-123456',
      conversationId: 'conv-private-123456'
    });
    expect(result?.conversationIds).toEqual(['conv-private-123456']);
    expect(result?.topicId).toBe('topic-private-123456');
    expect(result?.messageIds).toEqual(['input-private-123456', 'assistant-private-123456']);
    expect(result?.parentIds).toEqual(['parent-private-123456', 'input-private-123456']);
    expect(result?.terminal).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_PROMPT|SECRET_ANSWER/);
  });

  it('fails closed for unrelated, malformed, binary-shaped, and oversized frame text', () => {
    expect(parseWebSocketFrame('not json')).toEqual([]);
    expect(parseWebSocketFrame('{"payload":{}}')).toEqual([]);
    expect(parseWebSocketFrame('[{"payload":{"payload":{"encoded_item":7}}}]')).toEqual([]);
    expect(parseWebSocketFrame('x'.repeat(2 * 1024 * 1024 + 1))).toEqual([]);
  });

  it('caps the number of envelopes inspected', () => {
    const item = {
      payload: { payload: { encoded_item: 'data: {"conversation_id":"conv"}\n' } }
    };
    expect(parseWebSocketFrame(JSON.stringify(Array.from({ length: 20 }, () => item)))).toHaveLength(16);
  });

  it('exposes only a bounded outer topic ID for capture correlation', () => {
    const encode = (topic: unknown) => JSON.stringify([{ topic_id: topic, payload: { payload: {
      encoded_item: 'data: {"resolved_model_slug":"gpt-test","content":{"topic_id":"secret"}}\n\n'
    } } }]);
    expect(parseWebSocketFrame(encode('valid'))[0]?.topicId).toBe('valid');
    for (const invalid of ['', 'x'.repeat(513), 123, { id: 'secret' }]) {
      expect(parseWebSocketFrame(encode(invalid))[0]?.topicId).toBeNull();
    }
  });
});
