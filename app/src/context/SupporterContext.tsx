import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type as operatingSystemType } from '@tauri-apps/plugin-os';

export const SUPPORTER_STATUS_READ_ATTEMPTS = 3;

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
  message: 'Verified supporter activation is available in supported desktop and Android builds.',
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
  const currentStatus = useRef(status);
  const revision = useRef(0);
  const renewal = useRef<Promise<SupporterStatus> | null>(null);
  const checkoutPoll = useRef<Promise<CheckoutPollResult> | null>(null);
  const startupReadFailures = useRef(0);
  const publish = useCallback((next: SupporterStatus, expected: number) => {
    if (expected === revision.current) { currentStatus.current = next; setStatus(next); }
    return currentStatus.current;
  }, []);

  const refreshStatus = useCallback(async () => {
    const expected = ++revision.current;
    if (platform.isIos) {
      return publish(iosUnavailableStatus, expected);
    }
    try {
      const next = await invoke<SupporterStatus>('cmd_get_supporter_status');
      return publish(next, expected);
    } catch (error) {
      const cached = currentStatus.current;
      const now = Date.now() / 1000;
      const stillValid = cached.ad_free && cached.offline_until !== null && now <= cached.offline_until;
      const next: SupporterStatus = stillValid
        ? { ...cached, state: cached.expires_at !== null && now > cached.expires_at ? 'needs_refresh' : 'active' }
        : { ...cached, state: 'unavailable', ad_free: false, message: error instanceof Error ? error.message : String(error) };
      if (cached.state === 'loading' && expected === revision.current) {
        // Keep startup suppression while the renewal helper retries the native
        // read; exhausted retries use the existing unavailable fallback.
        startupReadFailures.current++;
        if (startupReadFailures.current < SUPPORTER_STATUS_READ_ATTEMPTS) throw error;
      }
      return publish(next, expected);
    }
  }, [platform.isIos, publish]);

  const refreshEntitlement = useCallback(() => {
    if (renewal.current) return renewal.current;
    const expected = ++revision.current;
    const operation = invoke<SupporterStatus>('cmd_refresh_supporter').then(next => publish(next, expected)).catch(async error => {
      if (expected === revision.current) await refreshStatus();
      throw error;
    });
    renewal.current = operation;
    void operation.finally(() => { if (renewal.current === operation) renewal.current = null; }).catch(() => undefined);
    return operation;
  }, [publish, refreshStatus]);

  const pollCheckout = useCallback(() => {
    if (checkoutPoll.current) return checkoutPoll.current;
    const expected = ++revision.current;
    const operation = invoke<CheckoutPollResult>('cmd_poll_supporter_checkout').then(async result => {
      if (expected === revision.current) {
        if (result.recovery_code) setLatestRecoveryCode(result.recovery_code);
        if (['completed', 'failed', 'expired'].includes(result.status)) await refreshStatus();
      }
      return result;
    });
    checkoutPoll.current = operation;
    void operation.finally(() => { if (checkoutPoll.current === operation) checkoutPoll.current = null; }).catch(() => undefined);
    return operation;
  }, [refreshStatus]);

  const beginCheckout = useCallback(async (termsVersion: string) => {
    const expected = ++revision.current;
    const checkout = await invoke<CheckoutStarted>('cmd_begin_supporter_checkout', { acceptedTermsVersion: termsVersion });
    if (expected === revision.current) {
      setLatestRecoveryCode(null);
      publish({ ...currentStatus.current, checkout_pending: true }, expected);
    }
    return checkout;
  }, [publish]);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import('../services/supporterRenewal').then(({ startSupporterRenewal }) => {
      if (!cancelled) stop = startSupporterRenewal({ isAndroid: platform.isAndroid, readStatus: refreshStatus, refresh: refreshEntitlement });
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [platform.isAndroid, refreshEntitlement, refreshStatus]);

  useEffect(() => {
    if (!status.checkout_pending) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import('../services/supporterRenewal').then(({ startCheckoutRecovery }) => {
      if (!cancelled) stop = startCheckoutRecovery(pollCheckout);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [pollCheckout, status.checkout_pending]);

  const value = useMemo<SupporterContextValue>(() => ({
    status,
    latestRecoveryCode,
    refreshStatus,
    refreshEntitlement,
    beginCheckout,
    pollCheckout,
    activate: async (recoveryCode, termsVersion) => {
      const expected = ++revision.current;
      const next = await invoke<SupporterStatus>('cmd_activate_supporter', { recoveryCode, acceptedTermsVersion: termsVersion });
      return publish(next, expected);
    },
  }), [beginCheckout, latestRecoveryCode, pollCheckout, publish, refreshEntitlement, refreshStatus, status]);

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
