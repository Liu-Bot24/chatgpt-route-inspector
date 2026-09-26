import { conversationIdFromPathname, temporaryConversationIdFromPathname } from './chatgpt-path';
import type { CaptureContext, CaptureMode, InspectorState, RouteTurn } from './types';

export function contextConversation(context: CaptureContext): string | null {
  return conversationIdFromPathname(new URL(context.pageUrl).pathname);
}

/** One document owns its contexts. Display-mode changes never enter this lifecycle. */
export class CaptureContextTracker {
  private current: CaptureContext;
  private previousCreation: CaptureContext | null = null;
  private assignedConversation: string | null = null;
  private creationStartedAt: number | null = null;

  constructor(pageUrl: string, private readonly id: () => string = () => crypto.randomUUID(), startedAt = Date.now()) {
    this.current = { id: id(), documentId: id(), documentStartedAt: startedAt, visitStartedAt: startedAt, revision: 0,
      pageUrl, reloadEligible: Boolean(conversationIdFromPathname(new URL(pageUrl).pathname)) };
  }

  navigate(pageUrl: string): CaptureContext {
    if (pageUrl === this.current.pageUrl) return this.snapshot();
    const old = this.current;
    const pathname = new URL(pageUrl).pathname;
    const conversation = conversationIdFromPathname(pathname);
    const creating = !contextConversation(old) && !old.reloadEligible && this.liveStarted;
    const temporary = temporaryConversationIdFromPathname(pathname);
    const oldTemporary = temporaryConversationIdFromPathname(new URL(old.pageUrl).pathname);
    // ChatGPT creates a local URL before replacing it with the server identity.
    // Keep this one creation chain, but never join two different local drafts.
    if (creating && temporary && (!oldTemporary || oldTemporary === temporary)) {
      this.current = { ...old, pageUrl, revision: old.revision + 1 };
      return this.snapshot();
    }
    const promoted = creating && conversation !== null && conversation === this.assignedConversation;
    const unresolvedCreation = creating && conversation !== null && this.assignedConversation === null;
    this.previousCreation = unresolvedCreation ? old : null;
    this.current = { ...old, id: promoted ? old.id : this.id(), pageUrl, revision: old.revision + 1,
      visitStartedAt: promoted ? old.visitStartedAt ?? old.documentStartedAt : Date.now(),
      reloadEligible: Boolean(conversation) && !promoted && !unresolvedCreation };
    this.liveStarted = promoted;
    this.assignedConversation = null;
    return this.snapshot();
  }

  private liveStarted = false;
  startLive(): CaptureContext {
    this.previousCreation = null;
    this.liveStarted = true;
    this.creationStartedAt = Date.now();
    this.current = { ...this.current, reloadEligible: false, revision: this.current.revision + 1 };
    return this.snapshot();
  }

  observeLive(contextId: string, conversationId: string | null | undefined): void {
    if (!conversationId) return;
    if (contextId === this.current.id && !contextConversation(this.current)) this.assignedConversation = conversationId;
    // The router may assign the URL before the response carrying its conversation ID reaches us.
    if (this.previousCreation?.id === contextId) {
      const promoted = contextConversation(this.current) === conversationId;
      this.current = { ...this.current, id: promoted ? contextId : this.current.id,
        reloadEligible: !promoted, revision: this.current.revision + 1 };
      this.previousCreation = null;
      this.liveStarted = promoted;
    }
  }

  abandonCreation(contextId: string): void {
    if (contextId === this.current.id && !contextConversation(this.current) && !this.assignedConversation) this.liveStarted = false;
    if (this.previousCreation?.id === contextId) {
      this.previousCreation = null;
      this.current = { ...this.current, reloadEligible: true, revision: this.current.revision + 1 };
    }
  }

  stopFallback(): void {
    this.previousCreation = null;
    if (!contextConversation(this.current)) {
      this.liveStarted = false;
      this.assignedConversation = null;
    }
    this.current = { ...this.current, reloadEligible: false, revision: this.current.revision + 1 };
  }

  /** A delayed clear must not sever a creation or visit that started after it. */
  clearBefore(cutoff: number): void {
    if (this.creationStartedAt !== null && this.creationStartedAt <= cutoff) {
      this.previousCreation = null;
      this.assignedConversation = null;
      this.creationStartedAt = null;
      if (!contextConversation(this.current)) this.liveStarted = false;
      this.current = { ...this.current, revision: this.current.revision + 1 };
    }
    if ((this.current.visitStartedAt ?? this.current.documentStartedAt) <= cutoff && this.current.reloadEligible) {
      this.current = { ...this.current, reloadEligible: false, revision: this.current.revision + 1 };
    }
  }

  hasUnresolvedCreation(): boolean { return this.previousCreation !== null; }

  /** New network reads are independent of DOM fallback, but not post-live history reads. */
  canStartReload(): boolean { return Boolean(contextConversation(this.current)) && !this.liveStarted; }

  snapshot(): CaptureContext { return { ...this.current }; }
}

/** Conflicting raw route fields are still evidence even when no unique model can be selected. */
export function hasResponseEvidence(turn: RouteTurn): boolean {
  return Boolean(turn.resolvedModelSlug || turn.serverModelSlug || turn.routeModel || turn.modelLabel || turn.modelLabelConflict);
}

export function latestInContext(state: InspectorState, tabId: number | undefined, mode: CaptureMode): RouteTurn | null {
  if (tabId === undefined) return null;
  const context = state.captureContexts?.[tabId];
  if (!context || context.invalidated) return null;
  const conversation = contextConversation(context);
  const candidates = state.turns.filter((turn) => turn.tabId === tabId && turn.captureMode === mode &&
    turn.captureContextId === context.id &&
    (!conversation || !turn.conversationId || turn.conversationId === conversation) &&
    (mode !== 'reload' || Boolean(conversation) && turn.conversationId === conversation));
  if (mode === 'reload') {
    const record = candidates.find((turn) => turn.sources.includes('conversation_record') &&
      hasResponseEvidence(turn));
    if (record) return record;
  }
  return candidates[0] ?? null;
}

export function normalizeCaptureContext(value: unknown): CaptureContext | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as CaptureContext;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 128 ||
    typeof v.documentId !== 'string' || !v.documentId || v.documentId.length > 128 ||
    !Number.isSafeInteger(v.documentStartedAt) || v.documentStartedAt < 0 ||
    (v.visitStartedAt !== undefined && (!Number.isSafeInteger(v.visitStartedAt) || v.visitStartedAt < v.documentStartedAt)) ||
    !Number.isSafeInteger(v.revision) || v.revision < 0 || typeof v.reloadEligible !== 'boolean') return null;
  try {
    const url = new URL(v.pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { id: v.id, documentId: v.documentId, documentStartedAt: v.documentStartedAt,
      ...(v.invalidated === true ? { invalidated: true } : {}),
      ...(v.visitStartedAt !== undefined ? { visitStartedAt: v.visitStartedAt } : {}),
      revision: v.revision, reloadEligible: v.reloadEligible, pageUrl: `${url.origin}${url.pathname}` };
  } catch { return null; }
}

export function newerContext(current: CaptureContext | undefined, incoming: CaptureContext): boolean {
  if (current?.invalidated && current.documentId === incoming.documentId) return false;
  return !current || (current.documentId === incoming.documentId
    ? incoming.revision > current.revision
    : incoming.documentStartedAt > current.documentStartedAt);
}
