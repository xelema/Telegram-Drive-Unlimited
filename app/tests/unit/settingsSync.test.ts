import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/config/defaultSettings';
import { pickSyncableSettings, SYNCABLE_SETTING_KEYS } from '../../src/services/settingsSync';

describe('settings sync allowlist', () => {
  it('includes portable preferences and excludes secrets and device state', () => {
    const syncable = pickSyncableSettings({
      ...DEFAULT_SETTINGS,
      language: 'ja',
      proxyPassword: 'never-sync-this',
      supporterMode: true,
      crashReportingConsentSeen: true,
    });

    expect(syncable.language).toBe('ja');
    expect(syncable).not.toHaveProperty('proxyPassword');
    expect(syncable).not.toHaveProperty('proxyUsername');
    expect(syncable).not.toHaveProperty('supporterMode');
    expect(syncable).not.toHaveProperty('crashReportingConsentSeen');
    expect(syncable).not.toHaveProperty('telegramSettingsSyncEnabled');
    expect(Object.keys(syncable)).toEqual([...SYNCABLE_SETTING_KEYS]);
  });
});
