export type TaskKind = 'image_generation' | 'deep_research';

export function normalizeTaskKind(value: unknown): TaskKind | null {
  return value === 'image_generation' || value === 'deep_research' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function imageTool(value: unknown): boolean {
  return typeof value === 'string' && /^(?:image_gen(?:\.text2im)?|dalle\.text2im)$/.test(value);
}

/** Only structured task/tool metadata, never prompt text, image inputs or quota names. */
export function taskFromMetadata(metadata: Record<string, unknown>): TaskKind | null {
  const hints = metadata.system_hints;
  if ((Array.isArray(hints) && hints.includes('plugin:connector_openai_deep_research')) ||
      record(metadata.chatgpt_sdk)?.resource_name === 'Deep Research App_start' ||
      record(metadata.invoked_resource)?.app_name === 'Deep Research App') return 'deep_research';
  return imageTool(metadata.tool_name) ? 'image_generation' : null;
}

export function taskFromMessage(message: Record<string, unknown>): TaskKind | null {
  const author = record(message.author);
  const metadata = record(message.metadata);
  const task = metadata ? taskFromMetadata(metadata) : null;
  if (task) return task;
  if (author?.role === 'tool' && typeof metadata?.image_gen_title === 'string' && metadata.image_gen_title.trim()) {
    return 'image_generation';
  }
  return (author?.role === 'assistant' && imageTool(message.recipient)) ||
    (author?.role === 'tool' && imageTool(author.name)) ? 'image_generation' : null;
}
