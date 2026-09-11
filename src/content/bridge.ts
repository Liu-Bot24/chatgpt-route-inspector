import type { CaptureMode, InspectorState, RouteTurn, UiLanguage } from '../core/types';
import { conversationIdFromPathname } from '../core/chatgpt-path';
import { isStaleState } from '../core/state';
import { isPageBridgeEnvelope, type RuntimeRequest, type RuntimeResponse } from '../shared/messages';
import { AUTHOR_LINK, AUTHOR_TEXT } from '../ui/shared/branding';
import { t } from '../ui/shared/i18n';
import { overlayVerdictCopy } from '../ui/shared/overlay';

let state: InspectorState | null = null;
let host: HTMLElement | null = null;
let ownTabId: number | null = null;
let scanTimer: number | null = null;
let scanRunning = false;
let reloadScanEnabledForDocument = false;
const documentStartedAtMs = Date.now();
const DOM_FALLBACK_DELAY_MS = 1200;
const seenDomRoutes = new Set<string>();
let domPathname = location.pathname;
const nodeIdentities = new WeakMap<HTMLElement, { pathname: string; messageId: string | null }>();
const domSelector = '[data-message-author-role="assistant"][data-message-model-slug]';
let renderedSignature = '';

function trackDomNodes(): HTMLElement[] {
  if (domPathname !== location.pathname) {
    domPathname = location.pathname;
    seenDomRoutes.clear();
  }
  const nodes = [...document.querySelectorAll<HTMLElement>(domSelector)];
  for (const node of nodes) {
    const identity = nodeIdentities.get(node);
    const messageId = node.getAttribute('data-message-id');
    if (!identity || (messageId !== null && messageId !== identity.messageId)) {
      nodeIdentities.set(node, { pathname: domPathname, messageId });
    }
  }
  return nodes;
}

function publishCaptureControl(): void {
  if (!state) return;
  window.postMessage({
    source: 'chatgpt-route-inspector-control', version: 1,
    revision: state.revision ?? 0,
    autoCaptureEnabled: state.settings.autoCaptureEnabled,
    captureMode: state.settings.captureMode,
    clearedAt: state.clearedAt ?? null
  }, location.origin);
}

function acceptState(next: InspectorState): boolean {
  if (isStaleState(state, next)) return false;
  if (!state) reloadScanEnabledForDocument = next.settings.captureMode === 'reload';
  else if (state.settings.captureMode !== next.settings.captureMode) reloadScanEnabledForDocument = false;
  if (state?.clearedAt !== next.clearedAt) {
    seenDomRoutes.clear();
    if (next.clearedAt) reloadScanEnabledForDocument = false;
  }
  state = next;
  publishCaptureControl();
  render();
  scheduleReloadDomScan();
  return true;
}

const stateReady = chrome.runtime.sendMessage<RuntimeRequest, RuntimeResponse>({ type: 'route:get-state' })
  .then((response) => {
    ownTabId = response.tabId ?? null;
    if (response.ok && response.state) acceptState(response.state);
  })
  .catch(() => undefined);

function currentTurn(): RouteTurn | null {
  if (!state) return null;
  const mode = state.settings.captureMode;
  const conversationId = mode === 'reload' ? conversationIdFromPath() : null;
  if (mode === 'reload' && !conversationId) return null;
  if (ownTabId !== null) {
    return state.turns.find((turn) =>
      turn.tabId === ownTabId &&
      turn.captureMode === mode &&
      (mode !== 'reload' || turn.conversationId === conversationId)
    ) ?? null;
  }
  return state.turns.find((turn) =>
    turn.tabId === null &&
    turn.captureMode === mode &&
    turn.pageUrl?.startsWith(location.origin) &&
    (mode !== 'reload' || turn.conversationId === conversationId)
  ) ?? null;
}

function currentPowReading() {
  if (!state) return null;
  if (ownTabId !== null) return state.powReadings.find((reading) => reading.tabId === ownTabId) ?? null;
  return state.powReadings.find((reading) => reading.tabId === null) ?? null;
}

