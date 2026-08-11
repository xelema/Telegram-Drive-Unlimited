import { useCallback, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { Heart, X } from 'lucide-react';
import { useSettings } from '../../../context/SettingsContext';

const AD_CLICK_URL = 'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40';
const AD_IFRAME_ORIGIN = 'http://localhost:14201';
const AD_IFRAME_URL = `${AD_IFRAME_ORIGIN}/ad-banner`;
const AD_STATUS_MESSAGE = 'telegram-drive:ad-banner-status';

interface DesktopAdBannerProps {
  suppressed?: boolean;
  onSupport?: () => void;
}

/** A quiet, static sponsor placement. It never interrupts a workflow. */
export function DesktopAdBanner({ suppressed = false, onSupport }: DesktopAdBannerProps) {
  const { settings } = useSettings();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (suppressed || settings.supporterMode || dismissed) return;
    setLoaded(false);
    const timeout = window.setTimeout(() => setLoaded(false), 6500);
    const receiveStatus = (event: MessageEvent<unknown>) => {
      if (event.origin !== AD_IFRAME_ORIGIN || event.source !== iframeRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;
      const message = event.data as { type?: unknown; status?: unknown };
      if (message.type !== AD_STATUS_MESSAGE) return;
      if (message.status === 'loaded') {
        window.clearTimeout(timeout);
        setLoaded(true);
      }
    };
    window.addEventListener('message', receiveStatus);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', receiveStatus);
    };
  }, [dismissed, settings.supporterMode, suppressed]);

  const openSponsor = useCallback(async () => {
    try {
      await open(AD_CLICK_URL);
    } catch {
      window.open(AD_CLICK_URL, '_blank', 'noopener,noreferrer');
    }
  }, []);

  if (suppressed || settings.supporterMode || dismissed) return null;

  return (
    <aside
      role="complementary"
      aria-label="Sponsored content"
      className="fixed bottom-4 end-4 z-40 w-[300px] overflow-hidden rounded-container border border-app-border bg-app-surface-raised shadow-[var(--shadow-floating)] motion-reduce:transition-none"
    >
      <header className="flex min-h-10 items-center gap-2 border-b border-app-border-subtle px-3 py-2">
        <span className="sponsored-label border-0 px-0">Sponsored</span>
        <span className="min-w-0 flex-1 truncate text-metadata text-app-text-secondary">Supports Telegram Drive development</span>
        {onSupport && (
          <button type="button" onClick={onSupport} className="quiet-control p-1.5 text-app-accent" aria-label="Support development and hide ads">
            <Heart className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={() => setDismissed(true)} className="quiet-control p-1.5 text-app-text-secondary" aria-label="Dismiss sponsor banner for this session">
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <button type="button" onClick={openSponsor} className="relative block h-[250px] w-[300px] bg-app-surface-sunken/40" aria-label="Open sponsored content in browser">
        {!loaded && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-5 text-center">
            <span className="sponsored-label">Sponsored</span>
            <span className="text-ui text-app-text-secondary">Open sponsor</span>
          </span>
        )}
        <iframe
          ref={iframeRef}
          src={AD_IFRAME_URL}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          title="Sponsored advertisement"
          width={300}
          height={250}
          className={`pointer-events-none relative border-0 bg-transparent ${loaded ? 'opacity-100' : 'opacity-0'}`}
          onError={() => setLoaded(false)}
        />
      </button>
    </aside>
  );
}
