import { applyStaticTranslations, bindLanguageSwitch, t, type NoticeLanguage } from './i18n';

// The independently deployed website does not use extension APIs or settings.
let language: NoticeLanguage = /^zh(?:[-_]|$)/i.test(navigator.language) ? 'zh' : 'en';
applyStaticTranslations(language);
bindLanguageSwitch((next) => { language = next; applyStaticTranslations(next); });
document.querySelector('#notice-close')?.addEventListener('click', () => {
  window.close();
  window.setTimeout(() => window.alert(t(language, 'notice.closeManually')), 200);
});