function modeLabel(mode: CaptureMode, language: UiLanguage): string {
  return t(language, mode === 'live' ? 'mode.live' : 'mode.reload');
}

function routeSource(turn: RouteTurn | null, language: UiLanguage): string {
  return turn?.routeModelSources.join(' + ') || t(language, 'value.noRouteField');
}

function labelSource(turn: RouteTurn | null, language: UiLanguage): string {
  return turn?.modelLabelSources.join(' + ') || t(language, 'value.noLabelField');
}

function labelValue(turn: RouteTurn | null, language: UiLanguage): string {
  if (turn?.modelLabelConflict) return t(language, 'value.labelConflict');
  return turn?.modelLabel ?? '—';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '—').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char);
}

function conversationIdFromPath(): string | null {
  return conversationIdFromPathname(location.pathname);
}

function hasCurrentDocumentConversationRecord(): boolean {
  if (!state || ownTabId === null) return false;
  const conversationId = conversationIdFromPath();
  if (!conversationId) return false;
  return state.turns.some((turn) =>
    turn.tabId === ownTabId &&
    turn.captureMode === 'reload' &&
    turn.conversationId === conversationId &&
    turn.phase === 'completed' &&
    turn.sources.includes('conversation_record') &&
    Date.parse(turn.observedAt) >= documentStartedAtMs &&
    Boolean(turn.routeModel || turn.modelLabel || turn.modelLabelConflict)
  );
}

async function scanReloadDom(): Promise<void> {
  if (!reloadScanEnabledForDocument || scanRunning || state?.settings.autoCaptureEnabled === false || state?.settings.captureMode !== 'reload') return;
  if (hasCurrentDocumentConversationRecord()) return;
  scanRunning = true;
  try {
    const pathname = location.pathname;
    const conversationId = conversationIdFromPath();
    if (!conversationId) return;
    const nodes = trackDomNodes();
    for (const [index, node] of nodes.entries()) {
      if (location.pathname !== pathname || !reloadScanEnabledForDocument || !state?.settings.autoCaptureEnabled || state.settings.captureMode !== 'reload') break;
      if (!node.isConnected || nodeIdentities.get(node)?.pathname !== pathname) continue;
      const model = node.getAttribute('data-message-model-slug')?.trim() ?? '';
      if (!model || model.length > 256) continue;
      const messageKey = node.getAttribute('data-message-id') ?? String(index);
      const key = `${pathname}\u0000${messageKey}\u0000${model}`;
      if (seenDomRoutes.has(key)) continue;

      const observedAt = new Date().toISOString();
      try {
        const response = await chrome.runtime.sendMessage<RuntimeRequest, RuntimeResponse>({
          type: 'route:observation',
          observation: {
            captureId: crypto.randomUUID(),
            source: 'assistant_dom',
            captureMode: 'reload',
            phase: 'completed',
            observedAt,
            startedAt: observedAt,
            completedAt: observedAt,
            pageUrl: `${location.origin}${pathname}`,
            conversationId,
            domModelSlug: model
          }
        });
        if (response.ok) {
          if (seenDomRoutes.size >= 1000) seenDomRoutes.delete(seenDomRoutes.values().next().value!);
          seenDomRoutes.add(key);
          if (response.state) acceptState(response.state);
        }
      } catch {
        // A transient extension reload leaves the node eligible for a later scan.
      }
    }
    render();
  } finally {
    scanRunning = false;
  }
}

function scheduleReloadDomScan(): void {
  if (scanTimer !== null) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    void scanReloadDom();
  }, DOM_FALLBACK_DELAY_MS);
}

async function updateSettings(settings: Partial<InspectorState['settings']>): Promise<void> {
  if (settings.captureMode !== undefined) reloadScanEnabledForDocument = false;
  const response = await chrome.runtime.sendMessage<RuntimeRequest, RuntimeResponse>({
    type: 'route:update-settings',
    settings
  });
  if (!response.ok) {
    window.alert(response.error ?? 'Unable to update extension settings.');
    return;
  }
  if (response.state) acceptState(response.state);
}

