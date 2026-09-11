import { afterEach, expect, it, vi } from 'vitest';
import type { RouteObservation } from '../../src/core/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

async function hook(response: Response) {
  const observations: RouteObservation[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    handlers = new Map<string, (event: { data: string }) => void>();
    constructor(public url: string) { sockets.push(this); }
    addEventListener(type: string, listener: (event: { data: string }) => void) { this.handlers.set(type, listener); }
  }
  const nativeFetch = vi.fn(async () => response);
  const windowMock = {
    fetch: nativeFetch as typeof window.fetch, WebSocket: FakeSocket,
    postMessage: vi.fn((envelope) => { if (envelope.observation) observations.push(envelope.observation); }),
    addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
    setInterval: vi.fn()
  };
  vi.stubGlobal('__ROUTE_INSPECTOR_ALLOWED_ORIGINS__', ['https://chatgpt.com']);
  vi.stubGlobal('window', windowMock);
  vi.stubGlobal('location', { origin: 'https://chatgpt.com', pathname: '/c/original', href: 'https://chatgpt.com/c/original' });
  vi.stubGlobal('document', { addEventListener: vi.fn() });
  await import('../../src/content/page-hook');
  return {
    observations, nativeFetch,
    socket: () => {
      new windowMock.WebSocket('wss://chatgpt.com/ws');
      return { message: (data: string) => sockets.at(-1)?.handlers.get('message')?.({ data }) };
    },
    request: (path = '/backend-api/f/conversation', body = { model: 'gpt-test', conversation_id: 'conv' as string | null, messages: [{ id: 'input' }] }) => windowMock.fetch(path, {
      method: 'POST', body: JSON.stringify(body)
    }),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => windowMock.fetch(input, init),
    prune: () => windowMock.setInterval.mock.calls[0]?.[0](),
    control: (settings: object) => listeners.get('message')?.({ source: windowMock, origin: 'https://chatgpt.com', data: {
      source: 'chatgpt-route-inspector-control', version: 1, revision: 1, autoCaptureEnabled: true, captureMode: 'live', ...settings
    } })
  };
}

const sse = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const ws = (topic: string, text: string) => JSON.stringify([{ topic_id: topic, payload: { payload: { encoded_item: text } } }]);
const handoff = (topic: string, key = 'topic_id') => sse(event({ type: 'stream_handoff' }) + event({ type: 'subscribe_ws_topic', [key]: topic }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it.each(['topic_id', 'topic'])('binds SSE %s to metadata-only WebSocket evidence without persisting topic IDs', async (key) => {
  const capture = await hook(handoff('private-topic', key));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('responding'));
  const socket = capture.socket();
  socket.message(ws('wrong-topic', event({ resolved_model_slug: 'wrong' })));
  await settle();
  expect(capture.observations.some((item) => item.source === 'page_websocket')).toBe(false);
  socket.message(ws('private-topic', event({ resolved_model_slug: 'gpt-topic' })));
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-topic'));
  expect(JSON.stringify(capture.observations)).not.toContain('private-topic');
});

it('synchronizes a newly assigned SSE conversation ID before conversation-only WebSocket metadata', async () => {
  const capture = await hook(sse(event({ conversation_id: 'new-conv' }) + event({ type: 'stream_handoff' })));
  await capture.request(undefined, { model: 'gpt-test', conversation_id: null, messages: [{ id: 'new-input' }] });
  await vi.waitFor(() => expect(capture.observations.at(-1)?.conversationId).toBe('new-conv'));
  const socket = capture.socket();
  socket.message(ws('wrong', event({ conversation_id: 'other-conv', resolved_model_slug: 'wrong' })));
  await settle();
  expect(capture.observations.some((item) => item.source === 'page_websocket')).toBe(false);
  socket.message(ws('assigned', event({ conversation_id: 'new-conv', resolved_model_slug: 'gpt-new' })));
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-new'));
});

it('keeps active WebSocket correlations past ten minutes but still expires idle ones', async () => {
  const start = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const capture = await hook(handoff('topic'));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('responding'));
  const socket = capture.socket();
  for (const minute of [5, 9, 13]) {
    clock.mockReturnValue(start + minute * 60_000);
    socket.message(ws('topic', event({ conversation_id: 'conv', type: 'progress' })));
    await settle();
    capture.prune();
  }
  clock.mockReturnValue(start + 17 * 60_000);
  socket.message(ws('topic', event({ resolved_model_slug: 'gpt-late' })));
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-late'));
  const count = capture.observations.length;
  clock.mockReturnValue(start + 28 * 60_000);
  capture.prune();
  socket.message(ws('topic', event({ conversation_id: 'conv', resolved_model_slug: 'expired' })));
  await settle();
  expect(capture.observations).toHaveLength(count);
});

