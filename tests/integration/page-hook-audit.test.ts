import { afterEach, expect, it, vi } from 'vitest';
import type { CaptureContext, RouteObservation, RouteTurn } from '../../src/core/types';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

async function hook(response: Response, pathname = '/c/original') {
  const observations: RouteObservation[] = [];
  const contexts: CaptureContext[] = [];
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
    postMessage: vi.fn((envelope) => {
      if (envelope.observation) observations.push(envelope.observation);
      if (envelope.context) contexts.push(envelope.context);
    }),
    addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
    setInterval: vi.fn()
  };
  vi.stubGlobal('__ROUTE_INSPECTOR_ALLOWED_ORIGINS__', ['https://chatgpt.com']);
  vi.stubGlobal('window', windowMock);
  vi.stubGlobal('location', { origin: 'https://chatgpt.com', pathname, href: `https://chatgpt.com${pathname}` });
  vi.stubGlobal('document', { addEventListener: vi.fn() });
  await import('../../src/content/page-hook');
  return {
    observations, contexts, nativeFetch,
    navigate: (path: string) => {
      Object.assign(location, { pathname: path, href: `https://chatgpt.com${path}` });
      listeners.get('popstate')?.({});
    },
    socket: () => {
      new windowMock.WebSocket('wss://chatgpt.com/ws');
      return { message: (data: string) => sockets.at(-1)?.handlers.get('message')?.({ data }) };
    },
    request: (path = '/backend-api/f/conversation', body = { model: 'gpt-test', conversation_id: 'conv' as string | null, messages: [{ id: 'input' }] }) => windowMock.fetch(path, {
      method: 'POST', body: JSON.stringify(body)
    }),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => windowMock.fetch(input, init),
    restore: () => listeners.get('pageshow')?.({ persisted: true }),
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
const record = (model: string) => new Response(JSON.stringify({ resolved_model_slug: model }), {
  headers: { 'content-type': 'application/json' }
});

const researchStream = () => sse(event({ conversation_id: 'research-conversation', message: {
  id: 'research-tool', author: { role: 'tool' }, metadata: { resolved_model_slug: 'planner',
    chatgpt_sdk: { resource_name: 'Deep Research App_start', widget_session_id: 'research-widget' } }
} }) + 'data: [DONE]\n\n');
const researchUpdate = (messageId = 'research-tool') => JSON.stringify({ type: 'conversation-update', payload: {
  conversation_id: 'research-conversation', update_type: 'update-widget-state', update_content: { updates: [{
    message_id: messageId, widget_state: { status: 'completed', report_message: { author: { role: 'assistant' },
      metadata: { resolved_model_slug: 'report-model' }, content: { parts: ['PRIVATE_REPORT'] } } }
  }] }
} });

const imageUpdate = (parent = 'input', conversation = 'conv', workingTurn = 'image-turn') => JSON.stringify({
  type: 'conversation-update', payload: { conversation_id: conversation, update_type: 'add-messages', update_content: {
    messages: [{ id: 'image-result', author: { role: 'tool', name: 'dynamic.tool' },
      metadata: { parent_id: parent, working_turn_id: workingTurn, image_gen_title: 'PRIVATE_IMAGE_TITLE' } }]
  } }
});

it('task intake: receives image updates for an ordinary completed HTTP request, with no handoff', async () => {
  const capture = await hook(sse(event({ conversation_id: 'conv', resolved_model_slug: 'chat-model' }) + 'data: [DONE]\n\n'), '/c/conv');
  await capture.request(); await settle();
  const id = capture.observations.at(-1)!.captureId;
  capture.socket().message(imageUpdate()); await settle();
  expect(capture.observations.at(-1)).toMatchObject({ captureId: id, captureMode: 'live', taskKind: 'image_generation' });
  expect(capture.observations.at(-1)?.resolvedModelSlug).toBeNull();
  expect(JSON.stringify(capture.observations)).not.toContain('PRIVATE_IMAGE_TITLE');
});

it('task intake: learns the originating turn from HTTP metadata before a sibling async task arrives', async () => {
  const capture = await hook(sse(event({ conversation_id: 'conv', message: { id: 'assistant-stream', author: { role: 'assistant' },
    metadata: { resolved_model_slug: 'chat-model', working_turn_id: 'image-turn' } } }) + 'data: [DONE]\n\n'), '/c/conv');
  await capture.request(); await settle();
  capture.socket().message(imageUpdate('missing-parent')); await settle();
  expect(capture.observations.at(-1)?.taskKind).toBe('image_generation');
});

it.each(['parent', 'turn'] as const)('task intake: learns %s identity from a matched WS handoff before a late image', async match => {
  const capture = await hook(handoff('owned'), '/c/conv');
  await capture.request(); await settle();
  const id = capture.observations[0]!.captureId;
  const socket = capture.socket();
  socket.message(ws('owned', event({ conversation_id: 'conv', message: { id: 'assistant-ws', author: { role: 'assistant' },
    metadata: { parent_id: 'input', resolved_model_slug: 'chat-model', working_turn_id: 'image-turn', turn_exchange_id: 'exchange' } }
  }) + 'data: [DONE]\n\n'));
  await settle();
  socket.message(imageUpdate(match === 'parent' ? 'assistant-ws' : 'missing-parent', 'conv', match === 'parent' ? '' : 'image-turn'));
  await settle();
  expect(capture.observations.at(-1)).toMatchObject({ captureId: id, captureMode: 'live', taskKind: 'image_generation' });
  const { upsertTurn } = await import('../../src/core/turns');
  const turns = capture.observations.reduce<RouteTurn[]>((turns, observation) => upsertTurn(turns, observation), []);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ verdict: 'image_generation', routeModel: 'chat-model' });
});

