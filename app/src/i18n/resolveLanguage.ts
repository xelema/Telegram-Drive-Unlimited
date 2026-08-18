import { SupportedLanguage, LanguagePreference, findLanguageInfo } from './languages';

export function normalizeLocale(input: string): string {
  if (!input) return 'en';
  return input.trim();
}

export function resolveSupportedLanguage(input: string | readonly string[]): SupportedLanguage {
  const list = Array.isArray(input) ? input : [input as string];
  for (const raw of list) {
    if (!raw) continue;
    const normalized = normalizeLocale(raw);
    const match = findLanguageInfo(normalized);
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
