import { invoke } from '@tauri-apps/api/core';

export async function requireAndroidReauthentication(reason: string): Promise<void> {
  let android = false;
  try {
    const { type } = await import('@tauri-apps/plugin-os');
    android = type() === 'android';
  } catch {
    // Browser tests and non-Tauri previews have no Android bridge.
    return;
  }
  if (!android) return;
  const available = await invoke<boolean>('cmd_get_android_authentication_available');
  if (!available) return;
  const authenticated = await invoke<boolean>('cmd_android_authenticate', { reason });
  if (!authenticated) throw new Error('Android authentication was cancelled');
}
