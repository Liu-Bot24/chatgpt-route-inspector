import { describe, expect, it } from 'vitest';
import { conversationIdFromPathname, redactConversationPathname, temporaryConversationIdFromPathname } from '../../src/core/chatgpt-path';

describe('ChatGPT conversation paths', () => {
  it('extracts conversation ids from standard and project conversations', () => {
    expect(conversationIdFromPathname('/c/standard-conversation')).toBe('standard-conversation');
    expect(conversationIdFromPathname('/g/g-p-project/c/project%20conversation')).toBe('project conversation');
  });

  it('rejects non-conversation and malformed paths', () => {
    expect(conversationIdFromPathname('/g/g-p-project')).toBeNull();
    expect(conversationIdFromPathname('/backend-api/conversation/private-id')).toBeNull();
    expect(conversationIdFromPathname('/g/g-p-project/c/%')).toBeNull();
  });

  it('distinguishes local creation URLs from server conversation identities', () => {
    for (const prefix of ['/c/', '/g/g-p-project/c/']) {
      expect(conversationIdFromPathname(`${prefix}local-chatgpt%3Adraft`)).toBeNull();
      expect(temporaryConversationIdFromPathname(`${prefix}local-chatgpt%3Adraft`)).toBe('local-chatgpt:draft');
      expect(temporaryConversationIdFromPathname(`${prefix}local-chatgpt:draft`)).toBe('local-chatgpt:draft');
    }
    expect(temporaryConversationIdFromPathname('/c/server-id')).toBeNull();
    expect(temporaryConversationIdFromPathname('/c/local-chatgpt%3A')).toBeNull();
    expect(temporaryConversationIdFromPathname('/c/%')).toBeNull();
  });

  it('redacts both conversation and project identifiers', () => {
    expect(redactConversationPathname('/c/standard-conversation')).toBe('/c/[redacted]');
    expect(redactConversationPathname('/g/g-p-project/c/project-conversation')).toBe('/g/[redacted]/c/[redacted]');
    expect(redactConversationPathname('/g/g-p-project')).toBe('/g/g-p-project');
  });
});
