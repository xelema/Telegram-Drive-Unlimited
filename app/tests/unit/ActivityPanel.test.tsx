import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ActivityPanel } from '../../src/components/workspace/ActivityPanel';
import { adoptLegacyTransfers, readTransferActivity, type ActivityJob, type TransferActivitySnapshot } from '../../src/services/transferActivity';
vi.mock('../../src/hooks/usePlatform', () => ({ usePlatform: () => ({ isDesktop: true }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/services/transferActivity', async () => ({ ...(await vi.importActual('../../src/services/transferActivity')), readTransferActivity: vi.fn(), adoptLegacyTransfers: vi.fn(), discardLegacyTransfers: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const view = (ownerId: string, client: QueryClient) => <QueryClientProvider client={client}><ActivityPanel ownerId={ownerId} /></QueryClientProvider>;
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('ActivityPanel', () => {
  it('keeps late results from the previous account out of the visible activity', async () => {
    let finishOld!: (value: TransferActivitySnapshot) => void;
    vi.mocked(readTransferActivity).mockImplementation(owner => owner === 'old'
      ? new Promise(resolve => { finishOld = resolve; })
      : Promise.resolve({ ownerId: 'new', jobs: [], legacy: [] }));
    const cache = client(); const rendered = render(view('old', cache));
    await waitFor(() => expect(readTransferActivity).toHaveBeenCalledWith('old'));
    rendered.rerender(view('new', cache));
    await act(async () => finishOld({ ownerId: 'old', jobs: [], legacy: [{ id: 'legacy', filename: 'old-account-private-file', direction: 'upload', kind: 'local_upload', status: 'paused', createdAt: 1, totalBytes: 1, canAdopt: true }] }));
    await screen.findByText('activity.empty');
    expect(screen.queryByText('old-account-private-file')).toBeNull();
    expect(screen.queryByText('activity.legacy_title')).toBeNull();
  });
  it('requires selection and account ownership confirmation before adopting old records', async () => {
    vi.mocked(readTransferActivity).mockResolvedValue({ ownerId: 'current', jobs: [], legacy: [{ id: 'legacy', filename: 'review-me.txt', direction: 'upload', kind: 'local_upload', status: 'paused', createdAt: 1, totalBytes: 10, canAdopt: true }] });
    vi.mocked(adoptLegacyTransfers).mockResolvedValue(undefined);
    render(view('current', client()));
    fireEvent.click(await screen.findByText('activity.legacy_show'));
    const adopt = screen.getByRole('button', { name: 'activity.legacy_adopt' });
    expect((adopt as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'activity.legacy_select' }));
    expect((adopt as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'activity.legacy_confirm' }));
    expect((adopt as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(adopt);
    await waitFor(() => expect(adoptLegacyTransfers).toHaveBeenCalledWith('current', ['legacy'], true));
  });
  it('never renders protected names, byte sizes or raw errors even from an older response', async () => {
    vi.mocked(readTransferActivity).mockResolvedValue({ ownerId: 'private-owner', legacy: [], jobs: [{
      id: 'retry-id', ownerId: 'private-owner', filename: 'secret-title.pdf', error: '/secret/path: unlock failed',
      direction: 'upload', kind: 'local_upload', status: 'waiting_for_unlock', protectionMode: 'vault',
      totalBytes: 12345678, progress: 12, updatedAt: 10,
    } as ActivityJob] });
    render(view('private-owner', client()));
    await screen.findByText('settings.protected');
    expect(screen.queryByText('secret-title.pdf')).toBeNull();
    expect(screen.queryByText('/secret/path: unlock failed')).toBeNull();
    expect(screen.queryByText('activity.details')).toBeNull();
  });

});