it('retains an open SSE correlation until a late handoff, even without early model metadata', async () => {
  const start = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const capture = await hook(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), {
    headers: { 'content-type': 'text/event-stream' }
  }));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('requested'));
  clock.mockReturnValue(start + 15 * 60_000);
  capture.prune();
  stream.enqueue(new TextEncoder().encode(event({ type: 'subscribe_ws_topic', topic_id: 'late' })));
  stream.close();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('responding'));
  capture.socket().message(ws('late', event({ resolved_model_slug: 'gpt-after-handoff' })));
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-after-handoff'));
});

it('captures the bare conversation POST and leaves GET/list requests untouched', async () => {
  const response = sse(event({ resolved_model_slug: 'gpt-bare' }) + 'data: [DONE]\n\n');
  const capture = await hook(response);
  const clone = vi.spyOn(response, 'clone');
  await capture.fetch('/backend-api/conversation');
  await capture.fetch('/backend-api/conversations?offset=0');
  expect(clone).not.toHaveBeenCalled();
  expect(capture.observations).toEqual([]);
  expect(await capture.request('/backend-api/conversation')).toBe(response);
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-bare'));
});

it('isolates concurrent same-conversation topics and rejects contradictory topic/message identities', async () => {
  const capture = await hook(handoff('topic-a'));
  await capture.request(undefined, { model: 'gpt-test', conversation_id: 'conv', messages: [{ id: 'input-a' }] });
  await vi.waitFor(() => expect(capture.observations).toHaveLength(2));
  const firstId = capture.observations[0]?.captureId;
  capture.nativeFetch.mockResolvedValue(handoff('topic-b'));
  await capture.request(undefined, { model: 'gpt-test', conversation_id: 'conv', messages: [{ id: 'input-b' }] });
  await vi.waitFor(() => expect(capture.observations).toHaveLength(4));
  const secondId = capture.observations[2]?.captureId;
  const socket = capture.socket();
  socket.message(ws('topic-a', event({ parent_id: 'input-b', resolved_model_slug: 'contradictory-input' })));
  socket.message(ws('topic-b', event({ conversation_id: 'other-conv', resolved_model_slug: 'contradictory-conv' })));
  socket.message(ws('unbound-topic', event({ conversation_id: 'conv', parent_id: 'input-a', resolved_model_slug: 'wrong-topic' })));
  await settle();
  expect(capture.observations).toHaveLength(4);
  // Reset socket parser state after intentionally contradictory frames.
  const cleanSocket = capture.socket();
  cleanSocket.message(ws('topic-b', event({ resolved_model_slug: 'model-b' })));
  cleanSocket.message(ws('topic-a', event({ resolved_model_slug: 'model-a' })));
  await vi.waitFor(() => expect(capture.observations).toHaveLength(6));
  expect(capture.observations.slice(4)).toMatchObject([
    { captureId: secondId, resolvedModelSlug: 'model-b' },
    { captureId: firstId, resolvedModelSlug: 'model-a' }
  ]);
});

it('fails closed when two pending requests claim the same topic', async () => {
  const capture = await hook(handoff('shared'));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations).toHaveLength(2));
  capture.nativeFetch.mockResolvedValue(handoff('shared'));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations).toHaveLength(4));
  capture.socket().message(ws('shared', event({ conversation_id: 'conv', resolved_model_slug: 'ambiguous' })));
  await settle();
  expect(capture.observations).toHaveLength(4);
});

it('does not let unrelated topics keep an idle handoff alive', async () => {
  const start = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const capture = await hook(handoff('owned'));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations).toHaveLength(2));
  const socket = capture.socket();
  clock.mockReturnValue(start + 9 * 60_000);
  socket.message(ws('other', event({ conversation_id: 'conv', type: 'progress' })));
  await settle();
  clock.mockReturnValue(start + 11 * 60_000);
  capture.prune();
  socket.message(ws('owned', event({ resolved_model_slug: 'expired' })));
  await settle();
  expect(capture.observations).toHaveLength(2);
});

it.each(['done', 'clear', 'pause'])('retires topic bindings on %s without leaking a late frame into a new turn', async (reason) => {
  const capture = await hook(handoff('old-topic'));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations).toHaveLength(2));
  const socket = capture.socket();
  if (reason === 'done') socket.message(ws('old-topic', 'data: [DONE]\n\n'));
  else {
    capture.control(reason === 'clear' ? { clearedAt: new Date().toISOString() } : { autoCaptureEnabled: false });
    capture.control({ revision: 2, autoCaptureEnabled: true });
  }
  await settle();
  capture.nativeFetch.mockResolvedValue(handoff('new-topic'));
  await capture.request(undefined, { model: 'gpt-test', conversation_id: 'conv', messages: [{ id: 'new-input' }] });
  await vi.waitFor(() => expect(capture.observations).toHaveLength(4));
  const newId = capture.observations.at(-1)?.captureId;
  socket.message(ws('old-topic', event({ conversation_id: 'conv', resolved_model_slug: 'stale' })));
  await settle();
  expect(capture.observations).toHaveLength(4);
  socket.message(ws('new-topic', event({ resolved_model_slug: 'fresh' })));
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('fresh'));
  expect(capture.observations.at(-1)?.captureId).toBe(newId);
});

