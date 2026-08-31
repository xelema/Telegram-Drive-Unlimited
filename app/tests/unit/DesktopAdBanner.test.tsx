import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopAdBanner } from '../../src/components/desktop/dashboard/DesktopAdBanner';
import { sponsorUrlFor } from '../../src/services/sponsorLinks';

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
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { isActive: true },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts its countdown after the creative loads and returns after 15 minutes in the same session', async () => {
    const onManualDismiss = vi.fn();
    render(<DesktopAdBanner onManualDismiss={onManualDismiss} />);
    const iframe = screen.getByTitle('Sponsored') as HTMLIFrameElement;

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
    expect(localStorage.getItem('desktopAdDismissedAt')).toBeNull();
    expect(onManualDismiss).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(14 * 60 * 1000); });
    expect(screen.queryByRole('complementary')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 1000); });
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('shows immediately in a new app session and clears a persisted legacy cooldown', () => {
    localStorage.setItem('desktopAdDismissedAt', Date.now().toString());

    render(<DesktopAdBanner />);

    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(localStorage.getItem('desktopAdDismissedAt')).toBeNull();
  });

  it('renders an interactive isolated provider frame with ad-free and manual-dismiss actions', async () => {
    render(<DesktopAdBanner onSupport={() => {}} />);
    const iframe = screen.getByTitle('Sponsored') as HTMLIFrameElement;

    expect(iframe.getAttribute('src')).toContain('http://localhost:14201/ad-banner?cycle=');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(iframe.getAttribute('referrerpolicy')).toBeNull();
    expect(screen.getByRole('button', { name: /close ad/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove ads forever for $5 once' })).toBeTruthy();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://localhost:14201',
        source: iframe.contentWindow,
        data: { type: 'telegram-drive:ad-banner-status', status: 'loaded' },
      }));
    });

    expect(iframe.className).toContain('pointer-events-auto');
    expect(screen.queryByRole('button', { name: /Sponsored content opens in your browser/i })).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
  });

  it('falls back after the provider timeout and still requires auto-dismissal', async () => {
    render(<DesktopAdBanner />);

    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(screen.getByText(/operation could not be completed/i)).toBeTruthy();
    expect(screen.getByText('Closes in 10s')).toBeTruthy();
    expect(screen.getByRole('button', { name: /close ad/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sponsored content opens in your browser/i }));
      await Promise.resolve();
    });
    expect(openMock).toHaveBeenCalledWith(sponsorUrlFor('desktop_banner_fallback'));
  });

  it('opens only the provider destination relayed by its own loopback frame', async () => {
    render(<DesktopAdBanner />);
    const iframe = screen.getByTitle('Sponsored') as HTMLIFrameElement;
    const providerDestination = 'https://tracking.example/click?id=42';

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://localhost:14201',
        source: iframe.contentWindow,
        data: { type: 'telegram-drive:ad-link', url: providerDestination },
      }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(openMock).toHaveBeenCalledWith(providerDestination);

    openMock.mockClear();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://localhost:14201',
        source: iframe.contentWindow,
        data: { type: 'telegram-drive:ad-link', url: 'javascript:alert(1)' },
      }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(openMock).not.toHaveBeenCalled();
  });

  it('ignores provider-link messages without an active user gesture', async () => {
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { isActive: false },
    });
    render(<DesktopAdBanner />);
    const iframe = screen.getByTitle('Sponsored') as HTMLIFrameElement;

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://localhost:14201',
        source: iframe.contentWindow,
        data: { type: 'telegram-drive:ad-link', url: 'https://tracking.example/click?id=42' },
      }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(openMock).not.toHaveBeenCalled();
  });

  it('reports only a manual dismissal after its exit animation', async () => {
    const onManualDismiss = vi.fn();
    render(<DesktopAdBanner onManualDismiss={onManualDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: /close ad/i }));
    expect(onManualDismiss).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(onManualDismiss).toHaveBeenCalledOnce();
  });

  it('accepts load messages only from its loopback ad frame', () => {
    render(<DesktopAdBanner />);
    const iframe = screen.getByTitle('Sponsored') as HTMLIFrameElement;

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
