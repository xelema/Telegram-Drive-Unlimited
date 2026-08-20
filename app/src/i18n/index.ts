import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import es from './locales/es.json';
import ru from './locales/ru.json';
import ukUA from './locales/uk-UA.json';
import plPL from './locales/pl-PL.json';
import faIR from './locales/fa-IR.json';
import urPK from './locales/ur-PK.json';
import msMY from './locales/ms-MY.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import ar from './locales/ar.json';
import ptBR from './locales/pt-BR.json';
import de from './locales/de.json';
import hi from './locales/hi.json';
import bnBD from './locales/bn-BD.json';
import id from './locales/id.json';
import filPH from './locales/fil-PH.json';
import tr from './locales/tr.json';
import thTH from './locales/th-TH.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import vi from './locales/vi.json';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      ru: { translation: ru },
      'uk-UA': { translation: ukUA },
      'pl-PL': { translation: plPL },
      'fa-IR': { translation: faIR },
      'ur-PK': { translation: urPK },
      'ms-MY': { translation: msMY },
      'zh-CN': { translation: zhCN },
      'zh-TW': { translation: zhTW },
      fr: { translation: fr },
      it: { translation: it },
      ar: { translation: ar },
      'pt-BR': { translation: ptBR },
      de: { translation: de },
      hi: { translation: hi },
      'bn-BD': { translation: bnBD },
      id: { translation: id },
      'fil-PH': { translation: filPH },
      tr: { translation: tr },
      'th-TH': { translation: thTH },
      ja: { translation: ja },
      ko: { translation: ko },
      vi: { translation: vi },
    },
    lng: 'en',
    // Every shipped locale is structurally complete and CI rejects missing keys.
    // Do not silently mask localization regressions with English at runtime.
    fallbackLng: false,
    interpolation: {
      escapeValue: false, // React already safeguards from XSS
    },
    react: {
      useSuspense: false,
    },
  });

export default i18n;
