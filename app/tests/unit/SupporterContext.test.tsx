import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupporterProvider, useSupporter, type SupporterStatus } from '../../src/context/SupporterContext';
import { shouldShowSponsorContent } from '../../src/services/supporterVisibility';

afterEach(() => vi.useRealTimers());

const { invokeMock, platformType } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  platformType: { current: 'android' },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => platformType.current }));

const pendingStatus: SupporterStatus = {
  state: 'inactive',
  ad_free: false,
  message: 'Waiting for PayPal confirmation.',
  terms_version: '2026-08-11',
  terms_url: null,
  expires_at: null,
  offline_until: null,
  recovery_code_saved: false,
  checkout_pending: true,
};

function StatusProbe() {
  const { status, latestRecoveryCode, refreshStatus, refreshEntitlement, activate, pollCheckout } = useSupporter();
  return <><div>{status.state}:{status.checkout_pending ? 'pending' : 'settled'}:{latestRecoveryCode ?? 'none'}</div>
    <span>{status.ad_free ? 'ad-free' : 'ads-eligible'}</span>
    <span>{shouldShowSponsorContent(status) ? 'sponsor-visible' : 'sponsor-hidden'}</span>
    <button onClick={() => void refreshStatus()}>Read status</button>
    <button onClick={() => void refreshEntitlement().catch(() => undefined)}>Renew</button>
    <button onClick={() => void activate('existing-recovery-code', status.terms_version)}>Restore</button>
    <button onClick={() => void pollCheckout()}>Poll</button>
  </>;
}

describe('SupporterProvider Android checkout recovery', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    platformType.current = 'android';
  });

  it('polls a pending checkout restored during application startup', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_supporter_status') return Promise.resolve(pendingStatus);
      if (command === 'cmd_poll_supporter_checkout') {
        return Promise.resolve({ status: 'pending', recovery_code: null, message: 'Waiting' });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(<SupporterProvider><StatusProbe /></SupporterProvider>);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cmd_poll_supporter_checkout'));
    expect(screen.getByText('inactive:pending:none')).toBeTruthy();
  });

  it('retains a recovery code when automatic verification completes', async () => {
    let statusReads = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_supporter_status') {
        statusReads += 1;
        return Promise.resolve(statusReads === 1 ? pendingStatus : {
          ...pendingStatus,
          state: 'active',
          ad_free: true,
          checkout_pending: false,
        });
      }
      if (command === 'cmd_poll_supporter_checkout') {
        return Promise.resolve({ status: 'completed', recovery_code: 'RECOVERY-CODE', message: 'Verified' });
      }
      if (command === 'cmd_refresh_supporter') return Promise.resolve(pendingStatus);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(<SupporterProvider><StatusProbe /></SupporterProvider>);

    expect(await screen.findByText('active:settled:RECOVERY-CODE')).toBeTruthy();
  });

  it('also resumes a pending checkout on desktop', async () => {
    platformType.current = 'macos';
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_supporter_status') return Promise.resolve(pendingStatus);
      if (command === 'cmd_poll_supporter_checkout') {
        return Promise.resolve({ status: 'pending', recovery_code: null, message: 'Waiting' });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(<SupporterProvider><StatusProbe /></SupporterProvider>);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cmd_poll_supporter_checkout'));
    expect(screen.getByText('inactive:pending:none')).toBeTruthy();
  });
});


const licensed = (state: SupporterStatus['state']): SupporterStatus => ({
  ...pendingStatus, state, ad_free: state === 'active' || state === 'needs_refresh',
  checkout_pending: false, recovery_code_saved: true,
  expires_at: Date.now() / 1000 + (state === 'active' ? 3600 : -1),
  offline_until: Date.now() / 1000 + (state === 'expired' ? -1 : 3600),
});

