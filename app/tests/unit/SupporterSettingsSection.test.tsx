import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupporterSettingsSection } from '../../src/components/desktop/dashboard/settings/SettingsTabs';

const supporter = vi.hoisted(() => ({
  status: {
    state: 'inactive',
    ad_free: false,
    message: 'No verified supporter activation is stored on this device.',
    terms_version: '2026-08-11',
    terms_url: null,
    expires_at: null,
    offline_until: null,
    recovery_code_saved: false,
    checkout_pending: false,
  },
  latestRecoveryCode: null as string | null,
  beginCheckout: vi.fn(),
  pollCheckout: vi.fn(),
  activate: vi.fn(),
  refreshEntitlement: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('../../src/components/desktop/dashboard/ThemesTab', () => ({ ThemesTab: () => null }));
vi.mock('../../src/context/SupporterContext', () => ({
  useSupporter: () => supporter,
}));

afterEach(() => {
  cleanup();
  supporter.status = {
    state: 'inactive',
    ad_free: false,
    message: 'No verified supporter activation is stored on this device.',
    terms_version: '2026-08-11',
    terms_url: null,
    expires_at: null,
    offline_until: null,
    recovery_code_saved: false,
    checkout_pending: false,
  };
  supporter.latestRecoveryCode = null;
});

describe('SupporterSettingsSection', () => {
  it('shows the lifetime offer and comparison to a new unlicensed user', () => {
    render(<SupporterSettingsSection />);

    expect(screen.getByRole('heading', { name: 'Lifetime Ad-Free Supporter License' })).toBeTruthy();
    expect(screen.getByText('Free forever')).toBeTruthy();
    expect(screen.getByText('$5 lifetime supporter')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get lifetime ad-free · $5' })).toBeTruthy();
  });

  it('keeps an active purchaser out of the purchase flow', () => {
    supporter.status = {
      ...supporter.status,
      state: 'active',
      ad_free: true,
      message: 'Verified ad-free supporter access is active.',
      recovery_code_saved: true,
    };

    render(<SupporterSettingsSection />);

    expect(screen.getByText('Lifetime ad-free access is active')).toBeTruthy();
    expect(screen.getByText(/no reactivation or repeat payment is required/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get lifetime ad-free · $5' })).toBeNull();
    expect(screen.queryByText('Free forever')).toBeNull();
  });

  it('directs an expired purchaser to refresh or restore instead of paying again', () => {
    supporter.status = {
      ...supporter.status,
      state: 'expired',
      message: 'Supporter verification expired.',
      recovery_code_saved: true,
    };

    render(<SupporterSettingsSection />);

    expect(screen.getByText(/do not pay again/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh verification' })).toBeTruthy();
    expect(screen.getByText('Already supported? Restore with a recovery code')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get lifetime ad-free · $5' })).toBeNull();
  });

  it('resumes a pending checkout without offering another payment', () => {
    supporter.status = { ...supporter.status, checkout_pending: true };

    render(<SupporterSettingsSection />);

    expect(screen.getByText('Waiting for PayPal confirmation')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check payment' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get lifetime ad-free · $5' })).toBeNull();
  });
});
