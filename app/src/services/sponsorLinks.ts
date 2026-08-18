import { open } from '@tauri-apps/plugin-shell';

export const SPONSOR_URL = 'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40';

export async function openSponsorLink(): Promise<void> {
  try {
    await open(SPONSOR_URL);
  } catch {
    window.open(SPONSOR_URL, '_blank', 'noopener,noreferrer');
  }
}
