import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileSupporterCard } from '../../src/components/mobile/MobileSupporterCard';

const { beginCheckoutMock, openUrlMock, pollCheckoutMock, supporter } = vi.hoisted(() => ({
  beginCheckoutMock: vi.fn(),
  openUrlMock: vi.fn(),
  pollCheckoutMock: vi.fn(),
  supporter: {
    status: {
      state: 'inactive',
      ad_free: false,
      message: 'No verified supporter activation is stored on this device.',
      terms_version: '2026-08-11',
      terms_url: 'https://support.example/terms',
      expires_at: null,
      offline_until: null,
      recovery_code_saved: false,
      checkout_pending: false,
    },
  },
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }));
vi.mock('../../src/context/SupporterContext', () => ({
  useSupporter: () => ({
    status: supporter.status,
    latestRecoveryCode: null,
    beginCheckout: beginCheckoutMock,
    pollCheckout: pollCheckoutMock,
    refreshStatus: vi.fn(),
    activate: vi.fn(),
    refreshEntitlement: vi.fn(),
  }),
}));

describe('MobileSupporterCard', () => {
  beforeEach(() => {
    beginCheckoutMock.mockReset();
    openUrlMock.mockReset();
    pollCheckoutMock.mockReset();
    pollCheckoutMock.mockResolvedValue({ status: 'pending', recovery_code: null, message: 'Waiting' });
    supporter.status = {
      state: 'inactive',
      ad_free: false,
      message: 'No verified supporter activation is stored on this device.',
      terms_version: '2026-08-11',
      terms_url: 'https://support.example/terms',
      expires_at: null,
      offline_until: null,
      recovery_code_saved: false,
      checkout_pending: false,
    };
  });

  it('starts only the verified in-app $5 checkout after terms are accepted', async () => {
    beginCheckoutMock.mockResolvedValue({ approval_url: 'https://paypal.example/approve', expires_at: 1_900_000_000 });
    render(<MobileSupporterCard />);

    const purchase = screen.getByRole('button', { name: /get lifetime ad-free/i });
    expect((purchase as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(purchase);

    await waitFor(() => expect(beginCheckoutMock).toHaveBeenCalledWith('2026-08-11'));
    expect(openUrlMock).toHaveBeenCalledWith('https://paypal.example/approve');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('shows an active lifetime license without another purchase prompt', () => {
    supporter.status = {
      ...supporter.status,
      state: 'active',
      ad_free: true,
      message: 'Verified ad-free supporter access is active.',
      recovery_code_saved: true,
    };
    render(<MobileSupporterCard />);

    expect(screen.getByText('Lifetime ad-free access is active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /get lifetime ad-free/i })).toBeNull();
  });

  it('shows the checkout state restored by the global supporter provider', async () => {
    supporter.status = { ...supporter.status, checkout_pending: true };
    render(<MobileSupporterCard />);

    expect(await screen.findByText('Waiting for PayPal confirmation')).toBeTruthy();
  });
});
