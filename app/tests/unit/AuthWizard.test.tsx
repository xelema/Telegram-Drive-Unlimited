import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthWizard } from '../../src/components/shared/AuthWizard';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));
vi.mock('../../src/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { seconds?: number }) => ({
      'auth.telegram_code': 'Telegram code',
      'auth.sign_in': 'Sign in',
      'auth.verifying': 'Verifying',
      'auth.change_phone': 'Change phone',
      'auth.use_qr_instead': 'Use QR instead',
      'auth.code_sent_sms': 'Code sent by SMS',
      'auth.resend_code': 'Resend code',
      'auth.resending': 'Resending',
      'auth.resend_in': `Resend in ${values?.seconds ?? 0}`,
    }[key] ?? key),
  }),
}));

describe('AuthWizard phone authentication', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'cmd_auth_qr_login') return 'tg://login?token=test';
      if (command === 'cmd_auth_request_code') {
        return {
          status: 'code_required',
          delivery: 'sms',
          codeLength: 5,
          resendAfterSeconds: 30,
          nextDelivery: 'call',
          numericCode: true,
        };
      }
      if (command === 'cmd_auth_sign_in') return { success: true };
      return null;
    });
  });

  it('preserves setup, phone-code, and successful sign-in sequencing', async () => {
    const onLogin = vi.fn();
    render(<AuthWizard onLogin={onLogin} />);

    fireEvent.change(screen.getByLabelText('API ID'), { target: { value: '12345' } });
    fireEvent.change(screen.getByLabelText('API Hash'), { target: { value: 'abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue to QR sign in/ }));

    await screen.findByText('Scan with your Telegram app');
    fireEvent.click(screen.getByRole('button', { name: /Phone Number/ }));
    fireEvent.change(screen.getByLabelText('Phone Number'), { target: { value: '+15551234567' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await screen.findByText('Code sent by SMS');
    fireEvent.change(screen.getByLabelText('Telegram code'), { target: { value: '12a3456' } });
    expect((screen.getByLabelText('Telegram code') as HTMLInputElement).value).toBe('12345');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'cmd_auth_qr_login',
      'cmd_auth_request_code',
      'cmd_auth_sign_in',
    ]);
  });
});
