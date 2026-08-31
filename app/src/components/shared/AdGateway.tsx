import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ExternalLink, Loader2 } from 'lucide-react';
import { load } from '@tauri-apps/plugin-store';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePlatform } from '../../hooks/usePlatform';
import { openSponsorLink } from '../../services/sponsorLinks';

export const AD_GATEWAY_PASSED_KEY = 'ad_gateway_passed';
const AD_CLICK_THANKS_KEY = 'ad_click_thanks';

interface AdGatewayProps {
  onContinue: () => void;
}

/**
 * One-time post-authentication sponsor choice for non-supporters.
 *
 * The sponsor action is optional and opens Adsterra's Smartlink only after a
 * real user click. Continuing to the app is always available immediately.
 */
export function AdGateway({ onContinue }: AdGatewayProps) {
  const { t } = useTranslation();
  const { isMobile } = usePlatform();
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => continueButtonRef.current?.focus(), 50);
    return () => window.clearTimeout(focusTimer);
  }, []);

  const persistChoice = useCallback(async (thankUser: boolean) => {
    try {
      const store = await load('config.json');
      await store.set(AD_GATEWAY_PASSED_KEY, true);
      if (thankUser) await store.set(AD_CLICK_THANKS_KEY, true);
      await store.save();
    } catch {
      // Persistence is best-effort. The user can always continue to the app.
    }
  }, []);

  const handleSponsor = useCallback(async () => {
    if (isOpening || hasOpened) return;
    setIsOpening(true);
    const opened = await openSponsorLink('first_ad_gateway');
    setIsOpening(false);

    if (!opened) {
      toast.error(t('common.operation_failed'));
      return;
    }

    setHasOpened(true);
    await persistChoice(true);
  }, [hasOpened, isOpening, persistChoice, t]);

  const handleContinue = useCallback(async () => {
    await persistChoice(false);
    onContinue();
  }, [onContinue, persistChoice]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('ads.sponsor_message')}
      className="auth-gradient relative flex h-full w-full items-center justify-center overflow-hidden p-6 pt-[calc(1.5rem+env(safe-area-inset-top,24px))]"
    >
      <section className={`auth-glass w-full max-w-md rounded-overlay ${isMobile ? 'p-5' : 'p-8'}`}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <span className="sponsored-label">{t('ads.sponsored')}</span>
            <h1 className="mt-4 text-balance text-app-title font-semibold tracking-[-0.01em] text-app-text">
              {t('ads.sponsor_message')}
            </h1>
            <p className="mt-2 text-ui leading-relaxed text-app-text-secondary">
              {t('ads.browser_note')}
            </p>
          </div>
          <img src="/logo.svg" className="h-11 w-11 shrink-0" alt={t('common.app_title')} />
        </div>

        <button
          type="button"
          onClick={() => void handleSponsor()}
          disabled={isOpening || hasOpened}
          className={`quiet-control toolbar-upload-action flex w-full items-center justify-center gap-2 border border-transparent px-4 text-ui font-semibold text-app-accent-contrast disabled:opacity-55 ${isMobile ? 'h-11' : 'h-9'}`}
          aria-label={`${t('ads.sponsored')} — ${t('ads.browser_note')}`}
        >
          {isOpening ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ExternalLink className="h-4 w-4" aria-hidden="true" />}
          {isOpening ? t('common.loading') : t('ads.sponsored')}
        </button>

        <button
          ref={continueButtonRef}
          type="button"
          onClick={() => void handleContinue()}
          className={`quiet-control mt-3 flex w-full items-center justify-center gap-2 border border-app-border bg-app-surface-raised px-4 text-ui font-semibold text-app-text ${isMobile ? 'h-11' : 'h-9'}`}
        >
          {t('ads.continue_to_files')} <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        </button>
      </section>
    </div>
  );
}
