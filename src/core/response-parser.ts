import { EMPTY_ROUTE_FIELDS, type RouteFields } from './types';
import { SseDecoder, type DecodedSseEvent } from './sse-decoder';
import { parseUsageQuota } from './usage-quota';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function identifier(value: unknown): string | null {
  return stringValue(value) ?? stringValue(asRecord(value)?.id);
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function mergeFields(base: RouteFields, next: Partial<RouteFields>): RouteFields {
  const result = { ...base };
  for (const [key, value] of Object.entries(next) as Array<[keyof RouteFields, RouteFields[keyof RouteFields]]>) {
    if (value !== null && value !== undefined) {
      (result as Record<keyof RouteFields, RouteFields[keyof RouteFields]>)[key] = value;
    }
  }
  return result;
}

function extractMetadata(metadata: UnknownRecord, modelKind: 'assistant' | 'server' | 'none' = 'none'): Partial<RouteFields> {
  const model = stringValue(metadata.model_slug);
  return {
    ...parseUsageQuota(metadata),
    responseModelSlug: modelKind === 'assistant' ? model : null,
    serverModelSlug: modelKind === 'server' ? model : null,
    defaultModelSlug: stringValue(metadata.default_model_slug),
    resolvedModelSlug: stringValue(metadata.resolved_model_slug),
    planType: stringValue(metadata.plan_type),
    requestId: stringValue(metadata.request_id),
    conversationId: stringValue(metadata.conversation_id),
    toolInvoked: booleanValue(metadata.tool_invoked),
    toolName: stringValue(metadata.tool_name),
    isSearch: booleanValue(metadata.is_search),
    hadImage: booleanValue(metadata.did_prompt_contain_image),
    fastConvo: booleanValue(metadata.fast_convo)
  };
}

function walkForFields(value: unknown, accumulator: RouteFields, depth = 0, budget = { count: 0 }): RouteFields {
  if (depth > 10 || budget.count > 3000) return accumulator;
  budget.count += 1;
  if (Array.isArray(value)) {
    let result = accumulator;
    for (const item of value) {
      if (budget.count > 3000) break;
      result = walkForFields(item, result, depth + 1, budget);
    }
    return result;
  }
  const record = asRecord(value);
  if (!record) return accumulator;

  let result = accumulator;
  const metadata = asRecord(record.metadata);
  if (record.type === 'server_ste_metadata' && metadata) {
    result = mergeFields(result, extractMetadata(metadata, 'server'));
  } else {
    result = mergeFields(result, extractMetadata(record));
    if (metadata) {
      const author = asRecord(record.author);
      result = mergeFields(result, extractMetadata(metadata, author?.role === 'assistant' ? 'assistant' : 'none'));
    }
  }

  if (typeof record.conversation_id === 'string') {
    result = mergeFields(result, { conversationId: record.conversation_id });
  }

  for (const [key, nested] of Object.entries(record)) {
    if (budget.count > 3000) break;
    // Message bodies and tool payloads are not metadata containers.
    if (['content', 'parts', 'text', 'args', 'arguments', 'input', 'output'].includes(key)) continue;
    if (record.type === 'server_ste_metadata' && key === 'metadata') continue;
    if (nested && typeof nested === 'object') result = walkForFields(nested, result, depth + 1, budget);
  }
  return result;
}

export class ResponseStreamParser {
  private decoder = new SseDecoder();
  private fields: RouteFields = { ...EMPTY_ROUTE_FIELDS };

  constructor(private readonly onEvent?: (event: DecodedSseEvent) => void) {}

  private accept = (event: DecodedSseEvent): void => {
    if (event.reset) this.fields = { ...EMPTY_ROUTE_FIELDS };
    if (!event.done) this.fields = walkForFields(event.value, this.fields);
    this.onEvent?.(event);
  };

  push(text: string): RouteFields {
    this.decoder.push(text, this.accept);
    return { ...this.fields };
  }

  finish(): RouteFields {
    this.decoder.finish(this.accept);
    return { ...this.fields };
  }
}

export function parseSseResponse(raw: string): RouteFields {
  const parser = new ResponseStreamParser();
  parser.push(raw);
  return parser.finish();
}

function messageFields(message: UnknownRecord): RouteFields {
  const author = asRecord(message.author);
  const metadata = asRecord(message.metadata);
  if (!metadata) return { ...EMPTY_ROUTE_FIELDS };
  let fields = mergeFields(
    { ...EMPTY_ROUTE_FIELDS },
    extractMetadata(metadata, author?.role === 'assistant' ? 'assistant' : 'none')
  );
  const nestedServerMetadata = asRecord(metadata.server_ste_metadata);
  if (nestedServerMetadata) fields = mergeFields(fields, extractMetadata(nestedServerMetadata, 'server'));
  return fields;
}

function hasModelEvidence(fields: RouteFields): boolean {
  return Boolean(
    fields.responseModelSlug ||
    fields.resolvedModelSlug ||
    fields.serverModelSlug
  );
}

interface ConversationNode {
  key: string;
  messageId: string;
  parentId: string | null;
  role: string | null;
  fields: RouteFields;
}

function fieldsForAssistant(
  node: ConversationNode,
  nodesById: Map<string, ConversationNode>,
  consumedParents?: Set<string>
): RouteFields {
  let fields = node.fields;
  let parentId = node.parentId;
  const visited = new Set<string>([node.key, node.messageId]);
  for (let depth = 0; parentId && depth < 64; depth += 1) {
    if (visited.has(parentId)) break;
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent) break;
    fields = mergeFields(parent.fields, fields);
    consumedParents?.add(parent.key);
    if (parent.role === 'user') break;
    parentId = parent.parentId;
  }
  return fields;
}

