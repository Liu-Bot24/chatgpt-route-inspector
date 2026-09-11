import type { InspectorState } from './types';

export function isStaleState(current: InspectorState | null | undefined, next: InspectorState): boolean {
  return Boolean(current && (next.revision ?? 0) < (current.revision ?? 0));
}

export function stateForTab(state: InspectorState, tabId: number): InspectorState {
  return {
    ...state,
    turns: state.turns.filter((turn) => turn.tabId === tabId),
    powReadings: state.powReadings.filter((reading) => reading.tabId === tabId)
  };
}
