import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';

const AD_INTERVAL_MS = 1000 * 60 * 45; // 45 minutes
const AUTO_DISMISS_SECONDS = 10; // auto-close after 10s
const DISMISSED_AT_KEY = 'desktopAdDismissedAt';

const AD_SCRIPT_SRC = 'https://pl29613714.effectivecpmnetwork.com/17/20/30/17203020d60eedd6d22a91318044dbd4.js';

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
 * Sandbox permissions:
 *   allow-scripts              → ad script can execute
 *   allow-popups               → ad clicks can open popups
 *   allow-popups-to-escape-sandbox → popups open as full browser windows
 *
 * No allow-same-origin — the iframe cannot access the parent document.
 *
 * Dismissal works three ways:
 * 1. Click the X button
 * 2. Click anywhere outside the ad panel
 * 3. Wait 10 seconds for auto-close (pauses on hover)
 */
export function DesktopAdBanner() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS);
  const [isHovering, setIsHovering] = useState(false);
  const mountedRef = useRef(true);

  // ── Auto-focus the close button when the panel appears ──────────────
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [visible]);

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

  // ── Build sandboxed iframe srcdoc with the ad script ─────────────────
  const srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 300px; height: 250px; overflow: hidden;
      background: #1a1a2e;
      display: flex; align-items: center; justify-content: center;
    }
  </style>
</head>
<body>
  <script type="text/javascript" src="${AD_SCRIPT_SRC}" async></script>
</body>
</html>`;

  // ── Internal dismiss (shared by X button, outside click, and timer) ──
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

  // ── Document-level click listener (non-blocking dismiss on outside click)
  //    Uses capture phase so clicks reach the real app element underneath
  //    (file card, sidebar, etc.) — we just dismiss without interfering.
  useEffect(() => {
    if (!visible) return;

    const handleDocumentClick = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      handleDismissInternal();
    };

    document.addEventListener('click', handleDocumentClick, true);
    return () => document.removeEventListener('click', handleDocumentClick, true);
  }, [visible, handleDismissInternal]);

  if (!visible) return null;

  return (
    <>
      {/* Ad panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Sponsored advertisement — closes automatically after 10 seconds"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        className={`
          fixed bottom-20 right-5 z-[90]
          bg-telegram-surface border border-telegram-border/60
          rounded-xl shadow-2xl overflow-hidden
          transition-all duration-300 ease-out
          ${exiting ? 'opacity-0 scale-95 translate-y-2' : 'opacity-100 scale-100'}
        `}
      >
        {/* Visually-hidden close button for screen readers and keyboard users */}
        <button
          ref={closeButtonRef}
          onClick={handleDismissInternal}
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:right-2 focus:z-10 focus:p-1.5 focus:rounded-full focus:bg-black/70 focus:text-white hover:bg-black/90 focus:outline-none focus:ring-2 focus:ring-telegram-primary"
          aria-label="Close advertisement"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header bar with dismiss countdown text */}
        <div className="flex items-center justify-center px-4 py-2 bg-telegram-hover/30 border-b border-telegram-border/30 select-none">
          <span className="text-[11px] font-medium text-telegram-text/80">
            Click Ad to close now or wait <span className="font-bold text-telegram-primary tabular-nums">{countdown}</span> seconds!
          </span>
        </div>

        {/* Screen-reader countdown announcements */}
        <div aria-live="polite" className="sr-only">
          {countdown > 0
            ? `Advertisement closes in ${countdown} ${countdown === 1 ? 'second' : 'seconds'}`
            : 'Advertisement closed'}
        </div>

        {/* Sandboxed ad iframe — isolates external scripts from the main document */}
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          title="Advertisement"
          width={300}
          height={250}
          style={{ border: 'none', overflow: 'hidden' }}
          className="bg-telegram-bg/50"
        />
      </div>
    </>
  );
}
