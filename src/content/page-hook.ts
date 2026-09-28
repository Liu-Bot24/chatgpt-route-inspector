import { classifyEndpoint } from '../core/endpoints';
import { CaptureContextTracker, contextConversation } from '../core/capture-context';
import { parsePowResponse } from '../core/pow';
import { hasUsageQuota, normalizeUsageQuota, parseUsageQuota, quotaSignature } from '../core/usage-quota';
import {
  parseConversationCapture,
  type ConversationCorrelation
} from '../core/request-parser';
import { mergeRouteFields, parseResponseValue, ResponseStreamParser } from '../core/response-parser';
import type { CaptureContext, CaptureMode, PowObservation, RouteFields, RouteObservation, UsageQuotaFields } from '../core/types';
import { WebSocketRouteParser, type WebSocketRouteEvidence } from '../core/websocket-parser';
import type { PageBridgeEnvelope } from '../shared/messages';
import { TaskCaptures } from '../core/task-captures';
import { currentTaskIdentity, type TaskIdentity } from '../core/task-identity';

const nativeFetch = window.fetch;
const nativeWebSocket = window.WebSocket;
const allowedOrigins = new Set(__ROUTE_INSPECTOR_ALLOWED_ORIGINS__);
const MAX_CONVERSATION_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_POW_RESPONSE_BYTES = 256 * 1024;
const MAX_PENDING_CAPTURES = 32;
const MAX_CAPTURE_TOPICS = 8;
const PENDING_CAPTURE_TTL_MS = 10 * 60 * 1000;
let captureEnabled = true;
const taskCaptures = new TaskCaptures();
let captureContext = new CaptureContextTracker(`${location.origin}${location.pathname}`);
let lastContextSignature = '';
interface ReloadVisit { context: CaptureContext; committedStartedAt: string | null; unresolvedCreation: boolean; discarded?: boolean }
interface ReloadCandidate {
  originContextId: string;
  conversationId: string;
  startedAt: string;
  visit: ReloadVisit | null;
  deliver?: () => void;
}
let reloadVisit: ReloadVisit = { context: captureContext.snapshot(), committedStartedAt: null, unresolvedCreation: false };
const deferredReloads = new Set<ReloadCandidate>();
// Off-route reads may precede SPA navigation. Keep only bounded, short-lived candidates;
// they cannot produce observations unless the very next visit matches their identity.
const earlyReloads = new Set<ReloadCandidate>();
const EARLY_RELOAD_TTL_MS = 30_000;

function syncReloadVisit(context: CaptureContext): void {
  if (reloadVisit.context.id === context.id) {
    reloadVisit.unresolvedCreation = captureContext.hasUnresolvedCreation();
    if (!reloadVisit.unresolvedCreation) {
      for (const candidate of deferredReloads) {
        if (Date.now() - Date.parse(candidate.startedAt) <= EARLY_RELOAD_TTL_MS) candidate.deliver?.();
      }
      deferredReloads.clear();
    }
    return;
  }
  deferredReloads.clear();
  const previousId = reloadVisit.context.id;
  reloadVisit = { context, committedStartedAt: null, unresolvedCreation: captureContext.hasUnresolvedCreation() };
  for (const candidate of earlyReloads) {
    if (candidate.originContextId === previousId && candidate.conversationId === contextConversation(context) &&
      Date.now() - Date.parse(candidate.startedAt) <= EARLY_RELOAD_TTL_MS && captureContext.canStartReload()) {
      candidate.visit = reloadVisit;
      candidate.deliver?.();
    }
  }
  earlyReloads.clear();
}

