import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdsterraBanner from '../../src/components/shared/AdsterraBanner';

const { supporterStatus } = vi.hoisted(() => ({
  supporterStatus: { current: { state: 'inactive', ad_free: false } },
}));

vi.mock('../../src/hooks/usePlatform', () => ({ usePlatform: () => ({ isAndroid: true }) }));
vi.mock('../../src/context/SupporterContext', () => ({
  useSupporter: () => ({ status: supporterStatus.current }),
}));
vi.mock('../../src/services/sponsorLinks', () => ({ openSponsorLink: vi.fn() }));
vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => false),
    set: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

describe('Android sponsor visibility', () => {
  beforeEach(() => {
    supporterStatus.current = { state: 'inactive', ad_free: false };
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
});
