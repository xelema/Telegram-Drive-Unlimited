import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useSettings } from '../context/SettingsContext';
import { useSupporter } from '../context/SupporterContext';
import { shouldShowSupporterPrompt, SUPPORTER_VALUE_MOMENT_EVENT, type SupporterPromptTrigger } from '../services/supporterVisibility';

const SETTLE_MS = 60_000;
const IDLE_MS = 15_000;

/** One shared weekly allowance for scheduled, transfer, and ad-dismissal offers. */
export function useSupporterPrompt(
  blocked: boolean,
  setTrigger: Dispatch<SetStateAction<SupporterPromptTrigger | null>>,
) {
  const { settings, updateSetting, isLoaded, persistenceStatus } = useSettings();
  const { status } = useSupporter();
  const ready = isLoaded && persistenceStatus !== 'loading' && persistenceStatus !== 'error'
    && settings.driveTourSeen && shouldShowSupporterPrompt(status, 0);
  const readyAt = useRef(Date.now());
  const lastInteraction = useRef(Date.now());
  const sessionLastShown = useRef(0);
  const [pending, setPending] = useState<{ trigger: SupporterPromptTrigger; at: number } | null>(null);

  useEffect(() => {
    readyAt.current = Date.now();
    if (!ready) { setTrigger(null); setPending(null); }
  }, [ready, setTrigger]);

  useEffect(() => { if (blocked) setTrigger(null); }, [blocked, setTrigger]);

  useEffect(() => {
    const interacted = () => { lastInteraction.current = Date.now(); };
    const events = ['pointerdown', 'pointerup', 'pointermove', 'keydown', 'wheel', 'scroll', 'focus', 'visibilitychange'] as const;
    for (const event of events) window.addEventListener(event, interacted, { capture: true, passive: true });
    return () => { for (const event of events) window.removeEventListener(event, interacted, true); };
  }, []);

  const showOffer = useCallback((trigger: SupporterPromptTrigger) => {
    const now = Date.now();
    if (!ready || blocked || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const storedAt = Number.isFinite(settings.supporterPromptLastShownAt) ? settings.supporterPromptLastShownAt : 0;
    if (!pending && !shouldShowSupporterPrompt(status, Math.max(storedAt, sessionLastShown.current), now)) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"]')) return;
    if (document.activeElement?.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    // An explicit ad dismissal can offer details immediately. Automatic offers
    // wait through startup and a quiet period without keyboard/pointer activity.
    if (trigger !== 'ad_dismissed' && (now - readyAt.current < SETTLE_MS || now - lastInteraction.current < IDLE_MS)) return;
    if (pending) {
      // Reserve the weekly allowance durably before showing anything. A failed
      // write must never create a reminder that repeats after every restart.
      if (persistenceStatus !== 'saved' || storedAt !== pending.at) return;
      setTrigger(pending.trigger);
      setPending(null);
      return;
    }
    sessionLastShown.current = now;
    setPending({ trigger, at: now });
    updateSetting('supporterPromptLastShownAt', now);
  }, [blocked, pending, persistenceStatus, ready, settings.supporterPromptLastShownAt, setTrigger, status, updateSetting]);

  useEffect(() => { if (pending) showOffer(pending.trigger); }, [pending, showOffer]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => showOffer('weekly'), IDLE_MS);
    const onValueMoment = (event: Event) => {
      const moment = (event as CustomEvent<{ moment?: SupporterPromptTrigger }>).detail?.moment;
      if (moment === 'upload_completed' || moment === 'download_completed') showOffer(moment);
    };
    window.addEventListener(SUPPORTER_VALUE_MOMENT_EVENT, onValueMoment);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(SUPPORTER_VALUE_MOMENT_EVENT, onValueMoment);
    };
  }, [ready, showOffer]);

  return showOffer;
}
