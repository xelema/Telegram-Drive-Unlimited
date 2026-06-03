import { useCallback, useState, useEffect } from 'react';
import { usePlatform } from '../../hooks/usePlatform';
import { open } from '@tauri-apps/plugin-shell';
import { load } from '@tauri-apps/plugin-store';
import { ExternalLink, X } from 'lucide-react';

interface AdsterraBannerProps {
  visible: boolean;
}

const SMARTLINK_URL = 'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40';
const DISMISSED_KEY = 'adBannerDismissed';

/** SmartLink clickable banner for Android. Tapping opens the offerwall in an external browser. */
export default function AdsterraBanner({ visible }: AdsterraBannerProps) {
  const { isAndroid } = usePlatform();
  const [dismissed, setDismissed] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Restore persisted dismissal state on mount
  useEffect(() => {
    let cancelled = false;
    load('config.json')
      .then((store) => store.get<boolean>(DISMISSED_KEY))
      .then((wasDismissed) => {
        if (!cancelled && wasDismissed) setDismissed(true);
        if (!cancelled) setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => { cancelled = true; };
  }, []);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await open(SMARTLINK_URL);
    } catch {
      window.open(SMARTLINK_URL, '_blank');
    }
  }, []);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Persist dismissal to store so it survives app restarts
    load('config.json')
      .then((store) => store.set(DISMISSED_KEY, true).then(() => store.save()))
      .catch(() => {});
    // Trigger fade-out animation, then fully dismiss
    setExiting(true);
    setTimeout(() => setDismissed(true), 300);
  }, []);

  // Don't render until store check completes, or once dismissed.
  // Using !loaded prevents a flash on restart when the banner was previously dismissed.
  if (!isAndroid || !loaded || dismissed) {
    return null;
  }

  const isVisible = visible && !exiting;

  return (
    <div
      id="adsterra-banner-container"
      role="complementary"
      aria-label="Sponsored content"
      className="w-full flex justify-center bg-telegram-surface/80 border-t border-telegram-border/30 transition-all duration-300 ease-out overflow-hidden relative"
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
        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-telegram-subtext hover:text-telegram-text hover:bg-telegram-hover/30 active:bg-telegram-hover/50 transition-all duration-200"
      >
        <ExternalLink className="w-3 h-3 text-telegram-primary" />
        <span className="text-[11px] uppercase tracking-wider">Sponsored</span>
      </button>
      <button
        onClick={handleDismiss}
        className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 text-telegram-subtext hover:text-telegram-text hover:bg-telegram-hover/30 rounded-full transition-all duration-200"
        aria-label="Close ad"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
