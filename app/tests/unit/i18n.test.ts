import { describe, expect, it } from 'vitest';
import i18n, { ensureLanguageResource } from '../../src/i18n';
import { getLanguageInfo, LANGUAGES } from '../../src/i18n/languages';
import { resolveSupportedLanguage } from '../../src/i18n/resolveLanguage';

describe('supported languages', () => {
  it('registers Japanese with native labels and regional formatting', () => {
    expect(LANGUAGES).toContainEqual(expect.objectContaining({
      code: 'ja',
      nativeLabel: '日本語',
      englishLabel: 'Japanese',
      dir: 'ltr',
      numberLocale: 'ja-JP',
      dateLocale: 'ja-JP',
    }));
    expect(getLanguageInfo('ja-JP').code).toBe('ja');
    expect(resolveSupportedLanguage(['ja-JP', 'en-US'])).toBe('ja');
  });

  it('loads Japanese directly without an English fallback', async () => {
    await ensureLanguageResource('ja');
    expect(i18n.options.fallbackLng).toBe(false);
    expect(i18n.t('settings.webdav_description', { lng: 'ja' }))
      .toBe('Finder、エクスプローラー、その他の WebDAV クライアントから Telegram Drive を開きます。');
  });

  it('registers Bengali, Thai, Filipino, and Traditional Chinese regional locales', () => {
    expect(LANGUAGES).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bn-BD', nativeLabel: 'বাংলা (বাংলাদেশ)', numberLocale: 'bn-BD' }),
      expect.objectContaining({ code: 'th-TH', nativeLabel: 'ไทย (ประเทศไทย)', numberLocale: 'th-TH' }),
      expect.objectContaining({ code: 'fil-PH', nativeLabel: 'Filipino (Pilipinas)', numberLocale: 'fil-PH' }),
      expect.objectContaining({ code: 'zh-TW', nativeLabel: '繁體中文', numberLocale: 'zh-TW' }),
    ]));

    expect(resolveSupportedLanguage(['bn-BD', 'en-US'])).toBe('bn-BD');
    expect(resolveSupportedLanguage(['bn-IN', 'en-US'])).toBe('bn-BD');
    expect(resolveSupportedLanguage(['th-TH', 'en-US'])).toBe('th-TH');
    expect(resolveSupportedLanguage(['fil-PH', 'en-US'])).toBe('fil-PH');
    expect(resolveSupportedLanguage(['tl-PH', 'en-US'])).toBe('fil-PH');
    expect(resolveSupportedLanguage(['unsupported-locale', 'TH-th'])).toBe('th-TH');
  });

  it('registers the priority desktop locales with regional aliases and direction metadata', () => {
    expect(LANGUAGES).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'uk-UA', nativeLabel: 'Українська', dir: 'ltr', numberLocale: 'uk-UA' }),
      expect.objectContaining({ code: 'pl-PL', nativeLabel: 'Polski', dir: 'ltr', numberLocale: 'pl-PL' }),
      expect.objectContaining({ code: 'fa-IR', nativeLabel: 'فارسی', dir: 'rtl', numberLocale: 'fa-IR' }),
      expect.objectContaining({ code: 'ur-PK', nativeLabel: 'اردو', dir: 'rtl', numberLocale: 'ur-PK' }),
      expect.objectContaining({ code: 'ms-MY', nativeLabel: 'Bahasa Melayu', dir: 'ltr', numberLocale: 'ms-MY' }),
    ]));

    expect(resolveSupportedLanguage(['uk-UA', 'en-US'])).toBe('uk-UA');
    expect(resolveSupportedLanguage(['pl', 'en-US'])).toBe('pl-PL');
    expect(resolveSupportedLanguage(['fa-IR', 'en-US'])).toBe('fa-IR');
    expect(resolveSupportedLanguage(['ur', 'en-US'])).toBe('ur-PK');
    expect(resolveSupportedLanguage(['ms-MY', 'en-US'])).toBe('ms-MY');
  });

  it('keeps Traditional and Simplified Chinese resolution separate', () => {
    expect(resolveSupportedLanguage('zh-TW')).toBe('zh-TW');
    expect(resolveSupportedLanguage('zh-HK')).toBe('zh-TW');
    expect(resolveSupportedLanguage('zh-Hant-TW')).toBe('zh-TW');
    expect(resolveSupportedLanguage('zh-CN')).toBe('zh-CN');
    expect(resolveSupportedLanguage('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveSupportedLanguage('zh')).toBe('zh-CN');
  });

  it('loads all four new locales without fallback text', async () => {
    await Promise.all(['bn-BD', 'th-TH', 'fil-PH', 'zh-TW'].map(ensureLanguageResource));
    expect(i18n.t('settings.offline_cache', { lng: 'bn-BD' })).toBe('অফলাইন ফাইল');
    expect(i18n.t('settings.offline_cache', { lng: 'th-TH' })).toBe('ไฟล์ออฟไลน์');
    expect(i18n.t('settings.offline_cache', { lng: 'fil-PH' })).toBe('Mga offline na file');
    expect(i18n.t('settings.offline_cache', { lng: 'zh-TW' })).toBe('離線文件');
  });

  it('loads the priority locale bundles without falling back to English', async () => {
    await Promise.all(['uk-UA', 'pl-PL', 'fa-IR', 'ur-PK', 'ms-MY'].map(ensureLanguageResource));
    expect(i18n.t('settings.offline_cache', { lng: 'uk-UA' })).toBe('Офлайн файли');
    expect(i18n.t('settings.offline_cache', { lng: 'pl-PL' })).toBe('Pliki offline');
    expect(i18n.t('settings.offline_cache', { lng: 'fa-IR' })).toBe('فایل های آفلاین');
    expect(i18n.t('settings.offline_cache', { lng: 'ur-PK' })).toBe('آف لائن فائلیں۔');
    expect(i18n.t('settings.offline_cache', { lng: 'ms-MY' })).toBe('Fail luar talian');
  });
});
