import { classifyEndpoint } from '../core/endpoints';
import { parsePowResponse } from '../core/pow';
import { hasUsageQuota, normalizeUsageQuota, parseUsageQuota, quotaSignature } from '../core/usage-quota';
import {
  parseConversationCapture,
  type ConversationCorrelation
} from '../core/request-parser';
import { mergeRouteFields, parseResponseValue, ResponseStreamParser } from '../core/response-parser';
import type { CaptureMode, PowObservation, RouteFields, RouteObservation, UsageQuotaFields } from '../core/types';
import { WebSocketRouteParser, type WebSocketRouteEvidence } from '../core/websocket-parser';
import type { PageBridgeEnvelope } from '../shared/messages';

const nativeFetch = window.fetch;
const nativeWebSocket = window.WebSocket;
const allowedOrigins = new Set(__ROUTE_INSPECTOR_ALLOWED_ORIGINS__);
const MAX_CONVERSATION_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_POW_RESPONSE_BYTES = 256 * 1024;
const MAX_PENDING_CAPTURES = 32;
const MAX_CAPTURE_TOPICS = 8;
const PENDING_CAPTURE_TTL_MS = 10 * 60 * 1000;
let captureEnabled = true;
let captureMode: CaptureMode | null = null;
let controlRevision = -1;
let clearedAt = 0;
let latestQuota: UsageQuotaFields | null = null;
const inspectionReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
  const data = event.data as Record<string, unknown>;
  if (data.source !== 'chatgpt-route-inspector-control' || data.version !== 1 ||
    typeof data.revision !== 'number' || data.revision < controlRevision ||
    typeof data.autoCaptureEnabled !== 'boolean' || !['live', 'reload'].includes(String(data.captureMode))) return;
  const nextClearedAt = typeof data.clearedAt === 'string' ? Date.parse(data.clearedAt) || 0 : 0;
  if (!data.autoCaptureEnabled || (captureMode !== null && captureMode !== data.captureMode) || nextClearedAt > clearedAt) {
    pendingLiveCaptures.clear();
    latestQuota = null;
    for (const reader of inspectionReaders) void reader.cancel().catch(() => undefined);
  }
  captureEnabled = data.autoCaptureEnabled;
  captureMode = data.captureMode as CaptureMode;
  controlRevision = data.revision;
  clearedAt = Math.max(clearedAt, nextClearedAt);
});
window.postMessage({ source: 'chatgpt-route-inspector-control-request' }, location.origin);

function canCapture(mode: CaptureMode | null, startedAt?: string): boolean {
  return captureEnabled && (!mode || !captureMode || mode === captureMode) &&
    (!startedAt || Date.parse(startedAt) > clearedAt);
}

function now(): string {
  return new Date().toISOString();
}

function safePageUrl(): string {
  return `${location.origin}${location.pathname}`;
}

function rememberQuota(fields: UsageQuotaFields, startedAt: string): UsageQuotaFields | null {
  if (!hasUsageQuota(fields) || !canCapture(null, startedAt)) return null;
  latestQuota = { ...normalizeUsageQuota(fields), quotaObservedAt: now() };
  return latestQuota;
}

function emit(observation: RouteObservation): void {
  if (!canCapture(observation.captureMode, observation.startedAt ?? observation.observedAt)) return;
  const envelope: PageBridgeEnvelope = {
    source: 'chatgpt-route-inspector',
    version: 1,
    observation
  };
  window.postMessage(envelope, location.origin);
}

function emitPow(pow: PowObservation): void {
  if (!canCapture(null, pow.startedAt ?? pow.observedAt)) return;
  const envelope: PageBridgeEnvelope = {
    source: 'chatgpt-route-inspector',
    version: 1,
    pow
  };
  window.postMessage(envelope, location.origin);
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  return String(input);
}

