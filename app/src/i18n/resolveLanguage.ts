import { SupportedLanguage, LanguagePreference, getLanguageInfo } from './languages';

export function normalizeLocale(input: string): string {
  if (!input) return 'en';
  const clean = input.trim();
  if (clean.toLowerCase().startsWith('zh-tw') || clean.toLowerCase().startsWith('zh-hk') || clean.toLowerCase().startsWith('zh-hant')) {
    // Explicit rule from plan: zh-TW/zh-HK/zh-Hant fall back to English, not Simplified Chinese
    return 'en';
  }
  return clean;
}

export function resolveSupportedLanguage(input: string | readonly string[]): SupportedLanguage {
  const list = Array.isArray(input) ? input : [input as string];
  for (const raw of list) {
    if (!raw) continue;
    const normalized = normalizeLocale(raw);
    const match = getLanguageInfo(normalized);
    if (match) {
      return match.code;
    }
  }
  return 'en';
}

export function resolveLanguagePreference(
  preference: LanguagePreference,
  systemLocales?: string | readonly string[]
): SupportedLanguage {
  if (preference && preference !== 'system') {
    return resolveSupportedLanguage(preference);
  }
  const sys = systemLocales || (typeof navigator !== 'undefined' ? (navigator.languages || [navigator.language]) : ['en']);
  return resolveSupportedLanguage(sys);
}