it.each(['unmatched-topic', 'wrong-conversation', 'wrong-turn', 'wrong-exchange'] as const)('task intake: WS identity does not bypass %s isolation', async mode => {
  const capture = await hook(handoff('owned'), '/c/conv');
  await capture.request(); await settle();
  const socket = capture.socket();
  socket.message(ws(mode === 'unmatched-topic' ? 'foreign' : 'owned', event({
    conversation_id: mode === 'wrong-conversation' ? 'other' : 'conv', message: { id: 'assistant-ws', author: { role: 'assistant' },
      metadata: { parent_id: 'input', working_turn_id: 'image-turn', turn_exchange_id: 'exchange' } }
  }) + 'data: [DONE]\n\n'));
  await settle();
  const late = JSON.parse(imageUpdate('assistant-ws', 'conv', mode === 'wrong-turn' ? 'other-turn' : 'image-turn'));
  if (mode === 'wrong-exchange') late.payload.update_content.messages[0].metadata.turn_exchange_id = 'other-exchange';
  socket.message(JSON.stringify(late)); await settle();
  expect(capture.observations.some(o => o.taskKind === 'image_generation')).toBe(false);
});

it.each([false, true])('research: async planner and widget reach storage without losing the model (repeated marker: %s)', async marked => {
  const capture = await hook(sse('data: [DONE]\n\n'), '/c/conv');
  await capture.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({
    model: 'gpt-6-pro', conversation_id: 'conv', messages: [{ id: 'input',
      metadata: { system_hints: ['plugin:connector_openai_deep_research'] } }]
  }) });
  await settle();
  capture.socket().message(JSON.stringify({ type: 'conversation-update', payload: { conversation_id: 'conv',
    update_type: 'add-messages', update_content: { messages: [
      { id: 'planner', author: { role: 'assistant' }, metadata: { parent_id: 'input', resolved_model_slug: 'planner-model',
        ...(marked ? { system_hints: ['plugin:connector_openai_deep_research'] } : {}) } },
      { id: 'tool', author: { role: 'tool' }, metadata: { parent_id: 'planner',
        chatgpt_sdk: { resource_name: 'Deep Research App_start', widget_session_id: 'widget' } } }
    ] } } }));
  await settle();
  expect(capture.observations.at(-1)).toMatchObject({ taskKind: 'deep_research', resolvedModelSlug: 'planner-model', researchWidgetId: 'widget', researchMessageId: 'tool' });
  const { upsertTurn } = await import('../../src/core/turns');
  const turns = capture.observations.reduce<RouteTurn[]>((turns, observation) => upsertTurn(turns, observation), []);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ verdict: 'deep_research', routeModel: 'planner-model', researchWidgetId: 'widget', researchReportModel: null });
});

it.each([
  { reverse: false, widget: true }, { reverse: true, widget: true },
  { reverse: false, widget: false }, { reverse: true, widget: false }
])('research: WS learned turn preserves report ownership across batch order ($reverse) and widget presence ($widget)', async ({ reverse, widget }) => {
  const capture = await hook(handoff('owned'), '/c/research-conversation');
  await capture.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({
    model: 'gpt-6-pro', conversation_id: 'research-conversation', messages: [{ id: 'input',
      metadata: { system_hints: ['plugin:connector_openai_deep_research'] } }]
  }) });
  await settle();
  const socket = capture.socket();
  const turnIdentity = { working_turn_id: 'research-turn', turn_exchange_id: 'research-exchange' };
  socket.message(ws('owned', event({ conversation_id: 'research-conversation', message: {
    id: 'anchor', author: { role: 'assistant' }, metadata: { parent_id: 'input', ...turnIdentity }
  } }) + 'data: [DONE]\n\n'));
  await settle();
  const messages = [
    { id: 'planner', author: { role: 'assistant' }, metadata: { parent_id: 'input', ...turnIdentity,
      system_hints: ['plugin:connector_openai_deep_research'], resolved_model_slug: 'planner-model' } },
    { id: 'research-tool', author: { role: 'tool' }, metadata: { parent_id: 'planner', ...turnIdentity,
      chatgpt_sdk: { resource_name: 'Deep Research App_start', ...(widget ? { widget_session_id: 'widget' } : {}) } } }
  ];
  socket.message(JSON.stringify({ type: 'conversation-update', payload: { conversation_id: 'research-conversation',
    update_type: 'add-messages', update_content: { messages: reverse ? messages.reverse() : messages } } }));
  await settle();
  socket.message(researchUpdate());
  await settle();
  const { upsertTurn } = await import('../../src/core/turns');
  const turns = capture.observations.reduce<RouteTurn[]>((turns, observation) => upsertTurn(turns, observation), []);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ verdict: 'deep_research', routeModel: 'planner-model', researchReportModel: 'report-model',
    researchMessageId: 'research-tool', researchWidgetId: widget ? 'widget' : null });
  expect(JSON.stringify(capture.observations)).not.toContain('PRIVATE_REPORT');
});

