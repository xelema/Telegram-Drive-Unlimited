import { SUPPORTER_STATUS_READ_ATTEMPTS, type SupporterStatus } from '../context/SupporterContext';

interface RenewalOptions {
  isAndroid: boolean;
  readStatus: () => Promise<SupporterStatus>;
  refresh: () => Promise<SupporterStatus>;
}

const renewable = (status: SupporterStatus) => ['active', 'needs_refresh', 'expired'].includes(status.state);

/** One startup attempt plus two bounded retries; connectivity can start a new cycle. */
export function startSupporterRenewal({ isAndroid, readStatus, refresh }: RenewalOptions): () => void {
  let stopped = false;
  let running = false;
  let wakePending = false;
  let attempts = 0;
  let retriedCredentials = false;
  let lastWake = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = (delay: number) => { clearTimer(); timer = setTimeout(() => { timer = undefined; void run(); }, delay); };
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const current = await readStatus();
      if (stopped) return;
      if (isAndroid && current.state === 'unavailable' && !retriedCredentials && attempts === 0) {
        retriedCredentials = true;
        schedule(1500);
        return;
      }
      if (!renewable(current)) return;
      attempts++;
      try { await refresh(); }
      catch {
        if (stopped) return;
        // Read cached validity/revocation after failure; never infer revocation
        // or discard an existing purchase because the transport failed.
        const cached = await readStatus();
        if (!stopped && renewable(cached) && attempts < SUPPORTER_STATUS_READ_ATTEMPTS) schedule(attempts === 1 ? 30_000 : 120_000);
      }
    } catch {
      // A local-status transport failure also has a bounded retry budget.
      attempts++;
      if (!stopped && attempts < SUPPORTER_STATUS_READ_ATTEMPTS) schedule(attempts === 1 ? 30_000 : 120_000);
    } finally {
      running = false;
      if (!stopped && wakePending) { wakePending = false; attempts = 0; clearTimer(); void run(); }
    }
  };
  const wake = () => {
    if (stopped || Date.now() - lastWake < 1000) return;
    lastWake = Date.now();
    attempts = 0;
    retriedCredentials = false;
    clearTimer();
    if (running) wakePending = true;
    else void run();
  };
  const visible = () => { if (document.visibilityState === 'visible') wake(); };
  const network = (event: Event) => { if ((event as CustomEvent<{ connected?: boolean }>).detail?.connected) wake(); };
  window.addEventListener('online', wake);
  window.addEventListener('android-environment-change', network);
  document.addEventListener('visibilitychange', visible);
  void run();
  return () => {
    stopped = true;
    clearTimer();
    window.removeEventListener('online', wake);
    window.removeEventListener('android-environment-change', network);
    document.removeEventListener('visibilitychange', visible);
  };
}

/** Bounded foreground recovery; the durable claim survives exhaustion/restart. */
export function startCheckoutRecovery(poll: () => Promise<unknown>): () => void {
  let stopped = false;
  let running = false;
  let attempts = 0;
  let lastWake = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delays = [3000, 5000, 10_000, 20_000, 30_000, 60_000];
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try { await poll(); } catch { /* The claim remains saved for the next retry. */ }
    finally {
      running = false;
      if (!stopped && attempts < delays.length) timer = setTimeout(() => { timer = undefined; void run(); }, delays[attempts++]);
    }
  };
  const wake = () => {
    if (stopped || running || Date.now() - lastWake < 1000) return;
    lastWake = Date.now();
    if (timer !== undefined) clearTimeout(timer);
    attempts = 0;
    void run();
  };
  const visible = () => { if (document.visibilityState === 'visible') wake(); };
  const network = (event: Event) => { if ((event as CustomEvent<{ connected?: boolean }>).detail?.connected) wake(); };
  window.addEventListener('online', wake);
  window.addEventListener('android-environment-change', network);
  document.addEventListener('visibilitychange', visible);
  void run();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener('online', wake);
    window.removeEventListener('android-environment-change', network);
    document.removeEventListener('visibilitychange', visible);
  };
}
