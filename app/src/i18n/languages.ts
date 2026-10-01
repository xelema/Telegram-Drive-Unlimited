export type SupportedLanguage = 'en' | 'es' | 'ru' | 'uk-UA' | 'pl-PL' | 'fa-IR' | 'ur-PK' | 'ms-MY' | 'zh-CN' | 'zh-TW' | 'fr' | 'it' | 'ar' | 'pt-BR' | 'de' | 'hi' | 'bn-BD' | 'id' | 'fil-PH' | 'tr' | 'th-TH' | 'ja' | 'ko' | 'vi';

export type LanguagePreference = 'system' | SupportedLanguage;

export interface LanguageInfo {
  code: SupportedLanguage;
  nativeLabel: string;
  englishLabel: string;
  dir: 'ltr' | 'rtl';
  numberLocale: string;
  dateLocale: string;
  aliases: string[];
  fontFamily?: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'en', nativeLabel: 'English', englishLabel: 'English', dir: 'ltr', numberLocale: 'en-US', dateLocale: 'en-US', aliases: ['en'] },
  { code: 'es', nativeLabel: 'Español', englishLabel: 'Spanish', dir: 'ltr', numberLocale: 'es-ES', dateLocale: 'es-ES', aliases: ['es'] },
  { code: 'ru', nativeLabel: 'Русский', englishLabel: 'Russian', dir: 'ltr', numberLocale: 'ru-RU', dateLocale: 'ru-RU', aliases: ['ru'] },
  { code: 'uk-UA', nativeLabel: 'Українська', englishLabel: 'Ukrainian', dir: 'ltr', numberLocale: 'uk-UA', dateLocale: 'uk-UA', aliases: ['uk', 'uk-UA'] },
  { code: 'pl-PL', nativeLabel: 'Polski', englishLabel: 'Polish', dir: 'ltr', numberLocale: 'pl-PL', dateLocale: 'pl-PL', aliases: ['pl', 'pl-PL'] },
  { code: 'fa-IR', nativeLabel: 'فارسی', englishLabel: 'Persian', dir: 'rtl', numberLocale: 'fa-IR', dateLocale: 'fa-IR', aliases: ['fa', 'fa-IR'] },
  { code: 'ur-PK', nativeLabel: 'اردو', englishLabel: 'Urdu', dir: 'rtl', numberLocale: 'ur-PK', dateLocale: 'ur-PK', aliases: ['ur', 'ur-PK'] },
  { code: 'ms-MY', nativeLabel: 'Bahasa Melayu', englishLabel: 'Malay', dir: 'ltr', numberLocale: 'ms-MY', dateLocale: 'ms-MY', aliases: ['ms', 'ms-MY'] },
  { code: 'zh-CN', nativeLabel: '简体中文', englishLabel: 'Chinese (Simplified)', dir: 'ltr', numberLocale: 'zh-CN', dateLocale: 'zh-CN', aliases: ['zh', 'zh-CN', 'zh-SG', 'zh-Hans'] },
  { code: 'zh-TW', nativeLabel: '繁體中文', englishLabel: 'Chinese (Traditional)', dir: 'ltr', numberLocale: 'zh-TW', dateLocale: 'zh-TW', aliases: ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant'] },
  { code: 'fr', nativeLabel: 'Français', englishLabel: 'French', dir: 'ltr', numberLocale: 'fr-FR', dateLocale: 'fr-FR', aliases: ['fr'] },
  { code: 'it', nativeLabel: 'Italiano', englishLabel: 'Italian', dir: 'ltr', numberLocale: 'it-IT', dateLocale: 'it-IT', aliases: ['it'] },
  { code: 'ar', nativeLabel: 'العربية', englishLabel: 'Arabic', dir: 'rtl', numberLocale: 'ar', dateLocale: 'ar', aliases: ['ar'] },
  { code: 'pt-BR', nativeLabel: 'Português (Brasil)', englishLabel: 'Portuguese (Brazil)', dir: 'ltr', numberLocale: 'pt-BR', dateLocale: 'pt-BR', aliases: ['pt', 'pt-BR'] },
  { code: 'de', nativeLabel: 'Deutsch', englishLabel: 'German', dir: 'ltr', numberLocale: 'de-DE', dateLocale: 'de-DE', aliases: ['de'] },
  { code: 'hi', nativeLabel: 'हिन्दी', englishLabel: 'Hindi', dir: 'ltr', numberLocale: 'hi-IN', dateLocale: 'hi-IN', aliases: ['hi'] },
  { code: 'bn-BD', nativeLabel: 'বাংলা (বাংলাদেশ)', englishLabel: 'Bengali (Bangladesh)', dir: 'ltr', numberLocale: 'bn-BD', dateLocale: 'bn-BD', aliases: ['bn', 'bn-BD'] },
  { code: 'id', nativeLabel: 'Bahasa Indonesia', englishLabel: 'Indonesian', dir: 'ltr', numberLocale: 'id-ID', dateLocale: 'id-ID', aliases: ['id', 'in'] },
  { code: 'fil-PH', nativeLabel: 'Filipino (Pilipinas)', englishLabel: 'Filipino (Philippines)', dir: 'ltr', numberLocale: 'fil-PH', dateLocale: 'fil-PH', aliases: ['fil', 'fil-PH', 'tl', 'tl-PH'] },
  { code: 'tr', nativeLabel: 'Türkçe', englishLabel: 'Turkish', dir: 'ltr', numberLocale: 'tr-TR', dateLocale: 'tr-TR', aliases: ['tr'] },
  { code: 'th-TH', nativeLabel: 'ไทย (ประเทศไทย)', englishLabel: 'Thai (Thailand)', dir: 'ltr', numberLocale: 'th-TH', dateLocale: 'th-TH', aliases: ['th', 'th-TH'] },
  { code: 'ja', nativeLabel: '日本語', englishLabel: 'Japanese', dir: 'ltr', numberLocale: 'ja-JP', dateLocale: 'ja-JP', aliases: ['ja'] },
  { code: 'ko', nativeLabel: '한국어', englishLabel: 'Korean', dir: 'ltr', numberLocale: 'ko-KR', dateLocale: 'ko-KR', aliases: ['ko'] },
  { code: 'vi', nativeLabel: 'Tiếng Việt', englishLabel: 'Vietnamese', dir: 'ltr', numberLocale: 'vi-VN', dateLocale: 'vi-VN', aliases: ['vi', 'vi-VN'] },
];

export function findLanguageInfo(code: string): LanguageInfo | undefined {
  const normalized = code ? code.trim().toLowerCase() : 'en';
  const exact = LANGUAGES.find(language => (
    language.code.toLowerCase() === normalized
    || language.aliases.some(alias => alias.toLowerCase() === normalized)
  ));
  if (exact) return exact;
  const prefixMatch = LANGUAGES
    .flatMap(language => language.aliases.map(alias => ({ language, alias })))
    .filter(({ alias }) => normalized.startsWith(`${alias.toLowerCase()}-`))
    .sort((left, right) => right.alias.length - left.alias.length)[0];
  return prefixMatch?.language;
}

export function getLanguageInfo(code: string): LanguageInfo {
  return findLanguageInfo(code) || LANGUAGES[0];
}
