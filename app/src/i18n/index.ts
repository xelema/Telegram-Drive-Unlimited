import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';

const localeLoaders = {
  es: () => import('./locales/es.json'),
  ru: () => import('./locales/ru.json'),
  'uk-UA': () => import('./locales/uk-UA.json'),
  'pl-PL': () => import('./locales/pl-PL.json'),
  'fa-IR': () => import('./locales/fa-IR.json'),
  'ur-PK': () => import('./locales/ur-PK.json'),
  'ms-MY': () => import('./locales/ms-MY.json'),
  'zh-CN': () => import('./locales/zh-CN.json'),
  'zh-TW': () => import('./locales/zh-TW.json'),
  fr: () => import('./locales/fr.json'),
  it: () => import('./locales/it.json'),
  ar: () => import('./locales/ar.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  de: () => import('./locales/de.json'),
  hi: () => import('./locales/hi.json'),
  'bn-BD': () => import('./locales/bn-BD.json'),
  id: () => import('./locales/id.json'),
  'fil-PH': () => import('./locales/fil-PH.json'),
  tr: () => import('./locales/tr.json'),
  'th-TH': () => import('./locales/th-TH.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  vi: () => import('./locales/vi.json'),
} as const;

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
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

export async function ensureLanguageResource(language: string): Promise<void> {
  if (language === 'en' || i18n.hasResourceBundle(language, 'translation')) return;
  const loader = localeLoaders[language as keyof typeof localeLoaders];
  if (!loader) throw new Error(`Unsupported language resource: ${language}`);
  const resource = await loader();
  if (!i18n.hasResourceBundle(language, 'translation')) {
    i18n.addResourceBundle(language, 'translation', resource.default, true, true);
  }
}

export default i18n;
