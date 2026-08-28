import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '../../hooks/usePlatform';
import { load } from '@tauri-apps/plugin-store';
import { ExternalLink, X } from 'lucide-react';
import { useSupporter } from '../../context/SupporterContext';
import { openSponsorLink } from '../../services/sponsorLinks';
import {
  shouldShowSponsorContent,
  sponsorAdCooldownRemaining,
} from '../../services/supporterVisibility';

interface AdsterraBannerProps {
  visible: boolean;
  onSupport?: () => void;
  onManualDismiss?: () => void;
}

const DISMISSED_AT_KEY = 'adBannerDismissedAt';
const LEGACY_DISMISSED_KEY = 'adBannerDismissed';

function parseDismissedAt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Clickable sponsor banner for Android. The offer always opens in an external browser. */
export default function AdsterraBanner({ visible, onSupport, onManualDismiss }: AdsterraBannerProps) {
  const { isAndroid, isTelevision } = usePlatform();
  const { status: supporterStatus } = useSupporter();
  const dismissAnimationRef = useRef<number | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [exiting, setExiting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Restore the timestamp-based cooldown and migrate the previous permanent dismissal.
  useEffect(() => {
    let cancelled = false;
    void load('config.json')
      .then(async (store) => {
        let restoredAt = parseDismissedAt(await store.get<unknown>(DISMISSED_AT_KEY));
        const legacyDismissed = await store.get<boolean>(LEGACY_DISMISSED_KEY);
        let storeChanged = false;

        if (restoredAt === null && legacyDismissed) {
          restoredAt = Date.now();
          await store.set(DISMISSED_AT_KEY, restoredAt);
          storeChanged = true;
        }
        if (legacyDismissed !== undefined) {
          await store.delete(LEGACY_DISMISSED_KEY);
          storeChanged = true;
        }

        if (restoredAt !== null && sponsorAdCooldownRemaining(restoredAt) === 0) {
          restoredAt = null;
          await store.delete(DISMISSED_AT_KEY);
          storeChanged = true;
        }
        if (storeChanged) await store.save();
        return restoredAt;
      })
      .then((restoredAt) => {
        if (!cancelled) setDismissedAt(restoredAt);
        if (!cancelled) setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
      if (dismissAnimationRef.current !== null) window.clearTimeout(dismissAnimationRef.current);
    };
  }, []);

  useEffect(() => {
    const remaining = sponsorAdCooldownRemaining(dismissedAt);
    if (remaining === 0) return;

    const timer = window.setTimeout(() => {
      setDismissedAt(null);
      setExiting(false);
      void load('config.json')
        .then((store) => store.delete(DISMISSED_AT_KEY).then(() => store.save()))
        .catch(() => {});
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [dismissedAt]);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await openSponsorLink();
  }, []);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dismissAnimationRef.current !== null) return;
    const timestamp = Date.now();
    // Persist the cooldown so the 15-minute cadence survives app restarts.
    load('config.json')
      .then(async (store) => {
        await store.set(DISMISSED_AT_KEY, timestamp);
        await store.delete(LEGACY_DISMISSED_KEY);
        await store.save();
      })
      .catch(() => {});
    setExiting(true);
    dismissAnimationRef.current = window.setTimeout(() => {
      setDismissedAt(timestamp);
      setExiting(false);
      dismissAnimationRef.current = null;
      onManualDismiss?.();
    }, 300);
  }, [onManualDismiss]);

  // Don't render until store check completes, or while the recurrence cooldown is active.
  // Using !loaded prevents a flash on restart when a dismissal was persisted.
  if (!isAndroid || !loaded || sponsorAdCooldownRemaining(dismissedAt) > 0 || !shouldShowSponsorContent(supporterStatus)) {
    return null;
  }

  const isVisible = visible && !exiting;

  return (
    <div
      id="adsterra-banner-container"
      role="complementary"
      aria-label="Sponsored content"
      className="relative flex w-full justify-center overflow-hidden border border-app-border bg-app-surface-raised shadow-[var(--shadow-raised)] transition-all duration-200 ease-out motion-reduce:transition-none"
      style={{
        visibility: isVisible ? 'visible' : 'hidden',
        minHeight: isVisible ? 48 : 0,
        maxHeight: isVisible ? 48 : 0,
        height: isVisible ? 48 : 0,
        opacity: isVisible ? 1 : 0,
      }}
    >
      <button
        onClick={handleClick}
        className="quiet-control flex min-w-0 flex-1 items-center justify-center gap-2 px-3 py-2.5 text-metadata font-medium text-app-text-secondary hover:bg-app-hover hover:text-app-text"
      >
        <ExternalLink className="h-3 w-3 text-app-accent" />
        <span className="sponsored-label border-0">{isTelevision ? 'Sponsored — View offer' : 'Sponsored'}</span>
      </button>
      {onSupport && (
        <button
          type="button"
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onSupport(); }}
          className="quiet-control me-9 shrink-0 border-s border-app-border-subtle px-3 py-2 text-[10px] font-semibold text-app-accent hover:bg-app-selected"
          aria-label="Remove ads forever for $5 once"
        >
          Ad-free · $5 once
        </button>
      )}
      <button
        onClick={handleDismiss}
        className="quiet-control absolute end-1 top-1/2 -translate-y-1/2 p-1.5 text-app-text-secondary hover:text-app-text"
        aria-label="Close ad"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
