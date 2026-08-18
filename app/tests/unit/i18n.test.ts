import { describe, expect, it } from 'vitest';
import i18n from '../../src/i18n';
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

  it('loads Japanese directly without an English fallback', () => {
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

  it('keeps Traditional and Simplified Chinese resolution separate', () => {
    expect(resolveSupportedLanguage('zh-TW')).toBe('zh-TW');
    expect(resolveSupportedLanguage('zh-HK')).toBe('zh-TW');
    expect(resolveSupportedLanguage('zh-Hant-TW')).toBe('zh-TW');
    expect(resolveSupportedLanguage('zh-CN')).toBe('zh-CN');
    expect(resolveSupportedLanguage('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveSupportedLanguage('zh')).toBe('zh-CN');
  });

  it('loads all four new locales without fallback text', () => {
    expect(i18n.t('settings.offline_cache', { lng: 'bn-BD' })).toBe('অফলাইন ফাইল');
    expect(i18n.t('settings.offline_cache', { lng: 'th-TH' })).toBe('ไฟล์ออฟไลน์');
    expect(i18n.t('settings.offline_cache', { lng: 'fil-PH' })).toBe('Mga offline na file');
    expect(i18n.t('settings.offline_cache', { lng: 'zh-TW' })).toBe('離線文件');
  });
});
