import { ResponseStreamParser } from './response-parser';
import { EMPTY_ROUTE_FIELDS, type RouteFields } from './types';

type UnknownRecord = Record<string, unknown>;

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_ENCODED_ITEM_BYTES = 1024 * 1024;
const MAX_ENVELOPES = 16;
const MAX_CORRELATION_IDS = 8;
const MAX_ID_LENGTH = 512;

export interface WebSocketRouteEvidence {
  topicId: string | null;
  fields: RouteFields;
  conversationIds: string[];
  messageIds: string[];
  parentIds: string[];
  terminal: boolean;
  streamEnded: boolean;
  errorCode?: string;
}

interface CorrelationAccumulator {
  conversationIds: string[];
  messageIds: string[];
  parentIds: string[];
  terminal: boolean;
  visited: number;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function boundedId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null;
}

function pushUnique(values: string[], value: string | null): void {
  if (value && values.length < MAX_CORRELATION_IDS && !values.includes(value)) values.push(value);
}

function collectCorrelation(
  value: unknown,
  result: CorrelationAccumulator,
  depth = 0
): void {
  if (depth > 8 || result.visited >= 500) return;
  result.visited += 1;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 32)) {
      if (result.visited >= 500) break;
      collectCorrelation(item, result, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;

  pushUnique(result.conversationIds, boundedId(record.conversation_id));
  pushUnique(result.parentIds, boundedId(record.parent_id));
  pushUnique(result.parentIds, boundedId(record.parent));

  const author = asRecord(record.author);
  if (author) pushUnique(result.messageIds, boundedId(record.id));
  const message = asRecord(record.message);
  if (message) pushUnique(result.messageIds, boundedId(message.id));

  if (record.type === 'server_ste_metadata') {
    result.terminal = true;
  }

  for (const [key, nested] of Object.entries(record)) {
    if (result.visited >= 500) break;
    if (['content', 'parts', 'text', 'args', 'arguments', 'input', 'output'].includes(key)) continue;
    if (nested && typeof nested === 'object') collectCorrelation(nested, result, depth + 1);
  }
}

function emptyCorrelation(): CorrelationAccumulator {
  return {
    conversationIds: [],
    messageIds: [],
    parentIds: [],
    terminal: false,
    visited: 0
  };
}

interface TopicState {
  parser: ResponseStreamParser;
  correlation: CorrelationAccumulator;
  streamEnded: boolean;
  expiresAt: number;
  reset: boolean;
}

/** A socket multiplexes topics; never inherit delta paths/roles from another topic. */
export class WebSocketRouteParser {
  private topics = new Map<string, TopicState>();

  clear(): void { this.topics.clear(); }

  private state(): TopicState {
    const state: TopicState = {
      parser: new ResponseStreamParser((event) => {
        if (event.reset) {
          state.reset = true;
          state.correlation = emptyCorrelation();
        }
        state.streamEnded ||= event.done;
        state.correlation.terminal ||= event.done;
        if (!event.done) collectCorrelation(event.value, state.correlation);
      }),
      correlation: emptyCorrelation(),
      streamEnded: false,
      expiresAt: 0,
      reset: false
    };
    return state;
  }

  parse(raw: string): WebSocketRouteEvidence[] {
    if (raw.length === 0 || raw.length > MAX_FRAME_BYTES) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const results: WebSocketRouteEvidence[] = [];
    const timestamp = Date.now();
    for (const [topic, state] of this.topics) if (state.expiresAt <= timestamp) this.topics.delete(topic);
    for (const candidate of parsed.slice(0, MAX_ENVELOPES)) {
      const envelope = asRecord(candidate);
      const outerPayload = asRecord(envelope?.payload);
      const innerPayload = asRecord(outerPayload?.payload);
      const encodedItem = innerPayload?.encoded_item;
      if (typeof encodedItem !== 'string' || encodedItem.length === 0 || encodedItem.length > MAX_ENCODED_ITEM_BYTES) continue;
      const topic = boundedId(envelope?.topic_id);
      const state = topic ? this.topics.get(topic) ?? this.state() : this.state();
      const previous = state.correlation;
      state.correlation = emptyCorrelation();
      state.streamEnded = false;
      state.reset = false;
      let fields: RouteFields;
      let errorCode: string | undefined;
      try {
        state.parser.push(encodedItem);
        // encoded_item contains whole SSE events; the delta context survives across items.
        fields = state.parser.finish();
      } catch {
        fields = { ...EMPTY_ROUTE_FIELDS };
        errorCode = 'stream_decode_failed';
        state.streamEnded = true;
      }
      const correlation = state.correlation;
      for (const key of ['conversationIds', 'messageIds', 'parentIds'] as const) {
        if (!state.reset && correlation[key].length === 0) correlation[key] = previous[key];
      }
      pushUnique(correlation.conversationIds, fields.conversationId);
      results.push({
        topicId: topic,
        fields,
        conversationIds: [...correlation.conversationIds],
        messageIds: [...correlation.messageIds],
        parentIds: [...correlation.parentIds],
        terminal: correlation.terminal,
        streamEnded: state.streamEnded,
        ...(errorCode ? { errorCode } : {})
      });
      if (topic) {
        this.topics.delete(topic);
        if (!state.streamEnded) {
          if (this.topics.size >= 32) this.topics.delete(this.topics.keys().next().value!);
          state.expiresAt = timestamp + 10 * 60 * 1000;
          this.topics.set(topic, state);
        }
      }
    }
    return results;
  }
}

export function parseWebSocketFrame(raw: string): WebSocketRouteEvidence[] {
  return new WebSocketRouteParser().parse(raw);
}
