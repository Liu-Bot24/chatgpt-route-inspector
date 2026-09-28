import { matchesResearchUpdate, parseResearchUpdates, type ResearchUpdate } from './research';
import { mergeRouteFields, parseResponseValue } from './response-parser';
import { compatibleTaskIdentity, parseTaskMessageUpdates, sameTaskTurn, streamTaskIdentities, type TaskIdentity } from './task-identity';
import type { RouteFields, RouteObservation } from './types';

interface Capture {
  observation: RouteObservation; fields: RouteFields; expiresAt: number;
  identity: TaskIdentity; messageIds: Set<string>;
}
const TTL = 2 * 60 * 60 * 1000;

function taskFieldsFrom(fields: RouteFields): Partial<RouteFields> {
  return {
    taskKind: fields.taskKind,
    researchWidgetId: fields.researchWidgetId, researchMessageId: fields.researchMessageId,
    researchReportModel: fields.researchReportModel,
    resolvedModelSlug: fields.resolvedModelSlug,
    serverModelSlug: fields.serverModelSlug,
    responseModelSlug: fields.responseModelSlug
  };
}

/** All captures can acquire task evidence after their short-lived Chat stream ends. */
export class TaskCaptures {
  private captures = new Map<string, Capture>();

  clear(before = Infinity): void {
    for (const [key, capture] of this.captures) {
      if (Date.parse(capture.observation.startedAt ?? capture.observation.observedAt) <= before) this.captures.delete(key);
    }
  }

  private prune(timestamp: number): void {
    for (const [key, capture] of this.captures) if (capture.expiresAt <= timestamp) this.captures.delete(key);
  }

  observe(observation: RouteObservation, contextId: string, timestamp = Date.now(), identity?: TaskIdentity | null): void {
    this.prune(timestamp);
    if (observation.captureContextId !== contextId) return;
    const key = `${contextId}:${observation.captureMode}:${observation.captureId}`;
    const existing = this.captures.get(key);
    if (!existing && this.captures.size >= 32) this.captures.delete(this.captures.keys().next().value!);
    this.captures.set(key, {
      observation: { ...existing?.observation, ...observation },
      fields: mergeRouteFields(existing?.fields ?? {}, observation),
      expiresAt: existing?.expiresAt ?? timestamp + TTL,
      identity: existing?.identity ?? { ...(identity ?? { messageId: null, parentId: null, workingTurnId: null, exchangeId: null }) },
      messageIds: existing?.messageIds ?? new Set(identity?.messageId ? [identity.messageId] : [])
    });
  }

  /** The HTTP response is already bound to this request, unlike the multiplexed socket. */
  rememberStream(captureId: string, contextId: string, value: unknown): void {
    this.rememberIdentities(captureId, contextId, streamTaskIdentities(value));
  }

  /** Socket callers must first match the envelope to its pending request/topic. */
  rememberIdentities(captureId: string, contextId: string, identities: TaskIdentity[]): void {
    const capture = this.captures.get(`${contextId}:live:${captureId}`);
    if (!capture) return;
    for (const identity of identities.slice(0, 128)) {
      if (compatibleTaskIdentity(capture.identity, identity)) {
        capture.identity.workingTurnId ??= identity.workingTurnId;
        capture.identity.exchangeId ??= identity.exchangeId;
        if (identity.messageId && capture.messageIds.size < 128) capture.messageIds.add(identity.messageId);
      }
    }
  }

  consume(raw: string, contextId: string, timestamp = Date.now()): RouteObservation[] {
    this.prune(timestamp);
    const results = this.consumeMessages(raw, contextId, timestamp);
    return [...results, ...parseResearchUpdates(raw).flatMap((update) => {
      if (!update.reportModel) return [];
      const matched = this.match(update, contextId, timestamp);
      return matched;
    })];
  }

  private consumeMessages(raw: string, contextId: string, timestamp: number): RouteObservation[] {
    let remaining = parseTaskMessageUpdates(raw);
    const changed = new Map<Capture, Partial<RouteFields>>();
    // A bounded fixed point handles a batch whose child appears before its parent.
    for (let pass = 0; remaining.length && pass < 64; pass++) {
      const unmatched: typeof remaining = [];
      let progress = false;
      for (const update of remaining) {
        const { identity } = update;
        const matches = [...this.captures.values()].filter(capture => {
          if (capture.observation.captureContextId !== contextId ||
              (capture.fields.conversationId && capture.fields.conversationId !== update.conversationId) ||
              !compatibleTaskIdentity(capture.identity, identity)) return false;
          const exactMessage = Boolean(identity.messageId && capture.messageIds.has(identity.messageId));
          // A distinct user message is not an assistant/tool continuation.
          const role = (update.message.author as { role?: string })?.role;
          const linkedParent = role !== 'user' && Boolean(identity.parentId && capture.messageIds.has(identity.parentId));
          return exactMessage || linkedParent || (role !== 'user' && sameTaskTurn(capture.identity, identity));
        });
        if (matches.length !== 1) { unmatched.push(update); continue; }
        const capture = matches[0]!;
        progress = true;
        capture.fields.conversationId ??= update.conversationId;
        capture.identity.workingTurnId ??= identity.workingTurnId;
        capture.identity.exchangeId ??= identity.exchangeId;
        if (identity.messageId && capture.messageIds.size < 128) capture.messageIds.add(identity.messageId);
        const fields = parseResponseValue({ message: update.message })[0];
        if (!fields || !(fields.taskKind || capture.fields.taskKind)) continue;
        const taskFields = taskFieldsFrom(fields);
        const next = mergeRouteFields(capture.fields, taskFields);
        if (JSON.stringify(next) === JSON.stringify(capture.fields)) continue;
        capture.fields = next;
        changed.set(capture, taskFieldsFrom(mergeRouteFields(changed.get(capture) ?? {}, taskFields, { taskKind: next.taskKind })));
      }
      if (!progress) break;
      remaining = unmatched;
    }
    return [...changed].map(([capture, fields]) => ({ ...this.observationFor(capture, contextId, timestamp), ...fields }));
  }

  private observationFor(capture: Capture, contextId: string, timestamp: number): RouteObservation {
    const { observation } = capture;
    return {
      captureId: observation.captureId, captureContextId: contextId,
      captureMode: observation.captureMode, source: observation.captureMode === 'live' ? 'page_websocket' : 'conversation_record',
      phase: observation.phase,
      ...(observation.startedAt ? { startedAt: observation.startedAt } : {}),
      observedAt: new Date(timestamp).toISOString(),
      ...(observation.pageUrl ? { pageUrl: observation.pageUrl } : {}),
      conversationId: capture.fields.conversationId
    };
  }

  private match(update: ResearchUpdate, contextId: string, timestamp: number): RouteObservation[] {
    const matches = [...this.captures.values()].filter((capture) =>
      capture.observation.captureContextId === contextId && matchesResearchUpdate(capture.fields, update));
    // More than one capture for the same widget is ambiguous; never pick the latest.
    if (matches.length !== 1 || !update.reportModel) return [];
    const capture = matches[0]!;
    if (capture.fields.researchReportModel === update.reportModel) return [];
    capture.fields.researchReportModel = update.reportModel;
    return [{
      ...this.observationFor(capture, contextId, timestamp),
      taskKind: 'deep_research', conversationId: capture.fields.conversationId,
      researchWidgetId: capture.fields.researchWidgetId, researchMessageId: capture.fields.researchMessageId,
      researchReportModel: update.reportModel
    }];
  }
}
