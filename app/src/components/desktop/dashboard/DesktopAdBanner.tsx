import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Heart, Megaphone, X } from 'lucide-react';
import { useSupporter } from '../../../context/SupporterContext';
import { openSponsorLink } from '../../../services/sponsorLinks';
import { shouldShowSponsorContent } from '../../../services/supporterVisibility';

const AD_INTERVAL_MS = 45 * 60 * 1000;
const AUTO_DISMISS_SECONDS = 10;
const DISMISSED_AT_KEY = 'desktopAdDismissedAt';

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
  const sessionDismissedAtRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS);
  const [isHovering, setIsHovering] = useState(false);
  const eligible = !suppressed && shouldShowSponsorContent(supporterStatus);

  useEffect(() => {
    if (!eligible || visible) return;

    const showWhenDue = () => {
      const dismissedAt = readDismissedAt() ?? sessionDismissedAtRef.current;
      if (dismissedAt !== null && Date.now() - dismissedAt < AD_INTERVAL_MS) return;
      setCountdown(AUTO_DISMISS_SECONDS);
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
    if (!eligible || !visible || exiting || isHovering) return;
    if (countdown <= 0) {
      dismiss();
      return;
    }
    const timer = window.setTimeout(() => setCountdown(current => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, dismiss, eligible, exiting, isHovering, visible]);

  const openSponsor = useCallback(async () => {
    await openSponsorLink();
  }, []);

  if (!eligible || !visible) return null;

  return (
    <aside
      role="complementary"
      aria-label={`Sponsored advertisement — closes automatically in ${countdown} seconds`}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      className={`fixed bottom-4 end-4 z-40 w-[300px] overflow-hidden rounded-container border border-app-border bg-app-surface-raised shadow-[var(--shadow-floating)] transition-all duration-200 motion-reduce:transition-none ${exiting ? 'translate-y-2 opacity-0' : 'opacity-100'}`}
    >
      <header className="flex min-h-10 items-center gap-2 border-b border-app-border-subtle px-3 py-2">
        <span className="sponsored-label border-0 px-0">Sponsored</span>
        <span className="min-w-0 flex-1 truncate text-metadata text-app-text-secondary">
          {`Closes in ${countdown}s`}
        </span>
        {onSupport && (
          <button type="button" onClick={onSupport} className="quiet-control p-1.5 text-app-accent" aria-label="Support development and hide ads">
            <Heart className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={dismiss} className="quiet-control p-1.5 text-app-text-secondary" aria-label="Dismiss sponsor banner">
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <button
        type="button"
        onClick={openSponsor}
        className="group relative flex h-[250px] w-full flex-col items-center justify-center overflow-hidden bg-app-surface-sunken/40 px-7 text-center transition-colors hover:bg-app-hover"
        aria-label="Open sponsored content in browser"
      >
        <span className="absolute end-2 -top-16 h-40 w-40 rounded-full bg-app-accent/10 blur-2xl" aria-hidden="true" />
        <span className="relative flex h-14 w-14 items-center justify-center rounded-full border border-app-border bg-app-surface-raised text-app-accent shadow-[var(--shadow-raised)]">
          <Megaphone className="h-6 w-6" aria-hidden="true" />
        </span>
        <span className="sponsored-label relative mt-5">Sponsored</span>
        <span className="relative mt-3 text-sm font-semibold text-app-text">A quick message from our sponsor</span>
        <span className="relative mt-2 text-metadata leading-5 text-app-text-secondary">The sponsored offer opens securely in your browser.</span>
        <span className="relative mt-5 inline-flex items-center gap-1.5 text-metadata font-medium text-app-accent">
          View sponsored offer
          <ExternalLink className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </span>
      </button>

      <div aria-live="polite" className="sr-only">
        {`Advertisement closes in ${countdown} seconds`}
      </div>
    </aside>
  );
}
