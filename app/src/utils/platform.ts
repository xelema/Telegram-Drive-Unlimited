import { type as osType } from '@tauri-apps/plugin-os';

// Resolve once because the platform cannot change during an app session.
export const isAndroidPlatform = ((): boolean => {
  try {
    return osType() === 'android';
  } catch {
    return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
  }
})();
