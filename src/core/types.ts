export const ROUTE_SCHEMA = 'chatgpt-route-observation' as const;
export const ROUTE_SCHEMA_VERSION = '1.9.0' as const;
import type { TaskKind } from './task-kind';

export type CaptureSource = 'page_fetch' | 'page_websocket' | 'conversation_record' | 'assistant_dom';
export type CaptureMode = 'live' | 'reload';
export type UiLanguage = 'zh' | 'en';
export type OverlayMode = 'full' | 'compact' | 'mini' | 'docked';
export type CapturePhase = 'requested' | 'responding' | 'completed' | 'failed';
export type RouteVerdict = 'normal' | 'mismatch' | 'conflict' | 'unknown' | 'auto_reasoning' | 'suspected_downgrade' | 'work_unverifiable' | TaskKind;
export type ModelLabelSource =
  | 'assistant.metadata.model_slug'
  | 'assistant[data-message-model-slug]';
export type RouteModelSource =
  | 'resolved_model_slug'
  | 'server_ste_metadata.model_slug';
export type ResponseModelSource = RouteModelSource | ModelLabelSource;

export function normalizeOverlayMode(value: unknown, legacyMinimized = false): OverlayMode {
  if (value === 'full' || value === 'compact' || value === 'mini' || value === 'docked') return value;
  return legacyMinimized ? 'compact' : 'full';
}

export interface UsageQuotaFields {
  deepResearchRemaining: number | null;
  deepResearchResetAt: string | null;
  imageGenRemaining: number | null;
  imageGenResetAt: string | null;
  quotaObservedAt: string | null;
}

export const EMPTY_QUOTA_FIELDS: UsageQuotaFields = {
  deepResearchRemaining: null, deepResearchResetAt: null,
  imageGenRemaining: null, imageGenResetAt: null, quotaObservedAt: null
};

export interface RouteFields extends UsageQuotaFields {
  taskKind: TaskKind | null;
  researchReportModel: string | null;
  researchWidgetId: string | null;
  researchMessageId: string | null;
  requestedModel: string | null;
  responseModelSlug: string | null;
  defaultModelSlug: string | null;
  resolvedModelSlug: string | null;
  serverModelSlug: string | null;
  domModelSlug: string | null;
  thinkingEffort: string | null;
  planType: string | null;
  requestId: string | null;
  conversationId: string | null;
  conversationMode: string | null;
  selectedSourcesCount: number | null;
  toolInvoked: boolean | null;
  toolName: string | null;
  isSearch: boolean | null;
  hadImage: boolean | null;
  fastConvo: boolean | null;
}

export interface RouteAssessment {
  verdict: RouteVerdict;
  routeModel: string | null;
  routeModelSources: ResponseModelSource[];
  modelLabel: string | null;
  modelLabelSources: ModelLabelSource[];
  modelLabelConflict: boolean;
  reasons: string[];
}

export interface RouteObservation extends Partial<RouteFields> {
  captureContextId?: string;
  captureId: string;
  source: CaptureSource;
  captureMode: CaptureMode;
  phase: CapturePhase;
  tabId?: number;
  pageUrl?: string;
  networkRequestId?: string;
  observedAt: string;
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
}

export interface RouteTurn extends RouteFields, RouteAssessment {
  captureContextId?: string;
  schema: typeof ROUTE_SCHEMA;
  schemaVersion: typeof ROUTE_SCHEMA_VERSION;
  captureId: string;
  sources: CaptureSource[];
  captureMode: CaptureMode;
  phase: CapturePhase;
  tabId: number | null;
  pageUrl: string | null;
  networkRequestId: string | null;
  observedAt: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
}

export interface InspectorSettings {
  overlayEnabled: boolean;
  overlayMode: OverlayMode;
  /** Kept in storage for compatibility with releases that only knew two overlay states. */
  overlayMinimized: boolean;
  retentionLimit: number;
  includeRequestIdsInExport: boolean;
  autoCaptureEnabled: boolean;
  /** Display selection only; both capture channels run while automatic capture is enabled. */
  captureMode: CaptureMode;
  uiLanguage: UiLanguage;
}

export interface PowObservation {
  startedAt?: string;
  rawHex: string;
  observedAt: string;
  tabId?: number;
}

export interface PowReading {
  rawHex: string;
  decimal: string;
  observedAt: string;
  tabId: number | null;
}

export interface CaptureContext {
  /** Background-only tombstone: leaving a supported site retires this document. */
  invalidated?: boolean;
  id: string;
  documentId: string;
  documentStartedAt: number;
  /** Absent only in contexts produced by earlier extension builds. */
  visitStartedAt?: number;
  revision: number;
  pageUrl: string;
  reloadEligible: boolean;
}

export interface InspectorState {
  captureContexts?: Record<number, CaptureContext>;
  /** Persisted monotonic snapshot version; absent only in older installations. */
  revision?: number;
  clearedAt?: string;
  turns: RouteTurn[];
  powReadings: PowReading[];
  settings: InspectorSettings;
  parserHealth: {
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
  };
}

export const EMPTY_ROUTE_FIELDS: RouteFields = {
  ...EMPTY_QUOTA_FIELDS,
  taskKind: null,
  researchReportModel: null,
  researchWidgetId: null,
  researchMessageId: null,
  requestedModel: null,
  responseModelSlug: null,
  defaultModelSlug: null,
  resolvedModelSlug: null,
  serverModelSlug: null,
  domModelSlug: null,
  thinkingEffort: null,
  planType: null,
  requestId: null,
  conversationId: null,
  conversationMode: null,
  selectedSourcesCount: null,
  toolInvoked: null,
  toolName: null,
  isSearch: null,
  hadImage: null,
  fastConvo: null
};

export const DEFAULT_SETTINGS: InspectorSettings = {
  overlayEnabled: true,
  overlayMode: 'full',
  overlayMinimized: false,
  retentionLimit: 100,
  includeRequestIdsInExport: false,
  autoCaptureEnabled: true,
  captureMode: 'live',
  uiLanguage: 'en'
};
