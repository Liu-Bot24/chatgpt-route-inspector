import { expect, it } from 'vitest';
import { CaptureContextTracker, latestInContext, newerContext, normalizeCaptureContext } from '../../src/core/capture-context';
import { DEFAULT_SETTINGS, type InspectorState } from '../../src/core/types';
import { createTurn, upsertTurn } from '../../src/core/turns';

const url = (id: string) => `https://chatgpt.com/c/${id}`;
function state() {
  const tracker = new CaptureContextTracker(url('a'));
  const context = tracker.snapshot();
  const observation = { captureId: 'request', captureContextId: context.id, tabId: 1,
    source: 'page_fetch' as const, captureMode: 'live' as const, phase: 'completed' as const,
    observedAt: '2026-09-16T00:00:00Z', conversationId: 'a', requestedModel: 'live', resolvedModelSlug: 'live' };
  const data: InspectorState = { settings: DEFAULT_SETTINGS, turns: [createTurn(observation)], powReadings: [],
    captureContexts: { 1: context }, parserHealth: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 } };
  return { tracker, context, observation, data };
}

it('keeps modes independent and leaves the missing side empty', () => {
  const { data, observation } = state();
  expect(latestInContext(data, 1, 'live')?.routeModel).toBe('live');
  expect(latestInContext(data, 1, 'reload')).toBeNull();
  data.turns = upsertTurn(data.turns, { ...observation, source: 'conversation_record', captureMode: 'reload', resolvedModelSlug: 'reload' });
  expect(data.turns).toHaveLength(2);
  expect(latestInContext(data, 1, 'reload')?.routeModel).toBe('reload');
  expect(latestInContext(data, 1, 'live')?.routeModel).toBe('live');
  expect(latestInContext(data, 2, 'live')).toBeNull();
  expect(latestInContext(data, undefined, 'live')).toBeNull();
});

it('does not show old document, old visit, another conversation or legacy history', () => {
  const { data, tracker } = state();
  data.captureContexts = { 1: tracker.navigate(url('b')) };
  expect(latestInContext(data, 1, 'live')).toBeNull();
  data.captureContexts = { 1: tracker.navigate(url('a')) };
  expect(latestInContext(data, 1, 'live')).toBeNull();
  data.captureContexts = { 1: new CaptureContextTracker(url('a')).snapshot() };
  expect(latestInContext(data, 1, 'live')).toBeNull();
  data.turns[0]!.captureContextId = data.captureContexts[1]!.id;
  data.turns[0]!.conversationId = 'wrong';
  expect(latestInContext(data, 1, 'live')).toBeNull();
  delete data.captureContexts;
  expect(latestInContext(data, 1, 'live')).toBeNull();
});

it('never merges the same network request ID across page visits', () => {
  const { data, observation } = state();
  data.turns = upsertTurn(data.turns, { ...observation, requestId: 'same', captureContextId: 'another' });
  expect(data.turns).toHaveLength(2);
});

it('prefers the actual reload response over a later DOM fallback without merging sources', () => {
  const { data, observation } = state();
  const record = createTurn({ ...observation, captureMode: 'reload', source: 'conversation_record' });
  const dom = createTurn({ ...observation, captureMode: 'reload', source: 'assistant_dom', domModelSlug: 'dom' });
  data.turns = [dom, record];
  expect(latestInContext(data, 1, 'reload')).toBe(record);
  expect(record.sources).toEqual(['conversation_record']);
});

it.each([true, false])('keeps explicit network conflict ahead of DOM (conflict=%s)', (conflict) => {
  const { data, observation } = state();
  const record = createTurn({ ...observation, source: 'conversation_record', captureMode: 'reload',
    resolvedModelSlug: 'gpt-5-6-thinking', serverModelSlug: conflict ? 'gpt-5-4-thinking' : 'gpt-5-6-thinking' });
  const dom = createTurn({ ...observation, captureId: 'dom', source: 'assistant_dom', captureMode: 'reload',
    resolvedModelSlug: null, domModelSlug: 'gpt-5-6-thinking' });
  data.turns = [dom, record];
  expect(latestInContext(data, 1, 'reload')).toBe(record);
  if (conflict) expect(record.verdict).toBe('conflict');
});

it('still permits DOM fallback when the network record has no response evidence', () => {
  const { data, observation } = state();
  const record = createTurn({ ...observation, source: 'conversation_record', captureMode: 'reload', resolvedModelSlug: null });
  const dom = createTurn({ ...observation, captureId: 'dom', source: 'assistant_dom', captureMode: 'reload',
    resolvedModelSlug: null, domModelSlug: 'dom-route' });
  data.turns = [dom, record];
  expect(latestInContext(data, 1, 'reload')).toBe(dom);
});

it.each(['before', 'after'])('preserves first-message capture when the new conversation URL arrives %s response metadata', (order) => {
  const tracker = new CaptureContextTracker('https://chatgpt.com/');
  const initial = tracker.startLive();
  if (order === 'before') tracker.navigate(url('new'));
  tracker.observeLive(initial.id, 'new');
  const current = tracker.navigate(url('new'));
  expect(current.id).toBe(initial.id);
  expect(current.reloadEligible).toBe(false);
});