it.each(['pause', 'clear', 'navigate', 'wrong-conversation', 'wrong-parent'] as const)('task intake: rejects %s late image update', async mode => {
  const capture = await hook(sse(event({ conversation_id: 'conv', resolved_model_slug: 'chat-model' }) + 'data: [DONE]\n\n'), '/c/conv');
  await capture.request(); await settle();
  if (mode === 'pause') capture.control({ autoCaptureEnabled: false });
  if (mode === 'clear') capture.control({ clearedAt: new Date(Date.now() + 1).toISOString() });
  if (mode === 'navigate') capture.navigate('/c/another');
  capture.socket().message(imageUpdate(mode === 'wrong-parent' ? 'unrelated' : 'input', mode === 'wrong-conversation' ? 'other' : 'conv'));
  await settle();
  expect(capture.observations.some(o => o.taskKind === 'image_generation')).toBe(false);
});

it('task intake: binds a later sibling update to the current reload without creating a live result', async () => {
  const data = { current_node: 'recap', messages: [{ id: 'recap', author: { role: 'assistant' },
    metadata: { resolved_model_slug: 'chat-model', working_turn_id: 'image-turn' } }] };
  const capture = await hook(new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }), '/c/conv');
  await capture.fetch('/backend-api/conversations/conv'); await settle();
  capture.socket().message(imageUpdate('missing-parent')); await settle();
  expect(capture.observations.at(-1)).toMatchObject({ taskKind: 'image_generation', captureMode: 'reload' });
  expect(capture.observations.some(o => o.captureMode === 'live')).toBe(false);
});

it('task intake: a late task only updates its original request after a newer message is sent', async () => {
  const capture = await hook(sse(event({ conversation_id: 'conv', resolved_model_slug: 'chat-model' }) + 'data: [DONE]\n\n'), '/c/conv');
  await capture.request(); await settle();
  const first = capture.observations.at(-1)!.captureId;
  capture.nativeFetch.mockResolvedValueOnce(sse(event({ conversation_id: 'conv', resolved_model_slug: 'new-model' }) + 'data: [DONE]\n\n'));
  await capture.request(undefined, { model: 'gpt-test', conversation_id: 'conv', messages: [{ id: 'next-input' }] }); await settle();
  const second = capture.observations.at(-1)!.captureId;
  capture.socket().message(imageUpdate()); await settle();
  expect(first).not.toBe(second);
  expect(capture.observations.at(-1)).toMatchObject({ captureId: first, taskKind: 'image_generation' });
});

it('research: retains a completed HTTP task association for its later report, not an unrelated widget', async () => {
  const capture = await hook(researchStream(), '/c/research-conversation');
  await capture.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({
    model: 'gpt-6-pro', conversation_id: 'research-conversation', messages: [{ id: 'research-input',
      metadata: { system_hints: ['plugin:connector_openai_deep_research'] } }]
  }) });
  await settle();
  expect(capture.observations[0]).toMatchObject({ phase: 'requested', taskKind: 'deep_research' });
  expect(capture.observations.at(-1)).toMatchObject({ phase: 'completed', resolvedModelSlug: 'planner' });
  const originalId = capture.observations.at(-1)!.captureId;
  const socket = capture.socket();
  socket.message(researchUpdate('unrelated-widget'));
  await settle();
  expect(capture.observations.some((o) => o.researchReportModel)).toBe(false);
  socket.message(researchUpdate());
  await settle();
  expect(capture.observations.at(-1)).toMatchObject({ captureId: originalId, taskKind: 'deep_research', researchReportModel: 'report-model' });
  expect(capture.observations.at(-1)?.resolvedModelSlug).toBeUndefined();
  expect(JSON.stringify(capture.observations)).not.toContain('PRIVATE_REPORT');
});

it.each(['pause', 'clear', 'navigate'] as const)('research: %s prevents a late report from repopulating the active capture', async (operation) => {
  const capture = await hook(researchStream(), '/c/research-conversation');
  await capture.request(undefined, { model: 'gpt-6-pro', conversation_id: 'research-conversation', messages: [{ id: 'research-input' }] });
  await settle();
  if (operation === 'pause') capture.control({ autoCaptureEnabled: false });
  if (operation === 'clear') capture.control({ clearedAt: new Date(Date.now() + 1).toISOString() });
  if (operation === 'navigate') capture.navigate('/c/unrelated');
  capture.socket().message(researchUpdate());
  await settle();
  expect(capture.observations.some((o) => o.researchReportModel)).toBe(false);
});

