import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdGateway, AD_GATEWAY_PASSED_KEY } from '../../src/components/shared/AdGateway';

const openSponsorLink = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  set: vi.fn(async () => undefined),
  save: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/sponsorLinks', () => ({ openSponsorLink }));
vi.mock('../../src/hooks/usePlatform', () => ({
  usePlatform: () => ({ isMobile: false }),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => store),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'ads.sponsored': 'Sponsored',
      'ads.sponsor_message': 'A quick message from our sponsor',
      'ads.browser_note': 'Sponsored content opens in your browser. You only see this gateway once.',
      'ads.continue_to_files': 'Continue to files',
      'common.loading': 'Loading…',
      'common.operation_failed': 'Operation failed',
    }[key] ?? key),
  }),
}));

describe('AdGateway', () => {
  beforeEach(() => {
    openSponsorLink.mockReset();
    openSponsorLink.mockResolvedValue(true);
    store.set.mockClear();
    store.save.mockClear();
  });

  it('lets the user continue immediately without opening sponsored content', async () => {
    const onContinue = vi.fn();
    render(<AdGateway onContinue={onContinue} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue to files' }));

    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    expect(openSponsorLink).not.toHaveBeenCalled();
    expect(store.set).toHaveBeenCalledWith(AD_GATEWAY_PASSED_KEY, true);
    expect(store.set).not.toHaveBeenCalledWith('ad_click_thanks', true);
  });

  it('opens the attributed Smartlink only after an explicit click', async () => {
    render(<AdGateway onContinue={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Sponsored content opens in your browser/i }));

    await waitFor(() => expect(openSponsorLink).toHaveBeenCalledWith('first_ad_gateway'));
    expect(store.set).toHaveBeenCalledWith(AD_GATEWAY_PASSED_KEY, true);
    expect(store.set).toHaveBeenCalledWith('ad_click_thanks', true);
  });
});
