import { describe, expect, it } from 'vitest';
import { isStaleState, stateForTab } from '../../src/core/state';
import { DEFAULT_SETTINGS, type InspectorState } from '../../src/core/types';
import { createTurn } from '../../src/core/turns';

const state: InspectorState = {
  revision: 5, turns: [1, 2].map((tabId) => createTurn({
    tabId, captureId: `capture-${tabId}`, source: 'page_fetch', captureMode: 'live', phase: 'completed', observedAt: '2026-09-11T00:00:00Z'
  })),
  powReadings: [1, 2].map((tabId) => ({ tabId, rawHex: 'ff', decimal: '255', observedAt: '2026-09-11T00:00:00Z' })),
  settings: DEFAULT_SETTINGS, parserHealth: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 }
};

describe('versioned state delivery', () => {
  it('rejects delayed initialization, action responses, and broadcasts using the same revision gate', () => {
    expect(isStaleState(state, { ...state, revision: 4 })).toBe(true);
    expect(isStaleState(state, { ...state, revision: 6 })).toBe(false);
    expect(isStaleState(null, state)).toBe(false);
    const legacy = { ...state }; delete legacy.revision;
    expect(isStaleState(state, legacy)).toBe(true);
    expect(isStaleState(legacy, state)).toBe(false);
  });

  it('projects only tab-local records without changing global settings, revisions, or history', () => {
    const projected = stateForTab(state, 1);
    expect(projected.turns.map((turn) => turn.tabId)).toEqual([1]);
    expect(projected.powReadings.map((reading) => reading.tabId)).toEqual([1]);
    expect(projected.revision).toBe(5);
    expect(projected.settings).toBe(state.settings);
    expect(state.turns).toHaveLength(2);
    expect(stateForTab(state, 99).turns).toEqual([]);
  });
});