function isAllowedRequest(url: string): boolean {
  try {
    return allowedOrigins.has(location.origin) && new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

function fieldsSignature(fields: RouteFields): string {
  return JSON.stringify(fields);
}

interface PendingLiveCapture extends ConversationCorrelation {
  captureId: string;
  startedAt: string;
  pageUrl: string;
  expiresAt: number;
  httpActive: boolean;
  topicIds: Set<string>;
  webSocketFields: RouteFields;
  lastWebSocketSignature: string;
}

const pendingLiveCaptures = new Map<string, PendingLiveCapture>();

function prunePendingCaptures(timestamp = Date.now()): void {
  for (const [captureId, pending] of pendingLiveCaptures) {
    // An open HTTP response is still active, even while waiting for its first metadata.
    if (!pending.httpActive && pending.expiresAt <= timestamp) pendingLiveCaptures.delete(captureId);
  }
}

function registerPendingCapture(
  captureId: string,
  startedAt: string,
  correlation: ConversationCorrelation,
  pageUrl: string
): void {
  prunePendingCaptures();
  if (!correlation.conversationId && !correlation.inputMessageId && !correlation.parentMessageId) return;
  while (pendingLiveCaptures.size >= MAX_PENDING_CAPTURES) {
    const oldest = pendingLiveCaptures.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingLiveCaptures.delete(oldest);
  }
  const emptyFields = mergeRouteFields();
  pendingLiveCaptures.set(captureId, {
    captureId,
    startedAt,
    pageUrl,
    ...correlation,
    expiresAt: Date.now() + PENDING_CAPTURE_TTL_MS,
    httpActive: true,
    topicIds: new Set(),
    webSocketFields: emptyFields,
    lastWebSocketSignature: fieldsSignature(emptyFields)
  });
}

function uniqueCandidate(candidates: PendingLiveCapture[]): PendingLiveCapture | null {
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

function boundedCorrelationId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function rememberTopic(pending: PendingLiveCapture, topicId: string | null): void {
  if (topicId && pending.topicIds.size < MAX_CAPTURE_TOPICS) pending.topicIds.add(topicId);
}

function pendingCaptureFor(evidence: WebSocketRouteEvidence): PendingLiveCapture | null {
  prunePendingCaptures();
  const pending = [...pendingLiveCaptures.values()];
  const inputMatches = pending.filter((candidate) =>
    Boolean(candidate.inputMessageId) &&
    (evidence.messageIds.includes(candidate.inputMessageId ?? '') ||
      evidence.parentIds.includes(candidate.inputMessageId ?? ''))
  );
  const compatible = (candidate: PendingLiveCapture): boolean =>
    (!candidate.conversationId || evidence.conversationIds.length === 0 ||
      evidence.conversationIds.includes(candidate.conversationId)) &&
    (!evidence.topicId || candidate.topicIds.size === 0 || candidate.topicIds.has(evidence.topicId));

  const parentMatches = pending.filter((candidate) =>
    Boolean(candidate.parentMessageId) &&
    evidence.parentIds.includes(candidate.parentMessageId ?? '') &&
    (evidence.conversationIds.length === 0 ||
      !candidate.conversationId || evidence.conversationIds.includes(candidate.conversationId))
  );

  const topicMatches = pending.filter((candidate) => Boolean(evidence.topicId && candidate.topicIds.has(evidence.topicId)));
  if (topicMatches.length > 0) {
    const match = uniqueCandidate(topicMatches);
    // A topic must not override contradictory request/message identity.
    const identityMatches = inputMatches.length > 0 ? inputMatches : parentMatches;
    return match && compatible(match) && (identityMatches.length === 0 || identityMatches.includes(match)) ? match : null;
  }
  if (inputMatches.length > 0) return uniqueCandidate(inputMatches.filter(compatible));

  if (parentMatches.length > 0) return uniqueCandidate(parentMatches.filter(compatible));

  const conversationMatches = pending.filter((candidate) =>
    Boolean(candidate.conversationId) && evidence.conversationIds.includes(candidate.conversationId ?? '')
  );
  return uniqueCandidate(conversationMatches.filter(compatible));
}

function hasWebSocketMetadata(fields: RouteFields): boolean {
  return Boolean(
    fields.responseModelSlug ||
    fields.resolvedModelSlug ||
    fields.serverModelSlug ||
    fields.requestId ||
    fields.planType || hasUsageQuota(fields)
  );
}

function handleWebSocketText(raw: string, parser: WebSocketRouteParser): void {
  if (!canCapture('live') || pendingLiveCaptures.size === 0) { parser.clear(); return; }
  const evidenceItems = parser.parse(raw);
  const updates = new Map<string, { pending: PendingLiveCapture; fields: RouteFields; terminal: boolean; streamEnded: boolean }>();

  for (const evidence of evidenceItems) {
    const pending = pendingCaptureFor(evidence);
    if (!pending) continue;
    // Expire idle handoffs, not long-running answers; progress without model fields counts.
    pending.expiresAt = Date.now() + PENDING_CAPTURE_TTL_MS;
    rememberTopic(pending, evidence.topicId);
    if (evidence.errorCode) {
      emit({
        captureId: pending.captureId, source: 'page_websocket', captureMode: 'live', phase: 'failed',
        observedAt: now(), startedAt: pending.startedAt, pageUrl: pending.pageUrl, errorCode: evidence.errorCode
      });
      updates.delete(pending.captureId);
      pendingLiveCaptures.delete(pending.captureId);
      continue;
    }
    if (!pending.conversationId && evidence.conversationIds.length === 1) {
      pending.conversationId = evidence.conversationIds[0] ?? null;
    }
    const current = updates.get(pending.captureId);
    updates.set(pending.captureId, {
      pending,
      fields: mergeRouteFields(current?.fields ?? pending.webSocketFields, evidence.fields),
      terminal: Boolean(current?.terminal || evidence.terminal),
      streamEnded: Boolean(current?.streamEnded || evidence.streamEnded)
    });
  }

  for (const { pending, fields, terminal, streamEnded } of updates.values()) {
    if (hasUsageQuota(fields) && quotaSignature(fields) !== quotaSignature(pending.webSocketFields)) {
      Object.assign(fields, rememberQuota(fields, pending.startedAt));
    }
    pending.webSocketFields = mergeRouteFields(fields, { conversationId: pending.conversationId });
    const signature = fieldsSignature(pending.webSocketFields);
    const shouldEmit = hasWebSocketMetadata(pending.webSocketFields) &&
      (signature !== pending.lastWebSocketSignature || terminal);
    if (shouldEmit) {
      pending.lastWebSocketSignature = signature;
      const observedAt = now();
      const observation: RouteObservation = {
        captureId: pending.captureId,
        source: 'page_websocket',
        captureMode: 'live',
        phase: terminal ? 'completed' : 'responding',
        observedAt,
        startedAt: pending.startedAt,
        pageUrl: pending.pageUrl,
        ...pending.webSocketFields
      };
      if (terminal) observation.completedAt = observedAt;
      emit(observation);
    }
    if (streamEnded) pendingLiveCaptures.delete(pending.captureId);
  }
}

async function parseSseStream(
  response: Response,
  captureId: string,
  startedAt: string,
  baseFields: RouteFields,
  pageUrl: string
): Promise<void> {
  const body = response.body;
  if (!body) throw new Error('stream_body_missing');
  const reader = body.getReader();
  inspectionReaders.add(reader);
  const decoder = new TextDecoder();
  let handedOff = false;
  const parser = new ResponseStreamParser((event) => {
    const value = event.value as { type?: string; topic_id?: unknown; topic?: unknown } | null;
    if (value?.type === 'stream_handoff' || value?.type === 'subscribe_ws_topic') {
      handedOff = true;
      const pending = pendingLiveCaptures.get(captureId);
      if (pending) rememberTopic(pending, boundedCorrelationId(value.topic_id) ?? boundedCorrelationId(value.topic));
    }
  });
  let fields = baseFields;
  let streamQuota: UsageQuotaFields | null = null;
  const mergeStreamFields = (parsed: RouteFields): RouteFields => {
    const pending = pendingLiveCaptures.get(captureId);
    if (pending) {
      pending.expiresAt = Date.now() + PENDING_CAPTURE_TTL_MS;
      if (!pending.conversationId) pending.conversationId = boundedCorrelationId(parsed.conversationId);
    }
    if (hasUsageQuota(parsed) && (!streamQuota || quotaSignature(parsed) !== quotaSignature(streamQuota))) {
      streamQuota = rememberQuota(parsed, startedAt);
    }
    return mergeRouteFields(baseFields, parsed, streamQuota ?? {});
  };
  let lastSignature = fieldsSignature(fields);

  try {
    while (true) {
      const { value, done } = await reader.read();
      fields = mergeStreamFields(parser.push(decoder.decode(value, { stream: !done })));
      const signature = fieldsSignature(fields);
      if (signature !== lastSignature) {
        lastSignature = signature;
        emit({
          captureId,
          source: 'page_fetch',
          captureMode: 'live',
          phase: 'responding',
          observedAt: now(),
          startedAt,
          pageUrl,
          ...fields
        });
      }
      if (done) break;
    }
    fields = mergeStreamFields(parser.finish());
  } finally {
    // Cancel only the inspection branch of the cloned response; never block ChatGPT's reader.
    void reader.cancel().catch(() => undefined);
    inspectionReaders.delete(reader);
    const pending = pendingLiveCaptures.get(captureId);
    if (pending) {
      pending.httpActive = false;
      pending.expiresAt = Date.now() + PENDING_CAPTURE_TTL_MS;
    }
  }
  emit({
    captureId,
    source: 'page_fetch',
    captureMode: 'live',
    phase: handedOff ? 'responding' : 'completed',
    observedAt: now(),
    startedAt,
    ...(!handedOff ? { completedAt: now() } : {}),
    pageUrl,
    ...fields
  });
  if (!handedOff) pendingLiveCaptures.delete(captureId);
}

async function boundedResponseText(response: Response, maxBytes: number, errorCode: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  inspectionReaders.add(reader);
  try {
    if (Number(response.headers.get('content-length') ?? '0') > maxBytes) throw new Error(errorCode);
    const decoder = new TextDecoder();
    let bytes = 0;
    const chunks: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(errorCode);
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    inspectionReaders.delete(reader);
    void reader.cancel().catch(() => undefined);
  }
}

async function parseConversationJson(
  response: Response,
  captureId: string,
  startedAt: string,
  conversationId: string | null,
  pageUrl: string,
  quotaAtStart: Partial<UsageQuotaFields>
): Promise<void> {
  const raw = await boundedResponseText(response, MAX_CONVERSATION_RECORD_BYTES, 'record_too_large');
  const parsed: unknown = JSON.parse(raw);
  const ownQuota = rememberQuota(parseUsageQuota(parsed), startedAt);
  const results = parseResponseValue(parsed).filter((fields) =>
    Boolean(fields.responseModelSlug || fields.resolvedModelSlug || fields.serverModelSlug)
  );
  for (const [index, fields] of results.entries()) {
    emit({
      captureId: `${captureId}:${index}`,
      source: 'conversation_record',
      captureMode: 'reload',
      phase: 'completed',
      observedAt: now(),
      startedAt,
      completedAt: now(),
      pageUrl,
      ...mergeRouteFields(quotaAtStart, fields, ownQuota ?? {}),
      conversationId: conversationId ?? fields.conversationId
    });
  }
}

async function parseQuotaJson(response: Response, startedAt: string): Promise<void> {
  const raw = await boundedResponseText(response, MAX_POW_RESPONSE_BYTES, 'quota_too_large');
  if (canCapture(null, startedAt)) rememberQuota(parseUsageQuota(JSON.parse(raw) as unknown), startedAt);
}

async function parsePowJson(response: Response, startedAt: string): Promise<void> {
  const raw = await boundedResponseText(response, MAX_POW_RESPONSE_BYTES, 'pow_too_large');
  const parsed = parsePowResponse(JSON.parse(raw) as unknown);
  if (!parsed) return;
  emitPow({ rawHex: parsed.rawHex, observedAt: now(), startedAt });
}

async function inspectFetch(
  downstreamFetch: typeof window.fetch,
  receiver: unknown,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const downstreamReceiver = receiver ?? window;
  const url = requestUrl(input);
  const endpoint = classifyEndpoint(url, location.href);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const metadataOnly = endpoint.kind === 'pow_requirements' || endpoint.kind === 'conversation_init';
  const mode = metadataOnly ? null : endpoint.kind === 'conversation_stream' ? 'live' : 'reload';
  if (!canCapture(mode) || !isAllowedRequest(url) || endpoint.kind === 'other' ||
    (endpoint.kind === 'conversation_stream' && method !== 'POST')) {
    return downstreamFetch.call(downstreamReceiver, input, init);
  }

  const captureId = crypto.randomUUID();
  const startedAt = now();
  const pageUrl = safePageUrl();
  const quotaAtStart = latestQuota ? { ...latestQuota } : {};
  const bodyPromise = endpoint.kind === 'conversation_stream' ? requestBody(input, init) : Promise.resolve(null);
  const requestFieldsPromise = bodyPromise.then((raw) => {
    if (!raw) return null;
    const parsed = parseConversationCapture(raw);
    const fields = mergeRouteFields(quotaAtStart, parsed.fields);
    const { correlation } = parsed;
    if (!canCapture('live', startedAt)) return fields;
    registerPendingCapture(captureId, startedAt, correlation, pageUrl);
    emit({
      captureId,
      source: 'page_fetch',
      captureMode: 'live',
      phase: 'requested',
      observedAt: now(),
      startedAt,
      pageUrl,
      ...fields
    });
    return fields;
  });
  const failed = (errorCode: string): void => {
    pendingLiveCaptures.delete(captureId);
    if (metadataOnly) return;
    emit({
      captureId, source: endpoint.kind === 'conversation_stream' ? 'page_fetch' : 'conversation_record',
      captureMode: mode ?? 'live', phase: 'failed', observedAt: now(), startedAt, completedAt: now(),
      pageUrl, conversationId: endpoint.conversationId, errorCode
    });
  };
  let response: Response;
  try {
    response = await downstreamFetch.call(downstreamReceiver, input, init);
  } catch (error) {
    void requestFieldsPromise.then(() => failed(error instanceof Error ? error.name : 'fetch_failed'));
    throw error;
  }
  if (!canCapture(mode, startedAt)) return response;
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const validType = endpoint.kind === 'conversation_stream'
    ? contentType === 'text/event-stream'
    : contentType === 'application/json' || /^application\/[\w.-]+\+json$/.test(contentType);
  if (!response.ok || !validType) {
    void requestFieldsPromise.then(() => failed(!response.ok ? `http_${response.status}` : 'unexpected_content_type'));
    return response;
  }
  // Clone synchronously, before the page can lock its response, but keep all inspection errors off the page's fetch path.
  try {
    const clone = response.clone();
    void requestFieldsPromise.then(async (fields) => {
      if (!canCapture(mode, startedAt)) { void clone.body?.cancel().catch(() => undefined); return; }
      if (endpoint.kind === 'pow_requirements') await parsePowJson(clone, startedAt);
      else if (endpoint.kind === 'conversation_init') await parseQuotaJson(clone, startedAt);
      else if (endpoint.kind === 'conversation_stream') await parseSseStream(clone, captureId, startedAt, fields ?? mergeRouteFields(quotaAtStart), pageUrl);
      else await parseConversationJson(clone, captureId, startedAt, endpoint.conversationId, pageUrl, quotaAtStart);
    }).catch((error: unknown) => failed(error instanceof Error && error.message === 'record_too_large'
      ? 'record_too_large' : endpoint.kind === 'conversation_stream' ? 'stream_parse_failed' : 'record_parse_failed'));
  } catch {
    void requestFieldsPromise.then(() => failed('response_clone_failed'));
  }
  return response;
}

interface FetchGeneration {
  capturesRawResponse: boolean;
  downstream: typeof window.fetch;
  wrapper: typeof window.fetch;
}

function createFetchGeneration(
  downstream: typeof window.fetch,
  capturesRawResponse: boolean
): FetchGeneration {
  const generation = {
    capturesRawResponse,
    downstream,
    wrapper: nativeFetch
  } satisfies FetchGeneration;
  generation.wrapper = async function routeInspectorFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const receiver = this ?? window;
    if (generation.capturesRawResponse) {
      return inspectFetch(generation.downstream, receiver, input, init);
    }
    return generation.downstream.call(receiver, input, init);
  };
  return generation;
}

let currentFetchGeneration = createFetchGeneration(nativeFetch, true);

function adoptDownstreamFetch(candidate: unknown): void {
  if (typeof candidate !== 'function' || candidate === currentFetchGeneration.wrapper) return;
  currentFetchGeneration = createFetchGeneration(
    candidate as typeof window.fetch,
    candidate === nativeFetch
  );
}

function routeFetchGetter(): typeof window.fetch {
  return currentFetchGeneration.wrapper;
}

function routeFetchSetter(candidate: unknown): void {
  adoptDownstreamFetch(candidate);
}

function installFetchHook(): void {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'fetch');
    if (descriptor?.get === routeFetchGetter && descriptor.set === routeFetchSetter) return;
    adoptDownstreamFetch(window.fetch);
    try {
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: routeFetchGetter,
        set: routeFetchSetter
      });
    } catch {
      window.fetch = currentFetchGeneration.wrapper;
    }
  } catch {
    // A hostile or frozen page fetch must not throw repeatedly from the recovery timer.
  }
}