function publishContext(force = false): void {
  captureContext.navigate(`${location.origin}${location.pathname}`);
  if (!captureEnabled && captureContext.snapshot().reloadEligible) captureContext.stopFallback();
  const context = captureContext.snapshot();
  const signature = JSON.stringify(context);
  if (!force && lastContextSignature === signature) return;
  lastContextSignature = signature;
  window.postMessage({ source: 'chatgpt-route-inspector-context', version: 1, context }, location.origin);
  syncReloadVisit(context);
}
let controlRevision = -1;
let clearedAt = 0;
let latestQuota: UsageQuotaFields | null = null;
const inspectionReaders = new Map<ReadableStreamDefaultReader<Uint8Array>, string>();
let captureEpoch = 0;

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
  const data = event.data as Record<string, unknown>;
  if (data.source === 'chatgpt-route-inspector-context-request') { publishContext(true); return; }
  if (data.source !== 'chatgpt-route-inspector-control' || data.version !== 1 ||
    typeof data.revision !== 'number' || data.revision < controlRevision ||
    typeof data.autoCaptureEnabled !== 'boolean' || !['live', 'reload'].includes(String(data.captureMode))) return;
  const nextClearedAt = typeof data.clearedAt === 'string' ? Date.parse(data.clearedAt) || 0 : 0;
  const pausing = captureEnabled && !data.autoCaptureEnabled;
  if (pausing || nextClearedAt > clearedAt) {
    taskCaptures.clear(pausing ? Infinity : nextClearedAt);
    if (pausing) captureEpoch++;
    for (const [id, pending] of pendingLiveCaptures) {
      if (pausing || Date.parse(pending.startedAt) <= nextClearedAt) pendingLiveCaptures.delete(id);
    }
    if (pausing || Date.parse(latestQuota?.quotaObservedAt ?? '') <= nextClearedAt) latestQuota = null;
    for (const [reader, startedAt] of inspectionReaders) {
      if (pausing || Date.parse(startedAt) <= nextClearedAt) void reader.cancel().catch(() => undefined);
    }
    for (const candidate of earlyReloads) {
      if (pausing || Date.parse(candidate.startedAt) <= nextClearedAt) earlyReloads.delete(candidate);
    }
    for (const candidate of deferredReloads) {
      if (pausing || Date.parse(candidate.startedAt) <= nextClearedAt) deferredReloads.delete(candidate);
    }
    if (pausing) captureContext.stopFallback();
    else {
      captureContext.clearBefore(nextClearedAt);
      if (reloadVisit.unresolvedCreation && !captureContext.hasUnresolvedCreation()) {
        // Clearing an unresolved creation is not evidence that its readback was unrelated.
        reloadVisit.discarded = true;
        reloadVisit = { ...reloadVisit, discarded: false, unresolvedCreation: false };
      }
    }
    if (pausing || Date.parse(reloadVisit.committedStartedAt ?? '') <= nextClearedAt) reloadVisit.committedStartedAt = null;
    publishContext();
  }
  captureEnabled = data.autoCaptureEnabled;
  controlRevision = data.revision;
  clearedAt = Math.max(clearedAt, nextClearedAt);
});
window.postMessage({ source: 'chatgpt-route-inspector-control-request' }, location.origin);

function canCapture(_mode: CaptureMode | null, startedAt?: string): boolean {
  return captureEnabled &&
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

function emit(observation: RouteObservation, identity?: TaskIdentity | null): void {
  if (!canCapture(observation.captureMode, observation.startedAt ?? observation.observedAt)) return;
  if (observation.captureMode === 'live' && observation.captureContextId) {
    publishContext();
    captureContext.observeLive(observation.captureContextId, observation.conversationId);
    if (observation.phase === 'failed' && ![...pendingLiveCaptures.values()].some((pending) =>
      pending.captureContextId === observation.captureContextId && pending.captureId !== observation.captureId)) {
      captureContext.abandonCreation(observation.captureContextId);
    }
    publishContext();
  }
  const envelope: PageBridgeEnvelope = {
    source: 'chatgpt-route-inspector',
    version: 1,
    observation
  };
  window.postMessage(envelope, location.origin);
  taskCaptures.observe(observation, captureContext.snapshot().id, Date.now(), identity);
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
  captureContextId: string;
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
  pageUrl: string,
  captureContextId: string
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
    captureContextId,
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
    fields.planType || fields.taskKind || hasUsageQuota(fields)
  );
}

