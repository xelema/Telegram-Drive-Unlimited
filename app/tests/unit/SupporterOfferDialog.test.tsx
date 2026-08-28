import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SupporterOfferDialog } from '../../src/components/shared/SupporterOfferDialog';

const copy: Record<string, string> = {
  'supporter_offer.eyebrow': 'Support Telegram Drive',
  'supporter_offer.ad_dismissed_title': 'Tired of the ads? Pay $5 one time to stop seeing all ads!',
  'supporter_offer.upload_completed_title': 'Enjoying smooth uploads? Keep Telegram Drive ad-free',
  'supporter_offer.download_completed_title': 'Your download is ready—keep future transfers ad-free',
  'supporter_offer.close_label': 'Close supporter offer',
  'supporter_offer.price': '$5',
  'supporter_offer.price_suffix': 'USD once',
  'supporter_offer.description': 'One verified payment removes every sponsor ad for life—no subscription.',
  'supporter_offer.free_features': 'Every feature stays free whether you support or not.',
  'supporter_offer.benefit_lifetime': 'No sponsor ads for life',
  'supporter_offer.benefit_devices': 'Activate up to 3 supported devices',
  'supporter_offer.benefit_updates': 'Normal app updates stay activated',
  'supporter_offer.project_support': 'Support ongoing maintenance and development.',
  'supporter_offer.privacy_note': 'PayPal handles payment.',
  'supporter_offer.secondary_action': 'Not now',
  'supporter_offer.primary_action': 'See supporter details',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => copy[key] ?? key }),
}));
vi.mock('../../src/hooks/useModalFocus', () => ({ useModalFocus: () => undefined }));

describe('SupporterOfferDialog', () => {
  it('shows the requested ad-dismissal message and honest lifetime terms', () => {
    render(<SupporterOfferDialog trigger="ad_dismissed" onClose={() => {}} onOpenSupporter={() => {}} />);

    expect(screen.getByRole('heading', { name: 'Tired of the ads? Pay $5 one time to stop seeing all ads!' })).toBeTruthy();
    expect(screen.getByText('Every feature stays free whether you support or not.')).toBeTruthy();
    expect(screen.getByText('Activate up to 3 supported devices')).toBeTruthy();
    expect(screen.getByText(/no subscription/i)).toBeTruthy();
  });

  it('lets the user decline or open supporter details', () => {
    const onClose = vi.fn();
    const onOpenSupporter = vi.fn();
    render(<SupporterOfferDialog trigger="upload_completed" presentation="bottom-sheet" onClose={onClose} onOpenSupporter={onOpenSupporter} />);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'See supporter details' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenSupporter).toHaveBeenCalledOnce();
  });
});
