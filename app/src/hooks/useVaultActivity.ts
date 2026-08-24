import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

const ACTIVITY_THROTTLE_MS = 5_000;
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const;

/**
 * Sends coarse foreground activity signals to the native inactivity deadline.
 * High-frequency input remains local and produces at most one bridge call every
 * five seconds. The backend decides atomically whether the vault is still
 * eligible to be extended, so a resume event cannot revive an expired vault.
 */
export function useVaultActivity(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let lastSignalAt = Number.NEGATIVE_INFINITY;

    const signalActivity = () => {
      if (document.visibilityState !== 'visible') return;
      const now = window.performance.now();
      if (now - lastSignalAt < ACTIVITY_THROTTLE_MS) return;
      lastSignalAt = now;
      void invoke('cmd_record_vault_activity').catch(() => {
        // Encryption capability diagnostics already surface backend failures.
      });
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') signalActivity();
    };

    signalActivity();
    for (const eventName of INPUT_EVENTS) {
      window.addEventListener(eventName, signalActivity, { passive: true });
    }
    window.addEventListener('focus', signalActivity);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      for (const eventName of INPUT_EVENTS) {
        window.removeEventListener(eventName, signalActivity);
      }
      window.removeEventListener('focus', signalActivity);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled]);
}
