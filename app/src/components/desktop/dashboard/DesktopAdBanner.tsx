import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';

const HOUR_MS = 1000 * 60 * 60;
const DISMISSED_AT_KEY = 'desktopAdDismissedAt';

const AD_SCRIPT_SRC = 'https://www.highperformanceformat.com/9cf449272b7e1c83054b82b7639c6029/invoke.js';
const AD_SCRIPT_INLINE = `
  atOptions = {
    'key' : '9cf449272b7e1c83054b82b7639c6029',
    'format' : 'iframe',
    'height' : 250,
    'width' : 300,
    'params' : {}
  };
`;

/**
 * Hourly ad banner for the desktop dashboard.
 *
 * Displays a 300×250 iframe ad in a floating panel. The user can dismiss it;
 * after 1 hour it reappears automatically. Dismissal timing is persisted to
 * localStorage so the timer survives page reloads.
 */
export function DesktopAdBanner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const scriptInjected = useRef(false);

  // ── Check whether enough time has passed since last dismissal ──────────
  useEffect(() => {
    const check = () => {
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
        if (elapsed >= HOUR_MS) {
          // Hour has passed — show again and clear the stored timestamp
          localStorage.removeItem(DISMISSED_AT_KEY);
          setVisible(true);
        }
      } catch {
        setVisible(true);
      }
    };

    check();

    // Re-check periodically (every 30s) only while the banner is hidden,
    // waiting for the hour to elapse.
    let interval: ReturnType<typeof setInterval> | undefined;
    if (!visible) {
      interval = setInterval(check, 30_000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [visible]);

  // ── Inject script elements when the container is mounted and visible ──
  useEffect(() => {
    if (!visible || !containerRef.current || scriptInjected.current) return;

    const container = containerRef.current;
    // Clear any previous content
    container.innerHTML = '';

    // 1. Inline config script
    const inlineScript = document.createElement('script');
    inlineScript.type = 'text/javascript';
    inlineScript.textContent = AD_SCRIPT_INLINE;
    container.appendChild(inlineScript);

    // 2. External invoke script
    const externalScript = document.createElement('script');
    externalScript.type = 'text/javascript';
    externalScript.src = AD_SCRIPT_SRC;
    externalScript.async = true;
    container.appendChild(externalScript);

    scriptInjected.current = true;

    return () => {
      // Cleanup on visibility toggle – reset for next re-injection
      scriptInjected.current = false;
    };
  }, [visible]);

  // ── Dismiss handler ────────────────────────────────────────────────────
  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Immediately clear the ad iframe to stop any running resources
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      scriptInjected.current = false;
    }
    try {
      localStorage.setItem(DISMISSED_AT_KEY, Date.now().toString());
    } catch { /* non-critical */ }
    setExiting(true);
    setTimeout(() => {
      setVisible(false);
      setExiting(false);
    }, 300);
  }, []);

  if (!visible) return null;

  return (
    <div
      className={`
        fixed bottom-20 right-5 z-[90]
        bg-telegram-surface border border-telegram-border/60
        rounded-xl shadow-2xl overflow-hidden
        transition-all duration-300 ease-out
        ${exiting ? 'opacity-0 scale-95 translate-y-2' : 'opacity-100 scale-100'}
      `}
    >
      {/* Header bar with dismiss button */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-telegram-hover/30 border-b border-telegram-border/30">
        <span className="text-[10px] font-semibold text-telegram-subtext/70 uppercase tracking-wider">
          Sponsored
        </span>
        <button
          onClick={handleDismiss}
          className="p-1 rounded-md text-telegram-subtext/50 hover:text-telegram-text hover:bg-telegram-hover/50 transition"
          aria-label="Dismiss ad"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Ad container — the script injects the iframe here */}
      <div
        ref={containerRef}
        style={{ width: 300, height: 250 }}
        className="bg-telegram-bg/50 flex items-center justify-center"
      />
    </div>
  );
}
