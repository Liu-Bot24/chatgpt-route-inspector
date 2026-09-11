import { EMPTY_QUOTA_FIELDS, type UsageQuotaFields } from './types';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function remaining(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function normalizeUsageQuota(value: unknown): UsageQuotaFields {
  const source = record(value);
  return {
    deepResearchRemaining: remaining(source?.deepResearchRemaining),
    deepResearchResetAt: timestamp(source?.deepResearchResetAt),
    imageGenRemaining: remaining(source?.imageGenRemaining),
    imageGenResetAt: timestamp(source?.imageGenResetAt),
    quotaObservedAt: timestamp(source?.quotaObservedAt)
  };
}

/** Keep only the two requested features and their count/reset fields. */
export function projectLimitsProgress(value: unknown): Array<Record<string, unknown> | null> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).map((item) => {
    const entry = record(item);
    if (entry?.feature_name !== 'deep_research' && entry?.feature_name !== 'image_gen') return null;
    return { feature_name: entry.feature_name, remaining: remaining(entry.remaining), reset_after: timestamp(entry.reset_after) };
  });
}

export function parseUsageQuota(value: unknown): UsageQuotaFields {
  const result = { ...EMPTY_QUOTA_FIELDS };
  for (const entry of projectLimitsProgress(record(value)?.limits_progress)) {
    if (!entry) continue;
    if (entry.feature_name === 'deep_research') {
      result.deepResearchRemaining = entry.remaining as number | null;
      result.deepResearchResetAt = entry.reset_after as string | null;
    } else {
      result.imageGenRemaining = entry.remaining as number | null;
      result.imageGenResetAt = entry.reset_after as string | null;
    }
  }
  return result;
}

export function hasUsageQuota(fields: UsageQuotaFields): boolean {
  return fields.deepResearchRemaining !== null || fields.deepResearchResetAt !== null ||
    fields.imageGenRemaining !== null || fields.imageGenResetAt !== null;
}

export function quotaSignature(fields: UsageQuotaFields): string {
  return JSON.stringify([fields.deepResearchRemaining, fields.deepResearchResetAt, fields.imageGenRemaining, fields.imageGenResetAt]);
}
