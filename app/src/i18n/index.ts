import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {unpackCatalog} from './packedCatalog';

// Translation catalogs are data, not executable JavaScript. Only the selected
// language follows the complete English bootstrap catalog; Vite bundles the local JSON assets into desktop/Android.
const localeUrls = import.meta.glob<string>(['./locales/*.json'], {
  eager: true, query: '?url', import: 'default',
});
const languageRequests = new Map<string, Promise<void>>();

export const i18nInitialized = i18n
  .use(initReactI18next)
  .init({
    resources: {},
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

export async function ensureLanguageResource(language: string, signal?: AbortSignal): Promise<void> {
  if (i18n.hasResourceBundle(language, 'translation')) return;
  const url = localeUrls[`./locales/${language}.json`];
  if (!url) throw new Error(`Unsupported language resource: ${language}`);
  let request = languageRequests.get(language);
  if (!request) {
    request = (async () => {
      const controller=new AbortController();
      const cancel=()=>controller.abort();
      if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
      const deadline=window.setTimeout(cancel,8_000);
      try {
      const response = await fetch(url,{signal:controller.signal});
      if (!response.ok) throw new Error(`Language resource unavailable: ${language}`);
      const resource = await unpackCatalog(await response.json(),controller.signal,language);
      if(controller.signal.aborted)throw new Error('Language request cancelled');
      if (!i18n.hasResourceBundle(language, 'translation')) {
        i18n.addResourceBundle(language, 'translation', resource, true, true);
      }
      } finally {window.clearTimeout(deadline);signal?.removeEventListener('abort',cancel);}
    })();
    languageRequests.set(language, request);
  }
  try { await request; }
  finally { if (languageRequests.get(language) === request) languageRequests.delete(language); }
}

export default i18n;
