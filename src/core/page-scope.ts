import type { InspectorState } from './types';

export function supportedPageUrl(value: string | undefined, origins: ReadonlySet<string>): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return origins.has(url.origin) ? `${url.origin}${url.pathname}` : null;
  } catch { return null; }
}

export type PageConnection = 'unsupported' | 'loading' | 'connected' | 'needs_refresh';

/**
 * Content scripts run only in documents loaded after install, update, or a granted site access.
 * An unreachable bridge does not prove that site access is blocked: on-click
 * access can be temporary and absent from permissions.contains().
 */
export function classifyPageConnection(tab: { url?: string | undefined; pendingUrl?: string | undefined; status?: string | undefined } | undefined,
  origins: ReadonlySet<string>, probe: { bridgeReachable: boolean }): PageConnection {
  if (!supportedPageUrl(tab?.url, origins)) return 'unsupported';
  if (tab?.pendingUrl || tab?.status !== 'complete') return 'loading';
  if (probe.bridgeReachable) return 'connected';
  return 'needs_refresh';
}

/** A tab ID alone does not prove that its stored visit is still on screen. */
export function displayTabId(state: InspectorState, tab: { id?: number | undefined; url?: string | undefined; pendingUrl?: string | undefined } | undefined,
  origins: ReadonlySet<string>): number | undefined {
  // A destination can hide a result during navigation, never prove current ownership.
  if (tab?.id === undefined || tab.pendingUrl) return undefined;
  const pageUrl = supportedPageUrl(tab.url, origins);
  const context = state.captureContexts?.[tab.id];
  return pageUrl && context && !context.invalidated && context.pageUrl === pageUrl ? tab.id : undefined;
}
