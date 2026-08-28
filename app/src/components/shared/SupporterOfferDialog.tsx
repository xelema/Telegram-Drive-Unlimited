import { useRef } from 'react';
import { ArrowRight, CheckCircle2, Heart, MegaphoneOff, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModalFocus } from '../../hooks/useModalFocus';
import type { SupporterPromptTrigger } from '../../services/supporterVisibility';

interface SupporterOfferDialogProps {
  trigger: SupporterPromptTrigger;
  presentation?: 'dialog' | 'bottom-sheet' | 'tv-dialog';
  onClose: () => void;
  onOpenSupporter: () => void;
}

export function SupporterOfferDialog({
  trigger,
  presentation = 'dialog',
  onClose,
  onOpenSupporter,
}: SupporterOfferDialogProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);

  const isBottomSheet = presentation === 'bottom-sheet';
  const titleKey = trigger === 'ad_dismissed'
    ? 'supporter_offer.ad_dismissed_title'
    : trigger === 'upload_completed'
      ? 'supporter_offer.upload_completed_title'
      : 'supporter_offer.download_completed_title';

  return (
    <div className={`fixed inset-0 z-[260] flex bg-app-overlay p-4 backdrop-blur-sm ${isBottomSheet ? 'items-end justify-center sm:items-center' : 'items-center justify-center'}`}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="supporter-offer-title"
        tabIndex={-1}
        className={`quiet-raised w-[min(560px,calc(100vw-2rem))] overflow-hidden motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200 ${isBottomSheet ? 'rounded-b-none sm:rounded-container' : ''}`}
      >
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4">
          <span className="text-xs font-semibold uppercase tracking-wider text-app-accent">
            {t('supporter_offer.eyebrow')}
          </span>
          <button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary hover:text-app-text" aria-label={t('supporter_offer.close_label')}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="p-6 text-center">
          <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-container bg-app-selected text-app-accent">
            <Heart className="h-8 w-8" aria-hidden="true" />
            <span className="absolute -bottom-1 -end-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-app-surface-raised bg-app-success text-white">
              <MegaphoneOff className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </div>

          <h2 id="supporter-offer-title" className="mt-5 text-xl font-semibold text-app-text">
            {t(titleKey)}
          </h2>
          <div className="mt-3 text-3xl font-semibold tracking-tight text-app-text">
            {t('supporter_offer.price')}{' '}
            <span className="text-sm font-medium text-app-text-secondary">{t('supporter_offer.price_suffix')}</span>
          </div>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-app-text-secondary">
            {t('supporter_offer.description')}
          </p>
          <p className="mt-1 text-xs font-medium text-app-text">{t('supporter_offer.free_features')}</p>

          <div className="mx-auto mt-5 grid max-w-lg gap-2 text-start text-xs leading-5 text-app-text-secondary sm:grid-cols-3">
            {([
              'supporter_offer.benefit_lifetime',
              'supporter_offer.benefit_devices',
              'supporter_offer.benefit_updates',
            ] as const).map(key => (
              <span key={key} className="flex items-start gap-2 rounded-lg bg-app-surface-sunken/35 p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-app-success" aria-hidden="true" />
                {t(key)}
              </span>
            ))}
          </div>

          <p className="mx-auto mt-4 max-w-md text-xs leading-5 text-app-text-secondary">
            {t('supporter_offer.project_support')}
          </p>
          <p className="mx-auto mt-2 max-w-md text-[11px] leading-5 text-app-text-tertiary">
            {t('supporter_offer.privacy_note')}
          </p>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-app-border-subtle px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" onClick={onClose} className="quiet-control px-4 py-2.5 text-sm font-medium text-app-text-secondary">
            {t('supporter_offer.secondary_action')}
          </button>
          <button type="button" data-modal-autofocus onClick={onOpenSupporter} className="quiet-control flex items-center justify-center gap-2 bg-app-accent px-5 py-3 text-sm font-semibold text-app-accent-contrast">
            {t('supporter_offer.primary_action')}
            <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          </button>
        </footer>
      </div>
    </div>
  );
}