function handleWebSocketText(raw: string, parser: WebSocketRouteParser): void {
  if (canCapture('live')) {
    publishContext();
    for (const update of taskCaptures.consume(raw, captureContext.snapshot().id)) emit(update);
  }
  if (!canCapture('live') || pendingLiveCaptures.size === 0) { parser.clear(); return; }
  const evidenceItems = parser.parse(raw);
  const updates = new Map<string, { pending: PendingLiveCapture; fields: RouteFields; terminal: boolean; streamEnded: boolean; identityChanged: boolean }>();

  for (const evidence of evidenceItems) {
    const pending = pendingCaptureFor(evidence);
    if (!pending) continue;
    // Expire idle handoffs, not long-running answers; progress without model fields counts.
    pending.expiresAt = Date.now() + PENDING_CAPTURE_TTL_MS;
    rememberTopic(pending, evidence.topicId);
    const identityChanged = !pending.conversationId && evidence.conversationIds.length === 1;
    if (identityChanged) pending.conversationId = evidence.conversationIds[0] ?? null;
    if (evidence.errorCode) {
      emit({
        ...mergeRouteFields(updates.get(pending.captureId)?.fields ?? pending.webSocketFields, { conversationId: pending.conversationId }),
        captureId: pending.captureId, captureContextId: pending.captureContextId, source: 'page_websocket', captureMode: 'live', phase: 'failed',
        observedAt: now(), startedAt: pending.startedAt, pageUrl: pending.pageUrl, errorCode: evidence.errorCode
      });
      updates.delete(pending.captureId);
      pendingLiveCaptures.delete(pending.captureId);
      continue;
    }
    taskCaptures.rememberIdentities(pending.captureId, pending.captureContextId, evidence.taskIdentities);
    const current = updates.get(pending.captureId);
    updates.set(pending.captureId, {
      pending,
      identityChanged: Boolean(current?.identityChanged || identityChanged),
      fields: mergeRouteFields(current?.fields ?? pending.webSocketFields, evidence.fields),
      terminal: Boolean(current?.terminal || evidence.terminal),
      streamEnded: Boolean(current?.streamEnded || evidence.streamEnded)
    });
  }

  for (const { pending, fields, terminal, streamEnded, identityChanged } of updates.values()) {
    if (hasUsageQuota(fields) && quotaSignature(fields) !== quotaSignature(pending.webSocketFields)) {
      Object.assign(fields, rememberQuota(fields, pending.startedAt));
    }
    pending.webSocketFields = mergeRouteFields(fields, { conversationId: pending.conversationId });
    const signature = fieldsSignature(pending.webSocketFields);
    const shouldEmit = (hasWebSocketMetadata(pending.webSocketFields) || identityChanged) &&
      (signature !== pending.lastWebSocketSignature || terminal);
    if (shouldEmit) {
      pending.lastWebSocketSignature = signature;
      const observedAt = now();
      const observation: RouteObservation = {
        captureId: pending.captureId,
        captureContextId: pending.captureContextId,
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
  pageUrl: string,
  captureContextId: string,
  epoch: number
): Promise<void> {
  const body = response.body;
  if (!body) throw new Error('stream_body_missing');
  const reader = body.getReader();
  inspectionReaders.set(reader, startedAt);
  const decoder = new TextDecoder();
  let handedOff = false;
  const parser = new ResponseStreamParser((event) => {
    if (!event.done && epoch === captureEpoch && canCapture('live', startedAt)) {
      taskCaptures.rememberStream(captureId, captureContextId, event.value);
    }
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
      if (epoch !== captureEpoch || !canCapture('live', startedAt)) return;
      fields = mergeStreamFields(parser.push(decoder.decode(value, { stream: !done })));
      const signature = fieldsSignature(fields);
      if (signature !== lastSignature) {
        lastSignature = signature;
        emit({
          captureId,
          captureContextId,
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
    captureContextId,
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

async function boundedResponseText(response: Response, maxBytes: number, errorCode: string, startedAt: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  inspectionReaders.set(reader, startedAt);
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
  quotaAtStart: Partial<UsageQuotaFields>,
  candidate: ReloadCandidate,
  epoch: number
): Promise<void> {
  const raw = await boundedResponseText(response, MAX_CONVERSATION_RECORD_BYTES, 'record_too_large', startedAt);
  const parsed: unknown = JSON.parse(raw);
  const taskAnchor = currentTaskIdentity(parsed);
  const parsedQuota = parseUsageQuota(parsed);
  const results = parseResponseValue(parsed).filter((fields) =>
    Boolean(fields.responseModelSlug || fields.resolvedModelSlug || fields.serverModelSlug || fields.taskKind)
  );
  candidate.deliver = () => {
    if (!candidate.visit || candidate.visit.discarded || candidate.visit.committedStartedAt || epoch !== captureEpoch || !canCapture('reload', startedAt)) return;
    if (candidate.visit.unresolvedCreation) {
      // The URL alone cannot distinguish creation readback from loading another conversation.
      // Keep evidence bounded and invisible until live identity resolves that ambiguity.
      if (candidate.visit === reloadVisit && Date.now() - Date.parse(startedAt) <= EARLY_RELOAD_TTL_MS) {
        if (deferredReloads.size >= MAX_PENDING_CAPTURES) deferredReloads.delete(deferredReloads.values().next().value!);
        deferredReloads.add(candidate);
      }
      return;
    }
    const ownQuota = candidate.visit === reloadVisit ? rememberQuota(parsedQuota, startedAt) : null;
    if (!results.length) return;
    candidate.visit.committedStartedAt = startedAt;
    for (const [index, fields] of results.entries()) {
      emit({
        captureId: `${captureId}:${index}`,
        captureContextId: candidate.visit.context.id,
        source: 'conversation_record',
        captureMode: 'reload',
        phase: 'completed',
        observedAt: now(),
        startedAt,
        completedAt: now(),
        pageUrl: candidate.visit.context.pageUrl,
        ...mergeRouteFields(quotaAtStart, fields, ownQuota ?? {}),
        conversationId: conversationId ?? fields.conversationId
      }, results.length === 1 ? taskAnchor : null);
    }
  };
  candidate.deliver();
}

async function parseQuotaJson(response: Response, startedAt: string, epoch: number): Promise<void> {
  const raw = await boundedResponseText(response, MAX_POW_RESPONSE_BYTES, 'quota_too_large', startedAt);
  if (epoch === captureEpoch && canCapture(null, startedAt)) rememberQuota(parseUsageQuota(JSON.parse(raw) as unknown), startedAt);
}

async function parsePowJson(response: Response, startedAt: string, epoch: number): Promise<void> {
  const raw = await boundedResponseText(response, MAX_POW_RESPONSE_BYTES, 'pow_too_large', startedAt);
  const parsed = parsePowResponse(JSON.parse(raw) as unknown);
  if (!parsed || epoch !== captureEpoch) return;
  emitPow({ rawHex: parsed.rawHex, observedAt: now(), startedAt });
}

async function inspectFetch(
  downstreamFetch: typeof window.fetch,
  receiver: unknown,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const downstreamReceiver = receiver ?? window;
  publishContext();
  const url = requestUrl(input);
  const endpoint = classifyEndpoint(url, location.href);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const metadataOnly = endpoint.kind === 'pow_requirements' || endpoint.kind === 'conversation_init';
  const mode = metadataOnly ? null : endpoint.kind === 'conversation_stream' ? 'live' : 'reload';
  if (!canCapture(mode) || !isAllowedRequest(url) || endpoint.kind === 'other' ||
    (endpoint.kind === 'conversation_stream' && method !== 'POST')) {
    return downstreamFetch.call(downstreamReceiver, input, init);
  }

  const context = captureContext.snapshot();
  const startedAt = now();
  const epoch = captureEpoch;
  let reloadCandidate: ReloadCandidate | null = null;
  if (endpoint.kind === 'conversation_record') {
    const sameConversation = endpoint.conversationId === contextConversation(context);
    if (method !== 'GET' || !endpoint.conversationId ||
      (sameConversation && (!captureContext.canStartReload() || reloadVisit.committedStartedAt))) {
      return downstreamFetch.call(downstreamReceiver, input, init);
    }
    reloadCandidate = { originContextId: context.id, conversationId: endpoint.conversationId,
      startedAt, visit: sameConversation ? reloadVisit : null };
    if (!sameConversation) {
      for (const candidate of earlyReloads) {
        if (Date.now() - Date.parse(candidate.startedAt) > EARLY_RELOAD_TTL_MS) earlyReloads.delete(candidate);
      }
      if (earlyReloads.size >= MAX_PENDING_CAPTURES) earlyReloads.delete(earlyReloads.values().next().value!);
      earlyReloads.add(reloadCandidate);
    }
  }
  if (endpoint.kind === 'conversation_stream') {
    earlyReloads.clear();
    deferredReloads.clear();
    if (reloadVisit.unresolvedCreation) reloadVisit.discarded = true;
    captureContext.startLive();
    publishContext();
  }
  const captureContextId = context.id;

  const captureId = crypto.randomUUID();
  const pageUrl = safePageUrl();
  const quotaAtStart = latestQuota ? { ...latestQuota } : {};
  const bodyPromise = endpoint.kind === 'conversation_stream' ? requestBody(input, init) : Promise.resolve(null);
  const requestFieldsPromise = bodyPromise.then((raw) => {
    if (!raw) return null;
    const parsed = parseConversationCapture(raw);
    const fields = mergeRouteFields(quotaAtStart, parsed.fields);
    const { correlation } = parsed;
    if (epoch !== captureEpoch || !canCapture('live', startedAt)) return fields;
    registerPendingCapture(captureId, startedAt, correlation, pageUrl, captureContextId);
    emit({
      captureId,
      captureContextId,
      source: 'page_fetch',
      captureMode: 'live',
      phase: 'requested',
      observedAt: now(),
      startedAt,
      pageUrl,
      ...fields
    }, { messageId: correlation.inputMessageId, parentId: null, workingTurnId: null, exchangeId: null });
    return fields;
  });
  const failed = (errorCode: string): void => {
    pendingLiveCaptures.delete(captureId);
    if (metadataOnly || epoch !== captureEpoch) return;
    if (reloadCandidate && (!reloadCandidate.visit || reloadCandidate.visit.unresolvedCreation || reloadCandidate.visit.committedStartedAt)) return;
    emit({
      captureId, captureContextId: reloadCandidate?.visit?.context.id ?? captureContextId, source: endpoint.kind === 'conversation_stream' ? 'page_fetch' : 'conversation_record',
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
  if (epoch !== captureEpoch || !canCapture(mode, startedAt)) return response;
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
      if (epoch !== captureEpoch || !canCapture(mode, startedAt)) { void clone.body?.cancel().catch(() => undefined); return; }
      if (endpoint.kind === 'pow_requirements') await parsePowJson(clone, startedAt, epoch);
      else if (endpoint.kind === 'conversation_init') await parseQuotaJson(clone, startedAt, epoch);
      else if (endpoint.kind === 'conversation_stream') await parseSseStream(clone, captureId, startedAt, fields ?? mergeRouteFields(quotaAtStart), pageUrl, captureContextId, epoch);
      else if (reloadCandidate) await parseConversationJson(clone, captureId, startedAt, endpoint.conversationId, quotaAtStart, reloadCandidate, epoch);
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
    if (typeof event.data !== 'string' || !canCapture('live')) { parser.clear(); return; }
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
publishContext();
// Detect SPA navigation synchronously, including navigation with no network or DOM changes.
try {
  for (const method of ['pushState', 'replaceState'] as const) {
    if (!window.history) break;
    const original = window.history[method];
    window.history[method] = function (...args) {
      const result = original.apply(this, args);
      publishContext();
      return result;
    };
  }
} catch {
  // Frozen history methods still have the fetch, popstate and recovery-timer checks.
}
window.addEventListener('popstate', () => publishContext());
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  captureEpoch++;
  earlyReloads.clear();
  deferredReloads.clear();
  for (const reader of inspectionReaders.keys()) void reader.cancel().catch(() => undefined);
  pendingLiveCaptures.clear();
  taskCaptures.clear();
  latestQuota = null;
  captureContext = new CaptureContextTracker(`${location.origin}${location.pathname}`);
  publishContext();
});
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
  for (const candidate of deferredReloads) {
    if (Date.now() - Date.parse(candidate.startedAt) > EARLY_RELOAD_TTL_MS) deferredReloads.delete(candidate);
  }
  for (const candidate of earlyReloads) {
    if (Date.now() - Date.parse(candidate.startedAt) > EARLY_RELOAD_TTL_MS) earlyReloads.delete(candidate);
  }
  publishContext();
  installFetchHook();
  installWebSocketHook();
  prunePendingCaptures();
}, 1000);
