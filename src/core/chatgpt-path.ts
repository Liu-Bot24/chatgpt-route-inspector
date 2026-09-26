const STANDARD_CONVERSATION_PATH = /^\/c\/([^/]+)(?=\/|$)/;
const PROJECT_CONVERSATION_PATH = /^\/g\/[^/]+\/c\/([^/]+)(?=\/|$)/;

function conversationMatch(pathname: string): RegExpExecArray | null {
  return STANDARD_CONVERSATION_PATH.exec(pathname) ?? PROJECT_CONVERSATION_PATH.exec(pathname);
}

function pathConversationId(pathname: string): string | null {
  const encodedId = conversationMatch(pathname)?.[1];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId) || null;
  } catch {
    return null;
  }
}

const TEMPORARY_CONVERSATION_PREFIX = 'local-chatgpt:';

/** A client-side draft is not a server conversation or a reload target. */
export function temporaryConversationIdFromPathname(pathname: string): string | null {
  const id = pathConversationId(pathname);
  return id?.startsWith(TEMPORARY_CONVERSATION_PREFIX) && id.length > TEMPORARY_CONVERSATION_PREFIX.length ? id : null;
}

export function conversationIdFromPathname(pathname: string): string | null {
  const id = pathConversationId(pathname);
  return id?.startsWith(TEMPORARY_CONVERSATION_PREFIX) ? null : id;
}

export function redactConversationPathname(pathname: string): string {
  if (PROJECT_CONVERSATION_PATH.test(pathname)) {
    return pathname.replace(/^\/g\/[^/]+\/c\/[^/]+/, '/g/[redacted]/c/[redacted]');
  }
  if (STANDARD_CONVERSATION_PATH.test(pathname)) {
    return pathname.replace(/^\/c\/[^/]+/, '/c/[redacted]');
  }
  return pathname;
}
