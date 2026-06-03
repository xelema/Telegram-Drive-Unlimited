import { useState, useCallback, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { ExternalLink, Loader2 } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { load } from '@tauri-apps/plugin-store';
import { usePlatform } from '../../hooks/usePlatform';

const SMARTLINK_URL = 'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40';
const GATEWAY_FLAG_KEY = 'ad_gateway_passed';

interface AdGatewayProps {
  onContinue: () => void;
}

/**
 * Interstitial ad gateway shown once after authentication.
 * Presents a SmartLink offerwall that opens in the external browser.
 * Once the user clicks or skips, a flag is persisted so future launches skip this screen.
 * A prominent skip button is immediately available for users who don't want to click the ad.
 */
export function AdGateway({ onContinue }: AdGatewayProps) {
  const [hasClicked, setHasClicked] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [skipCountdown, setSkipCountdown] = useState(5);
  const { isMobile } = usePlatform();
  const continueButtonRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the primary button so keyboard users can act immediately
  useEffect(() => {
    const id = setTimeout(() => continueButtonRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  // Persist the gateway flag so future launches skip this screen.
  // The flag check happens in App.tsx checkSession before this component mounts,
  // so returning users never see this screen at all.
  const markAsPassed = useCallback(async () => {
    try {
      const store = await load('config.json');
      await store.set(GATEWAY_FLAG_KEY, true);
      await store.save();
    } catch {
      // Non-critical — just means gateway shows again next time
    }
  }, []);

  const handleSmartLinkClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOpening(true);

    // Open the SmartLink in the device's external browser
    try {
      await open(SMARTLINK_URL);
    } catch {
      window.open(SMARTLINK_URL, '_blank');
    }

    // Mark as clicked, persist gateway flag, and flag for thank-you toast
    setHasClicked(true);
    await markAsPassed();
    try {
      const store = await load('config.json');
      await store.set('ad_click_thanks', true);
      await store.save();
    } catch {
      // Non-critical
    }

    // Don't auto-advance — user must explicitly click "Return to App"
    setIsOpening(false);
  }, [markAsPassed]);

  const handleSkip = useCallback(async () => {
    await markAsPassed();
    onContinue();
  }, [markAsPassed, onContinue]);

  // 5-second countdown before Skip button becomes available
  // Stops early if the user clicks the ad (since Skip button is hidden anyway)
  useEffect(() => {
    if (skipCountdown <= 0 || hasClicked) return;
    const timer = setTimeout(() => {
      setSkipCountdown(prev => prev - 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [skipCountdown, hasClicked]);

  return (
    <div
      role="dialog"
      aria-label="Welcome — tap the sponsored link to continue, or skip to your files"
      className="h-full w-full auth-gradient flex items-center justify-center p-6 pt-[calc(1.5rem+env(safe-area-inset-top,24px))] relative overflow-hidden">
      {/* Background glow effects */}
      <div className="fixed top-[-20%] left-[-10%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px] pointer-events-none -z-10" />
      <div className="fixed bottom-[-10%] right-[-10%] w-[400px] h-[400px] bg-purple-600/10 rounded-full blur-[100px] pointer-events-none -z-10" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className={`auth-glass rounded-3xl shadow-2xl w-full max-w-md text-center ${isMobile ? 'p-5' : 'p-8'}`}
      >
        {/* Logo */}
        <div className={`mx-auto flex items-center justify-center ${isMobile ? 'mb-4' : 'mb-6'}`}>
          <img src="/logo.svg" className={`drop-shadow-lg ${isMobile ? 'w-16 h-16' : 'w-20 h-20'}`} alt="Telegram Drive Logo" />
        </div>

        {/* Title */}
        <h1 className={`font-bold text-white mb-2 tracking-tight ${isMobile ? 'text-lg' : 'text-2xl'}`}>
          Welcome to Telegram Drive
        </h1>
        <p className="text-sm text-white/60 font-medium mb-8">
          Tap below to continue to your files
        </p>

        {/* SmartLink button — opens the ad in the external browser */}
        <button
          ref={continueButtonRef}
          onClick={handleSmartLinkClick}
          disabled={hasClicked}
          className={`w-full rounded-2xl font-bold flex items-center justify-center gap-2.5 transition-all duration-300 ${isMobile ? 'py-3.5 text-sm' : 'py-5 text-base'} ${
            hasClicked
              ? 'bg-white/5 text-white/30 border border-white/10 cursor-default'
              : 'bg-gradient-to-r from-telegram-primary to-blue-500 text-black hover:shadow-xl hover:shadow-blue-500/30 active:scale-[0.98]'
          }`}
        >
          {isOpening ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Opening...
            </>
          ) : hasClicked ? (
            <>
              <ExternalLink className="w-5 h-5" />
              Ad Opened ✓
            </>
          ) : (
            <>
              <ExternalLink className="w-5 h-5" />
              Click to Continue
            </>
          )}
        </button>

        {/* Return to App button — appears after the ad is clicked */}
        {hasClicked && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            onClick={onContinue}
            className={`mt-3 w-full rounded-2xl font-bold flex items-center justify-center gap-2 transition-all duration-300 ${isMobile ? 'py-3.5 text-sm' : 'py-5 text-base'} bg-gradient-to-r from-green-500 to-emerald-600 text-white hover:shadow-xl hover:shadow-green-500/30 active:scale-[0.98]`}
          >
            Return to App
          </motion.button>
        )}

        <p className="text-[11px] text-white/30 mt-5 leading-relaxed">
          This helps support development and keeps Telegram Drive free.
          You'll only see this once.
        </p>

        {/* Screen-reader countdown announcements */}
        <div aria-live="polite" className="sr-only">
          {skipCountdown > 0
            ? `Skip available in ${skipCountdown} ${skipCountdown === 1 ? 'second' : 'seconds'}`
            : 'Skip now available'}
        </div>

        {/* Skip button — only shown before the ad is clicked, with a 5-second delay */}
        {!hasClicked && (
        <button
          onClick={handleSkip}
          disabled={skipCountdown > 0}
          className="mt-4 w-full py-2.5 rounded-xl text-sm font-semibold text-white/60 hover:text-white hover:bg-white/10 border border-white/10 hover:border-white/20 active:scale-[0.98] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-white/60 disabled:hover:bg-transparent disabled:hover:border-white/10 disabled:active:scale-100"
        >
          {skipCountdown > 0 ? `Skip in ${skipCountdown}s` : 'Skip & Continue to Files'}
        </button>
        )}
      </motion.div>
    </div>
  );
}
