import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflinePacksPanel } from '../../src/components/workspace/OfflinePacksPanel';
import type { OfflinePack, OfflinePackSnapshot } from '../../src/services/offlinePacks';
import type { WorkspaceFile } from '../../src/services/workspace';

const mocks = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), action: vi.fn(), path: vi.fn() }));
vi.mock('../../src/services/offlinePacks', async importOriginal => ({ ...await importOriginal<typeof import('../../src/services/offlinePacks')>(), readOfflinePacks: mocks.read, createOfflinePack: mocks.create, actOnOfflinePack: mocks.action, offlinePackPath: mocks.path }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const file: WorkspaceFile = { id: 1, key: 'saved:1', name: 'Trip.mp4', size: 10, folder_id: null, folderName: 'Saved', tags: [], collectionIds: [], mime_type: 'video/mp4', created_at: '2026-09-10', encryption_state: 'plain' };
const pack: OfflinePack = { id: 'pack', ownerId: '12', name: 'Verified trip', wifiOnly: true, expiresAt: null, createdAt: 1, updatedAt: 1, status: 'ready', waitingReason: null, autoResume: false, activeRun: null, files: [{ file, status: 'ready', downloadedBytes: 10, error: null }] };
const snapshot = (ownerId: string): OfflinePackSnapshot => ({ ownerId, packs: ownerId === '12' ? [pack] : [], freeBytes: 1000, reserveBytes: 100, network: { known: true, connected: false, wifi: false } });
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockImplementation(async owner => snapshot(owner)); mocks.action.mockResolvedValue(pack); mocks.create.mockResolvedValue(pack); mocks.path.mockResolvedValue('/verified/offline/Trip.mp4'); });
describe('offline trip pack UI', () => {
  it('opens only the verified device path and surfaces a missing copy without opening remotely', async () => {
    const open = vi.fn(); render(<OfflinePacksPanel ownerId="12" selectedFiles={[]} onOpen={open} />);
    await screen.findByText('Verified trip'); fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.files' }));
    fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.open Trip.mp4' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(file, '/verified/offline/Trip.mp4', expect.any(Function)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'offlinePacks.open Trip.mp4' }).hasAttribute('disabled')).toBe(false));
    mocks.path.mockRejectedValueOnce(new Error('OFFLINE_FILE_MISSING'));
    fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.open Trip.mp4' }));
    await screen.findByRole('alert'); expect(open).toHaveBeenCalledTimes(1);
  });
  it('discards a pending path across account switches, even when returning to the original account', async () => {
    let resolve!: (path: string) => void; mocks.path.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
    const open = vi.fn(); const view = render(<OfflinePacksPanel ownerId="12" selectedFiles={[]} onOpen={open} />);
    await screen.findByText('Verified trip'); fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.files' }));
    fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.open Trip.mp4' }));
    view.rerender(<OfflinePacksPanel ownerId="13" selectedFiles={[]} onOpen={open} />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledWith('13'));
    expect(screen.queryByText('Verified trip')).toBeNull();
    view.rerender(<OfflinePacksPanel ownerId="12" selectedFiles={[]} onOpen={open} />);
    await act(async () => resolve('/stale/offline/Trip.mp4'));
    expect(open).not.toHaveBeenCalled();
  });
  it('creates the full reviewed selection and requires an explicit remove confirmation', async () => {
    const files = Array.from({ length: 125 }, (_, i) => ({ ...file, id: i + 1, key: `saved:${i + 1}`, name: `File${i + 1}.mp4` }));
    render(<OfflinePacksPanel ownerId="12" selectedFiles={files} onOpen={vi.fn()} />);
    await screen.findByText('Verified trip'); fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.download' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('12', 'offlinePacks.default_name', files, true, null));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('12', 'pack', 'start'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'offlinePacks.remove' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.remove' }));
    expect(mocks.action).not.toHaveBeenCalledWith('12', 'pack', 'remove', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.remove_confirm' }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('12', 'pack', 'remove', undefined));
  });
  it('does not open a delayed device path after leaving the panel', async () => {
    let finish!: (path: string) => void; mocks.path.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const open = vi.fn(); const { unmount } = render(<OfflinePacksPanel ownerId="12" selectedFiles={[]} onOpen={open} />);
    await screen.findByText('Verified trip'); fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.files' }));
    fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.open Trip.mp4' }));
    unmount(); await act(async () => finish('/late/Trip.mp4'));
    expect(open).not.toHaveBeenCalled();
  });
  it('invalidates the continuation passed to a native opener when the panel closes', async () => {
    const open = vi.fn(); const { unmount } = render(<OfflinePacksPanel ownerId="12" selectedFiles={[]} onOpen={open} />);
    await screen.findByText('Verified trip'); fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.files' }));
    fireEvent.click(screen.getByRole('button', { name: 'offlinePacks.open Trip.mp4' }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    const isCurrent = open.mock.calls[0][2] as () => boolean;
    expect(isCurrent()).toBe(true); unmount(); expect(isCurrent()).toBe(false);
  });
});
