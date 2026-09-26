import type { UiLanguage } from '../../core/types';
import type { RuntimeRequest, RuntimeResponse } from '../../shared/messages';
import { UPGRADE_NOTICE_URL } from '../../shared/upgrade-notice';
import { t } from './i18n';

export const suspectedDowngradeHintStyles = `
  .suspect-hint{position:relative;z-index:8;display:inline-block;max-width:116px;justify-self:end}
  .suspect-trigger.status{display:block;max-width:116px;border:0;padding:0;background:transparent;color:#f4e45e;cursor:help;text-align:right}
  .probe:lang(en) .suspect-trigger.status{white-space:normal}
  .suspect-trigger:focus-visible,.suspect-popover a:focus-visible{outline:2px solid #f4e45e;outline-offset:2px}
  .suspect-popover{position:absolute;top:100%;right:0;z-index:9;width:min(286px,calc(100vw - 30px));padding-top:5px;visibility:hidden;opacity:0;white-space:normal}
  .suspect-popover a{display:block;padding:12px;border:1px solid #697461;background:#171b16;color:#f3f5ec;box-shadow:0 8px 24px rgba(0,0,0,.4);font:12px/1.65 "Bahnschrift",sans-serif;text-decoration:none;overflow-wrap:anywhere}
  .suspect-popover a:hover{border-color:#f4e45e}
  .suspect-popover strong{color:#f4e45e;text-decoration:underline;text-underline-offset:3px;font-weight:400;white-space:nowrap}
  .suspect-hint:hover .suspect-popover,.suspect-hint:focus-within .suspect-popover{visibility:visible;opacity:1}
  .suspect-hint[data-dismissed] .suspect-popover{visibility:hidden;opacity:0}
  .suspect-error{display:block;color:#f07868}.suspect-error[hidden]{display:none}
`;

export function suspectedDowngradeHintMarkup(language: UiLanguage, url: string): string {
  return `<span id="suspect-hint" class="suspect-hint"><button id="suspect-trigger" class="status suspect-trigger" type="button" aria-label="${t(language, 'notice.hintLabel')}" aria-controls="suspect-popover">${t(language, 'result.suspectedDowngrade')}</button><span id="suspect-popover" class="suspect-popover"><a id="suspect-link" href="${url}" target="_blank" rel="noopener noreferrer">${t(language, 'notice.hint')} <strong>${t(language, 'notice.readMore')}</strong><span id="suspect-error" class="suspect-error" role="alert" hidden>${t(language, 'notice.openFailed')}</span></a></span></span>`;
}

export function currentSuspectedDowngradeHint(language: UiLanguage): string {
  return suspectedDowngradeHintMarkup(language, UPGRADE_NOTICE_URL);
}

export function bindSuspectedDowngradeHint(root: ShadowRoot): void {
  const hint = root.getElementById('suspect-hint');
  if (!hint) return;
  hint.addEventListener('pointerenter', () => hint.removeAttribute('data-dismissed'));
  hint.addEventListener('focusin', () => hint.removeAttribute('data-dismissed'));
  hint.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      root.getElementById('suspect-trigger')?.focus();
      hint.setAttribute('data-dismissed', '');
    }
  });
  root.getElementById('suspect-trigger')?.addEventListener('click', () => hint.removeAttribute('data-dismissed'));
  root.getElementById('suspect-link')?.addEventListener('click', async (event) => {
    event.preventDefault();
    // Keep opening and failure reporting consistent with other extension actions.
    try {
      const response = await chrome.runtime.sendMessage<RuntimeRequest, RuntimeResponse>({ type: 'route:open-announcement' });
      if (!response.ok) throw new Error(response.error);
    } catch {
      root.getElementById('suspect-error')?.removeAttribute('hidden');
    }
  });
}
