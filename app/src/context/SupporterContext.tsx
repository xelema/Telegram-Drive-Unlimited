import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type as operatingSystemType } from '@tauri-apps/plugin-os';

export type SupporterState = 'loading' | 'inactive' | 'active' | 'needs_refresh' | 'expired' | 'revoked' | 'unavailable';

export interface SupporterStatus {
  state: SupporterState;
  ad_free: boolean;
  message: string;
  terms_version: string;
  terms_url: string | null;
  expires_at: number | null;
  offline_until: number | null;
  recovery_code_saved: boolean;
  checkout_pending?: boolean;
}

interface CheckoutStarted {
  approval_url: string;
  expires_at: number;
}

export interface CheckoutPollResult {
  status: string;
  recovery_code: string | null;
  message: string;
}

interface SupporterContextValue {
  status: SupporterStatus;
  latestRecoveryCode: string | null;
  refreshStatus: () => Promise<SupporterStatus>;
  beginCheckout: (termsVersion: string) => Promise<CheckoutStarted>;
  pollCheckout: () => Promise<CheckoutPollResult>;
  activate: (recoveryCode: string, termsVersion: string) => Promise<SupporterStatus>;
  refreshEntitlement: () => Promise<SupporterStatus>;
}

const unavailableStatus: SupporterStatus = {
  state: 'unavailable',
  ad_free: false,
  message: 'Verified supporter activation is available in the desktop app.',
  terms_version: '2026-08-11',
  terms_url: null,
  expires_at: null,
  offline_until: null,
  recovery_code_saved: false,
  checkout_pending: false,
};

const iosUnavailableStatus: SupporterStatus = {
  ...unavailableStatus,
  message: 'Verified supporter activation is unavailable on this platform.',
};

const SupporterContext = createContext<SupporterContextValue | null>(null);

export function SupporterProvider({ children }: { children: ReactNode }) {
  const platform = useMemo(() => {
    try {
      const current = operatingSystemType();
      return { isAndroid: current === 'android', isIos: current === 'ios' };
    } catch {
      const userAgent = navigator.userAgent.toLowerCase();
      return {
        isAndroid: userAgent.includes('android'),
        isIos: userAgent.includes('iphone') || userAgent.includes('ipad'),
      };
    }
  }, []);
  const [status, setStatus] = useState<SupporterStatus>({ ...unavailableStatus, state: 'loading', message: 'Checking supporter activation…' });
  const [latestRecoveryCode, setLatestRecoveryCode] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (platform.isIos) {
      setStatus(iosUnavailableStatus);
      return iosUnavailableStatus;
    }
    try {
      const next = await invoke<SupporterStatus>('cmd_get_supporter_status');
      setStatus(next);
      return next;
    } catch (error) {
      const next = { ...unavailableStatus, message: error instanceof Error ? error.message : String(error) };
      setStatus(next);
      return next;
    }
  }, [platform.isIos]);

  const refreshEntitlement = useCallback(async () => {
    const next = await invoke<SupporterStatus>('cmd_refresh_supporter');
    setStatus(next);
    return next;
  }, []);

  const pollCheckout = useCallback(async () => {
    const result = await invoke<CheckoutPollResult>('cmd_poll_supporter_checkout');
    if (result.recovery_code) setLatestRecoveryCode(result.recovery_code);
    if (result.status === 'completed' || (platform.isAndroid && ['failed', 'expired'].includes(result.status))) {
      await refreshStatus();
    }
    return result;
  }, [platform.isAndroid, refreshStatus]);

  const beginCheckout = useCallback(async (termsVersion: string) => {
    const checkout = await invoke<CheckoutStarted>('cmd_begin_supporter_checkout', { acceptedTermsVersion: termsVersion });
    setLatestRecoveryCode(null);
    setStatus(current => ({ ...current, checkout_pending: true }));
    return checkout;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let androidRetry: number | undefined;
    void refreshStatus().then(current => {
      if (cancelled) return;
      if (platform.isAndroid && current.state === 'unavailable') {
        androidRetry = window.setTimeout(() => {
          if (cancelled) return;
          void refreshStatus().then(retried => {
            if (cancelled || !['active', 'needs_refresh'].includes(retried.state)) return;
            void refreshEntitlement().catch(() => {
              if (!cancelled) void refreshStatus();
            });
          });
        }, 1_500);
        return;
      }
      if (!['active', 'needs_refresh'].includes(current.state)) return;
      void refreshEntitlement().catch(() => {
        if (!cancelled) void refreshStatus();
      });
    });
    return () => {
      cancelled = true;
      if (androidRetry !== undefined) window.clearTimeout(androidRetry);
    };
  }, [platform.isAndroid, refreshEntitlement, refreshStatus]);

  useEffect(() => {
    if (!platform.isAndroid || !status.checkout_pending || status.ad_free) return;
    let cancelled = false;
    let inFlight = false;
    const recoverCheckout = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await pollCheckout();
      } catch {
        // A pending checkout remains durable and will be retried after connectivity returns.
      } finally {
        inFlight = false;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void recoverCheckout();
    };
    void recoverCheckout();
    const interval = window.setInterval(() => void recoverCheckout(), 3_000);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [platform.isAndroid, pollCheckout, status.ad_free, status.checkout_pending]);

  const value = useMemo<SupporterContextValue>(() => ({
    status,
    latestRecoveryCode,
    refreshStatus,
    refreshEntitlement,
    beginCheckout,
    pollCheckout,
    activate: async (recoveryCode, termsVersion) => {
      const next = await invoke<SupporterStatus>('cmd_activate_supporter', { recoveryCode, acceptedTermsVersion: termsVersion });
      setStatus(next);
      return next;
    },
  }), [beginCheckout, latestRecoveryCode, pollCheckout, refreshEntitlement, refreshStatus, status]);

  return <SupporterContext.Provider value={value}>{children}</SupporterContext.Provider>;
}

export function useSupporter() {
  return useContext(SupporterContext) ?? {
    status: unavailableStatus,
    latestRecoveryCode: null,
    refreshStatus: async () => unavailableStatus,
    beginCheckout: async () => { throw new Error('Supporter activation is unavailable.'); },
    pollCheckout: async () => { throw new Error('Supporter activation is unavailable.'); },
    activate: async () => { throw new Error('Supporter activation is unavailable.'); },
    refreshEntitlement: async () => { throw new Error('Supporter activation is unavailable.'); },
  };
}
