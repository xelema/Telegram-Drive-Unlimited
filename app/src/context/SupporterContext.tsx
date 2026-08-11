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
};

const SupporterContext = createContext<SupporterContextValue | null>(null);

export function SupporterProvider({ children }: { children: ReactNode }) {
  const isMobile = useMemo(() => {
    try {
      return ['android', 'ios'].includes(operatingSystemType());
    } catch {
      const userAgent = navigator.userAgent.toLowerCase();
      return userAgent.includes('android') || userAgent.includes('iphone') || userAgent.includes('ipad');
    }
  }, []);
  const [status, setStatus] = useState<SupporterStatus>({ ...unavailableStatus, state: 'loading', message: 'Checking supporter activation…' });

  const refreshStatus = useCallback(async () => {
    if (isMobile) {
      setStatus(unavailableStatus);
      return unavailableStatus;
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
  }, [isMobile]);

  const refreshEntitlement = useCallback(async () => {
    const next = await invoke<SupporterStatus>('cmd_refresh_supporter');
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refreshStatus().then(current => {
      if (cancelled || !['active', 'needs_refresh'].includes(current.state)) return;
      void refreshEntitlement().catch(() => {
        if (!cancelled) void refreshStatus();
      });
    });
    return () => { cancelled = true; };
  }, [refreshEntitlement, refreshStatus]);

  const value = useMemo<SupporterContextValue>(() => ({
    status,
    refreshStatus,
    refreshEntitlement,
    beginCheckout: termsVersion => invoke<CheckoutStarted>('cmd_begin_supporter_checkout', { acceptedTermsVersion: termsVersion }),
    pollCheckout: async () => {
      const result = await invoke<CheckoutPollResult>('cmd_poll_supporter_checkout');
      if (result.status === 'completed') await refreshStatus();
      return result;
    },
    activate: async (recoveryCode, termsVersion) => {
      const next = await invoke<SupporterStatus>('cmd_activate_supporter', { recoveryCode, acceptedTermsVersion: termsVersion });
      setStatus(next);
      return next;
    },
  }), [refreshEntitlement, refreshStatus, status]);

  return <SupporterContext.Provider value={value}>{children}</SupporterContext.Provider>;
}

export function useSupporter() {
  return useContext(SupporterContext) ?? {
    status: unavailableStatus,
    refreshStatus: async () => unavailableStatus,
    beginCheckout: async () => { throw new Error('Supporter activation is unavailable.'); },
    pollCheckout: async () => { throw new Error('Supporter activation is unavailable.'); },
    activate: async () => { throw new Error('Supporter activation is unavailable.'); },
    refreshEntitlement: async () => { throw new Error('Supporter activation is unavailable.'); },
  };
}
