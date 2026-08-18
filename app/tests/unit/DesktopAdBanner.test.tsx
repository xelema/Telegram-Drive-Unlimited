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

  it('starts its countdown immediately and dismisses for 45 minutes', async () => {
    render(<DesktopAdBanner />);

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

  it('always renders a sponsor card and opens the configured SmartLink', async () => {
    render(<DesktopAdBanner />);
    expect(screen.getByText('A quick message from our sponsor')).toBeTruthy();
    expect(screen.queryByTitle('Sponsored advertisement')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open sponsored content in browser' }));
      await Promise.resolve();
    });
    expect(openMock).toHaveBeenCalledWith(SPONSOR_URL);
  });

  it('does not render sponsor content for an ad-free supporter', () => {
    supporterStatus.current = { state: 'active', ad_free: true };

    render(<DesktopAdBanner />);

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
  });
});