type WebSocketConstructor = typeof window.WebSocket;

interface WebSocketGeneration {
  capturesRawMessages: boolean;
  downstream: WebSocketConstructor;
  wrapper: WebSocketConstructor;
}

const observedSockets = new WeakSet<WebSocket>();

function isAllowedWebSocket(url: string): boolean {
  if (!allowedOrigins.has(location.origin)) return false;
  try {
    const parsed = new URL(url, location.href);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
    const httpOrigin = `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`;
    if (allowedOrigins.has(httpOrigin)) return true;
    const hostname = parsed.hostname.toLowerCase();
    return hostname.endsWith('.chatgpt.com') || hostname.endsWith('.openai.com');
  } catch {
    return false;
  }
}

function observeWebSocket(socket: WebSocket): void {
  if (observedSockets.has(socket) || !isAllowedWebSocket(socket.url)) return;
  observedSockets.add(socket);
  const parser = new WebSocketRouteParser();
  socket.addEventListener('close', () => parser.clear(), { once: true });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || !canCapture('live') || pendingLiveCaptures.size === 0) { parser.clear(); return; }
    const raw = event.data;
    queueMicrotask(() => handleWebSocketText(raw, parser));
  });
}

function copyWebSocketConstructorShape(
  wrapper: WebSocketConstructor,
  downstream: WebSocketConstructor
): void {
  try {
    Object.setPrototypeOf(wrapper, Object.getPrototypeOf(downstream));
  } catch {
    // Constructor inheritance is cosmetic; instance behavior remains native.
  }
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(downstream, key) ??
      Object.getOwnPropertyDescriptor(nativeWebSocket, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(wrapper, key, descriptor);
    } catch {
      // A non-standard downstream wrapper may expose non-configurable statics.
    }
  }
  try {
    Object.defineProperty(wrapper, 'prototype', {
      value: downstream.prototype,
      writable: false,
      enumerable: false,
      configurable: false
    });
  } catch {
    // The default wrapper prototype still leaves the returned native instance untouched.
  }
  try {
    Object.defineProperty(wrapper, 'name', { value: 'WebSocket', configurable: true });
    Object.defineProperty(wrapper, 'length', { value: downstream.length, configurable: true });
    const nativeSource = Function.prototype.toString.call(downstream);
    Object.defineProperty(wrapper, 'toString', {
      value: () => nativeSource,
      configurable: true
    });
  } catch {
    // Function metadata must never prevent the page from constructing a socket.
  }
}

