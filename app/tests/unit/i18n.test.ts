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
});
