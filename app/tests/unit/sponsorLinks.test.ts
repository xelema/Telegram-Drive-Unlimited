import { describe, expect, it, vi } from 'vitest';

const openMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }));

import {
  isSafeSponsorDestination,
  openSponsorLink,
  SPONSOR_URL,
  sponsorUrlFor,
} from '../../src/services/sponsorLinks';

describe('sponsor campaign configuration', () => {
  it('uses the production Adsterra campaign link', () => {
    expect(SPONSOR_URL).toBe(
      'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40',
    );
  });

  it('adds Adsterra placement sub-IDs without attaching user identifiers', () => {
    expect(sponsorUrlFor('first_ad_gateway')).toBe(`${SPONSOR_URL}&psid=first_ad_gateway`);
    expect(sponsorUrlFor('android_banner')).toBe(`${SPONSOR_URL}&psid=android_banner`);
    expect(sponsorUrlFor('desktop_banner_fallback')).toBe(`${SPONSOR_URL}&psid=desktop_banner_fallback`);
  });

  it('opens the attributed URL and rejects non-web destinations', async () => {
    openMock.mockResolvedValue(undefined);

    await expect(openSponsorLink('android_banner')).resolves.toBe(true);
    expect(openMock).toHaveBeenCalledWith(`${SPONSOR_URL}&psid=android_banner`);
    expect(isSafeSponsorDestination('https://provider.example/click')).toBe(true);
    expect(isSafeSponsorDestination('http://provider.example/click')).toBe(true);
    expect(isSafeSponsorDestination('javascript:alert(1)')).toBe(false);
    expect(isSafeSponsorDestination('not a URL')).toBe(false);
  });
});
