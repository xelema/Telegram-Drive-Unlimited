import { open } from '@tauri-apps/plugin-shell';

export const SPONSOR_URL = 'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40';

export type SponsorPlacement =
  | 'first_ad_gateway'
  | 'android_banner'
  | 'desktop_banner_fallback';

export function sponsorUrlFor(placement: SponsorPlacement): string {
  const url = new URL(SPONSOR_URL);
  url.searchParams.set('psid', placement);
  return url.toString();
}

export function isSafeSponsorDestination(destination: string): boolean {
  try {
    const url = new URL(destination);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function openSponsorDestination(destination: string): Promise<boolean> {
  if (!isSafeSponsorDestination(destination)) return false;

  try {
    await open(destination);
    return true;
  } catch {
    return window.open(destination, '_blank', 'noopener,noreferrer') !== null;
  }
}

export async function openSponsorLink(placement: SponsorPlacement): Promise<boolean> {
  return openSponsorDestination(sponsorUrlFor(placement));
}
