import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

import { SPONSOR_URL } from '../../src/services/sponsorLinks';

describe('sponsor campaign configuration', () => {
  it('uses the production Adsterra campaign link', () => {
    expect(SPONSOR_URL).toBe(
      'https://www.effectivecpmnetwork.com/nk8qy01t0g?key=a6c132f628973ad13b326e57e4a92f40',
    );
  });
});