it('passively carries an init quota snapshot into subsequent route observations without an extra request', async () => {
  const payload = { type: 'conversation_detail_metadata', limits_progress: [
    { feature_name: 'deep_research', remaining: 0, reset_after: '2026-10-11T12:37:00Z' },
    { feature_name: 'image_gen', remaining: 987, reset_after: '2026-09-12T12:37:00Z', token: 'SECRET' }
  ] };
  const response = new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  const capture = await hook(response);
  await (await capture.request('/backend-api/conversation/init')).text();
  // Let both native Response tee branches finish; the extension never waits on a user-facing fetch.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(capture.observations).toEqual([]);
  capture.nativeFetch.mockResolvedValue(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('completed'));
  expect(capture.observations.at(-1)).toMatchObject({ deepResearchRemaining: 0, imageGenRemaining: 987 });
  expect(capture.observations.at(-1)?.quotaObservedAt).toBeTruthy();
  expect(capture.nativeFetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(capture.observations)).not.toContain('SECRET');
});

it('captures quota updates carried by the SSE response itself', async () => {
  const capture = await hook(new Response('data: {"type":"conversation_detail_metadata","limits_progress":[{"feature_name":"image_gen","remaining":5,"reset_after":"2026-09-12T12:37:00Z"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('completed'));
  expect(capture.observations.at(-1)).toMatchObject({ imageGenRemaining: 5, imageGenResetAt: '2026-09-12T12:37:00.000Z' });
});

it('reports HTTP errors and unexpected content types without touching the page response', async () => {
  const response = new Response('denied', { status: 403, headers: { 'content-type': 'text/html' } });
  const capture = await hook(response);
  expect(await capture.request()).toBe(response);
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('failed'));
  expect(capture.observations.at(-1)?.errorCode).toBe('http_403');
  expect(await response.text()).toBe('denied');
});

it('rejects a successful HTML response and accepts a normal SSE response', async () => {
  let capture = await hook(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.errorCode).toBe('unexpected_content_type'));
  vi.resetModules();
  capture = await hook(new Response('data: {"resolved_model_slug":"gpt-test"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('completed'));
  expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-test');
});

it('enforces byte limits on an undeclared stream without buffering the rest', async () => {
  const cancelled = vi.fn();
  let reads = 0;
  const inspection = new Response(new ReadableStream({
    pull(controller) { reads += 1; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel: cancelled
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
  vi.spyOn(response, 'clone').mockReturnValue(inspection);
  const capture = await hook(response);
  await capture.request('/backend-api/conversation/conv');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.errorCode).toBe('record_too_large'));
  expect(reads).toBe(9);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(await response.text()).toBe('{}');
});

it('releases completed HTTP correlations so the next handoff can match by conversation', async () => {
  const capture = await hook(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('completed'));
  capture.nativeFetch.mockResolvedValue(new Response('data: {"type":"stream_handoff"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('responding'));
  const secondCapture = capture.observations.at(-1)?.captureId;
  const socket = capture.socket();
  socket.message(JSON.stringify([{ topic_id: 'topic', payload: { payload: {
    encoded_item: 'data: {"conversation_id":"conv","resolved_model_slug":"gpt-new"}\n\ndata: [DONE]\n\n'
  } } }]));
  await vi.waitFor(() => expect(capture.observations.at(-1)?.source).toBe('page_websocket'));
  expect(capture.observations.at(-1)?.captureId).toBe(secondCapture);
  expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-new');
});

it('does not mark an SSE transport handoff as a completed answer', async () => {
  const capture = await hook(new Response('data: {"type":"stream_handoff"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations).toHaveLength(2));
  expect(capture.observations.at(-1)?.phase).toBe('responding');
  expect(capture.observations.at(-1)?.completedAt).toBeUndefined();
});

it('cancels a declared oversized inspection body before reading it', async () => {
  const cancelled = vi.fn();
  const inspection = new Response(new ReadableStream({ cancel: cancelled }), {
    headers: { 'content-type': 'application/json', 'content-length': '9000000' }
  });
  const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
  vi.spyOn(response, 'clone').mockReturnValue(inspection);
  const capture = await hook(response);
  await capture.request('/backend-api/conversation/conv');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.errorCode).toBe('record_too_large'));
  expect(cancelled).toHaveBeenCalledOnce();
});

it('does not clone or parse fetch responses while capture is paused', async () => {
  const response = new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const clone = vi.spyOn(response, 'clone');
  const capture = await hook(response);
  capture.control({ autoCaptureEnabled: false });
  expect(await capture.request()).toBe(response);
  expect(clone).not.toHaveBeenCalled();
  expect(capture.observations).toEqual([]);
  expect(capture.nativeFetch).toHaveBeenCalledOnce();
});
