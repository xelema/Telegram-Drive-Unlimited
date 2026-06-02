import { useState, useEffect, useRef, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-shell';

const AD_INTERVAL_MS = 1000 * 60 * 45; // 45 minutes
const AUTO_DISMISS_SECONDS = 10; // auto-close after 10s
const DISMISSED_AT_KEY = 'desktopAdDismissedAt';

const AD_SCRIPT_SRC = 'https://pl29613714.effectivecpmnetwork.com/17/20/30/17203020d60eedd6d22a91318044dbd4.js';

/**
 * Periodic ad banner for the desktop dashboard (every 45 minutes).
 *
 * Displays a 300×250 inline ad in a floating panel. Three ways to dismiss:
 * 1. Click the X button
 * 2. Click anywhere outside the ad panel (non-blocking — clicks pass through)
 * 3. Wait 10 seconds for auto-close (pauses on hover)
 * Dismissal timing is persisted to localStorage so the timer survives reloads.
 *
 * Anchor tags inside the ad are intercepted so clicks open in the system
 * browser via Tauri's shell plugin rather than failing silently in the webview.
 */
export function DesktopAdBanner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS);
  const [isHovering, setIsHovering] = useState(false);
  const scriptInjected = useRef(false);
  const initialCheckDone = useRef(false);

  // ── Check whether enough time has passed since last dismissal ──────────
  useEffect(() => {
    const check = () => {
      if (!initialCheckDone.current) {
        initialCheckDone.current = true;
        setVisible(true);
        return;
      }
      try {
        const raw = localStorage.getItem(DISMISSED_AT_KEY);
        if (!raw) {
          setVisible(true);
          return;
        }
        const dismissedAt = parseInt(raw, 10);
        if (isNaN(dismissedAt)) {
          setVisible(true);
          return;
        }
        const elapsed = Date.now() - dismissedAt;
        if (elapsed >= AD_INTERVAL_MS) {
          // Interval has passed — show again and clear the stored timestamp
          localStorage.removeItem(DISMISSED_AT_KEY);
          setVisible(true);
        }
      } catch {
        setVisible(true);
      }
    };

    check();

    // Re-check periodically (every 30s) only while the banner is hidden,
    // waiting for the interval to elapse.
    let interval: ReturnType<typeof setInterval> | undefined;
    if (!visible) {
      interval = setInterval(check, 30_000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [visible]);

  // ── Intercept clicks on ad links so they open in the system browser ────
  //    Tauri's webview does not navigate target="_blank" links from cross-
  //    origin iframes; this handler catches anchor clicks (both inline and
  //    inside any iframes the ad network may still inject) and opens them
  //    via the shell plugin.
  useEffect(() => {
    if (!visible || !containerRef.current) return;
    const container = containerRef.current;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('javascript:')) return;

      e.preventDefault();
      e.stopPropagation();
      open(href).catch(() => {
        // Fallback for environments where the shell plugin isn't available
        window.open(href, '_blank');
      });
    };

    // Capture phase so we catch events before the ad's own scripts handle them
    container.addEventListener('click', handleClick, true);

    return () => {
      container.removeEventListener('click', handleClick, true);
    };
  }, [visible]);

  // ── Watch for iframes injected by the ad network & try to forward clicks ──
  //    Even with format:'inline', some ad networks wrap content in an iframe.
  //    Clicks inside a cross-origin iframe never reach the parent, so we try to
  //    access each injected iframe's document (same-origin) and install the same
  //    click→shell.open interception. If the iframe is cross-origin, this
  //    silently fails — the inline click handler above is the primary fix.
  useEffect(() => {
    if (!visible || !containerRef.current) return;
    const container = containerRef.current;
    const hookedIframes = new WeakSet<HTMLIFrameElement>();

    const hookIframe = (iframe: HTMLIFrameElement) => {
      if (hookedIframes.has(iframe)) return;
      hookedIframes.add(iframe);

      const tryHook = () => {
        try {
          const doc = iframe.contentDocument;
          if (!doc) return;

          doc.addEventListener('click', (e: Event) => {
            const target = e.target as HTMLElement;
            const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
            if (!anchor) return;
            const href = anchor.getAttribute('href');
            if (!href || href.startsWith('javascript:')) return;

            e.preventDefault();
            e.stopPropagation();
            open(href).catch(() => window.open(href, '_blank'));
          }, true);
        } catch {
          // Cross-origin iframe — contentDocument is inaccessible, which is
          // expected. The inline click handler + format:'inline' handle it.
        }
      };

      // Try immediately (for srcdoc / inline iframes)
      tryHook();
      // Also try on load (for src-based iframes that are still loading)
      iframe.addEventListener('load', tryHook, { once: true });
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLIFrameElement) {
            hookIframe(node);
          } else if (node instanceof HTMLElement) {
            node.querySelectorAll('iframe').forEach(hookIframe);
          }
        }
      }
    });

    // Also hook any iframes already present (e.g. from a previous injection)
    container.querySelectorAll('iframe').forEach(hookIframe);

    observer.observe(container, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [visible]);

  // ── Internal dismiss (shared by X button, backdrop click, and timer) ──
  const handleDismissInternal = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      scriptInjected.current = false;
    }
    try {
      localStorage.setItem(DISMISSED_AT_KEY, Date.now().toString());
    } catch { /* non-critical */ }
    setExiting(true);
    setCountdown(0); // stop the timer
    setTimeout(() => {
      setVisible(false);
      setExiting(false);
    }, 300);
  }, []);

  // ── Auto-dismiss after 10 seconds ───────────────────────────────────────
  useEffect(() => {
    if (!visible) {
      setCountdown(AUTO_DISMISS_SECONDS);
      return;
    }
    if (countdown <= 0) {
      if (!exiting) handleDismissInternal();
      return;
    }
    // Pause countdown while the user's mouse is hovering over the ad panel
    if (isHovering) return;
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [visible, countdown, exiting, isHovering, handleDismissInternal]);

  // ── Detect clicks on cross-origin iframe ads using window blur ──────────
  useEffect(() => {
    if (!visible) return;
    const handleBlur = () => {
      // Focus shifted away from the window — check if activeElement is an iframe (ad click)
      setTimeout(() => {
        if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
          handleDismissInternal();
        }
      }, 100);
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [visible, handleDismissInternal]);

  // ── Inject script elements when the container is mounted and visible ──
  useEffect(() => {
    if (!visible || !containerRef.current || scriptInjected.current) return;

    const container = containerRef.current;
    container.innerHTML = '';

    const externalScript = document.createElement('script');
    externalScript.type = 'text/javascript';
    externalScript.src = AD_SCRIPT_SRC;
    externalScript.async = true;
    container.appendChild(externalScript);

    scriptInjected.current = true;

    return () => {
      scriptInjected.current = false;
    };
  }, [visible]);



  // ── Document-level click listener (non-blocking dismiss on outside click)
  //    Uses capture phase so we can catch the click before ad scripts handle
  //    it, but does NOT preventDefault/stopPropagation — the click still
  //    reaches the real app element underneath (file card, sidebar, etc.).
  useEffect(() => {
    if (!visible) return;

    const handleDocumentClick = (e: MouseEvent) => {
      // Ignore clicks inside the ad panel itself
      if (panelRef.current?.contains(e.target as Node)) return;
      // Click was outside — dismiss the ad without interfering
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
        {/* Header bar with dismiss countdown text */}
        <div className="flex items-center justify-center px-4 py-2 bg-telegram-hover/30 border-b border-telegram-border/30 select-none">
          <span className="text-[11px] font-medium text-telegram-text/80">
            Click Ad to close now or wait <span className="font-bold text-telegram-primary tabular-nums">{countdown}</span> seconds!
          </span>
        </div>

        {/* Ad container — the script injects the ad content here */}
        <div
          ref={containerRef}
          style={{ width: 300, height: 250 }}
          className="bg-telegram-bg/50 flex items-center justify-center"
        />
      </div>
    </>
  );
}
