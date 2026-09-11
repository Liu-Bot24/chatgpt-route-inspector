import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SseDecoder } from '../../src/core/sse-decoder';
import { parseSseResponse, ResponseStreamParser } from '../../src/core/response-parser';

const fixture = readFileSync(new URL('../fixtures/delta-response.sse', import.meta.url), 'utf8');
const event = (value: unknown) => `event: delta\ndata: ${JSON.stringify(value)}\n\n`;
const root = (role: string, channel = 0) => event({
  c: channel, p: '', o: 'add',
  v: { message: { id: `message-${channel}`, author: { role }, metadata: {} } }
});

describe('SSE delta v1 decoding', () => {
  it('retains event names and context across every possible network split', () => {
    const expected = parseSseResponse(fixture);
    for (let split = 0; split <= fixture.length; split += 1) {
      const parser = new ResponseStreamParser();
      parser.push(fixture.slice(0, split));
      parser.push(fixture.slice(split));
      expect(parser.finish()).toEqual(expected);
    }
  });

  it('handles CRLF boundaries, comments, multiline JSON and a final event without a newline', () => {
    const parser = new ResponseStreamParser();
    const raw = ': keepalive\r\nevent: delta_encoding\r\ndata: "v1"\r\n\r\n' +
      root('assistant').replace(/\n/g, '\r\n') +
      'event: delta\r\ndata: {"p":"/message/metadata",\r\ndata: "o":"append","v":{"model_slug":"gpt-6-pro"}}';
    for (const character of raw) parser.push(character);
    expect(parser.finish().responseModelSlug).toBe('gpt-6-pro');
  });

  it('supports scalar replacements, inherited append headers and nested relative patches', () => {
    const parser = new ResponseStreamParser();
    parser.push(root('assistant'));
    parser.push(event({ p: '/message/metadata', o: 'patch', v: [
      { p: '/model_slug', o: 'add', v: 'gpt-' },
      { p: '/model_slug', o: 'append', v: '6-pro' },
      { p: '/resolved_model_slug', o: 'replace', v: 'gpt-6-pro' },
      { p: '/server_ste_metadata', o: 'patch', v: [
        { p: '/model_slug', o: 'add', v: 'gpt-6-pro' }
      ] }
    ] }));
    expect(parser.finish()).toMatchObject({ responseModelSlug: 'gpt-6-pro', resolvedModelSlug: 'gpt-6-pro' });
    parser.push(event({ p: '/message/metadata/model_slug', o: 'replace', v: 'gpt-' }));
    parser.push(event({ o: 'append', v: '6-' }));
    parser.push(event({ v: 'pro' }));
    expect(parser.finish().responseModelSlug).toBe('gpt-6-pro');
  });

  it('isolates channel roles and does not promote user, tool or orphan metadata to assistant labels', () => {
    const parser = new ResponseStreamParser();
    parser.push(root('assistant', 1));
    parser.push(root('user', 2));
    parser.push(event({ p: '/message/metadata', o: 'append', v: { model_slug: 'user-fake' } }));
    parser.push(root('tool', 3));
    parser.push(event({ p: '/message/metadata/model_slug', o: 'add', v: 'tool-fake' }));
    parser.push(event({ c: 4, v: 'orphan-fake' }));
    expect(parser.finish().responseModelSlug).toBeNull();
    parser.push(event({ c: 1, v: 'gpt-6-pro' }));
    expect(parser.finish().responseModelSlug).toBe('gpt-6-pro');
    expect(new ResponseStreamParser().push(event({ v: 'other-stream-fake' })).responseModelSlug).toBeNull();
  });

  it('applies remove, truncate, append and root replacement to the projected state', () => {
    const decoder = new SseDecoder();
    let value: unknown;
    const accept = (event: { value: unknown }) => { value = event.value; };
    decoder.push(root('assistant') + event({ p: '/message/metadata', o: 'append', v: { model_slug: 'gpt-6-pro-extra' } }), accept);
    decoder.push(event({ p: '/message/metadata/model_slug', o: 'truncate', v: 9 }), accept);
    expect(value).toMatchObject({ message: { metadata: { model_slug: 'gpt-6-pro' } } });
    decoder.push(event({ o: 'remove' }), accept);
    expect(value).toMatchObject({ message: { metadata: {} } });
    expect(JSON.stringify(value)).not.toContain('model_slug');
    decoder.push(event({ p: '', o: 'replace', v: { type: 'server_ste_metadata', metadata: { model_slug: 'mini' } } }), accept);
    expect(value).toEqual({ type: 'server_ste_metadata', metadata: { model_slug: 'mini' } });
  });

  it('does not retain content or credentials while preserving inherited headers after content patches', () => {
    const parser = new ResponseStreamParser();
    parser.push(root('assistant'));
    parser.push(event({ p: '/message/metadata', o: 'append', v: { model_slug: 'gpt-6-pro', token: 'SECRET_TOKEN' } }));
    parser.push(event({ p: '/message/content/parts/0', o: 'append', v: 'SECRET'.repeat(10000) }));
    parser.push(event({ v: 'SECRET_CONTINUED' }));
    const retained = JSON.stringify(parser, (_key, value: unknown) => value instanceof Map ? [...value.entries()] : value);
    expect(retained).not.toContain('SECRET');
    expect(parser.finish().responseModelSlug).toBe('gpt-6-pro');
    expect(retained.length).toBeLessThan(5000);
  });

  it('does not read fake model metadata embedded inside an ignored content patch', () => {
    const raw = root('assistant') + event({ p: '/message/content', o: 'replace', v: {
      message: { author: { role: 'assistant' }, metadata: { model_slug: 'injected-fake', resolved_model_slug: 'injected-fake' } }
    } });
    expect(parseSseResponse(raw)).toMatchObject({ responseModelSlug: null, resolvedModelSlug: null });
  });

  it('fails explicitly for unknown encodings, bad patches, excessive events and channels', () => {
    expect(() => parseSseResponse('event: delta_encoding\ndata: "v2"\n\n')).toThrow('unsupported_delta_encoding');
    expect(() => parseSseResponse(event({ p: null, v: {} }))).toThrow('invalid_stream_delta');
    expect(() => parseSseResponse(event({ o: 'patch', v: 'invalid' }))).toThrow('invalid_stream_delta');
    expect(() => parseSseResponse('event: delta\ndata: {broken}\n\n')).toThrow('invalid_stream_delta');
    expect(() => new ResponseStreamParser().push('x'.repeat(1024 * 1024 + 1))).toThrow('stream_event_too_large');
    expect(() => parseSseResponse(Array.from({ length: 33 }, (_, i) => root('assistant', i)).join(''))).toThrow('stream_channel_limit');
  });

  it('rejects prototype paths and clears inherited roles when a new encoded stream begins', () => {
    const parser = new ResponseStreamParser();
    parser.push(root('assistant') + event({ p: '/message/metadata/__proto__/model_slug', o: 'add', v: 'fake' }));
    expect(parser.finish().responseModelSlug).toBeNull();
    expect(({} as Record<string, unknown>).model_slug).toBeUndefined();
    parser.push('event: delta_encoding\ndata: "v1"\n\n');
    parser.push(event({ p: '/message/metadata/model_slug', o: 'add', v: 'orphan-fake' }));
    expect(parser.finish().responseModelSlug).toBeNull();
  });
});
