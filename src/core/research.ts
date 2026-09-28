import { EMPTY_ROUTE_FIELDS, type RouteFields } from './types';
import { assessRoute } from './assessment';
import { taskFromMetadata } from './task-kind';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function projectedReport(value: unknown): Record<string, unknown> | undefined {
  const message = record(value);
  const metadata = record(message?.metadata);
  if (record(message?.author)?.role !== 'assistant' || !metadata) return undefined;
  const model = (value: unknown): string | null => typeof value === 'string' && value.length <= 256 ? value.trim() || null : null;
  return { author: { role: 'assistant' }, metadata: {
    resolved_model_slug: model(metadata.resolved_model_slug),
    model_slug: model(metadata.model_slug),
    server_ste_metadata: { model_slug: model(record(metadata.server_ste_metadata)?.model_slug) }
  } };
}

function reportModel(state: Record<string, unknown> | null): string | null {
  const message = projectedReport(state?.report_message);
  const metadata = record(message?.metadata);
  if (!metadata) return null;
  return assessRoute({ ...EMPTY_ROUTE_FIELDS,
    resolvedModelSlug: metadata.resolved_model_slug as string | null,
    serverModelSlug: record(metadata.server_ste_metadata)?.model_slug as string | null,
    responseModelSlug: metadata.model_slug as string | null
  }).routeModel;
}

export function projectResearchWidgetState(value: unknown): unknown {
  let state = record(value);
  if (typeof value === 'string' && value.length <= 2 * 1024 * 1024) {
    try { state = record(JSON.parse(value)); } catch { return undefined; }
  }
  const report = projectedReport(state?.report_message);
  return report ? { report_message: report } : undefined;
}

/** The report is a separate message, never input to the planner's route assessment. */
export function researchFromMetadata(metadata: Record<string, unknown>, messageId?: unknown): Partial<RouteFields> {
  if (taskFromMetadata(metadata) !== 'deep_research') return {};
  const sdk = record(metadata.chatgpt_sdk);
  let state = record(sdk?.widget_state);
  if (typeof sdk?.widget_state === 'string' && sdk.widget_state.length <= 2 * 1024 * 1024) {
    try { state = record(JSON.parse(sdk.widget_state)); } catch { /* Incomplete widget state: no report evidence yet. */ }
  }
  const widgetId = identifier(sdk?.widget_session_id);
  // A generic task hint identifies research, not the message that owns its report.
  const ownsReport = Boolean(widgetId || sdk?.resource_name === 'Deep Research App_start' ||
    record(metadata.invoked_resource)?.app_name === 'Deep Research App');
  return {
    researchWidgetId: widgetId,
    researchMessageId: ownsReport ? identifier(messageId) : null,
    researchReportModel: reportModel(state)
  };
}

export interface ResearchUpdate {
  conversationId: string;
  correlationIds: string[];
  reportModel: string | null;
  completed: boolean;
}

/** Accept only the observed widget-update envelope; never scan answer/tool bodies. */
export function parseResearchUpdates(raw: string): ResearchUpdate[] {
  if (raw.length > 2 * 1024 * 1024) return [];
  let root: Record<string, unknown> | null;
  try { root = record(JSON.parse(raw)); } catch { return []; }
  const payload = record(root?.payload);
  if (root?.type !== 'conversation-update' || payload?.update_type !== 'update-widget-state') return [];
  const conversationId = identifier(payload.conversation_id);
  const updates = record(payload.update_content)?.updates;
  if (!conversationId || !Array.isArray(updates)) return [];
  return updates.slice(0, 16).flatMap((value): ResearchUpdate[] => {
    const update = record(value);
    const state = record(update?.widget_state);
    if (!update || !state) return [];
    // Match only explicit widget/message identity. Conversation identity alone is
    // insufficient when a conversation contains more than one research task.
    const correlationIds = ['id', 'message_id', 'widget_session_id'].flatMap((key) => {
      const id = identifier(update[key]);
      return id ? [id] : [];
    });
    return [{ conversationId, correlationIds, reportModel: reportModel(state), completed: state.status === 'completed' }];
  });
}

export function matchesResearchUpdate(fields: Pick<RouteFields, 'taskKind' | 'conversationId' | 'researchWidgetId' | 'researchMessageId'>, update: ResearchUpdate): boolean {
  return fields.taskKind === 'deep_research' && fields.conversationId === update.conversationId &&
    [fields.researchWidgetId, fields.researchMessageId].some((id) => Boolean(id && update.correlationIds.includes(id)));
}
