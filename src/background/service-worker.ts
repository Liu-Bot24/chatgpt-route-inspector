import { clearState, invalidateCaptureContext, mutateState, readState, storeObservation, storePowObservation, storeCaptureContext } from './storage';
import { displayTabId, supportedPageUrl } from '../core/page-scope';
import { latestInContext, normalizeCaptureContext } from '../core/capture-context';
import { stateForTab } from '../core/state';
import { normalizeUiLanguage } from '../core/language';
import { normalizeObservation } from '../core/observation';
import type { InspectorState, PowObservation, RouteObservation } from '../core/types';
import type { RuntimeRequest, RuntimeResponse } from '../shared/messages';
import { handleInstallation } from './upgrade-notice';
import { UPGRADE_NOTICE_URL } from '../shared/upgrade-notice';

const allowedOrigins = new Set(__ROUTE_INSPECTOR_ALLOWED_ORIGINS__);
const badgeTexts = new Map<number, string>();

async function currentTabPage(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return supportedPageUrl(tab.url, allowedOrigins);
  } catch { return null; }
}

async function retireOffsiteContext(tabId: number): Promise<InspectorState> {
  // Bind before the asynchronous browser query: its reply may outlive this visit.
  const before = await readState();
  const expectedId = before.captureContexts?.[tabId]?.id;
  if (await currentTabPage(tabId) === null) return invalidateCaptureContext(tabId, expectedId);
  return readState();
}

async function updateBadge(tabId: number | undefined, state: InspectorState): Promise<void> {
  if (tabId === undefined) return;
  const latest = latestInContext(state, tabId, state.settings.captureMode);
  const text = !latest || !state.settings.autoCaptureEnabled ? '' : latest.phase === 'failed' ? '?' : latest?.verdict === 'mismatch' || latest?.verdict === 'conflict'
    ? '!'
    : latest?.verdict === 'normal'
      ? 'OK'
      : latest?.verdict === 'auto_reasoning'
        ? 'AUTO'
      : latest?.verdict === 'suspected_downgrade'
        ? 'SUS'
      : latest?.verdict === 'work_unverifiable'
        ? 'WM'
      : latest?.phase === 'requested' || latest?.phase === 'responding'
        ? '…'
        : '?';
  const color = text === '!' ? '#d95343' : text === 'OK' ? '#6fa92e' : text === 'AUTO' ? '#367c8c'
    : text === 'SUS' ? '#aa9929' : text === 'WM' ? '#545e52' : '#b47d2d';
  if (badgeTexts.get(tabId) === text) return;
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  badgeTexts.set(tabId, text);
}

async function broadcast(state: InspectorState): Promise<void> {
  const message = { type: 'route:state-changed', state };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No extension page is currently listening.
  }
  try {
    const tabs = await chrome.tabs.query({});
    const openIds = new Set(tabs.map((tab) => tab.id));
    for (const tabId of badgeTexts.keys()) if (!openIds.has(tabId)) badgeTexts.delete(tabId);
    await Promise.allSettled(tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      if (!supportedPageUrl(tab.url, allowedOrigins)) {
        if (state.captureContexts?.[tab.id] && !state.captureContexts[tab.id]!.invalidated) {
          const invalidated = await invalidateCaptureContext(tab.id, state.captureContexts[tab.id]!.id);
          // Queue, do not await our own publication queue from inside a broadcast.
          void publish(invalidated).catch((error: unknown) => console.error('Could not publish retired tab context.', error));
        }
        await updateBadge(tab.id, { ...state, captureContexts: {} });
        return;
      }
      await Promise.allSettled([
        updateBadge(tab.id, displayTabId(state, tab, allowedOrigins) === undefined ? { ...state, captureContexts: {} } : state),
        chrome.tabs.sendMessage(tab.id, { ...message, state: stateForTab(state, tab.id) })
      ]);
    }));
  } catch {
    // A tab can disappear or deny messaging between query and delivery.
  }
}

let publication = Promise.resolve();
let publishedRevision = -1;
function publish(state: InspectorState): Promise<void> {
  const operation = publication.then(async () => {
    if ((state.revision ?? 0) <= publishedRevision) return;
    await broadcast(state);
    publishedRevision = state.revision ?? 0;
  });
  publication = operation.catch(() => undefined);
  return operation;
}

function refreshTabBadge(tabId: number): Promise<void> {
  // Navigation can change display eligibility without changing stored state.
  // Share the publication queue so an older broadcast cannot overwrite this refresh.
  const operation = publication.then(async () => {
    const tab = await chrome.tabs.get(tabId);
    const state = await readState();
    await updateBadge(tabId, displayTabId(state, tab, allowedOrigins) === undefined
      ? { ...state, captureContexts: {} } : state);
  });
  publication = operation.catch(() => undefined);
  return operation;
}

