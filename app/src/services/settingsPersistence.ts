import { load } from '@tauri-apps/plugin-store';
import type { Settings } from '../types/settings';

const SETTINGS_FILE = 'settings.json';
const SETTINGS_KEY = 'settings';

export interface SettingsStore {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

type StoreLoader = () => Promise<SettingsStore>;

const loadSettingsStore: StoreLoader = () => load(SETTINGS_FILE);

export function mergeStoredSettings(defaults: Settings, stored?: Partial<Settings> | null): Settings {
  const merged = { ...defaults, ...stored };
  if ((merged.proxyType as string) === 'mtproto') merged.proxyType = 'socks5';
  return merged;
}

export async function readPersistedSettings(
  defaults: Settings,
  loadStore: StoreLoader = loadSettingsStore,
): Promise<Settings> {
  try {
    const store = await loadStore();
    const stored = await store.get<Partial<Settings>>(SETTINGS_KEY);
    return mergeStoredSettings(defaults, stored);
  } catch {
    return defaults;
  }
}

export async function writePersistedSettings(
  settings: Settings,
  loadStore: StoreLoader = loadSettingsStore,
): Promise<void> {
  try {
    const store = await loadStore();
    await store.set(SETTINGS_KEY, settings);
    await store.save();
  } catch {
    // Settings remain active in memory when persistent storage is unavailable.
  }
}
