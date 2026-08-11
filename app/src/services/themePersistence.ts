import type { CustomTheme } from '../theme/themeEngine';
import type { Theme, ThemePreference } from '../types/settings';

const THEME_KEY = 'theme';
const THEME_PREFERENCE_KEY = 'theme-preference';
const USER_THEMES_KEY = 'user-themes';
const ACTIVE_CUSTOM_THEME_KEY = 'active-custom-theme-id';

function storageOrDefault(storage?: Storage): Storage | null {
  if (storage) return storage;
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function readStorageValue(key: string, storage?: Storage): string | null {
  try {
    return storageOrDefault(storage)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorageValue(key: string, value: string, storage?: Storage): void {
  try {
    storageOrDefault(storage)?.setItem(key, value);
  } catch {
    // Theme changes remain active in memory when storage is unavailable.
  }
}

export function readThemePreference(storage?: Storage): ThemePreference {
  const preference = readStorageValue(THEME_PREFERENCE_KEY, storage);
  if (preference === 'light' || preference === 'dark' || preference === 'system' || preference === 'default') {
    return preference;
  }
  const legacyTheme = readStorageValue(THEME_KEY, storage);
  return legacyTheme === 'light' || legacyTheme === 'dark' ? legacyTheme : 'default';
}

export function readUserThemes(storage?: Storage): CustomTheme[] {
  const raw = readStorageValue(USER_THEMES_KEY, storage);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CustomTheme[];
  } catch {
    return [];
  }
}

export function writeUserThemes(themes: CustomTheme[], storage?: Storage): void {
  writeStorageValue(USER_THEMES_KEY, JSON.stringify(themes), storage);
}

export function readActiveCustomTheme(storage?: Storage): string | null {
  return readStorageValue(ACTIVE_CUSTOM_THEME_KEY, storage);
}

export function writeActiveCustomTheme(id: string | null, storage?: Storage): void {
  writeStorageValue(ACTIVE_CUSTOM_THEME_KEY, id || '', storage);
}

export function writeBaseTheme(theme: Theme, preference: ThemePreference, storage?: Storage): void {
  writeStorageValue(THEME_KEY, theme, storage);
  writeStorageValue(THEME_PREFERENCE_KEY, preference, storage);
}
