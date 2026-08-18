import { beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }));

import { openSponsorLink, SPONSOR_URL } from '../../src/services/sponsorLinks';

describe('sponsor links', () => {
  beforeEach(() => {
    openMock.mockReset();
  });

  it('uses the configured EffectiveCPMNetwork SmartLink', async () => {
    openMock.mockResolvedValue(undefined);

    await openSponsorLink();

    expect(SPONSOR_URL).toBe('https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40');
    expect(openMock).toHaveBeenCalledWith(SPONSOR_URL);
  });

  it('keeps the browser fallback isolated from the application window', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    openMock.mockRejectedValue(new Error('native shell unavailable'));

    await openSponsorLink();

    expect(windowOpen).toHaveBeenCalledWith(SPONSOR_URL, '_blank', 'noopener,noreferrer');
    windowOpen.mockRestore();
  });
});
