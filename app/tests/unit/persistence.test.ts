import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/config/defaultSettings';
import {
  markProxySecretMigrated,
  mergeStoredSettings,
  readPersistedSettings,
  settingsForPersistence,
  writePersistedSettings,
  type SettingsStore,
} from '../../src/services/settingsPersistence';
import {
  readActiveCustomTheme,
  readThemePreference,
  readUserThemes,
  writeActiveCustomTheme,
  writeBaseTheme,
  writeUserThemes,
} from '../../src/services/themePersistence';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('settings persistence', () => {
  it('merges new defaults and migrates the legacy proxy type', () => {
    const stored = { maxConcurrentUploads: 2, proxyType: 'mtproto' } as unknown as Partial<typeof DEFAULT_SETTINGS>;
    const merged = mergeStoredSettings(DEFAULT_SETTINGS, stored);
    expect(merged.maxConcurrentUploads).toBe(2);
    expect(merged.proxyType).toBe('socks5');
    expect(merged.maxConcurrentDownloads).toBe(DEFAULT_SETTINGS.maxConcurrentDownloads);
    expect(merged.fileSortField).toBe('name');
    expect(merged.fileSortDirection).toBe('asc');
  });

  it('round-trips the file sorting preference', async () => {
    const stored = {
      ...DEFAULT_SETTINGS,
      fileSortField: 'date' as const,
      fileSortDirection: 'desc' as const,
    };
    const store: SettingsStore = {
      get: vi.fn(async () => stored),
      set: vi.fn(),
      save: vi.fn(),
    };
    const loaded = await readPersistedSettings(DEFAULT_SETTINGS, async () => store);
    expect(loaded.fileSortField).toBe('date');
    expect(loaded.fileSortDirection).toBe('desc');
  });

  it('reads and writes through the store adapter', async () => {
    const set = vi.fn(async () => undefined);
    const save = vi.fn(async () => undefined);
    const store: SettingsStore = {
      get: vi.fn(async () => ({ viewMode: 'list' })),
      set,
      save,
    };
    const loadStore = async () => store;

    expect((await readPersistedSettings(DEFAULT_SETTINGS, loadStore)).viewMode).toBe('list');
    await writePersistedSettings(DEFAULT_SETTINGS, loadStore);
    expect(set).toHaveBeenCalledWith('settings', { ...DEFAULT_SETTINGS, proxyPassword: '' });
    expect(save).toHaveBeenCalledOnce();
  });

  it('never persists a newly entered proxy password', () => {
    markProxySecretMigrated();
    expect(settingsForPersistence({ ...DEFAULT_SETTINGS, proxyPassword: 'super-secret' }).proxyPassword).toBe('');
  });

  it('retains a legacy password only until secure migration is confirmed', async () => {
    const store: SettingsStore = {
      get: vi.fn().mockResolvedValue({ proxyPassword: 'legacy-secret' }),
      set: vi.fn(),
      save: vi.fn(),
    };
    const loadStore = async () => store;
    const loaded = await readPersistedSettings(DEFAULT_SETTINGS, loadStore);

    expect(settingsForPersistence(loaded).proxyPassword).toBe('legacy-secret');
    markProxySecretMigrated();
    expect(settingsForPersistence(loaded).proxyPassword).toBe('');
  });

  it('never restores a legacy password after the user replaces it', async () => {
    const store: SettingsStore = {
      get: vi.fn().mockResolvedValue({ proxyPassword: 'legacy-secret' }),
      set: vi.fn(),
      save: vi.fn(),
    };
    const loaded = await readPersistedSettings(DEFAULT_SETTINGS, async () => store);

    expect(settingsForPersistence({ ...loaded, proxyPassword: 'replacement-secret' }).proxyPassword).toBe('');
    expect(settingsForPersistence(loaded).proxyPassword).toBe('');
  });

  it('falls back safely when the settings store is unavailable', async () => {
    const unavailable = async (): Promise<SettingsStore> => { throw new Error('unavailable'); };
    expect(await readPersistedSettings(DEFAULT_SETTINGS, unavailable)).toBe(DEFAULT_SETTINGS);
    await expect(writePersistedSettings(DEFAULT_SETTINGS, unavailable)).rejects.toThrow('unavailable');
  });
});

describe('theme persistence', () => {
  it('supports current and legacy theme preferences', () => {
    const storage = memoryStorage();
    storage.setItem('theme', 'light');
    expect(readThemePreference(storage)).toBe('light');
    storage.setItem('theme-preference', 'system');
    expect(readThemePreference(storage)).toBe('system');
  });

  it('round-trips custom themes and active selection', () => {
    const storage = memoryStorage();
    const themes = [{ id: 'custom-one', name: 'Custom', isDark: true, palette: {} }] as never[];
    writeUserThemes(themes, storage);
    writeActiveCustomTheme('custom-one', storage);
    writeBaseTheme('dark', 'default', storage);

    expect(readUserThemes(storage)).toEqual(themes);
    expect(readActiveCustomTheme(storage)).toBe('custom-one');
    expect(storage.getItem('theme')).toBe('dark');
    expect(storage.getItem('theme-preference')).toBe('default');
  });
});