function activeAssistant(
  currentNodeId: string,
  nodesById: Map<string, ConversationNode>
): ConversationNode | null {
  let node = nodesById.get(currentNodeId) ?? null;
  const visited = new Set<string>();
  for (let depth = 0; node && depth < 64; depth += 1) {
    if (visited.has(node.key)) return null;
    visited.add(node.key);
    if (node.role === 'assistant') return node;
    node = node.parentId ? nodesById.get(node.parentId) ?? null : null;
  }
  return null;
}

export function parseConversationRecord(value: unknown): RouteFields[] {
  const root = asRecord(value);
  const mapping = asRecord(root?.mapping);
  const messages = Array.isArray(root?.messages) ? root.messages : null;
  if (!mapping && !messages) return [];

  const nodes: ConversationNode[] = [];
  const nodesById = new Map<string, ConversationNode>();
  const rawNodes = mapping
    ? Object.entries(mapping)
    : (messages ?? []).map((message, index) => [String(index), message] as const);
  for (const [key, rawNode] of rawNodes) {
    const node = asRecord(rawNode);
    const nestedMessage = asRecord(node?.message);
    const message = nestedMessage ?? node;
    const author = asRecord(message?.author);
    const parsed = {
      key,
      messageId: stringValue(message?.id) ?? key,
      parentId: identifier(node?.parent) ?? identifier(message?.parent_id),
      role: stringValue(author?.role),
      fields: message ? messageFields(message) : { ...EMPTY_ROUTE_FIELDS }
    };
    nodes.push(parsed);
    nodesById.set(key, parsed);
    nodesById.set(parsed.messageId, parsed);
  }

  const currentNodeId = identifier(root?.current_node);
  if (currentNodeId) {
    const assistant = activeAssistant(currentNodeId, nodesById);
    if (assistant) {
      const fields = fieldsForAssistant(assistant, nodesById);
      return hasModelEvidence(fields) ? [fields] : [];
    }
    // A paginated older page can reference a current node that is not part of that page.
    // It must not replace the current response with an older turn.
    return [];
  }

  const grouped = new Map<string, RouteFields>();
  const consumedParents = new Set<string>();
  for (const node of nodes.filter((candidate) => candidate.role === 'assistant')) {
    const fields = fieldsForAssistant(node, nodesById, consumedParents);
    if (!hasModelEvidence(fields)) continue;
    const groupKey = fields.requestId ?? node.messageId ?? crypto.randomUUID();
    grouped.set(groupKey, mergeFields(grouped.get(groupKey) ?? { ...EMPTY_ROUTE_FIELDS }, fields));
  }

  for (const node of nodes) {
    if (node.role === 'assistant' || consumedParents.has(node.key) || !hasModelEvidence(node.fields)) continue;
    const groupKey = node.fields.requestId ?? node.messageId ?? crypto.randomUUID();
    grouped.set(groupKey, mergeFields(grouped.get(groupKey) ?? { ...EMPTY_ROUTE_FIELDS }, node.fields));
  }
  return [...grouped.values()];
}

export function parseResponseText(raw: string): RouteFields[] {
  if (/^\s*data:/m.test(raw)) return [parseSseResponse(raw)];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseResponseValue(parsed);
  } catch {
    return [];
  }
}

export function parseResponseValue(parsed: unknown): RouteFields[] {
  const root = asRecord(parsed);
  if (asRecord(root?.mapping) || Array.isArray(root?.messages)) {
    return parseConversationRecord(parsed).map((fields) => mergeFields(fields, parseUsageQuota(parsed)));
  }
  return [walkForFields(parsed, { ...EMPTY_ROUTE_FIELDS })];
}

export function mergeRouteFields(...items: Array<Partial<RouteFields>>): RouteFields {
  return items.reduce<RouteFields>((result, item) => mergeFields(result, item), { ...EMPTY_ROUTE_FIELDS });
}
