import { DEFAULT_SETTINGS, normalizeOverlayMode, type InspectorState, type PowObservation, type RouteObservation } from '../core/types';
import { browserUiLanguage, normalizeUiLanguage } from '../core/language';
import { migrateStoredTurn } from '../core/migration';
import { normalizePowObservation, upsertPowReading } from '../core/pow';
import { newestCaptureFirst, upsertTurn } from '../core/turns';

const STORAGE_KEY = 'chatgptRouteInspectorStateV1';
let queue = Promise.resolve();
let cached: Promise<InspectorState> | null = null;

export function defaultState(): InspectorState {
  return {
    revision: 0,
    turns: [],
    powReadings: [],
    settings: { ...DEFAULT_SETTINGS, uiLanguage: browserUiLanguage() },
    parserHealth: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 }
  };
}

async function loadState(): Promise<InspectorState> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const candidate = stored[STORAGE_KEY] as Partial<InspectorState> | undefined;
  if (!candidate) return defaultState();
  const turns = Array.isArray(candidate.turns)
    ? candidate.turns.map(migrateStoredTurn).filter((turn): turn is NonNullable<typeof turn> => turn !== null)
    : [];
  const powReadings = Array.isArray(candidate.powReadings)
    ? candidate.powReadings
      .map(normalizePowObservation)
      .filter((reading): reading is NonNullable<typeof reading> => reading !== null)
    : [];
  const captureMode = candidate.settings?.captureMode === 'reload' ? 'reload' : 'live';
  const uiLanguage = normalizeUiLanguage(candidate.settings?.uiLanguage) ?? browserUiLanguage();
  const overlayMode = normalizeOverlayMode(candidate.settings?.overlayMode, candidate.settings?.overlayMinimized);
  return {
    revision: Number.isSafeInteger(candidate.revision) && (candidate.revision ?? 0) >= 0 ? candidate.revision! : 0,
    ...(candidate.clearedAt ? { clearedAt: candidate.clearedAt } : {}),
    turns: turns.sort(newestCaptureFirst),
    powReadings,
    settings: {
      ...DEFAULT_SETTINGS,
      ...candidate.settings,
      captureMode,
      uiLanguage,
      overlayMode,
      overlayMinimized: overlayMode !== 'full'
    },
    parserHealth: candidate.parserHealth ?? { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 }
  };
}

function currentState(): Promise<InspectorState> {
  cached ??= loadState().catch((error: unknown) => { cached = null; throw error; });
  return cached;
}

export async function readState(): Promise<InspectorState> {
  await queue;
  return currentState();
}

export function clearState(): Promise<InspectorState> {
  return mutateState((current) => ({
    ...defaultState(), settings: current.settings, clearedAt: new Date().toISOString()
  }));
}

export function storePowObservation(observation: PowObservation): Promise<InspectorState> {
  return mutateState((state) => isCleared(state, observation.startedAt ?? observation.observedAt) ? state : ({
    ...state,
    powReadings: upsertPowReading(state.powReadings, observation)
  }));
}

export function mutateState(mutator: (state: InspectorState) => InspectorState | Promise<InspectorState>): Promise<InspectorState> {
  const operation = queue.then(async () => {
    const current = await currentState();
    const updated = await mutator(current);
    if (updated === current) return current;
    const next = { ...updated, revision: (current.revision ?? 0) + 1 };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    cached = Promise.resolve(next);
    return next;
  });
  queue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function storeObservation(observation: RouteObservation): Promise<InspectorState> {
  return mutateState((state) => {
    if (isCleared(state, observation.startedAt ?? observation.observedAt)) return state;
    const turns = upsertTurn(state.turns, observation).slice(0, state.settings.retentionLimit);
    const previous = state.turns.find((turn) => turn.captureId === observation.captureId && turn.tabId === (observation.tabId ?? null));
    const stale = previous && Date.parse(observation.observedAt) < Date.parse(previous.observedAt);
    const failed = observation.phase === 'failed' && previous?.phase !== 'failed';
    const successful = observation.phase !== 'requested' && observation.phase !== 'failed' && Boolean(
      observation.responseModelSlug || observation.resolvedModelSlug || observation.serverModelSlug || observation.domModelSlug
    );
    return {
      ...state,
      turns,
      parserHealth: stale ? state.parserHealth : failed
        ? { lastSuccessAt: state.parserHealth.lastSuccessAt, lastFailureAt: observation.observedAt, consecutiveFailures: state.parserHealth.consecutiveFailures + 1 }
        : successful ? { lastSuccessAt: observation.observedAt, lastFailureAt: state.parserHealth.lastFailureAt, consecutiveFailures: 0 }
        : state.parserHealth
    };
  });
}

function isCleared(state: InspectorState, startedAt: string): boolean {
  return Boolean(state.clearedAt && Date.parse(startedAt) <= Date.parse(state.clearedAt));
}
