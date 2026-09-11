import { EMPTY_ROUTE_FIELDS, type RouteFields } from './types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function correlationValue(value: unknown): string | null {
  const string = stringValue(value);
  return string && string.length <= 512 ? string : null;
}

function parseRoot(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export interface ConversationCorrelation {
  conversationId: string | null;
  inputMessageId: string | null;
  parentMessageId: string | null;
}

export function parseConversationCorrelation(raw: string): ConversationCorrelation {
  return correlationFromRoot(parseRoot(raw));
}

function correlationFromRoot(root: Record<string, unknown> | null): ConversationCorrelation {
  const messages = Array.isArray(root?.messages) ? root.messages : [];
  const firstMessage = asRecord(messages[0]);
  return {
    conversationId: correlationValue(root?.conversation_id),
    inputMessageId: correlationValue(firstMessage?.id),
    parentMessageId: correlationValue(root?.parent_message_id)
  };
}

export function parseConversationRequest(raw: string): RouteFields {
  return fieldsFromRoot(parseRoot(raw));
}

export function parseConversationCapture(raw: string): { fields: RouteFields; correlation: ConversationCorrelation } {
  const root = parseRoot(raw);
  return { fields: fieldsFromRoot(root), correlation: correlationFromRoot(root) };
}

function fieldsFromRoot(root: Record<string, unknown> | null): RouteFields {
  if (!root) return { ...EMPTY_ROUTE_FIELDS };
  const mode = asRecord(root.conversation_mode);
  const messages = Array.isArray(root.messages) ? root.messages : [];
  const firstMessage = asRecord(messages[0]);
  const metadata = asRecord(firstMessage?.metadata);
  const selectedSources = Array.isArray(metadata?.selected_sources) ? metadata.selected_sources : null;

  return {
    ...EMPTY_ROUTE_FIELDS,
    requestedModel: stringValue(root.model),
    thinkingEffort: stringValue(root.thinking_effort),
    conversationId: stringValue(root.conversation_id),
    conversationMode: stringValue(mode?.kind),
    selectedSourcesCount: selectedSources?.length ?? null
  };
}