it.each(['new', 'other'])('N1: stages ambiguous GET until creation identity proves %s', async (identity) => {
  const capture = await hook(sse(event({ resolved_model_slug: 'live-route' }) + event({ type: 'subscribe_ws_topic', topic_id: 'creation' })), '/');
  await capture.request(undefined, { model: 'gpt-test', conversation_id: null, messages: [{ id: 'new-input' }] });
  await settle();
  capture.navigate('/c/new');
  capture.nativeFetch.mockResolvedValueOnce(record('read-after-creation'));
  await capture.fetch('/backend-api/conversation/new');
  await settle();
  expect(capture.observations.filter((o) => o.captureMode === 'reload')).toHaveLength(0);
  capture.socket().message(ws('creation', event({ conversation_id: identity })));
  await settle();
  expect(capture.observations.filter((o) => o.captureMode === 'reload')).toHaveLength(identity === 'new' ? 0 : 1);
});

it('N2: delayed clear preserves a newer first-request identity across URL promotion', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);
  const capture = await hook(handoff('creation'), '/');
  vi.setSystemTime(12_000);
  await capture.request(undefined, { model: 'gpt-test', conversation_id: null, messages: [{ id: 'new-input' }] });
  await settle();
  const id = capture.contexts.at(-1)!.id;
  capture.navigate('/c/new');
  vi.setSystemTime(13_000);
  capture.control({ clearedAt: new Date(11_000).toISOString() });
  capture.socket().message(ws('creation', event({ conversation_id: 'new' })));
  await settle();
  expect(capture.contexts.at(-1)?.id).toBe(id);
  expect(capture.observations.at(-1)?.conversationId).toBe('new');
});

it('N3: identity and valid metadata survive a later decoding error in the same raw WS batch', async () => {
  const capture = await hook(handoff('creation'), '/');
  await capture.request(undefined, { model: 'gpt-test', conversation_id: null, messages: [{ id: 'new-input' }] });
  await settle();
  const id = capture.contexts.at(-1)!.id;
  capture.navigate('/c/new');
  const raw = [...JSON.parse(ws('creation', event({ conversation_id: 'new', resolved_model_slug: 'valid-route' }))),
    ...JSON.parse(ws('creation', 'event: delta_encoding\ndata: "unsupported"\n\n'))];
  capture.socket().message(JSON.stringify(raw));
  await settle();
  expect(capture.observations.at(-1)).toMatchObject({ phase: 'failed', errorCode: 'stream_decode_failed',
    conversationId: 'new', resolvedModelSlug: 'valid-route' });
  expect(capture.contexts.at(-1)?.id).toBe(id);
});

it('N3: validated identity survives an error later in the same encoded item', async () => {
  const capture = await hook(handoff('creation'), '/');
  await capture.request(undefined, { model: 'gpt-test', conversation_id: null, messages: [{ id: 'new-input' }] });
  await settle();
  const id = capture.contexts.at(-1)!.id;
  capture.navigate('/c/new');
  capture.socket().message(ws('creation', event({ conversation_id: 'new' }) + 'event: delta_encoding\ndata: "unsupported"\n\n'));
  await settle();
  expect(capture.observations.at(-1)).toMatchObject({ phase: 'failed', errorCode: 'stream_decode_failed', conversationId: 'new' });
  expect(capture.contexts.at(-1)?.id).toBe(id);
});

it('N6: navigation while paused never opens DOM replay, but a fresh network read after resume works', async () => {
  const capture = await hook(sse(event({ resolved_model_slug: 'paused-answer' })));
  capture.control({ autoCaptureEnabled: false });
  capture.navigate('/c/paused');
  await capture.request();
  await settle();
  capture.control({ revision: 2 });
  expect(capture.contexts.at(-1)?.reloadEligible).toBe(false);
  expect(capture.observations).toHaveLength(0);
  capture.nativeFetch.mockResolvedValueOnce(record('fresh-network'));
  await capture.fetch('/backend-api/conversation/paused');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('fresh-network'));
});

it('N7: a quota-only initial record updates quota without consuming the reload model slot', async () => {
  const capture = await hook(new Response(JSON.stringify({ limits_progress: [
    { feature_name: 'deep_research', remaining: 9 }, { feature_name: 'image_gen', remaining: 21 }
  ] }), { headers: { 'content-type': 'application/json' } }));
  await capture.fetch('/backend-api/conversation/original');
  await settle();
  expect(capture.observations).toHaveLength(0);
  capture.nativeFetch.mockResolvedValueOnce(record('reload-model'));
  await capture.fetch('/backend-api/conversation/original');
  await settle();
  expect(capture.observations.at(-1)).toMatchObject({ resolvedModelSlug: 'reload-model', deepResearchRemaining: 9, imageGenRemaining: 21 });
  capture.nativeFetch.mockResolvedValueOnce(sse(event({ resolved_model_slug: 'live-model' })));
  await capture.request();
  await settle();
  expect(capture.observations.at(-1)).toMatchObject({ resolvedModelSlug: 'live-model', deepResearchRemaining: 9, imageGenRemaining: 21 });
});

