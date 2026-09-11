import { EMPTY_ROUTE_FIELDS, type CaptureMode, type CapturePhase, type CaptureSource, type RouteFields, type RouteObservation } from './types';
import { redactConversationPathname } from './chatgpt-path';
import { normalizeUsageQuota } from './usage-quota';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function boundedString(value: unknown, maxLength = 512): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : null;
}

function validDate(value: unknown): string | null {
  const string = boundedString(value, 64);
  return string && Number.isFinite(Date.parse(string)) ? string : null;
}

function safePageUrl(value: unknown): string | null {
  const string = boundedString(value, 4096);
  if (!string) return null;
  try {
    const url = new URL(string);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.search = '';
    url.hash = '';
    url.pathname = redactConversationPathname(url.pathname)
      .replace(/^\/backend-api\/(conversations?)\/[^/]+/, '/backend-api/$1/[redacted]');
    return url.toString();
  } catch {
    return null;
  }
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : null;
}

function routeFields(record: UnknownRecord): RouteFields {
  return {
    ...EMPTY_ROUTE_FIELDS,
    ...normalizeUsageQuota(record),
    requestedModel: boundedString(record.requestedModel, 256),
    responseModelSlug: boundedString(record.responseModelSlug, 256),
    defaultModelSlug: boundedString(record.defaultModelSlug, 256),
    resolvedModelSlug: boundedString(record.resolvedModelSlug, 256),
    serverModelSlug: boundedString(record.serverModelSlug, 256),
    domModelSlug: boundedString(record.domModelSlug, 256),
    thinkingEffort: boundedString(record.thinkingEffort, 128),
    planType: boundedString(record.planType, 128),
    requestId: boundedString(record.requestId),
    conversationId: boundedString(record.conversationId),
    conversationMode: boundedString(record.conversationMode, 128),
    selectedSourcesCount: countOrNull(record.selectedSourcesCount),
    toolInvoked: booleanOrNull(record.toolInvoked),
    toolName: boundedString(record.toolName, 256),
    isSearch: booleanOrNull(record.isSearch),
    hadImage: booleanOrNull(record.hadImage),
    fastConvo: booleanOrNull(record.fastConvo)
  };
}

export function normalizeObservation(value: unknown): RouteObservation | null {
  const record = asRecord(value);
  if (!record) return null;
  const captureId = boundedString(record.captureId);
  const observedAt = validDate(record.observedAt);
  const source = record.source;
  const captureMode = record.captureMode;
  const phase = record.phase;
  if (!captureId || !observedAt || !['page_fetch', 'page_websocket', 'conversation_record', 'assistant_dom'].includes(String(source))) return null;
  if (!['live', 'reload'].includes(String(captureMode))) return null;
  if (!['requested', 'responding', 'completed', 'failed'].includes(String(phase))) return null;

  const result: RouteObservation = {
    captureId,
    source: source as CaptureSource,
    captureMode: captureMode as CaptureMode,
    phase: phase as CapturePhase,
    observedAt,
    ...routeFields(record)
  };
  if (typeof record.tabId === 'number' && Number.isInteger(record.tabId) && record.tabId >= 0) result.tabId = record.tabId;
  const pageUrl = safePageUrl(record.pageUrl);
  if (pageUrl) result.pageUrl = pageUrl;
  const networkRequestId = boundedString(record.networkRequestId);
  if (networkRequestId) result.networkRequestId = networkRequestId;
  const startedAt = validDate(record.startedAt);
  if (startedAt) result.startedAt = startedAt;
  const completedAt = validDate(record.completedAt);
  if (completedAt) result.completedAt = completedAt;
  const errorCode = boundedString(record.errorCode, 128);
  if (errorCode) result.errorCode = errorCode;
  return result;
}
