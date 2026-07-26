import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, ExternalLink, Loader2 } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { load } from '@tauri-apps/plugin-store';
import { usePlatform } from '../../hooks/usePlatform';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

const SMARTLINK_URL = 'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40';
const GATEWAY_FLAG_KEY = 'ad_gateway_passed';

interface AdGatewayProps {
  onContinue: () => void;
}

export function AdGateway({ onContinue }: AdGatewayProps) {
  const { t } = useTranslation();
  const [hasClicked, setHasClicked] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [skipCountdown, setSkipCountdown] = useState(5);
  const { isMobile } = usePlatform();
  const sponsorButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const id = setTimeout(() => sponsorButtonRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  const markAsPassed = useCallback(async () => {
    try {
      const store = await load('config.json');
      await store.set(GATEWAY_FLAG_KEY, true);
      await store.save();
    } catch {
      // Persistence is best-effort; the gateway may be shown again next launch.
    }
  }, []);

  const handleSmartLinkClick = async () => {
    setIsOpening(true);
    setHasClicked(true);
    await markAsPassed();
    try {
      await open(SMARTLINK_URL);
      toast.success(t('ads.sponsored'), { duration: 3000 });
    } catch {
      window.open(SMARTLINK_URL, '_blank', 'noopener,noreferrer');
    } finally {
      setIsOpening(false);
    }
  };

  const handleSkip = async () => {
    if (skipCountdown <= 0) {
      await markAsPassed();
      onContinue();
    }
  };

  useEffect(() => {
    if (hasClicked || skipCountdown <= 0) return;
    const timer = setTimeout(() => setSkipCountdown((previous) => previous - 1), 1000);
    return () => clearTimeout(timer);
  }, [skipCountdown, hasClicked]);

  return (
    <div
      role="dialog"
      aria-label={t('ads.sponsor_message')}
      className="auth-gradient relative flex h-full w-full items-center justify-center overflow-hidden p-6 pt-[calc(1.5rem+env(safe-area-inset-top,24px))]"
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className={`auth-glass w-full max-w-md rounded-overlay ${isMobile ? 'p-5' : 'p-8'}`}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <span className="sponsored-label">
              {t('ads.sponsored')}
            </span>
            <h1 className="mt-4 text-balance text-app-title font-semibold tracking-[-0.01em] text-app-text">
              {t('ads.sponsor_message')}
            </h1>
            <p className="mt-2 text-ui leading-relaxed text-app-text-secondary">
              {t('ads.sponsor_support_desc')}
            </p>
          </div>
          <img src="/logo.svg" className="h-11 w-11 shrink-0" alt="Telegram Drive" />
        </div>

        <button
          ref={sponsorButtonRef}
          onClick={handleSmartLinkClick}
          disabled={hasClicked}
          className={`quiet-control toolbar-upload-action flex w-full items-center justify-center gap-2 border border-transparent px-4 text-ui font-semibold text-app-accent-contrast disabled:opacity-55 ${isMobile ? 'h-11' : 'h-9'}`}
        >
          {isOpening ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          {isOpening ? t('common.loading') : hasClicked ? t('ads.sponsored') : t('ads.sponsored')}
        </button>

        {hasClicked ? (
          <motion.button
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={onContinue}
            className={`quiet-control mt-3 flex w-full items-center justify-center gap-2 border border-app-border bg-app-surface-raised px-4 text-ui font-semibold text-app-text ${isMobile ? 'h-11' : 'h-9'}`}
          >
            {t('ads.continue_to_files')} <ArrowRight className="h-4 w-4 rtl:rotate-180" />
          </motion.button>
        ) : (
          <button
            onClick={handleSkip}
            disabled={skipCountdown > 0}
            className={`quiet-control mt-3 w-full border border-transparent text-ui font-medium text-app-text-secondary hover:text-app-text disabled:opacity-45 ${isMobile ? 'h-11' : 'h-8'}`}
          >
            {skipCountdown > 0 ? `${t('ads.continue_to_files')} (${skipCountdown}s)` : t('ads.continue_to_files')}
          </button>
        )}

        <p className="mt-5 text-metadata leading-relaxed text-app-text-tertiary">
          {t('ads.browser_note')}
        </p>
      </motion.div>
    </div>
  );
}
