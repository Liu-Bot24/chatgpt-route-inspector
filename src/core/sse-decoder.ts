import { projectLimitsProgress } from './usage-quota';

type RecordValue = Record<string, unknown>;

const MAX_EVENT_CHARS = 1024 * 1024;
const MAX_CHANNELS = 32;
const MAX_DEPTH = 16;
const MAX_OPERATIONS = 512;
const MAX_STRING_CHARS = 1024;
const KEYS = new Set([
  'message', 'messages', 'metadata', 'server_ste_metadata', 'author', 'role', 'type',
  'id', 'parent', 'parent_id', 'conversation_id', 'model_slug', 'default_model_slug',
  'resolved_model_slug', 'plan_type', 'request_id', 'tool_invoked', 'tool_name',
  'is_search', 'did_prompt_contain_image', 'fast_convo', 'limits_progress', 'feature_name', 'remaining', 'reset_after'
]);
const OPERATIONS = new Set(['add', 'replace', 'append', 'remove', 'truncate', 'patch']);

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;
}

// Keep only evidence and message identity. Never retain answer text, attachments or tokens.
function project(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 4096 || depth > MAX_DEPTH) throw new Error('stream_metadata_limit');
  if (typeof value === 'string') return value.length <= MAX_STRING_CHARS ? value : undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error('stream_metadata_limit');
    return value.map((item) => project(item, depth + 1, budget));
  }
  const source = record(value);
  if (!source) return undefined;
  const result: RecordValue = {};
  for (const [key, item] of Object.entries(source)) {
    if (!KEYS.has(key)) continue;
    if (key === 'limits_progress') { result[key] = projectLimitsProgress(item); continue; }
    const projected = project(item, depth + 1, budget);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

interface DeltaHeader {
  channel: number;
  path: string;
  op: string;
}

export interface DecodedSseEvent {
  value: unknown;
  done: boolean;
  reset?: boolean;
}

/** One instance per HTTP response or WebSocket topic; v1 headers inherit across events. */
export class SseDecoder {
  private buffer = '';
  private eventName = '';
  private data: string[] = [];
  private dataLength = 0;
  private previous: DeltaHeader = { channel: 0, path: '', op: 'add' };
  private channels = new Map<number, unknown>();

  push(text: string, onEvent: (event: DecodedSseEvent) => void): void {
    this.buffer += text;
    let start = 0;
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && index + 1 === this.buffer.length) break;
      const line = this.buffer.slice(start, index);
      if (char === '\r' && this.buffer[index + 1] === '\n') index += 1;
      start = index + 1;
      this.line(line, onEvent);
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > MAX_EVENT_CHARS) throw new Error('stream_event_too_large');
  }

  finish(onEvent: (event: DecodedSseEvent) => void): void {
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ''), onEvent);
    this.buffer = '';
    this.dispatch(onEvent);
  }

  private line(line: string, onEvent: (event: DecodedSseEvent) => void): void {
    if (line.length > MAX_EVENT_CHARS) throw new Error('stream_event_too_large');
    if (line === '') {
      this.dispatch(onEvent);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.eventName = value;
    if (field === 'data') {
      this.dataLength += value.length + 1;
      if (this.dataLength > MAX_EVENT_CHARS) throw new Error('stream_event_too_large');
      this.data.push(value);
    }
  }

  private dispatch(onEvent: (event: DecodedSseEvent) => void): void {
    const payload = this.data.join('\n');
    const name = this.eventName;
    this.data = [];
    this.dataLength = 0;
    this.eventName = '';
    if (!payload) return;
    if (payload === '[DONE]') {
      onEvent({ value: null, done: true });
      this.channels.clear();
      this.previous = { channel: 0, path: '', op: 'add' };
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      if (name === 'delta' || name === 'delta_encoding') throw new Error('invalid_stream_delta');
      // Legacy captures sometimes concatenate independent data lines without SSE separators.
      for (const line of payload.split('\n')) {
        let item: unknown;
        try { item = JSON.parse(line) as unknown; } catch { continue; }
        onEvent({ value: item, done: false });
      }
      return;
    }
    if (name === 'delta_encoding') {
      if (value !== 'v1') throw new Error('unsupported_delta_encoding');
      this.channels.clear();
      this.previous = { channel: 0, path: '', op: 'add' };
      onEvent({ value: null, done: false, reset: true });
      return;
    }
    const item = record(value);
    if (name === 'delta' && item && ('v' in item || 'o' in item || 'p' in item || 'c' in item)) {
      value = this.delta(item);
    }
    onEvent({ value, done: false });
  }

  private delta(item: RecordValue): unknown {
    const channel = 'c' in item ? item.c : this.previous.channel;
    const path = 'p' in item ? item.p : this.previous.path;
    const op = 'o' in item ? item.o : this.previous.op;
    if (typeof channel !== 'number' || !Number.isSafeInteger(channel) || channel < 0 ||
        typeof path !== 'string' || path.length > MAX_STRING_CHARS ||
        typeof op !== 'string' || !OPERATIONS.has(op)) throw new Error('invalid_stream_delta');
    if (!this.channels.has(channel) && this.channels.size >= MAX_CHANNELS) throw new Error('stream_channel_limit');
    const header = { channel, path, op };
    const result = this.apply(this.channels.get(channel), header, item.v, { operations: 0 });
    if ((JSON.stringify(result)?.length ?? 0) > 64 * 1024) throw new Error('stream_metadata_limit');
    this.previous = header;
    this.channels.set(channel, result);
    return result;
  }

  private apply(root: unknown, delta: DeltaHeader, value: unknown, budget: { operations: number }, depth = 0): unknown {
    if (++budget.operations > MAX_OPERATIONS || depth > MAX_DEPTH) throw new Error('stream_patch_limit');
    const { path, op } = delta;
    if (typeof path !== 'string' || path.length > MAX_STRING_CHARS || !OPERATIONS.has(op)) throw new Error('invalid_stream_delta');
    const tokens = path === '' ? [] : path.replace(/^\//, '').split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (tokens.length > MAX_DEPTH) throw new Error('stream_patch_limit');
    // Still update inherited headers for ignored content patches, but never keep their values.
    if (tokens.some((part) => !KEYS.has(part) && !/^(?:0|[1-9]\d{0,2})$/.test(part))) return root;
    const box: RecordValue = { root };
    let parent: RecordValue | unknown[] = box;
    let key: string | number = 'root';
    for (const token of tokens) {
      let child = (parent as RecordValue)[key];
      if (!child || typeof child !== 'object') {
        child = /^\d+$/.test(token) ? [] : {};
        (parent as RecordValue)[key] = child;
      }
      parent = child as RecordValue;
      key = Array.isArray(parent) ? Number(token) : token;
      if (Array.isArray(parent) && (!Number.isSafeInteger(key) || Number(key) >= 128)) throw new Error('stream_metadata_limit');
    }
    const target = parent as RecordValue;
    const old = target[key];
    if (op === 'patch') {
      if (!Array.isArray(value) || value.length > MAX_OPERATIONS) throw new Error('invalid_stream_delta');
      let patched = old;
      for (const entry of value) {
        const child = record(entry);
        if (!child || typeof child.o !== 'string' || (child.p !== undefined && typeof child.p !== 'string')) throw new Error('invalid_stream_delta');
        patched = this.apply(patched, { channel: delta.channel, path: child.p as string ?? '', op: child.o }, child.v, budget, depth + 1);
      }
      target[key] = patched;
    } else if (op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete target[key];
    } else if (op === 'truncate') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_stream_delta');
      if (typeof old === 'string') target[key] = old.slice(0, value);
      else if (Array.isArray(old)) old.length = Math.min(old.length, value);
    } else {
      const next = project(value);
      if (op === 'append' && typeof old === 'string' && typeof next === 'string') {
        if (old.length + next.length > MAX_STRING_CHARS) throw new Error('stream_metadata_limit');
        target[key] = old + next;
      } else if (op === 'append' && Array.isArray(old)) {
        const items = Array.isArray(next) ? next : [next];
        if (old.length + items.length > 128) throw new Error('stream_metadata_limit');
        old.push(...items);
      } else if (op === 'append' && record(old) && record(next)) {
        Object.assign(old as RecordValue, next);
      } else if (op === 'add' && Array.isArray(parent)) {
        if (parent.length >= 128) throw new Error('stream_metadata_limit');
        parent.splice(Number(key), 0, next);
      } else {
        target[key] = next;
      }
    }
    return box.root;
  }
}
