import { useCallback, useEffect, useRef, useState } from 'react';
import { Heart } from 'lucide-react';
import { useSupporter } from '../../../context/SupporterContext';
import { openSponsorLink } from '../../../services/sponsorLinks';
import { shouldShowSponsorContent } from '../../../services/supporterVisibility';

const AD_INTERVAL_MS = 45 * 60 * 1000;
const AUTO_DISMISS_SECONDS = 10;
const AD_LOAD_TIMEOUT_MS = 12_000;
const DISMISSED_AT_KEY = 'desktopAdDismissedAt';
const AD_IFRAME_ORIGIN = 'http://localhost:14201';
const AD_IFRAME_URL = `${AD_IFRAME_ORIGIN}/ad-banner`;
const AD_STATUS_MESSAGE = 'telegram-drive:ad-banner-status';

type AdLoadStatus = 'loading' | 'loaded' | 'fallback';

interface DesktopAdBannerProps {
  suppressed?: boolean;
  onSupport?: () => void;
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

export function DesktopAdBanner({ suppressed = false, onSupport }: DesktopAdBannerProps) {
  const { status: supporterStatus } = useSupporter();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionDismissedAtRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS);
  const [loadStatus, setLoadStatus] = useState<AdLoadStatus>('loading');
  const [cycle, setCycle] = useState(0);
  const eligible = !suppressed && shouldShowSponsorContent(supporterStatus);

  useEffect(() => {
    if (!eligible || visible) return;

    const showWhenDue = () => {
      const dismissedAt = readDismissedAt() ?? sessionDismissedAtRef.current;
      if (dismissedAt !== null && Date.now() - dismissedAt < AD_INTERVAL_MS) return;
      setCountdown(AUTO_DISMISS_SECONDS);
      setLoadStatus('loading');
      setCycle(current => current + 1);
      setVisible(true);
    };

    showWhenDue();
    const interval = window.setInterval(showWhenDue, 30_000);
    return () => window.clearInterval(interval);
  }, [eligible, visible]);

  const dismiss = useCallback(() => {
    const dismissedAt = Date.now();
    sessionDismissedAtRef.current = dismissedAt;
    saveDismissedAt(dismissedAt);
    setExiting(true);
    setCountdown(0);
    window.setTimeout(() => {
      setVisible(false);
      setExiting(false);
    }, 200);
  }, []);

  useEffect(() => {
    if (!eligible || !visible) return;

    const timeout = window.setTimeout(() => setLoadStatus('fallback'), AD_LOAD_TIMEOUT_MS);
    const receiveStatus = (event: MessageEvent<unknown>) => {
      if (event.origin !== AD_IFRAME_ORIGIN || event.source !== iframeRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;

      const message = event.data as { type?: unknown; status?: unknown };
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
  }, [cycle, eligible, visible]);

  useEffect(() => {
    if (!eligible || !visible || exiting || loadStatus === 'loading') return;
    if (countdown <= 0) {
      dismiss();
      return;
    }
    const timer = window.setTimeout(() => setCountdown(current => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, dismiss, eligible, exiting, loadStatus, visible]);

  const openSponsor = useCallback(async () => {
    await openSponsorLink();
  }, []);

  if (!eligible || !visible) return null;

  return (
    <aside
      role="complementary"
      aria-label={`Sponsored advertisement — closes automatically in ${countdown} seconds`}
      className={`fixed bottom-4 end-4 z-40 w-[300px] overflow-hidden rounded-container border border-app-border bg-app-surface-raised shadow-[var(--shadow-floating)] transition-all duration-200 motion-reduce:transition-none ${exiting ? 'translate-y-2 opacity-0' : 'opacity-100'}`}
    >
      <header className="flex min-h-10 items-center gap-2 border-b border-app-border-subtle px-3 py-2">
        <span className="sponsored-label border-0 px-0">Sponsored</span>
        <span className="min-w-0 flex-1 truncate text-metadata text-app-text-secondary">
          {loadStatus === 'loading' ? 'Loading…' : `Closes in ${countdown}s`}
        </span>
        {onSupport && (
          <button type="button" onClick={onSupport} className="quiet-control p-1.5 text-app-accent" aria-label="Support development and hide ads">
            <Heart className="h-3.5 w-3.5" />
          </button>
        )}
      </header>

      <button
        type="button"
        onClick={openSponsor}
        className="relative block h-[250px] w-full overflow-hidden bg-app-surface-sunken/40"
        aria-label="Open sponsored content in browser"
      >
        {loadStatus !== 'loaded' && (
          <span className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-5 text-center">
            <span className="sponsored-label">Sponsored</span>
            <span className="text-ui text-app-text-secondary">
              {loadStatus === 'loading' ? 'Loading advertisement…' : 'Sponsored content unavailable'}
            </span>
            {loadStatus === 'fallback' && <span className="text-metadata text-app-accent">Open sponsor</span>}
          </span>
        )}
        <iframe
          ref={iframeRef}
          src={`${AD_IFRAME_URL}?cycle=${cycle}`}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          title="Sponsored advertisement"
          width={300}
          height={250}
          className={`pointer-events-none relative border-0 bg-transparent transition-opacity duration-200 ${loadStatus === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
          onError={() => setLoadStatus('fallback')}
        />
      </button>

      <div aria-live="polite" className="sr-only">
        {loadStatus === 'loading' ? 'Advertisement loading' : `Advertisement closes in ${countdown} seconds`}
      </div>
    </aside>
  );
}
