import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdsterraBanner from '../../src/components/shared/AdsterraBanner';

const { supporterStatus } = vi.hoisted(() => ({
  supporterStatus: { current: { state: 'inactive', ad_free: false } },
}));

const { platformInfo, openSponsorLink } = vi.hoisted(() => ({
  platformInfo: { current: { isAndroid: true, isTelevision: false } },
  openSponsorLink: vi.fn(),
}));

const store = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(async () => undefined),
  delete: vi.fn(async () => false),
  save: vi.fn(async () => undefined),
}));

vi.mock('../../src/hooks/usePlatform', () => ({ usePlatform: () => platformInfo.current }));
vi.mock('../../src/context/SupporterContext', () => ({
  useSupporter: () => ({ status: supporterStatus.current }),
}));
vi.mock('../../src/services/sponsorLinks', () => ({
  openSponsorLink,
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => store),
}));

describe('Android sponsor visibility', () => {
  beforeEach(() => {
    supporterStatus.current = { state: 'inactive', ad_free: false };
    platformInfo.current = { isAndroid: true, isTelevision: false };
    openSponsorLink.mockReset();
    store.get.mockReset();
    store.get.mockResolvedValue(undefined);
    store.set.mockClear();
    store.delete.mockClear();
    store.save.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the sponsor placement for a free Android user', async () => {
    render(<AdsterraBanner visible />);
    expect(await screen.findByRole('complementary', { name: /sponsored content/i })).toBeTruthy();
  });

  it('removes the sponsor placement for a verified lifetime license', async () => {
    supporterStatus.current = { state: 'active', ad_free: true };
    render(<AdsterraBanner visible />);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: /sponsored content/i })).toBeNull());
  });

  it('does not flash the sponsor placement while Android checks an existing license', async () => {
    supporterStatus.current = { state: 'loading', ad_free: false };
    render(<AdsterraBanner visible />);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: /sponsored content/i })).toBeNull());
  });

  it('provides a remote-focusable sponsor action on Android TV', async () => {
    platformInfo.current = { isAndroid: true, isTelevision: true };
    render(<AdsterraBanner visible />);

    const sponsorAction = await screen.findByRole('button', { name: /sponsored — view offer/i });
    fireEvent.click(sponsorAction);
    expect(openSponsorLink).toHaveBeenCalledWith('android_banner');
  });

  it('returns 15 minutes after the user closes it', async () => {
    const onManualDismiss = vi.fn();
    render(<AdsterraBanner visible onManualDismiss={onManualDismiss} />);
    await screen.findByRole('complementary', { name: /sponsored content/i });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));
    fireEvent.click(screen.getByRole('button', { name: /close ad/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.queryByRole('complementary', { name: /sponsored content/i })).toBeNull();
    expect(onManualDismiss).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1_000 - 301); });
    expect(screen.queryByRole('complementary', { name: /sponsored content/i })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('complementary', { name: /sponsored content/i })).toBeTruthy();
    expect(store.set).toHaveBeenCalledWith('adBannerDismissedAt', expect.any(Number));
  });

  it('provides a separate lifetime ad-free action', async () => {
    const onSupport = vi.fn();
    render(<AdsterraBanner visible onSupport={onSupport} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove ads forever for $5 once' }));

    expect(onSupport).toHaveBeenCalledOnce();
    expect(openSponsorLink).not.toHaveBeenCalled();
  });

  it('migrates a legacy permanent dismissal into a 15-minute cooldown', async () => {
    store.get.mockImplementation(async (key: string) => key === 'adBannerDismissed');

    render(<AdsterraBanner visible />);

    await waitFor(() => expect(store.set).toHaveBeenCalledWith('adBannerDismissedAt', expect.any(Number)));
    expect(screen.queryByRole('complementary', { name: /sponsored content/i })).toBeNull();
    expect(store.delete).toHaveBeenCalledWith('adBannerDismissed');
  });
});
