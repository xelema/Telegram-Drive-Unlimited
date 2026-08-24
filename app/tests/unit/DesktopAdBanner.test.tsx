import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopAdBanner } from '../../src/components/desktop/dashboard/DesktopAdBanner';
import { SPONSOR_URL } from '../../src/services/sponsorLinks';

const openMock = vi.hoisted(() => vi.fn());
const supporterStatus = vi.hoisted(() => ({ current: { state: 'inactive', ad_free: false } }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }));
vi.mock('../../src/context/SupporterContext', () => ({
  useSupporter: () => ({ status: supporterStatus.current }),
}));

describe('DesktopAdBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    localStorage.clear();
    openMock.mockReset();
    openMock.mockResolvedValue(undefined);
    supporterStatus.current = { state: 'inactive', ad_free: false };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts its countdown after the creative loads and returns after 15 minutes', async () => {
    render(<DesktopAdBanner />);
    const iframe = screen.getByTitle('Sponsored advertisement') as HTMLIFrameElement;

    expect(screen.getByText('Loading…')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://localhost:14201',
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

    await act(async () => { await vi.advanceTimersByTimeAsync(14 * 60 * 1000); });
    expect(screen.queryByRole('complementary')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 1000); });
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('renders the isolated provider frame without a manual close button', async () => {
    render(<DesktopAdBanner onSupport={() => {}} />);
    const iframe = screen.getByTitle('Sponsored advertisement');

    expect(iframe.getAttribute('src')).toContain('http://localhost:14201/ad-banner?cycle=');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(screen.queryByRole('button', { name: /dismiss|close ad/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Support development and hide ads' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open sponsored content in browser' }));
      await Promise.resolve();
    });
    expect(openMock).toHaveBeenCalledWith(SPONSOR_URL);
  });

  it('falls back after the provider timeout and still requires auto-dismissal', async () => {
    render(<DesktopAdBanner />);

    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(screen.getByText('Sponsored content unavailable')).toBeTruthy();
    expect(screen.getByText('Closes in 10s')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /dismiss|close ad/i })).toBeNull();
  });

  it('accepts load messages only from its loopback ad frame', () => {
    render(<DesktopAdBanner />);
    const iframe = screen.getByTitle('Sponsored advertisement') as HTMLIFrameElement;

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'null',
        source: iframe.contentWindow,
        data: { type: 'telegram-drive:ad-banner-status', status: 'loaded' },
      }));
    });
    expect(screen.getByText('Loading…')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://localhost:14201',
        source: iframe.contentWindow,
        data: { type: 'telegram-drive:ad-banner-status', status: 'loaded' },
      }));
    });
    expect(screen.getByText('Closes in 10s')).toBeTruthy();
  });

  it('does not render sponsor content for an ad-free supporter', () => {
    supporterStatus.current = { state: 'active', ad_free: true };

    render(<DesktopAdBanner />);

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
  });
});