function createWebSocketGeneration(
  downstream: WebSocketConstructor,
  capturesRawMessages: boolean
): WebSocketGeneration {
  const generation = {
    capturesRawMessages,
    downstream,
    wrapper: nativeWebSocket
  } satisfies WebSocketGeneration;
  generation.wrapper = function routeInspectorWebSocket(
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[]
  ): WebSocket {
    if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    const argumentsList = arguments.length > 1 ? [url, protocols] : [url];
    const invokedTarget = new.target as unknown as WebSocketConstructor;
    const newTarget = invokedTarget === generation.wrapper
      ? generation.downstream
      : invokedTarget;
    const socket = Reflect.construct(generation.downstream, argumentsList, newTarget) as WebSocket;
    if (generation.capturesRawMessages) observeWebSocket(socket);
    return socket;
  } as unknown as WebSocketConstructor;
  copyWebSocketConstructorShape(generation.wrapper, downstream);
  return generation;
}

let currentWebSocketGeneration = createWebSocketGeneration(nativeWebSocket, true);

function adoptDownstreamWebSocket(candidate: unknown): void {
  if (typeof candidate !== 'function' || candidate === currentWebSocketGeneration.wrapper) return;
  currentWebSocketGeneration = createWebSocketGeneration(
    candidate as WebSocketConstructor,
    candidate === nativeWebSocket
  );
}

function routeWebSocketGetter(): WebSocketConstructor {
  return currentWebSocketGeneration.wrapper;
}

function routeWebSocketSetter(candidate: unknown): void {
  adoptDownstreamWebSocket(candidate);
}

function installWebSocketHook(): void {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'WebSocket');
    if (descriptor?.get === routeWebSocketGetter && descriptor.set === routeWebSocketSetter) return;
    adoptDownstreamWebSocket(window.WebSocket);
    try {
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: routeWebSocketGetter,
        set: routeWebSocketSetter
      });
    } catch {
      window.WebSocket = currentWebSocketGeneration.wrapper;
    }
  } catch {
    // A hostile or frozen page WebSocket must not break ChatGPT or the recovery timer.
  }
}

installFetchHook();
installWebSocketHook();
queueMicrotask(() => {
  installFetchHook();
  installWebSocketHook();
});
document.addEventListener('DOMContentLoaded', () => {
  installFetchHook();
  installWebSocketHook();
}, { once: true });
window.addEventListener('load', () => {
  installFetchHook();
  installWebSocketHook();
}, { once: true });
window.setInterval(() => {
  installFetchHook();
  installWebSocketHook();
  prunePendingCaptures();
}, 1000);
