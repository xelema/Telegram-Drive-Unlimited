import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Heart, X } from 'lucide-react';
import { useSupporter } from '../../../context/SupporterContext';
import { openSponsorDestination, openSponsorLink } from '../../../services/sponsorLinks';
import {
  shouldShowSponsorContent,
  sponsorAdCooldownRemaining,
} from '../../../services/supporterVisibility';
import i18n from '../../../i18n';

const AUTO_DISMISS_SECONDS = 10;
const AD_LOAD_TIMEOUT_MS = 12_000;
const DISMISSED_AT_KEY = 'desktopAdDismissedAt';
const AD_IFRAME_ORIGIN = 'http://localhost:14201';
const AD_IFRAME_URL = `${AD_IFRAME_ORIGIN}/ad-banner`;
const AD_STATUS_MESSAGE = 'telegram-drive:ad-banner-status';
const AD_LINK_MESSAGE = 'telegram-drive:ad-link';

type AdLoadStatus = 'loading' | 'loaded' | 'fallback';

interface DesktopAdBannerProps {
  suppressed?: boolean;
  onSupport?: () => void;
  onManualDismiss?: () => void;
  previewContent?: ReactNode;
}

function readDismissedAt(): number | null {
  try {
    const value = Number.parseInt(localStorage.getItem(DISMISSED_AT_KEY) ?? '', 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function saveDismissedAt(timestamp: number): void {
  try {
    localStorage.setItem(DISMISSED_AT_KEY, timestamp.toString());
  } catch {
    // Persistence is optional; the component also retains the timestamp in memory.
  }
}

export function DesktopAdBanner({ suppressed = false, onSupport, onManualDismiss, previewContent }: DesktopAdBannerProps) {
  const { status: supporterStatus } = useSupporter();
  const isPreview = previewContent !== undefined;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionDismissedAtRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const dismissingRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS);
  const [loadStatus, setLoadStatus] = useState<AdLoadStatus>(isPreview ? 'loaded' : 'loading');
  const [cycle, setCycle] = useState(0);
  const eligible = !suppressed && shouldShowSponsorContent(supporterStatus);

  useEffect(() => {
    if (!eligible || visible) return;

    let timer: number | undefined;
    const showWhenDue = () => {
      const dismissedAt = readDismissedAt() ?? sessionDismissedAtRef.current;
      const remaining = sponsorAdCooldownRemaining(dismissedAt);
      if (remaining > 0) {
        timer = window.setTimeout(showWhenDue, remaining);
        return;
      }
      setCountdown(AUTO_DISMISS_SECONDS);
      setLoadStatus(isPreview ? 'loaded' : 'loading');
      setCycle(current => current + 1);
      setVisible(true);
    };

    showWhenDue();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [eligible, isPreview, visible]);

  const dismiss = useCallback((manual = false) => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    const dismissedAt = Date.now();
    sessionDismissedAtRef.current = dismissedAt;
    saveDismissedAt(dismissedAt);
    setExiting(true);
    setCountdown(0);
    dismissTimerRef.current = window.setTimeout(() => {
      setVisible(false);
      setExiting(false);
      dismissingRef.current = false;
      dismissTimerRef.current = null;
      if (manual) onManualDismiss?.();
    }, 200);
  }, [onManualDismiss]);

  useEffect(() => () => {
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
  }, []);

  useEffect(() => {
    if (!eligible || !visible || isPreview) return;

    const timeout = window.setTimeout(() => setLoadStatus('fallback'), AD_LOAD_TIMEOUT_MS);
    const receiveStatus = (event: MessageEvent<unknown>) => {
      if (event.origin !== AD_IFRAME_ORIGIN || event.source !== iframeRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;

      const message = event.data as { type?: unknown; status?: unknown; url?: unknown };

      if (message.type === AD_LINK_MESSAGE && typeof message.url === 'string') {
        const userActivation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (userActivation?.isActive !== true) return;
        void openSponsorDestination(message.url);
        return;
      }

      if (message.type !== AD_STATUS_MESSAGE) return;

      if (message.status === 'loaded') {
        window.clearTimeout(timeout);
        setLoadStatus('loaded');
      } else if (message.status === 'failed') {
        window.clearTimeout(timeout);
        setLoadStatus('fallback');
      }
    };

    window.addEventListener('message', receiveStatus);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', receiveStatus);
    };
  }, [cycle, eligible, isPreview, visible]);

  useEffect(() => {
    if (!eligible || !visible || exiting || isPreview || loadStatus === 'loading') return;
    if (countdown <= 0) {
      dismiss(false);
      return;
    }
    const timer = window.setTimeout(() => setCountdown(current => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, dismiss, eligible, exiting, isPreview, loadStatus, visible]);

  const openSponsor = useCallback(async () => {
    await openSponsorLink('desktop_banner_fallback');
  }, []);

  if (!eligible || !visible) return null;

  return (
    <aside
      role="complementary"
      aria-label={`Sponsored advertisement — closes automatically in ${countdown} seconds`}
      className={`fixed bottom-4 end-4 z-40 w-[300px] overflow-hidden rounded-container border border-app-border bg-app-surface-raised shadow-[var(--shadow-floating)] transition-all duration-200 motion-reduce:transition-none ${exiting ? 'translate-y-2 opacity-0' : 'opacity-100'}`}
    >
      <header className="flex min-h-10 items-center gap-2 border-b border-app-border-subtle px-3 py-2">
        <span className="sponsored-label border-0 px-0">{i18n.t("ads.sponsored")}</span>
        <span className="min-w-0 flex-1 truncate text-metadata text-app-text-secondary">
          {loadStatus === 'loading' ? 'Loading…' : `Closes in ${countdown}s`}
        </span>
        <button type="button" onClick={() => dismiss(true)} className="quiet-control p-1.5 text-app-text-secondary hover:text-app-text" aria-label={i18n.t("ads.close_ad")}>
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="relative block h-[250px] w-full overflow-hidden bg-app-surface-sunken/40">
        {isPreview ? (
          <span className="absolute inset-0 flex items-center justify-center px-5 text-center text-ui text-app-text-secondary">
            {previewContent}
          </span>
        ) : (
          <>
            {loadStatus === 'loading' && (
              <span className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-5 text-center">
                <span className="sponsored-label">{i18n.t("ads.sponsored")}</span>
                <span className="text-ui text-app-text-secondary">
                  {i18n.t("common.loading")}
                </span>
              </span>
            )}
            {loadStatus === 'fallback' && (
              <button
                type="button"
                onClick={() => void openSponsor()}
                className="quiet-control absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-5 text-center hover:bg-app-hover"
                aria-label={i18n.t("ads.browser_note")}
              >
                <span className="sponsored-label">{i18n.t("ads.sponsored")}</span>
                <span className="text-ui text-app-text-secondary">{i18n.t("common.operation_failed")}</span>
                <span className="text-metadata text-app-accent">{i18n.t("ads.sponsored")}</span>
              </button>
            )}
            <iframe
              ref={iframeRef}
              src={`${AD_IFRAME_URL}?cycle=${cycle}`}
              sandbox="allow-scripts allow-same-origin"
              title={i18n.t("ads.sponsored")}
              width={300}
              height={250}
              className={`relative border-0 bg-transparent transition-opacity duration-200 ${loadStatus === 'loaded' ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
              onError={() => setLoadStatus('fallback')}
            />
          </>
        )}
      </div>

      {onSupport && (
        <button type="button" onClick={onSupport} className="flex w-full items-center justify-center gap-2 border-t border-app-border-subtle bg-app-selected/40 px-3 py-2.5 text-xs font-semibold text-app-accent hover:bg-app-selected" aria-label="Remove ads forever for $5 once">
          <Heart className="h-3.5 w-3.5" aria-hidden="true" />
          Remove ads forever · $5 once
        </button>
      )}

      <div aria-live="polite" className="sr-only">
        {loadStatus === 'loading' ? 'Advertisement loading' : `Advertisement closes in ${countdown} seconds`}
      </div>
    </aside>
  );
}