it.each(['expired', 'navigate', 'live', 'clear', 'pause'])('N1: ambiguous records never escape after %s', async (reason) => {
  const capture = await hook(handoff('creation'), '/');
  await capture.request(undefined, { model: 'gpt-test', conversation_id: null, messages: [{ id: 'new-input' }] });
  await settle();
  capture.navigate('/c/new');
  let finish!: ReadableStreamDefaultController<Uint8Array>;
  capture.nativeFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(c) { finish = c; } }), {
    headers: { 'content-type': 'application/json' }
  }));
  await capture.fetch('/backend-api/conversation/new');
  await settle();
  if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
  if (reason === 'navigate') capture.navigate('/c/other');
  if (reason === 'live') {
    capture.nativeFetch.mockResolvedValueOnce(sse(event({ resolved_model_slug: 'second-live' })));
    await capture.request(undefined, { model: 'gpt-test', conversation_id: 'new', messages: [{ id: 'second-input' }] });
  }
  if (reason === 'clear') capture.control({ clearedAt: new Date().toISOString() });
  if (reason === 'pause') capture.control({ autoCaptureEnabled: false });
  finish.enqueue(new TextEncoder().encode(JSON.stringify({ resolved_model_slug: 'ambiguous' })));
  finish.close();
  await settle();
  capture.socket().message(ws('creation', event({ conversation_id: 'created-elsewhere' })));
  await settle();
  expect(capture.observations.filter((o) => o.captureMode === 'reload')).toHaveLength(0);
});

it.each(['prefetch', 'pause', 'clear'])('N7: quota-only data rejected by %s cannot seed a new live request', async (reason) => {
  let finish!: ReadableStreamDefaultController<Uint8Array>;
  const capture = await hook(new Response(new ReadableStream<Uint8Array>({ start(c) { finish = c; } }), {
    headers: { 'content-type': 'application/json' }
  }));
  await capture.fetch(`/backend-api/conversation/${reason === 'prefetch' ? 'other' : 'original'}`);
  if (reason === 'pause') capture.control({ autoCaptureEnabled: false });
  if (reason === 'clear') capture.control({ clearedAt: new Date().toISOString() });
  finish.enqueue(new TextEncoder().encode(JSON.stringify({ limits_progress: [{ feature_name: 'image_gen', remaining: 21 }] })));
  finish.close();
  await settle();
  capture.control({ revision: 2 });
  capture.nativeFetch.mockResolvedValueOnce(sse(event({ resolved_model_slug: 'fresh-live' })));
  await capture.request();
  await settle();
  expect(capture.observations.at(-1)).toMatchObject({ resolvedModelSlug: 'fresh-live', imageGenRemaining: null });
});

it.each(['failed', 'pending'])('F1: captures an unrelated conversation after a %s creation', async (phase) => {
  const capture = await hook(phase === 'failed' ? new Response('', { status: 503 }) : handoff('creation'), '/');
  await capture.request(undefined, { model: 'gpt-test', conversation_id: null, messages: [{ id: 'new' }] });
  await settle();
  capture.navigate('/c/other');
  expect(capture.contexts.at(-1)?.reloadEligible).toBe(phase === 'failed');
  capture.nativeFetch.mockResolvedValueOnce(record('other-route'));
  await capture.fetch('/backend-api/conversation/other');
  // A bare model-only response cannot prove this is unrelated to the pending creation.
  // Supply the live identity; the already-fetched unrelated record must then be released.
  if (phase === 'pending') capture.socket().message(ws('creation', event({ conversation_id: 'created-elsewhere' })));
  await vi.waitFor(() => expect(capture.observations.some((o) => o.captureMode === 'reload' && o.resolvedModelSlug === 'other-route')).toBe(true));
});

it.each(['pause', 'clear'])('F2: accepts fresh record requests after %s without reopening DOM fallback', async (reason) => {
  const capture = await hook(record('fresh'));
  if (reason === 'pause') {
    capture.control({ autoCaptureEnabled: false });
    capture.control({ revision: 2 });
  } else capture.control({ clearedAt: new Date().toISOString() });
  await settle();
  expect(capture.contexts.at(-1)?.reloadEligible).toBe(false);
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('fresh'));
});

it('F3: ignores pagination even when it precedes the initial record', async () => {
  const capture = await hook(record('older'));
  await capture.fetch('/backend-api/conversation/original?cursor=older');
  await settle();
  expect(capture.observations).toHaveLength(0);
  capture.nativeFetch.mockResolvedValueOnce(record('initial'));
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('initial'));
});

it('F4: captures an immediate page retry without waiting for clone parsing to fail', async () => {
  const capture = await hook(new Response('invalid', { headers: { 'content-type': 'application/json' } }));
  const response = await capture.fetch('/backend-api/conversation/original');
  await expect(response.json()).rejects.toThrow();
  capture.nativeFetch.mockResolvedValueOnce(record('retry'));
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations.some((o) => o.resolvedModelSlug === 'retry')).toBe(true));
});