async function acceptObservation(observation: RouteObservation): Promise<InspectorState> {
  const normalized = normalizeObservation(observation);
  if (!normalized) throw new Error('无效的路由观察记录。');
  const state = await storeObservation(normalized);
  await publish(state);
  return state;
}

async function acceptPowObservation(observation: PowObservation): Promise<InspectorState> {
  const state = await storePowObservation(observation);
  await publish(state);
  return state;
}

chrome.runtime.onInstalled.addListener((details) => {
  void handleInstallation(details).catch((error: unknown) => console.error('Unable to open the extension welcome or update page.', error));
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (response: RuntimeResponse) => void) => {
  const request = raw as RuntimeRequest;
  // Extension pages can also have sender.tab. Only content-script replies are tab projections.
  let contentTabId: number | undefined;
  try {
    if (sender.url && allowedOrigins.has(new URL(sender.url).origin)) contentTabId = sender.tab?.id;
  } catch { /* An invalid sender URL never acquires a content-tab scope. */ }
  void (async () => {
    if (request.type === 'route:context') {
      const context = normalizeCaptureContext(request.context);
      if (contentTabId === undefined || !context || new URL(context.pageUrl).origin !== new URL(sender.url!).origin) {
        return { ok: false, error: 'Invalid capture context.' };
      }
      if (await currentTabPage(contentTabId) !== context.pageUrl) {
        return { ok: false, error: 'Capture context does not belong to the current page.' };
      }
      const state = await storeCaptureContext(contentTabId, context);
      const accepted = state.captureContexts?.[contentTabId];
      if (!accepted || accepted.invalidated || accepted.id !== context.id || accepted.documentId !== context.documentId) {
        return { ok: false, error: 'Capture context is no longer current.' };
      }
      await publish(state);
      return { ok: true, state };
    }
    if (request.type === 'route:observation') {
      const observation: RouteObservation = sender.tab?.id === undefined
        ? request.observation
        : { ...request.observation, tabId: sender.tab.id };
      return { ok: true, state: await acceptObservation(observation) };
    }
    if (request.type === 'pow:observation') {
      const observation: PowObservation = sender.tab?.id === undefined
        ? request.observation
        : { ...request.observation, tabId: sender.tab.id };
      return { ok: true, state: await acceptPowObservation(observation) };
    }
    if (request.type === 'route:get-state') {
      if (Number.isInteger(request.tabId)) await publish(await retireOffsiteContext(request.tabId!));
      const state = await readState();
      return sender.tab?.id === undefined ? { ok: true, state } : { ok: true, state, tabId: sender.tab.id };
    }
    if (request.type === 'route:update-settings') {
      const requestedLanguage = request.settings.uiLanguage;
      const uiLanguage = requestedLanguage === undefined ? undefined : normalizeUiLanguage(requestedLanguage);
      if (requestedLanguage !== undefined && !uiLanguage) return { ok: false, error: 'Invalid UI language.' };
      const settings = uiLanguage ? { ...request.settings, uiLanguage } : request.settings;
      const state = await mutateState((current) => ({ ...current, settings: { ...current.settings, ...settings } }));
      await publish(state);
      return { ok: true, state };
    }
    if (request.type === 'route:clear') {
      const state = await clearState();
      await publish(state);
      return { ok: true, state };
    }
    if (request.type === 'route:open-dashboard') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard/index.html') });
      return { ok: true };
    }
    if (request.type === 'route:open-announcement') {
      await chrome.tabs.create({ url: UPGRADE_NOTICE_URL });
      return { ok: true };
    }
    return { ok: false, error: '未知请求。' };
  })().then((response) => sendResponse(response.state && contentTabId !== undefined
    ? { ...response, state: stateForTab(response.state, contentTabId) } : response)).catch((error: unknown) => sendResponse({
    ok: false,
    error: error instanceof Error ? error.message : '扩展内部错误。'
  }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url === undefined && change.status === undefined) return;
  if (supportedPageUrl(tab.url, allowedOrigins)) {
    void refreshTabBadge(tabId).catch((error: unknown) => console.error('Could not refresh navigation badge.', error));
    return;
  }
  // Recheck event snapshots and use the same identity-bound invalidation as reads.
  void retireOffsiteContext(tabId).then(publish)
    .catch((error: unknown) => console.error('Could not retire navigation context.', error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  badgeTexts.delete(tabId);
  void mutateState((state) => {
    if (!state.captureContexts?.[tabId]) return state;
    const captureContexts = { ...state.captureContexts };
    delete captureContexts[tabId];
    return { ...state, captureContexts };
  }).then(publish).catch((error: unknown) => console.error('Could not clear closed-tab capture context.', error));
});
