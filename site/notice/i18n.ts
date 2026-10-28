export type NoticeLanguage = 'zh' | 'en';

const zh = {
  "notice.documentTitle": "Route Inspector · 1.1.0 版本公告",
  "notice.subtitle": "1.1.0 · 版本公告",
  "language.label": "切换语言",
  "notice.badge": "版本公告",
  "notice.update110Tasks": "新增“图片生成”和“深度研究”状态，避免将这两类任务误判为降级或路由错配。",
  "notice.update110Models": "深度研究支持分别记录和显示规划模型、报告模型。",
  "notice.update110Capture": "实时请求与会话重载均支持识别图片生成和深度研究，并接收同一任务的后续结果。",
  "notice.update110AutoBefore": "适配免费账号请求模型为 ",
  "notice.update110AutoAfter": " 的情况，统一显示为“自动推理”。",
  "notice.close": "关闭公告",
  "notice.historyTitle": "历代更新日志",
  "notice.comment": "留言",
  "notice.release110": "新增图片生成、深度研究识别，支持显示规划与报告模型；适配免费账号 Auto 请求。",
  "notice.release109": "修复新建会话时实时请求模型与响应路由无法显示的问题；扩展连接失效时提示刷新页面，避免浮窗按钮无响应。",
  "notice.pollBefore": "根据此前",
  "notice.pollLink": "投票",
  "notice.release108After": "反馈，新增“疑似降级”标记。",
  "notice.release107": "实时请求与会话重载同时独立采集，切换标签即可查看；优化浮窗排版。",
  "notice.release106": "适配增量流、多行 SSE 与 WebSocket；修复请求配对与记录隔离；新增额度快照和 5.6/5.5 自动推理状态。",
  "notice.release105": "修复 ChatGPT 页面重建后浮窗消失的问题，并保留手动隐藏设置。",
  "notice.release104": "适配 ChatGPT 官方后端会话接口的路径与响应结构调整。",
  "notice.release103": "新增迷你浮窗与边缘停靠，优化英文文案和窄屏排版。",
  "notice.release102": "支持项目内会话的重载路由识别，并加强导出脱敏与隐私测试。",
  "notice.release101": "首次公开发布：实时请求、会话重载、Popup、浮窗、诊断台、PoW 难度及中英文界面。",
  "notice.closeManually": "请关闭此浏览器标签页。"
};

export type NoticeKey = keyof typeof zh;
const en: Record<NoticeKey, string> = {
  "notice.documentTitle": "Route Inspector · 1.1.0 Version notice",
  "notice.subtitle": "1.1.0 · Version notice",
  "language.label": "Switch language",
  "notice.badge": "Version notice",
  "notice.update110Tasks": "Added “Image generation” and “Deep Research” statuses to avoid misclassifying these tasks as model downgrades or route mismatches.",
  "notice.update110Models": "Deep Research now records and displays the planning model and report model separately.",
  "notice.update110Capture": "Both live requests and session reloads support image generation and Deep Research detection, including subsequent results from the same task.",
  "notice.update110AutoBefore": "Added support for free accounts requesting ",
  "notice.update110AutoAfter": ", consistently displayed as “Auto reasoning”.",
  "notice.close": "Close notice",
  "notice.historyTitle": "Version history",
  "notice.comment": "Comment",
  "notice.release110": "Added image generation and Deep Research detection, with planning and report model display; added support for Auto requests on free accounts.",
  "notice.release109": "Fixed missing live request models and response routes in new chats; added a refresh prompt when the extension connection is lost instead of leaving unresponsive overlay controls.",
  "notice.pollBefore": "Based on feedback from the earlier ",
  "notice.pollLink": "poll",
  "notice.release108After": ", added the “Possible downgrade” marker.",
  "notice.release107": "Captured live requests and session reloads independently at the same time; improved overlay layout.",
  "notice.release106": "Adapted delta streams, multiline SSE and WebSockets; fixed request pairing and record isolation; added quota snapshots and 5.6/5.5 auto-reasoning status.",
  "notice.release105": "Restored the overlay after ChatGPT rebuilt the page, while respecting manual hiding.",
  "notice.release104": "Adapted to changes in ChatGPT’s official conversation API paths and response format.",
  "notice.release103": "Added mini overlay and edge docking; improved English copy and narrow-screen layout.",
  "notice.release102": "Supported reload routing for project conversations and improved export redaction and privacy tests.",
  "notice.release101": "First public release: live capture, session reload, popup, overlay, diagnostics, PoW difficulty and Chinese/English UI.",
  "notice.closeManually": "Please close this browser tab."
};

export const NOTICE_TRANSLATIONS = { zh, en };

export function t(language: NoticeLanguage, key: NoticeKey): string {
  return NOTICE_TRANSLATIONS[language][key] ?? en[key] ?? key;
}

export function applyStaticTranslations(language: NoticeLanguage): void {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    element.textContent = t(language, element.dataset.i18n as NoticeKey);
  });
  for (const [attribute, dataName] of [['aria-label', 'i18nAriaLabel'], ['title', 'i18nTitle']] as const) {
    const selector = '[data-' + dataName.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase()) + ']';
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      element.setAttribute(attribute, t(language, element.dataset[dataName] as NoticeKey));
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-language]').forEach((button) => {
    const active = button.dataset.language === language;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

export function bindLanguageSwitch(handler: (language: NoticeLanguage) => void): void {
  document.querySelectorAll<HTMLButtonElement>('[data-language]').forEach((button) => {
    button.addEventListener('click', () => {
      const language = button.dataset.language;
      if (language === 'zh' || language === 'en') handler(language);
    });
  });
}