it('F4: a pending failed clone cannot exclude or overwrite a successful retry', async () => {
  let first!: ReadableStreamDefaultController<Uint8Array>;
  const invalid = new Response('invalid', { headers: { 'content-type': 'application/json' } });
  // Control only the inspection branch schedule; the page still reads its native response.
  vi.spyOn(invalid, 'clone').mockReturnValue(new Response(new ReadableStream<Uint8Array>({ start(c) { first = c; } })));
  const capture = await hook(invalid);
  await expect((await capture.fetch('/backend-api/conversation/original')).json()).rejects.toThrow();
  capture.nativeFetch.mockResolvedValueOnce(record('retry'));
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations.some((o) => o.resolvedModelSlug === 'retry')).toBe(true));
  first.enqueue(new TextEncoder().encode('invalid'));
  first.close();
  await settle();
  expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('retry');
  capture.nativeFetch.mockResolvedValueOnce(record('not-a-retry'));
  await capture.fetch('/backend-api/conversation/original');
  await settle();
  expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('retry');
});

it('R1: stages an early navigation GET without exposing a prefetch in the current visit', async () => {
  const capture = await hook(record('next-route'));
  await capture.fetch('/backend-api/conversation/next');
  await settle();
  expect(capture.observations).toHaveLength(0);
  capture.navigate('/c/next');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('next-route'));
  expect(capture.observations.at(-1)?.captureContextId).toBe(capture.contexts.at(-1)?.id);
  expect(capture.observations.at(-1)?.conversationId).toBe('next');
});

it('F5: identity-only raw WS evidence promotes the existing SSE capture', async () => {
  const capture = await hook(sse(event({ resolved_model_slug: 'sse-route' }) + event({ type: 'subscribe_ws_topic', topic_id: 'creation' })), '/');
  await capture.request(undefined, { model: 'gpt-test', conversation_id: null, messages: [{ id: 'new' }] });
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('sse-route'));
  const original = capture.observations[0]!;
  capture.navigate('/c/new-conv');
  expect(capture.contexts.at(-1)?.reloadEligible).toBe(false);
  capture.socket().message(ws('creation', event({ conversation_id: 'new-conv' }) + 'data: [DONE]\n\n'));
  await vi.waitFor(() => expect(capture.contexts.at(-1)?.id).toBe(original.captureContextId));
  expect(capture.observations.at(-1)).toMatchObject({ captureId: original.captureId, conversationId: 'new-conv' });
  expect(capture.contexts.at(-1)?.reloadEligible).toBe(false);
});

it('B1: historical clear initialization does not cancel a newer in-flight reader', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const capture = await hook(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), {
    headers: { 'content-type': 'application/json' }
  }));
  await capture.fetch('/backend-api/conversation/original');
  await settle();
  capture.control({ clearedAt: new Date(Date.now() - 86_400_000).toISOString() });
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ resolved_model_slug: 'newer' })));
  controller.close();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('newer'));
});

it('B1: a delayed older clear cannot reopen a newer committed reload snapshot', async () => {
  const timestamp = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(timestamp - 10_000);
  const capture = await hook(record('newer'));
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations).toHaveLength(1));
  capture.control({ clearedAt: new Date(timestamp - 5000).toISOString() });
  capture.nativeFetch.mockResolvedValueOnce(record('duplicate'));
  await capture.fetch('/backend-api/conversation/original');
  await settle();
  expect(capture.observations).toHaveLength(1);
  expect(capture.observations[0]?.resolvedModelSlug).toBe('newer');
});

it.each(['pause', 'clear', 'restore'])('does not resurrect a late native fetch after %s', async (reason) => {
  const capture = await hook(record('stale'));
  let resolve!: (response: Response) => void;
  capture.nativeFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
  const old = capture.fetch('/backend-api/conversation/original');
  if (reason === 'restore') capture.restore();
  else {
    capture.control(reason === 'pause' ? { autoCaptureEnabled: false } : { clearedAt: new Date().toISOString() });
    capture.control({ revision: 2 });
  }
  resolve(record('stale'));
  await old;
  await settle();
  expect(capture.observations).toHaveLength(0);
  capture.nativeFetch.mockResolvedValueOnce(record('fresh'));
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('fresh'));
});

it('commits only one valid snapshot from concurrent initial reads, leaving page responses intact', async () => {
  let resolve!: (response: Response) => void;
  const capture = await hook(record('first'));
  capture.nativeFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
  const slow = capture.fetch('/backend-api/conversation/original');
  const fast = await capture.fetch('/backend-api/conversation/original');
  expect(await fast.json()).toEqual({ resolved_model_slug: 'first' });
  await vi.waitFor(() => expect(capture.observations).toHaveLength(1));
  resolve(record('late'));
  expect(await (await slow).json()).toEqual({ resolved_model_slug: 'late' });
  await settle();
  expect(capture.observations).toHaveLength(1);
  expect(capture.observations[0]?.resolvedModelSlug).toBe('first');
});

it('an empty initial JSON does not exclude a later valid initial response', async () => {
  const capture = await hook(new Response('{}', { headers: { 'content-type': 'application/json' } }));
  await capture.fetch('/backend-api/conversation/original');
  await settle();
  capture.nativeFetch.mockResolvedValueOnce(record('valid'));
  await capture.fetch('/backend-api/conversation/original?decorative=true');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('valid'));
});

