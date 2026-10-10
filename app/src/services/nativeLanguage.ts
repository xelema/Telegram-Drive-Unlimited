import {invoke} from '@tauri-apps/api/core';
import {type} from '@tauri-apps/plugin-os';
import type {SupportedLanguage} from '../i18n/languages';

// Desktop receives only an already loaded, successfully applied language.
// This publishes memory state; the existing Settings persistence owns storage.
export async function publishNativeLanguage(language: SupportedLanguage): Promise<void> {
  let operatingSystem: ReturnType<typeof type>;
  try { operatingSystem = type(); } catch { return; }
  if (operatingSystem === 'android' || operatingSystem === 'ios') return;
  try { await invoke('cmd_set_native_language', {language}); }
  catch { if (import.meta.env.DEV) console.error('[i18n] Native language synchronization unavailable.'); }
}
