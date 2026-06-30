import { useState, useEffect, useRef, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-shell';


const AD_INTERVAL_MS = 1000 * 60 * 45; // 45 minutes
const AUTO_DISMISS_SECONDS = 10; // auto-close after 10s
const DISMISSED_AT_KEY = 'desktopAdDismissedAt';

const AD_CLICK_URL = 'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40';

// Hosted ad page — loads the Adsterra script under its own origin/CSP
const AD_IFRAME_URL = 'https://www.cameronamer.com/ad-banner.html';


// Safe localStorage wrappers — prevent crashes in restricted webview environments
function safeTryGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeTryRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* unavailable */ }
}
function safeTrySet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* unavailable */ }
}

/**
 * Periodic ad banner for the desktop dashboard (every 45 minutes).
 *
 * Renders a 300×250 ad inside a **sandboxed iframe** so the external ad
 * script cannot attach global event listeners or pollute the main document.
 * Without this sandbox, the ad network's scripts can install document-level
 * click handlers that open popups/popunders on random clicks anywhere in
 * the app — especially noticeable on Windows WebView2.
 *
 * Clicks on the ad are handled by our own onClick wrapper which opens the
 * ad network URL in the system browser via @tauri-apps/plugin-shell.
 * This avoids the complexity of sandbox navigation interception.
 *
 * Sandbox permissions:
 *   allow-scripts              → ad script can execute
 *   allow-same-origin          → ad script runs on the parent origin
 *                              (localhost/tauri) — needed for cookies,
 *                              localStorage, and XHR/fetch to function.
 *   allow-popups               → ad clicks can open popups
 *   allow-popups-to-escape-sandbox → popups open as full browser windows
 *
 * Dismissal:
 * The ad auto-closes after AUTO_DISMISS_SECONDS (10 s). The countdown
 * pauses while the user hovers over the panel. Manual dismissal is disabled
 * during the countdown to ensure the full ad impression is served.
 */
export function DesktopAdBanner() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS);
  const [isHovering, setIsHovering] = useState(false);
  const mountedRef = useRef(true);

  // Clear dismissed state on mount so it shows on every reload
  useEffect(() => {
    safeTryRemove(DISMISSED_AT_KEY);
  }, []);

  // ── Check dismissal interval ─────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;

    const check = () => {
      if (!mountedRef.current) return;
      const raw = safeTryGet(DISMISSED_AT_KEY);
      if (!raw) {
        setVisible(true);
        return;
      }
      const dismissedAt = parseInt(raw, 10);
      if (isNaN(dismissedAt) || Date.now() - dismissedAt >= AD_INTERVAL_MS) {
        safeTryRemove(DISMISSED_AT_KEY);
        setVisible(true);
      }
    };

    check();

    let interval: ReturnType<typeof setInterval> | undefined;
    if (!visible) {
      interval = setInterval(check, 30_000);
    }
    return () => {
      mountedRef.current = false;
      if (interval) clearInterval(interval);
    };
  }, [visible]);


  // ── Internal dismiss ──
  const handleDismissInternal = useCallback(() => {
    // Clear the iframe src to stop scripts
    if (iframeRef.current) {
      iframeRef.current.src = 'about:blank';
    }
    safeTrySet(DISMISSED_AT_KEY, Date.now().toString());
    setExiting(true);
    setCountdown(0);
    setTimeout(() => {
      setVisible(false);
      setExiting(false);
    }, 300);
  }, []);

  // ── Handle ad click — open in system browser ────────────────────────
  const handleAdClick = useCallback(async () => {
    try {
      await open(AD_CLICK_URL);
    } catch {
      // Fallback: try window.open if shell plugin fails
      window.open(AD_CLICK_URL, '_blank');
    }
  }, []);

  // ── Auto-dismiss after 10 seconds ─────────────────────────────────────
  useEffect(() => {
    if (!visible) {
      setCountdown(AUTO_DISMISS_SECONDS);
      return;
    }
    if (countdown <= 0) {
      if (!exiting) handleDismissInternal();
      return;
    }
    if (isHovering) return;
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [visible, countdown, exiting, isHovering, handleDismissInternal]);

  if (!visible) return null;

  return (
    <>
      {/* Ad panel */}
      <div
        role="dialog"
        aria-label="Sponsored advertisement — closes automatically after 10 seconds"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        className={`
          fixed bottom-20 right-5 z-[100]
          bg-telegram-surface border border-telegram-border/60
          rounded-xl shadow-2xl overflow-hidden
          transition-all duration-300 ease-out
          ${exiting ? 'opacity-0 scale-95 translate-y-2' : 'opacity-100 scale-100'}
        `}
      >
        {/* Countdown display — shows seconds remaining until auto-close */}
        <div
          className="
            absolute top-1.5 right-1.5 z-20
            p-1 rounded-md text-[10px] font-bold
            flex items-center justify-center min-w-[24px] h-[20px]
            bg-white/5 text-white/40 border border-white/10
          "
          aria-label={`Advertisement closes in ${countdown} seconds`}
        >
          {countdown}s
        </div>

        {/* Header bar with dismiss countdown text */}
        <div className="flex items-center justify-center pl-4 pr-10 py-2 bg-telegram-hover/30 border-b border-telegram-border/30 select-none">
          <span className="text-[11px] font-medium text-telegram-text/80">
            Sponsored Ad — closes in <span className="font-bold text-telegram-primary tabular-nums">{countdown}</span>s
          </span>
        </div>

        {/* Screen-reader countdown announcements */}
        <div aria-live="polite" className="sr-only">
          {countdown > 0
            ? `Advertisement closes in ${countdown} ${countdown === 1 ? 'second' : 'seconds'}`
            : 'Advertisement closed'}
        </div>

        {/* Clickable ad wrapper — opens ad URL in system browser on click */}
        <button
          onClick={handleAdClick}
          className="relative block cursor-pointer border-0 bg-transparent p-0 m-0 w-[300px] h-[250px]"
          aria-label="Click to open sponsored content in browser"
        >
          {/* Sandboxed ad iframe — isolates external scripts from the main document.
              pointer-events-none prevents the ad from intercepting clicks so our
              onClick handler always fires. */}
          <iframe
            ref={iframeRef}
            src={AD_IFRAME_URL}
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            title="Advertisement"
            width={300}
            height={250}
            style={{ border: 'none', overflow: 'hidden', pointerEvents: 'none' }}
            className="bg-telegram-bg/50"
          />
        </button>
      </div>
    </>
  );
}
