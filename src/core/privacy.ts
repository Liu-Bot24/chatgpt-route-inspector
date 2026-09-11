import type { InspectorState, RouteTurn, UiLanguage } from './types';
import { redactConversationPathname } from './chatgpt-path';

function redactedId(value: string | null): string | null {
  if (!value) return null;
  return `[redacted:${value.slice(-6)}]`;
}

function sanitizePageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.pathname = redactConversationPathname(url.pathname);
    url.pathname = url.pathname.replace(
      /^\/backend-api\/(conversations?)\/[^/]+/,
      '/backend-api/$1/[redacted]'
    );
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizeTurn(turn: RouteTurn, includeRequestIds = false): RouteTurn {
  return {
    ...turn,
    captureId: '[redacted]',
    pageUrl: sanitizePageUrl(turn.pageUrl),
    conversationId: redactedId(turn.conversationId),
    requestId: includeRequestIds ? turn.requestId : redactedId(turn.requestId),
    networkRequestId: includeRequestIds ? turn.networkRequestId : redactedId(turn.networkRequestId)
  };
}

export function sanitizedExport(state: InspectorState): InspectorState {
  return {
    ...state,
    turns: state.turns.map((turn, index) => ({
      ...sanitizeTurn(turn, state.settings.includeRequestIdsInExport), captureId: `capture-${index + 1}`
    }))
  };
}

export function buildMarkdownReport(state: InspectorState, language: UiLanguage = state.settings.uiLanguage): string {
  const exported = sanitizedExport(state);
  const chinese = language === 'zh';
  const lines = chinese
    ? [
        '# ChatGPT Route Inspector 报告',
        '',
        `生成时间：${new Date().toISOString()}`,
        `记录数：${exported.turns.length}`,
        '',
        '| 时间 | 模式 | 请求模型 | 模型标签 | 响应路由模型 | 响应来源 | 结论 | 请求 ID |',
        '|---|---|---|---|---|---|---|---|'
      ]
    : [
        '# ChatGPT Route Inspector Report',
        '',
        `Generated: ${new Date().toISOString()}`,
        `Records: ${exported.turns.length}`,
        '',
        '| Time | Mode | Requested model | Model label | Response route | Response source | Verdict | Request ID |',
        '|---|---|---|---|---|---|---|---|'
      ];
  for (const turn of exported.turns) {
    const unknown = chinese ? '未知' : 'Unknown';
    const none = chinese ? '无' : 'None';
    const label = turn.modelLabelConflict ? (chinese ? '标签字段不一致' : 'Label fields disagree') : turn.modelLabel ?? unknown;
    lines.push(`| ${turn.observedAt} | ${turn.captureMode} | ${turn.requestedModel ?? unknown} | ${label} | ${turn.routeModel ?? unknown} | ${turn.routeModelSources.join(' + ') || none} | ${turn.verdict} | ${turn.requestId ?? none} |`);
  }
  lines.push('', chinese
    ? '> 本报告只包含允许字段，不包含提示词、回答正文、Cookie、Authorization 或令牌。'
    : '> This report contains allowlisted fields only. It excludes prompts, answer text, cookies, Authorization headers, and tokens.');
  return `${lines.join('\n')}\n`;
}
