import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupporterProvider, useSupporter, type SupporterStatus } from '../../src/context/SupporterContext';

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
  const { status, latestRecoveryCode } = useSupporter();
  return <div>{status.state}:{status.checkout_pending ? 'pending' : 'settled'}:{latestRecoveryCode ?? 'none'}</div>;
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