it.each(['intermediate', 'live', 'clear', 'expired'])('R1: discards an unmatched early read after %s', async (reason) => {
  const capture = await hook(record('prefetched'));
  await capture.fetch('/backend-api/conversation/next');
  await settle();
  if (reason === 'intermediate') capture.navigate('/c/intermediate');
  if (reason === 'live') {
    capture.nativeFetch.mockResolvedValueOnce(sse('data: [DONE]\n\n'));
    await capture.request();
    await settle();
  }
  if (reason === 'clear') capture.control({ clearedAt: new Date().toISOString() });
  if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
  capture.navigate('/c/next');
  await settle();
  expect(capture.observations.filter((o) => o.captureMode === 'reload')).toHaveLength(0);
});

it('R1: binds an early in-flight read once, never to a later return visit', async () => {
  const capture = await hook(record('next'));
  let resolve!: (response: Response) => void;
  capture.nativeFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
  const early = capture.fetch('/backend-api/conversation/next');
  capture.navigate('/c/next');
  const firstVisit = capture.contexts.at(-1)?.id;
  capture.navigate('/c/other');
  capture.navigate('/c/next');
  resolve(record('late-first-visit'));
  await early;
  await vi.waitFor(() => expect(capture.observations).toHaveLength(1));
  expect(capture.observations[0]?.captureContextId).toBe(firstVisit);
  expect(firstVisit).not.toBe(capture.contexts.at(-1)?.id);
});

it('F5: identity-only updates preserve the original model and do not create a reload turn', async () => {
  const { upsertTurn } = await import('../../src/core/turns');
  const { latestInContext } = await import('../../src/core/capture-context');
  const { DEFAULT_SETTINGS } = await import('../../src/core/types');
  const capture = await hook(sse(event({ resolved_model_slug: 'route' }) + event({ type: 'subscribe_ws_topic', topic_id: 'topic' })), '/');
  await capture.request(undefined, { model: 'route', conversation_id: null, messages: [{ id: 'first' }] });
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('route'));
  capture.socket().message(ws('wrong', event({ conversation_id: 'bad' })));
  await settle();
  expect(capture.contexts.at(-1)?.pageUrl).toBe('https://chatgpt.com/');
  capture.socket().message(ws('topic', event({ conversation_id: 'new' })));
  await vi.waitFor(() => expect(capture.observations.at(-1)?.conversationId).toBe('new'));
  capture.navigate('/c/new');
  const state = { settings: DEFAULT_SETTINGS, turns: capture.observations.reduce((turns, o) => upsertTurn(turns, { ...o, tabId: 1 }), [] as RouteTurn[]),
    powReadings: [], captureContexts: { 1: capture.contexts.at(-1)! }, parserHealth: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 } };
  expect(state.turns).toHaveLength(1);
  expect(latestInContext(state, 1, 'live')).toMatchObject({ routeModel: 'route', conversationId: 'new' });
  expect(latestInContext(state, 1, 'reload')).toBeNull();
});

it.each(['before-local', 'during-local', 'after-local'])('keeps live capture visible across temporary creation URL (identity %s)', async (order) => {
  const { upsertTurn } = await import('../../src/core/turns');
  const { latestInContext } = await import('../../src/core/capture-context');
  const { DEFAULT_SETTINGS } = await import('../../src/core/types');
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const capture = await hook(new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; } }), {
    headers: { 'content-type': 'text/event-stream' }
  }), '/');
  const send = (value: unknown) => stream.enqueue(new TextEncoder().encode(event(value)));
  await capture.request(undefined, { model: 'gpt-5-6-thinking', conversation_id: null, messages: [{ id: 'new-input' }] });
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('requested'));
  const current = (mode: 'live' | 'reload') => latestInContext({ settings: DEFAULT_SETTINGS,
    turns: capture.observations.reduce((turns, o) => upsertTurn(turns, { ...o, tabId: 1 }), [] as RouteTurn[]),
    powReadings: [], captureContexts: { 1: capture.contexts.at(-1)! },
    parserHealth: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 } }, 1, mode);
  const identity = async () => {
    send({ conversation_id: 'new-conversation' });
    await vi.waitFor(() => expect(capture.observations.at(-1)?.conversationId).toBe('new-conversation'));
  };
  if (order === 'before-local') await identity();
  capture.navigate('/c/local-chatgpt%3Adraft');
  expect(current('live')?.requestedModel).toBe('gpt-5-6-thinking');
  expect(current('reload')).toBeNull();
  if (order === 'during-local') await identity();
  capture.navigate('/c/new-conversation');
  if (order === 'after-local') await identity();
  send({ resolved_model_slug: 'gpt-5-6-thinking' });
  stream.close();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('completed'));
  expect(current('live')).toMatchObject({ requestedModel: 'gpt-5-6-thinking', resolvedModelSlug: 'gpt-5-6-thinking' });
  expect(current('reload')).toBeNull();
  // Creation readback is not a separate user reload.
  capture.nativeFetch.mockResolvedValueOnce(record('readback-route'));
  await capture.fetch('/backend-api/conversation/new-conversation');
  await settle();
  expect(current('reload')).toBeNull();
  capture.navigate('/c/unrelated');
  expect(current('live')).toBeNull();
});

