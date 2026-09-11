import { clearState, mutateState, readState, storeObservation, storePowObservation } from './storage';
import { stateForTab } from '../core/state';
import { normalizeUiLanguage } from '../core/language';
import { normalizeObservation } from '../core/observation';
import type { InspectorState, PowObservation, RouteObservation } from '../core/types';
import type { RuntimeRequest, RuntimeResponse } from '../shared/messages';

const allowedOrigins = new Set(__ROUTE_INSPECTOR_ALLOWED_ORIGINS__);
const badgeTexts = new Map<number, string>();

async function updateBadge(tabId: number | undefined, state: InspectorState): Promise<void> {
  if (tabId === undefined) return;
  const latest = state.turns.find((turn) => turn.tabId === tabId && turn.captureMode === state.settings.captureMode);
  const text = !latest || !state.settings.autoCaptureEnabled ? '' : latest.phase === 'failed' ? '?' : latest?.verdict === 'mismatch' || latest?.verdict === 'conflict'
    ? '!'
    : latest?.verdict === 'normal'
      ? 'OK'
      : latest?.verdict === 'auto_reasoning'
        ? 'AUTO'
      : latest?.phase === 'requested' || latest?.phase === 'responding'
        ? '…'
        : '?';
  const color = text === '!' ? '#d95343' : text === 'OK' ? '#6fa92e' : text === 'AUTO' ? '#367c8c' : '#b47d2d';
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
      if (tab.id === undefined || !tab.url) return;
      try {
        if (!allowedOrigins.has(new URL(tab.url).origin)) return;
      } catch {
        return;
      }
      await Promise.allSettled([
        updateBadge(tab.id, state),
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
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('ui/onboarding/index.html') });
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (response: RuntimeResponse) => void) => {
  const request = raw as RuntimeRequest;
  // Extension pages can also have sender.tab. Only content-script replies are tab projections.
  let contentTabId: number | undefined;
  try {
    if (sender.url && allowedOrigins.has(new URL(sender.url).origin)) contentTabId = sender.tab?.id;
  } catch { /* An invalid sender URL never acquires a content-tab scope. */ }
  void (async () => {
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
    return { ok: false, error: '未知请求。' };
  })().then((response) => sendResponse(response.state && contentTabId !== undefined
    ? { ...response, state: stateForTab(response.state, contentTabId) } : response)).catch((error: unknown) => sendResponse({
    ok: false,
    error: error instanceof Error ? error.message : '扩展内部错误。'
  }));
  return true;
});
