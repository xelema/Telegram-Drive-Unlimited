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
import i18n from '../../i18n';

interface AdsterraBannerProps {
  visible: boolean;
  onSupport?: () => void;
  onManualDismiss?: () => void;
}

const LEGACY_DISMISSED_AT_KEY = 'adBannerDismissedAt';
const LEGACY_DISMISSED_KEY = 'adBannerDismissed';

/** Clickable sponsor banner for Android. The offer always opens in an external browser. */
export default function AdsterraBanner({ visible, onSupport, onManualDismiss }: AdsterraBannerProps) {
  const { isAndroid, isTelevision } = usePlatform();
  const { status: supporterStatus } = useSupporter();
  const dismissAnimationRef = useRef<number | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [exiting, setExiting] = useState(false);

  // Older builds persisted dismissals across restarts. Clear both formats before
  // they can affect a later build. This cleanup never blocks the current banner.
  useEffect(() => {
    void load('config.json')
      .then(async (store) => {
        const removedTimestamp = await store.delete(LEGACY_DISMISSED_AT_KEY);
        const removedPermanentFlag = await store.delete(LEGACY_DISMISSED_KEY);
        if (removedTimestamp || removedPermanentFlag) await store.save();
      })
      .catch(() => {});
    return () => {
      if (dismissAnimationRef.current !== null) window.clearTimeout(dismissAnimationRef.current);
    };
  }, []);

  useEffect(() => {
    const remaining = sponsorAdCooldownRemaining(dismissedAt);
    if (remaining === 0) return;

    const timer = window.setTimeout(() => {
      setDismissedAt(null);
      setExiting(false);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [dismissedAt]);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await openSponsorLink('android_banner');
  }, []);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dismissAnimationRef.current !== null) return;
    const timestamp = Date.now();
    setExiting(true);
    dismissAnimationRef.current = window.setTimeout(() => {
      setDismissedAt(timestamp);
      setExiting(false);
      dismissAnimationRef.current = null;
      onManualDismiss?.();
    }, 300);
  }, [onManualDismiss]);

  // Entitlement resolution still gates every sponsor surface. Dismissal cooldowns
  // apply only within this running session.
  if (!isAndroid || sponsorAdCooldownRemaining(dismissedAt) > 0 || !shouldShowSponsorContent(supporterStatus)) {
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
        aria-label={i18n.t("ads.close_ad")}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
