import type { CaptureContext, InspectorSettings, InspectorState, PowObservation, RouteObservation } from '../core/types';

export type RuntimeRequest =
  | { type: 'route:context'; context: CaptureContext }
  | { type: 'route:observation'; observation: RouteObservation }
  | { type: 'pow:observation'; observation: PowObservation }
  | { type: 'route:get-state'; tabId?: number }
  | { type: 'route:update-settings'; settings: Partial<InspectorSettings> }
  | { type: 'route:clear' }
  | { type: 'route:open-dashboard' }
  | { type: 'route:open-announcement' };

/** Sent from extension pages to a tab; only a live bridge in that document answers. */
export interface BridgePingRequest { type: 'route:bridge-ping' }

export interface RuntimeResponse {
  ok: boolean;
  state?: InspectorState;
  error?: string;
  tabId?: number;
}

interface PageRouteBridgeEnvelope {
  source: 'chatgpt-route-inspector';
  version: 1;
  observation: RouteObservation;
}

interface PagePowBridgeEnvelope {
  source: 'chatgpt-route-inspector';
  version: 1;
  pow: PowObservation;
}

export type PageBridgeEnvelope = PageRouteBridgeEnvelope | PagePowBridgeEnvelope;

export function isPageBridgeEnvelope(value: unknown): value is PageBridgeEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.source !== 'chatgpt-route-inspector' || candidate.version !== 1) return false;
  if (candidate.pow && typeof candidate.pow === 'object') {
    const pow = candidate.pow as Record<string, unknown>;
    return typeof pow.rawHex === 'string' && typeof pow.observedAt === 'string';
  }
  if (!candidate.observation || typeof candidate.observation !== 'object') return false;
  const record = candidate.observation as Record<string, unknown>;
  return typeof record.captureId === 'string' &&
    typeof record.observedAt === 'string' &&
    ['page_fetch', 'page_websocket', 'conversation_record'].includes(String(record.source)) &&
    ['live', 'reload'].includes(String(record.captureMode)) &&
    ['requested', 'responding', 'completed', 'failed'].includes(String(record.phase));
}