function render(): void {
  if (!state?.settings.overlayEnabled) {
    host?.remove();
    host = null;
    renderedSignature = '';
    return;
  }
  if (!host?.isConnected) {
    host = document.createElement('div');
    host.id = 'chatgpt-route-inspector-root';
    document.documentElement.append(host);
    host.attachShadow({ mode: 'open' });
    renderedSignature = '';
  }
  const root = host.shadowRoot;
  if (!root) return;
  const language = state.settings.uiLanguage;
  const mode = state.settings.captureMode;
  const overlayMode = state.settings.overlayMode ?? (state.settings.overlayMinimized ? 'compact' : 'full');
  const turn = currentTurn();
  const pow = currentPowReading();
  const signature = JSON.stringify([language, mode, overlayMode,
    turn && [turn.phase, turn.verdict, turn.requestedModel, turn.routeModel, turn.modelLabel, turn.modelLabelConflict,
      turn.routeModelSources, turn.modelLabelSources, turn.sources], pow?.rawHex, pow?.decimal]);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  const copy = overlayVerdictCopy(turn, mode, language);
  const routeModel = turn?.verdict === 'conflict' ? t(language, 'result.routeConflict') : turn?.routeModel ?? (turn ? t(language, 'value.unavailable') : null);
  const hint = t(language, mode === 'live' ? 'overlay.liveHint' : 'overlay.reloadHint');
  const requestedModel = turn?.requestedModel ?? (mode === 'reload' && turn ? t(language, 'value.reloadNoRequest') : null);
  const powRaw = pow?.rawHex ?? t(language, 'pow.notCaptured');
  const powDecimal = pow?.decimal ?? '—';
  const powInline = pow
    ? language === 'zh' ? `${pow.rawHex}（${pow.decimal}）` : `${pow.rawHex} (${pow.decimal})`
    : t(language, 'pow.notCaptured');
  const styles = `
    <style>
      :host{all:initial}*{box-sizing:border-box}.probe{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:356px;color:#f3f5ec;background:#10130f;border:1px solid #404a3b;box-shadow:0 24px 64px rgba(0,0,0,.42);font-family:"Bahnschrift","Avenir Next Condensed",sans-serif}.head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 11px;border-bottom:1px solid #30372d}.brand{display:flex;align-items:center;gap:8px;min-width:0}.brand-copy{display:grid;gap:2px;min-width:0}.brand-line{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 7px}.radar{width:17px;height:17px;border:1px solid #697461;border-radius:50%;position:relative;flex:0 0 auto}.radar:after{content:"";position:absolute;inset:5px;border-radius:50%;background:#a9f04d;box-shadow:0 0 12px #a9f04d}.title{font:700 11px/1.1 "Cascadia Mono",monospace;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}.author{color:#75c5d8;font:700 8px/1.1 "Bahnschrift",sans-serif;text-decoration:none;text-underline-offset:2px;white-space:nowrap}.author:hover{text-decoration:underline}.head-tools{display:flex;align-items:center;gap:8px}.status{max-width:130px;text-align:right;font:10px/1.25 "Cascadia Mono",monospace;color:${copy.tone === 'normal' ? '#a9f04d' : copy.tone === 'danger' ? '#f07868' : '#efb55d'}}.icon-button{position:relative;display:grid;place-items:center;width:24px;height:22px;border:1px solid #404a3b;background:#171b16;color:#dfe4d8;cursor:pointer;font:700 14px/1 "Cascadia Mono",monospace}.icon-button:hover{border-color:#a9f04d;color:#a9f04d}.icon-button:after{content:attr(data-tooltip);position:absolute;top:calc(100% + 6px);right:-1px;z-index:2;width:max-content;padding:5px 7px;border:1px solid #aaa;background:#f1f1f1;box-shadow:0 2px 5px rgba(0,0,0,.22);color:#222;font:13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(-2px);transition:opacity .08s ease,transform .08s ease}.icon-button:hover:after,.icon-button:focus-visible:after{opacity:1;visibility:visible;transform:translateY(0);transition-delay:.1s}.body{padding:12px}.modes{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:9px}.modes button{border:1px solid #30372d;background:#121612;color:#899382;padding:7px 6px;cursor:pointer;font:9px "Cascadia Mono",monospace}.modes button.active{border-color:#a9f04d;color:#a9f04d;background:rgba(169,240,77,.08);box-shadow:inset 3px 0 #a9f04d}.hint{margin:0 1px 9px;color:#899382;font:9px/1.4 "Cascadia Mono",monospace}.route{display:grid;grid-template-columns:1fr 24px 1fr;align-items:center;gap:6px;height:64px;padding:11px;background:#171b16;border:1px solid #30372d}.model small{display:block;color:#899382;font:8px "Cascadia Mono",monospace;text-transform:uppercase;letter-spacing:.1em}.model b{display:block;height:18px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:18px;white-space:nowrap}.arrow{text-align:center;color:#697461}.meta{display:grid;grid-template-columns:70px minmax(0,1fr);gap:5px 8px;margin-top:9px;color:#899382;font:8px/1.4 "Cascadia Mono",monospace}.meta code{color:#75c5d8;overflow-wrap:anywhere}.full-pow{display:grid;grid-template-columns:70px minmax(0,1fr);gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid #30372d;color:#899382;font:8px/1.4 "Cascadia Mono",monospace}.full-pow code{color:#75c5d8;overflow-wrap:anywhere}.actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}.actions button{border:1px solid #404a3b;background:#171b16;color:#dfe4d8;padding:7px;cursor:pointer;font:9px "Cascadia Mono",monospace}.actions button:hover{border-color:#a9f04d}.actions .hide{color:#efb55d;border-color:rgba(239,181,93,.55)}.danger .route{border-color:rgba(240,120,104,.65);box-shadow:inset 3px 0 #f07868}.normal .route{border-color:rgba(169,240,77,.45);box-shadow:inset 3px 0 #a9f04d}.compact{width:420px}.compact-hit{display:block;width:100%;padding:10px;border:0;background:#10130f;color:inherit;text-align:left;cursor:pointer}.compact-hit:hover{background:#141914}.compact-hit:focus-visible{outline:2px solid #a9f04d;outline-offset:-3px}.compact .route{padding:8px 10px}.compact .model b{font-size:13px}.compact-pow{display:flex;align-items:center;gap:10px;margin-top:7px;padding:8px 10px;border:1px solid #30372d;background:#121612;color:#899382;font:8px/1.2 "Cascadia Mono",monospace;text-transform:uppercase;letter-spacing:.06em}.compact-pow code{min-width:0;overflow:hidden;color:#75c5d8;font:12px/1.2 "Cascadia Mono",monospace;text-overflow:ellipsis;white-space:nowrap;text-transform:none;letter-spacing:normal}.pow-divider{color:#566151;font:12px/1 "Cascadia Mono",monospace}@media(max-width:560px){.probe{right:8px;bottom:8px;max-width:calc(100vw - 16px)}}
      /* One shared scale for the full overlay and compact strip. */
      .probe{--type-meta:10px;--type-control:12px;--type-value:14px;--type-icon:16px;font-size:var(--type-icon)}
      .head{display:grid;grid-template-columns:minmax(0,1fr) auto}
      .head-tools{display:grid;grid-template-columns:minmax(0,auto) 24px 24px;align-items:center;min-width:0}
      .status{min-width:0;max-width:116px;justify-self:end;text-align:right;white-space:normal}
      .probe:lang(zh) .status{margin-right:4px;font-size:12px;white-space:nowrap}
      .probe:lang(en) .status{font-size:11px;line-height:1.15;white-space:nowrap}
      .hint{white-space:normal;overflow-wrap:anywhere}
      .probe:lang(zh) .hint{white-space:nowrap}
      .compact-hit{font:inherit}
      .author,.status,.hint,.model small,.meta,.full-pow,.compact-pow{font-size:var(--type-meta)}
      .title,.modes button,.actions button,.full-pow code,.compact-pow code,.pow-divider{font-size:var(--type-control)}
      .full-pow>span{white-space:nowrap}
      .model b,.compact .model b{font-size:var(--type-value)}
      .icon-button,.arrow{font-size:var(--type-icon)}
      /* Match the current macOS AppKit tooltip metrics while keeping a stable web fallback. */
      .icon-button:after{
        content:attr(data-tooltip);
        position:absolute;
        top:calc(100% + 10px);
        right:-1px;
        z-index:2;
        box-sizing:border-box;
        width:max-content;
        max-width:min(240px,calc(100vw - 16px));
        padding:2px 6px;
        border:0;
        border-radius:0;
        background:rgba(255,255,255,.937255);
        -webkit-backdrop-filter:blur(12px) saturate(1.15);
        backdrop-filter:blur(12px) saturate(1.15);
        box-shadow:inset 0 0 0 1px rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.18);
        color:rgba(0,0,0,.847059);
        font:400 11px/14px system-ui,-apple-system,"Segoe UI",sans-serif;
        text-align:left;
        white-space:normal;
        overflow-wrap:anywhere;
        pointer-events:none;
        opacity:0;
        visibility:hidden;
        transform:none;
        transition:none;
      }
      .icon-button:hover:after{
        opacity:1;
        visibility:visible;
        transition:opacity .06s linear .42s;
      }
      .icon-button:focus-visible:after{
        opacity:1;
        visibility:visible;
        transition:none;
      }
      @media(forced-colors:active){
        .icon-button:after{
          background:Canvas;
          -webkit-backdrop-filter:none;
          backdrop-filter:none;
          box-shadow:inset 0 0 0 1px CanvasText;
          color:CanvasText;
        }
      }
      .mode-icon{display:block;background:currentColor}
      .compact-icon{width:8px;height:3px}
      .mini-icon{width:6px;height:6px;border-radius:1px}
      .mini,.mini-docked{--mini-accent:#efb55d;--mini-accent-width:5px;--mini-edge-width:11px;right:0;bottom:76px;border-right:0;border-radius:4px 0 0 4px;box-shadow:calc(-1 * var(--mini-accent-width)) 0 var(--mini-accent),0 16px 36px rgba(0,0,0,.35)}
      .mini.normal,.mini-docked.normal{--mini-accent:#a9f04d}
      .auto .status{color:#75c5d8}
      .auto .route{border-color:rgba(117,197,216,.5);box-shadow:inset 3px 0 #75c5d8}
      .mini.auto,.mini-docked.auto{--mini-accent:#75c5d8}
      .mini.danger,.mini-docked.danger{--mini-accent:#f07868}
      .mini{width:148px;max-width:calc(100vw - 8px)}
      .mini-hit{display:grid;width:100%;padding:0;border:0;background:#10130f;color:inherit;text-align:center;cursor:pointer;font:inherit}
      .mini-hit:hover{background:#141914}
      .mini-hit:focus-visible{outline:2px solid #a9f04d;outline-offset:-3px}
      .mini-dock-hit,.mini-undock-hit{position:absolute;z-index:1;padding:0;border:0;appearance:none;background:transparent;cursor:pointer}
      .mini-dock-hit{top:-1px;bottom:-1px;left:calc(-1px - var(--mini-accent-width));width:calc(var(--mini-accent-width) + var(--mini-edge-width))}
      .mini-dock-hit:focus-visible,.mini-undock-hit:focus-visible{outline:2px solid var(--mini-accent);outline-offset:-2px}
      .mini-value{display:block;min-width:0;overflow:hidden;padding:9px 11px;color:#75c5d8;font:var(--type-control)/1.2 "Cascadia Mono",monospace;text-overflow:ellipsis;white-space:nowrap}
      .mini-divider{height:1px;margin:0 10px;background:#404a3b}
      .mini-docked{width:var(--mini-edge-width);height:68px;max-width:none}
      .mini-undock-hit{top:-1px;right:0;bottom:-1px;left:calc(-1px - var(--mini-accent-width))}
      @media(max-width:560px){.mini,.mini-docked{right:0;bottom:66px}.mini{max-width:calc(100vw - 8px)}}
    </style>
    `;
  const overlayLanguage = language === 'zh' ? 'zh-CN' : 'en';
  const compactOverlay = `${styles}<section class="probe compact ${copy.tone}" lang="${overlayLanguage}"><button id="expand" class="compact-hit" type="button" aria-label="${escapeHtml(t(language, 'overlay.expand'))}"><div class="route"><div class="model"><small>${escapeHtml(t(language, 'field.requested'))}</small><b>${escapeHtml(requestedModel)}</b></div><div class="arrow">→</div><div class="model"><small>${escapeHtml(t(language, 'field.responseRoute'))}</small><b>${escapeHtml(routeModel)}</b></div></div><div class="compact-pow"><span>${escapeHtml(t(language, 'pow.inline'))}</span><code>${escapeHtml(powRaw)}</code><span class="pow-divider">|</span><code>${escapeHtml(powDecimal)}</code></div></button></section>`;
  const miniOverlay = `${styles}<section class="probe mini ${copy.tone}" lang="${overlayLanguage}"><button id="mini-dock" class="mini-dock-hit" type="button" aria-label="${escapeHtml(t(language, 'overlay.dock'))}"></button><button id="expand" class="mini-hit" type="button" aria-label="${escapeHtml(t(language, 'overlay.expand'))}"><code class="mini-value">${escapeHtml(routeModel)}</code><span class="mini-divider" aria-hidden="true"></span><code class="mini-value">${escapeHtml(powDecimal)}</code></button></section>`;
  const dockedOverlay = `${styles}<section class="probe mini-docked ${copy.tone}" lang="${overlayLanguage}"><button id="mini-undock" class="mini-undock-hit" type="button" aria-label="${escapeHtml(t(language, 'overlay.undock'))}"></button></section>`;
  const fullOverlay = `${styles}<section class="probe ${copy.tone}" lang="${overlayLanguage}"><header class="head"><div class="brand"><span class="radar"></span><div class="brand-copy"><div class="brand-line"><span class="title">Route Inspector</span><a class="author" href="${AUTHOR_LINK}" target="_blank" rel="noopener noreferrer">${AUTHOR_TEXT}</a></div></div></div><div class="head-tools"><span class="status">${escapeHtml(copy.label)}</span><button id="compact" class="icon-button" data-tooltip="${escapeHtml(t(language, 'overlay.compact'))}" aria-label="${escapeHtml(t(language, 'overlay.compact'))}"><span class="mode-icon compact-icon" aria-hidden="true"></span></button><button id="mini" class="icon-button" data-tooltip="${escapeHtml(t(language, 'overlay.mini'))}" aria-label="${escapeHtml(t(language, 'overlay.mini'))}"><span class="mode-icon mini-icon" aria-hidden="true"></span></button></div></header><div class="body"><div class="modes"><button id="mode-live" class="${mode === 'live' ? 'active' : ''}">${escapeHtml(t(language, 'mode.live'))}</button><button id="mode-reload" class="${mode === 'reload' ? 'active' : ''}">${escapeHtml(t(language, 'mode.reload'))}</button></div><p class="hint">${escapeHtml(hint)}</p><div class="route"><div class="model"><small>${escapeHtml(t(language, 'field.requested'))}</small><b>${escapeHtml(requestedModel)}</b></div><div class="arrow">→</div><div class="model"><small>${escapeHtml(t(language, 'field.responseRoute'))}</small><b>${escapeHtml(routeModel)}</b></div></div><div class="meta"><span>${escapeHtml(t(language, 'field.mode'))}</span><code>${escapeHtml(modeLabel(mode, language))}</code><span>${escapeHtml(t(language, 'field.route'))}</span><code>${escapeHtml(routeSource(turn, language))}</code><span>${escapeHtml(t(language, 'field.label'))}</span><code>${escapeHtml(labelValue(turn, language))}</code><span>${escapeHtml(t(language, 'field.labelSource'))}</span><code>${escapeHtml(labelSource(turn, language))}</code><span>${escapeHtml(t(language, 'field.adapter'))}</span><code>${escapeHtml(turn?.sources.join('+') ?? null)}</code></div><div class="full-pow"><span>${escapeHtml(t(language, 'pow.inline'))}</span><code>${escapeHtml(powInline)}</code></div><div class="actions"><button id="dashboard">${escapeHtml(t(language, 'button.dashboard'))}</button><button id="hide" class="hide">${escapeHtml(t(language, 'overlay.hide'))}</button></div></div></section>`;
  root.innerHTML = overlayMode === 'docked' ? dockedOverlay : overlayMode === 'mini' ? miniOverlay : overlayMode === 'compact' ? compactOverlay : fullOverlay;
  root.getElementById('mode-live')?.addEventListener('click', () => void updateSettings({ captureMode: 'live' }));
  root.getElementById('mode-reload')?.addEventListener('click', () => void updateSettings({ captureMode: 'reload' }));
  root.getElementById('compact')?.addEventListener('click', () => void updateSettings({ overlayMode: 'compact', overlayMinimized: true, captureMode: 'live' }));
  root.getElementById('mini')?.addEventListener('click', () => void updateSettings({ overlayMode: 'mini', overlayMinimized: true, captureMode: 'live' }));
  root.getElementById('mini-dock')?.addEventListener('click', () => void updateSettings({ overlayMode: 'docked', overlayMinimized: true }));
  root.getElementById('mini-undock')?.addEventListener('click', () => void updateSettings({ overlayMode: 'mini', overlayMinimized: true }));
  root.getElementById('expand')?.addEventListener('click', () => void updateSettings({ overlayMode: 'full', overlayMinimized: false }));
  root.getElementById('hide')?.addEventListener('click', () => void updateSettings({ overlayEnabled: false }));
  root.getElementById('dashboard')?.addEventListener('click', () => {
    void chrome.runtime.sendMessage<RuntimeRequest>({ type: 'route:open-dashboard' });
  });
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source === window && event.origin === location.origin &&
    (event.data as { source?: string } | null)?.source === 'chatgpt-route-inspector-control-request') {
    publishCaptureControl();
    return;
  }
  if (event.source !== window || event.origin !== location.origin || !isPageBridgeEnvelope(event.data)) return;
  const envelope = event.data;
  void stateReady.then(async () => {
    if (state?.settings.autoCaptureEnabled === false) return;
    if ('pow' in envelope) {
      const response = await chrome.runtime.sendMessage<RuntimeRequest, RuntimeResponse>({
        type: 'pow:observation',
        observation: envelope.pow
      });
      if (response.ok && response.state) acceptState(response.state);
      return;
    }
    if (state?.settings.captureMode !== envelope.observation.captureMode) return;
    const response = await chrome.runtime.sendMessage<RuntimeRequest, RuntimeResponse>({
      type: 'route:observation',
      observation: envelope.observation
    });
    if (response.ok && response.state) acceptState(response.state);
  }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const record = message as Record<string, unknown>;
  if (record.type !== 'route:state-changed' || !record.state) return;
  const next = record.state as InspectorState;
  acceptState(next);
});

const domObserver = new MutationObserver(() => {
  if (reloadScanEnabledForDocument) trackDomNodes();
  if (state?.settings.overlayEnabled && !host?.isConnected) render();
  scheduleReloadDomScan();
});
function observeDocument(): void {
  if (!document.documentElement) return;
  trackDomNodes();
  domObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-message-model-slug', 'data-message-id']
  });
  scheduleReloadDomScan();
}

if (document.documentElement) observeDocument();
else document.addEventListener('DOMContentLoaded', observeDocument, { once: true });

void stateReady;