it('captures live requests while the reload tab is selected', async () => {
  const capture = await hook(sse(event({ resolved_model_slug: 'gpt-live' }) + 'data: [DONE]\n\n'));
  capture.control({ captureMode: 'reload' });
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-live'));
  expect(capture.observations.every((item) => item.captureMode === 'live')).toBe(true);
});

it('captures conversation reloads while the live tab is selected', async () => {
  const capture = await hook(new Response(JSON.stringify({ resolved_model_slug: 'gpt-reload' }), {
    headers: { 'content-type': 'application/json' }
  }));
  capture.control({ captureMode: 'live' });
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-reload'));
  expect(capture.observations.every((item) => item.captureMode === 'reload')).toBe(true);
});

it('keeps an in-flight live stream when the display tab changes', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const capture = await hook(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), {
    headers: { 'content-type': 'text/event-stream' }
  }));
  capture.control({ captureMode: 'live' });
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('requested'));
  capture.control({ captureMode: 'reload', revision: 2 });
  stream.enqueue(new TextEncoder().encode(event({ resolved_model_slug: 'gpt-late' }) + 'data: [DONE]\n\n'));
  stream.close();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-late'));
});

it('ignores prefetches, post-live history reads and pagination without creating reload results', async () => {
  const capture = await hook(new Response(JSON.stringify({ resolved_model_slug: 'gpt-record' }), {
    headers: { 'content-type': 'application/json' }
  }));
  await capture.fetch('/backend-api/conversation/other');
  expect(capture.observations).toHaveLength(0);
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations).toHaveLength(1));
  await capture.fetch('/backend-api/conversation/original?cursor=old');
  await settle();
  expect(capture.observations).toHaveLength(1);
  capture.nativeFetch.mockResolvedValue(sse(event({ resolved_model_slug: 'gpt-live' }) + 'data: [DONE]\n\n'));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('completed'));
  await capture.fetch('/backend-api/conversation/original');
  await settle();
  expect(capture.observations.filter((item) => item.captureMode === 'reload')).toHaveLength(1);
});

it('stamps late reload responses with their original context after navigating elsewhere', async () => {
  let resolve!: (value: Response) => void;
  const capture = await hook(new Response());
  capture.nativeFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
  const old = capture.fetch('/backend-api/conversation/original');
  Object.assign(location, { pathname: '/c/other', href: 'https://chatgpt.com/c/other' });
  capture.nativeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ resolved_model_slug: 'gpt-new' }), {
    headers: { 'content-type': 'application/json' }
  }));
  await capture.fetch('/backend-api/conversation/other');
  await vi.waitFor(() => expect(capture.observations).toHaveLength(1));
  resolve(new Response(JSON.stringify({ resolved_model_slug: 'gpt-old' }), { headers: { 'content-type': 'application/json' } }));
  await old;
  await vi.waitFor(() => expect(capture.observations).toHaveLength(2));
  expect(capture.observations[0]?.captureContextId).not.toBe(capture.observations[1]?.captureContextId);
  expect(capture.observations[1]?.conversationId).toBe('original');
});

it('allows retrying a failed initial reload without capturing subsequent pagination', async () => {
  const capture = await hook(new Response('failed', { status: 503 }));
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('failed'));
  capture.nativeFetch.mockResolvedValue(new Response(JSON.stringify({ resolved_model_slug: 'retried' }), {
    headers: { 'content-type': 'application/json' }
  }));
  await capture.fetch('/backend-api/conversation/original');
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('retried'));
  await capture.fetch('/backend-api/conversation/original?cursor=old');
  await settle();
  expect(capture.observations).toHaveLength(2);
});

it('preserves a WebSocket handoff across display switches', async () => {
  const capture = await hook(handoff('topic'));
  capture.control({ captureMode: 'live' });
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('responding'));
  const contextId = capture.observations[0]?.captureContextId;
  capture.control({ captureMode: 'reload', revision: 2 });
  capture.socket().message(ws('topic', event({ resolved_model_slug: 'gpt-ws' })));
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('gpt-ws'));
  expect(capture.observations.at(-1)?.captureContextId).toBe(contextId);
});

it('treats browser-cache restoration as a new visit and does not reuse old captures', async () => {
  const capture = await hook(sse(event({ resolved_model_slug: 'first' }) + 'data: [DONE]\n\n'));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.phase).toBe('completed'));
  const previous = capture.observations.at(-1)?.captureContextId;
  capture.restore();
  capture.nativeFetch.mockResolvedValue(sse(event({ resolved_model_slug: 'second' }) + 'data: [DONE]\n\n'));
  await capture.request();
  await vi.waitFor(() => expect(capture.observations.at(-1)?.resolvedModelSlug).toBe('second'));
  expect(capture.observations.at(-1)?.captureContextId).not.toBe(previous);
});

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
  await capture.fetch('/backend-api/conversation/original');
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
  await capture.fetch('/backend-api/conversation/original');
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