describe('SupporterProvider lifetime renewal safeguards', () => {
  beforeEach(() => { invokeMock.mockReset(); platformType.current = 'macos'; });

  it('automatically refreshes an expired existing purchaser at startup', async () => {
    invokeMock.mockImplementation((command: string) => Promise.resolve(command === 'cmd_get_supporter_status' ? licensed('expired') : licensed('active')));
    render(<SupporterProvider><StatusProbe /></SupporterProvider>);
    expect(await screen.findByText('active:settled:none')).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith('cmd_refresh_supporter');
    expect(invokeMock).not.toHaveBeenCalledWith('cmd_begin_supporter_checkout', expect.anything());
  });

  it.each(['android', 'macos', 'windows', 'linux'])('keeps startup sponsors hidden through bounded transient native reads on %s', async platform => {
    vi.useFakeTimers();
    platformType.current = platform;
    let reads = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_supporter_status' && reads++ < 2) return Promise.reject(new Error('Credential storage starting'));
      return Promise.resolve(licensed('active'));
    });
    render(<SupporterProvider><StatusProbe /></SupporterProvider>);
    await act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(0); });
    expect(reads).toBe(1);
    expect(screen.getByText('loading:settled:none')).toBeTruthy();
    expect(screen.getByText('sponsor-hidden')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(reads).toBe(2);
    expect(screen.getByText('loading:settled:none')).toBeTruthy();
    expect(screen.getByText('sponsor-hidden')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(reads).toBe(3);
    expect(screen.getByText('active:settled:none')).toBeTruthy();
    expect(screen.getByText('ad-free')).toBeTruthy();
    expect(screen.getByText('sponsor-hidden')).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith('cmd_begin_supporter_checkout', expect.anything());
  });

  it.each(['android', 'macos'])('uses the existing unavailable fallback after exactly three cold read failures on %s', async platform => {
    vi.useFakeTimers();
    platformType.current = platform;
    invokeMock.mockRejectedValue(new Error('Credential storage unavailable'));
    render(<SupporterProvider><StatusProbe /></SupporterProvider>);
    await act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('loading:settled:none')).toBeTruthy();
    expect(screen.getByText('sponsor-hidden')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText('loading:settled:none')).toBeTruthy();
    expect(screen.getByText('sponsor-hidden')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(screen.getByText('unavailable:settled:none')).toBeTruthy();
    expect(screen.getByText('sponsor-visible')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
    expect(invokeMock.mock.calls.filter(([command]) => command === 'cmd_get_supporter_status')).toHaveLength(3);
    expect(invokeMock).not.toHaveBeenCalledWith('cmd_refresh_supporter');
    expect(invokeMock).not.toHaveBeenCalledWith('cmd_begin_supporter_checkout', expect.anything());
  });

  it('coalesces manual renewal with startup and ignores its result after newer activation', async () => {
    let resolveRenewal!: (status: SupporterStatus) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_supporter_status') return Promise.resolve(licensed('expired'));
      if (command === 'cmd_refresh_supporter') return new Promise(resolve => { resolveRenewal = resolve; });
      if (command === 'cmd_activate_supporter') return Promise.resolve(licensed('active'));
      throw new Error(command);
    });
    render(<SupporterProvider><StatusProbe /></SupporterProvider>);
    await waitFor(() => expect(resolveRenewal).toBeDefined());
    fireEvent.click(screen.getByText('Renew'));
    expect(invokeMock.mock.calls.filter(([command]) => command === 'cmd_refresh_supporter')).toHaveLength(1);
    fireEvent.click(screen.getByText('Restore'));
    expect(await screen.findByText('active:settled:none')).toBeTruthy();
    await act(async () => { resolveRenewal(licensed('revoked')); });
    expect(screen.getByText('active:settled:none')).toBeTruthy();
    expect(screen.getByText('ad-free')).toBeTruthy();
  });

  it('keeps verified offline-grace ad suppression through transport and local-read failures', async () => {
    let reads = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_supporter_status' && reads++ === 0) return Promise.resolve(licensed('needs_refresh'));
      return Promise.reject(new Error('temporarily unavailable'));
    });
    render(<SupporterProvider><StatusProbe /></SupporterProvider>);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cmd_refresh_supporter'));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(screen.getByText('needs_refresh:settled:none')).toBeTruthy();
    expect(screen.getByText('ad-free')).toBeTruthy();
  });

  it('coalesces manual payment checks with automatic recovery and retains incomplete receipts', async () => {
    let finish!: (result: unknown) => void;
    const pendingReceipt = { ...licensed('active'), checkout_pending: true };
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_supporter_status' || command === 'cmd_refresh_supporter') return Promise.resolve(pendingReceipt);
      if (command === 'cmd_poll_supporter_checkout') return new Promise(resolve => { finish = resolve; });
      throw new Error(command);
    });
    render(<SupporterProvider><StatusProbe /></SupporterProvider>);
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByText('Poll'));
    expect(invokeMock.mock.calls.filter(([command]) => command === 'cmd_poll_supporter_checkout')).toHaveLength(1);
    await act(async () => { finish({ status: 'completed', recovery_code: null, message: 'Receipt pending' }); });
    expect(screen.getByText('active:pending:none')).toBeTruthy();
    expect(screen.getByText('ad-free')).toBeTruthy();
  });
});