it('does not promote an unrelated route or revive a creation after another navigation', () => {
  const tracker = new CaptureContextTracker('https://chatgpt.com/');
  const original = tracker.startLive();
  tracker.navigate(url('other'));
  tracker.observeLive(original.id, 'new');
  expect(tracker.snapshot().id).not.toBe(original.id);
  tracker.navigate(url('new'));
  tracker.observeLive(original.id, 'new');
  expect(tracker.snapshot().id).not.toBe(original.id);
});

it.each(['before-local', 'during-local', 'after-local'])('retains creation across a local URL with identity %s', (order) => {
  const tracker = new CaptureContextTracker('https://chatgpt.com/');
  const initial = tracker.startLive();
  if (order === 'before-local') tracker.observeLive(initial.id, 'new');
  const local = tracker.navigate(url('local-chatgpt%3Adraft'));
  expect(local.id).toBe(initial.id);
  expect(local.visitStartedAt).toBe(initial.visitStartedAt);
  expect(local.reloadEligible).toBe(false);
  expect(tracker.canStartReload()).toBe(false);
  if (order === 'during-local') tracker.observeLive(initial.id, 'new');
  tracker.navigate(url('new'));
  if (order === 'after-local') tracker.observeLive(initial.id, 'new');
  expect(tracker.snapshot().id).toBe(initial.id);
  expect(tracker.snapshot().reloadEligible).toBe(false);
});

it.each(['other-local', 'other-chat', 'back-home', 'clear', 'pause'])('does not carry a local creation across %s', (action) => {
  const tracker = new CaptureContextTracker('https://chatgpt.com/');
  const initial = tracker.startLive();
  tracker.navigate(url('local-chatgpt%3Adraft'));
  if (action === 'other-local') tracker.navigate(url('local-chatgpt%3Aanother'));
  if (action === 'other-chat') tracker.navigate(url('unrelated'));
  if (action === 'back-home') tracker.navigate('https://chatgpt.com/');
  if (action === 'clear') tracker.clearBefore(Date.now());
  if (action === 'pause') tracker.stopFallback();
  tracker.observeLive(initial.id, 'new');
  tracker.navigate(url('new'));
  tracker.observeLive(initial.id, 'new');
  expect(tracker.snapshot().id).not.toBe(initial.id);
});

it('allows new network loads while an unconfirmed creation keeps DOM fallback closed', () => {
  const tracker = new CaptureContextTracker('https://chatgpt.com/');
  const original = tracker.startLive();
  expect(tracker.navigate(url('other')).reloadEligible).toBe(false);
  expect(tracker.canStartReload()).toBe(true);
  tracker.observeLive(original.id, 'new');
  expect(tracker.snapshot().reloadEligible).toBe(true);
  expect(tracker.snapshot().id).not.toBe(original.id);
});

it.each(['clear', 'new-live'])('does not let a late creation identity undo %s', (action) => {
  const tracker = new CaptureContextTracker('https://chatgpt.com/');
  const original = tracker.startLive();
  const next = tracker.navigate(url('other'));
  if (action === 'clear') tracker.stopFallback();
  else tracker.startLive();
  tracker.observeLive(original.id, 'other');
  tracker.abandonCreation(original.id);
  expect(tracker.snapshot().id).toBe(next.id);
  expect(tracker.snapshot().reloadEligible).toBe(false);
});

it('closes DOM fallback at live start, clear or pause; a new visit opens its own fallback', () => {
  const tracker = new CaptureContextTracker(url('a'));
  expect(tracker.snapshot().reloadEligible).toBe(true);
  expect(tracker.startLive().reloadEligible).toBe(false);
  expect(tracker.navigate(url('b')).reloadEligible).toBe(true);
  tracker.stopFallback();
  expect(tracker.snapshot().reloadEligible).toBe(false);
});

it('rejects stale contexts and strips extraneous page URL data', () => {
  const { context } = state();
  expect(newerContext(context, { ...context, revision: context.revision + 1 })).toBe(true);
  expect(newerContext(context, context)).toBe(false);
  expect(newerContext(context, { ...context, documentId: 'old', documentStartedAt: context.documentStartedAt - 1, revision: 99 })).toBe(false);
  expect(normalizeCaptureContext({ ...context, pageUrl: `${url('a')}?secret=1#x` })?.pageUrl).toBe(url('a'));
  expect(normalizeCaptureContext({ ...context, pageUrl: 'javascript:1' })).toBeNull();
  expect(normalizeCaptureContext({ ...context, id: '' })).toBeNull();
});

it('validates optional visit time without changing legacy contexts', () => {
  const { context } = state();
  const legacy = { ...context };
  delete legacy.visitStartedAt;
  expect(normalizeCaptureContext(legacy)).toEqual(legacy);
  expect(normalizeCaptureContext({ ...context, visitStartedAt: context.documentStartedAt - 1 })).toBeNull();
  expect(normalizeCaptureContext({ ...context, visitStartedAt: context.documentStartedAt + 100 })).toMatchObject({
    visitStartedAt: context.documentStartedAt + 100
  });
});
