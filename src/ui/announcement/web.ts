import { browserUiLanguage } from '../../core/language';
import { applyStaticTranslations, bindLanguageSwitch, t } from '../shared/i18n';

// The public notice has no extension API, capture data, or analytics dependency.
let language = browserUiLanguage();
applyStaticTranslations(language);
bindLanguageSwitch((next) => { language = next; applyStaticTranslations(next); });
document.querySelector('#notice-close')?.addEventListener('click', () => {
  window.close();
  // Browsers may refuse to close a directly opened or restored tab.
  window.setTimeout(() => window.alert(t(language, 'notice.closeManually')), 200);
});
