import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncPreview, SyncPreviewRequest } from '../../src/types/sync';
import { SyncSettingsPanel } from '../../src/components/desktop/sync/SyncSettingsPanel';
import { SyncPlanPreview } from '../../src/components/desktop/sync/SyncPlanPreview';

const mocks = vi.hoisted(() => ({
  ownerId: '42',
  invoke: vi.fn(), open: vi.fn(), preview: vi.fn(), addPair: vi.fn(), updatePair: vi.fn(), setPairActive: vi.fn(), removePair: vi.fn(), setEnabled: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../../src/services/syncService', () => ({ previewSyncPair: mocks.preview }));
vi.mock('../../src/context/SyncContext', () => ({ useSync: () => ({
  ownerId: mocks.ownerId,
  settings: { data: { enabled: false }, isLoading: false }, pairs: { data: [] }, status: { data: { pairs: [] } },
  addPair: mocks.addPair, updatePair: mocks.updatePair, setPairActive: mocks.setPairActive, removePair: mocks.removePair, setEnabled: mocks.setEnabled,
}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const completedPreview = (request: SyncPreviewRequest): SyncPreview => ({
  request, generatedAt: 1_700_000_000, reviewToken: 'review-current-settings', accountOwner: '42',
  localFiles: 1, remoteFiles: 0,
  counts: { uploads: 1, downloads: 0, deleteLocal: 0, deleteRemote: 0, conflicts: 0, skipped: 0 },
  operations: [{ action: 'upload', relativePath: 'report.txt', detail: 'Upload a new file to Telegram' }],
  pauseReasons: [], warnings: [],
});

async function chooseMapping(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'settings.sync.select_folder' }));
  await screen.findByRole('option', { name: 'Docs' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'settings.sync.select_channel' }), '7');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ownerId = '42';
  mocks.invoke.mockResolvedValue([{ id: 7, name: 'Docs' }]);
  mocks.open.mockResolvedValue('/tmp/local');
  mocks.addPair.mockResolvedValue(undefined);
  mocks.preview.mockImplementation(async (request: SyncPreviewRequest) => completedPreview(request));
});

describe('sync setup review', () => {
  it('defaults to paused upload backup without deletions and cannot save until previewed', async () => {
    const user = userEvent.setup();
    render(<SyncSettingsPanel />);
    await chooseMapping(user);
    expect((screen.getByRole('combobox', { name: 'syncPreview.mode' }) as HTMLSelectElement).value).toBe('upload_only');
    expect((screen.getByRole('checkbox', { name: 'syncPreview.delete_upload' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'syncPreview.pause_conflicts' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'syncPreview.start_after_save' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'syncPreview.save_paused' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.addPair).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'syncPreview.preview_button' }));
    await screen.findByText('report.txt');
    expect(mocks.addPair).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'syncPreview.save_paused' }));
    await waitFor(() => expect(mocks.addPair).toHaveBeenCalledWith('/tmp/local', 7, 'Docs', expect.objectContaining({
      syncDirection: 'upload_only', previewToken: 'review-current-settings', isActive: false,
      preferences: expect.objectContaining({ propagateDeletions: false, pauseOnConflicts: true }),
    })));
  });

  it('ignores a late preview for changed settings and invalidates reviewed deletion changes', async () => {
    let finish!: (preview: SyncPreview) => void;
    mocks.preview.mockImplementationOnce(() => new Promise<SyncPreview>(resolve => { finish = resolve; }));
    const user = userEvent.setup();
    render(<SyncSettingsPanel />);
    await chooseMapping(user);
    await user.click(screen.getByRole('button', { name: 'syncPreview.preview_button' }));
    const firstRequest = mocks.preview.mock.calls[0][0] as SyncPreviewRequest;
    await user.selectOptions(screen.getByRole('combobox', { name: 'syncPreview.mode' }), 'download_only');
    await act(async () => finish(completedPreview(firstRequest)));
    expect(screen.queryByText('report.txt')).toBeNull();
    expect((screen.getByRole('button', { name: 'syncPreview.save_paused' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'syncPreview.preview_button' }));
    await screen.findByText('report.txt');
    await user.click(screen.getByRole('checkbox', { name: 'syncPreview.delete_download' }));
    expect(screen.queryByText('report.txt')).toBeNull();
    expect((screen.getByRole('button', { name: 'syncPreview.save_paused' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.addPair).not.toHaveBeenCalled();
  });

  it('keeps saving disabled when the remote scan fails', async () => {
    mocks.preview.mockRejectedValueOnce(new Error('Telegram is offline'));
    const user = userEvent.setup();
    render(<SyncSettingsPanel />);
    await chooseMapping(user);
    await user.click(screen.getByRole('button', { name: 'syncPreview.preview_button' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'syncPreview.save_paused' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.addPair).not.toHaveBeenCalled();
  });

  it('discards the old account draft and its late preview after switching accounts', async () => {
    let finish!: (preview: SyncPreview) => void;
    mocks.preview.mockImplementationOnce(() => new Promise<SyncPreview>(resolve => { finish = resolve; }));
    const user = userEvent.setup();
    const view = render(<SyncSettingsPanel />);
    await chooseMapping(user);
    await user.click(screen.getByRole('button', { name: 'syncPreview.preview_button' }));
    const request = mocks.preview.mock.calls[0][0] as SyncPreviewRequest;
    expect(mocks.preview.mock.calls[0][1]).toBe('42');
    mocks.ownerId = '84';
    view.rerender(<SyncSettingsPanel />);
    await act(async () => finish(completedPreview(request)));
    expect(screen.queryByText('report.txt')).toBeNull();
    expect(screen.queryByText('/tmp/local')).toBeNull();
    expect((screen.getByRole('button', { name: 'syncPreview.save_paused' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.addPair).not.toHaveBeenCalled();
  });

  it('shows every category and lets users inspect a deletion beyond the first page', async () => {
    const request: SyncPreviewRequest = { pairId: null, localPath: '/tmp/local', channelId: 7, syncDirection: 'bidirectional', preferences: { ignorePatterns: [], propagateDeletions: true, pauseOnConflicts: true } };
    const preview = completedPreview(request);
    preview.operations = Array.from({ length: 45 }, (_, index) => ({ action: 'upload' as const, relativePath: `upload-${index}.txt`, detail: 'Upload' }));
    preview.operations.push({ action: 'delete_local', relativePath: 'removed-in-telegram.txt', detail: 'Delete the local copy' });
    preview.counts = { ...preview.counts, uploads: 45, deleteLocal: 1 };
    const user = userEvent.setup();
    render(<SyncPlanPreview preview={preview} />);
    expect(screen.queryByText('removed-in-telegram.txt')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'syncPreview.next' }));
    expect(screen.getByText('removed-in-telegram.txt')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'syncPreview.delete_local (1)' }));
    expect(screen.getByText('removed-in-telegram.txt')).toBeTruthy();
    expect(screen.queryByText('upload-44.txt')).toBeNull();
  });
});
