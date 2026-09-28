/** Correlation stays in the page observer; none of these identifiers is exported or stored. */
export interface TaskIdentity {
  messageId: string | null;
  parentId: string | null;
  workingTurnId: string | null;
  exchangeId: string | null;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function taskId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

export function taskIdentity(message: Record<string, unknown>): TaskIdentity {
  const metadata = object(message.metadata);
  return { messageId: taskId(message.id), parentId: taskId(message.parent_id) ?? taskId(metadata?.parent_id),
    workingTurnId: taskId(metadata?.working_turn_id), exchangeId: taskId(metadata?.turn_exchange_id) };
}

/** Project only assistant/tool identities from a bound stream, never bodies or report payloads. */
export function streamTaskIdentities(value: unknown): TaskIdentity[] {
  const identities: TaskIdentity[] = [];
  let budget = 0;
  const visit = (value: unknown, depth = 0): void => {
    if (++budget > 500 || depth > 10 || identities.length >= 128) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 64)) visit(item, depth + 1); return; }
    const message = object(value);
    if (!message) return;
    if (['assistant', 'tool'].includes(String(object(message.author)?.role))) identities.push(taskIdentity(message));
    for (const key of ['message', 'messages', 'data']) if (message[key]) visit(message[key], depth + 1);
  };
  visit(value);
  return identities;
}

export function compatibleTaskIdentity(a: TaskIdentity, b: TaskIdentity): boolean {
  return !(a.workingTurnId && b.workingTurnId && a.workingTurnId !== b.workingTurnId) &&
    !(a.exchangeId && b.exchangeId && a.exchangeId !== b.exchangeId);
}

export function sameTaskTurn(a: TaskIdentity, b: TaskIdentity): boolean {
  // An exchange can contain retries/branches: an exchange ID alone is not a round.
  return Boolean(a.workingTurnId && a.workingTurnId === b.workingTurnId && compatibleTaskIdentity(a, b));
}

export function currentTaskIdentity(value: unknown): TaskIdentity | null {
  const root = object(value);
  const current = taskId(root?.current_node) ?? taskId(object(root?.current_node)?.id);
  if (!current) return null;
  const mapping = object(root?.mapping);
  const node = object(mapping?.[current]);
  const message = object(node?.message) ?? (Array.isArray(root?.messages)
    ? root.messages.map(object).find(m => m?.id === current) : null);
  return message ? taskIdentity(message) : null;
}

export interface TaskMessageUpdate { conversationId: string; message: Record<string, unknown>; identity: TaskIdentity }

export function parseTaskMessageUpdates(raw: string): TaskMessageUpdate[] {
  if (raw.length > 2 * 1024 * 1024) return [];
  let root: Record<string, unknown> | null;
  try { root = object(JSON.parse(raw)); } catch { return []; }
  const payload = object(root?.payload);
  if (root?.type !== 'conversation-update' || payload?.update_type !== 'add-messages') return [];
  const conversationId = taskId(payload.conversation_id);
  const messages = object(payload.update_content)?.messages;
  if (!conversationId || !Array.isArray(messages) || messages.length > 64) return [];
  return messages.flatMap(value => {
    const message = object(value);
    if (!message || !['user', 'assistant', 'tool'].includes(String(object(message.author)?.role))) return [];
    return [{ conversationId, message, identity: taskIdentity(message) }];
  });
}
