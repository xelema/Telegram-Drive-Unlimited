import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopAdBanner } from '../../src/components/desktop/dashboard/DesktopAdBanner';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('../../src/context/SupporterContext', () => ({
  useSupporter: () => ({ status: { ad_free: false } }),
}));

describe('DesktopAdBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts its countdown after the creative loads and dismisses for 45 minutes', async () => {
    render(<DesktopAdBanner />);
    const iframe = screen.getByTitle('Sponsored advertisement') as HTMLIFrameElement;

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'null',
        source: iframe.contentWindow,
        data: { type: 'telegram-drive:ad-banner-status', status: 'loaded' },
      }));
    });

    expect(screen.getByText('Closes in 10s')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('Closes in 9s')).toBeTruthy();

    for (let second = 0; second < 9; second += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(localStorage.getItem('desktopAdDismissedAt')).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(44 * 60 * 1000); });
    expect(screen.queryByRole('complementary')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(61 * 1000); });
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('uses a non-popup sandbox and shows a clickable fallback when loading fails', async () => {
    render(<DesktopAdBanner />);
    const iframe = screen.getByTitle('Sponsored advertisement');

    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    await act(async () => { await vi.advanceTimersByTimeAsync(6_500); });
    expect(screen.getByText('Sponsored content unavailable')).toBeTruthy();
    expect(screen.getByText('Open sponsor')).toBeTruthy();
  });
});
