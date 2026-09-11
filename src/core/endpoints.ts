export type EndpointKind = 'conversation_stream' | 'conversation_record' | 'conversation_init' | 'pow_requirements' | 'other';

const POW_REQUIREMENTS_PATHS = new Set([
  '/backend-api/sentinel/chat-requirements/prepare',
  '/backend-anon/sentinel/chat-requirements/prepare',
  '/api/sentinel/chat-requirements/prepare',
  '/backend-api/sentinel/chat-requirements',
  '/backend-anon/sentinel/chat-requirements',
  '/api/sentinel/chat-requirements'
]);

export interface EndpointMatch {
  kind: EndpointKind;
  conversationId: string | null;
}

export function classifyEndpoint(input: string, base = 'https://chatgpt.com/'): EndpointMatch {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return { kind: 'other', conversationId: null };
  }

  if (url.pathname === '/backend-api/conversation' || /^\/backend-api\/f\/conversations?$/.test(url.pathname)) {
    return { kind: 'conversation_stream', conversationId: null };
  }

  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
  if (pathname === '/backend-api/conversation/init') return { kind: 'conversation_init', conversationId: null };
  if (POW_REQUIREMENTS_PATHS.has(pathname)) {
    return { kind: 'pow_requirements', conversationId: null };
  }

  const match = /^\/backend-api\/conversations?\/([^/]+)$/.exec(url.pathname);
  if (match?.[1]) {
    try {
      return { kind: 'conversation_record', conversationId: decodeURIComponent(match[1]) };
    } catch {
      return { kind: 'other', conversationId: null };
    }
  }

  return { kind: 'other', conversationId: null };
}
