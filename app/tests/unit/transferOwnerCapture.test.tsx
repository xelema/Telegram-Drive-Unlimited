import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileUpload } from '../../src/hooks/useFileUpload';
import { useFileDownload } from '../../src/hooks/useFileDownload';
const mocks = vi.hoisted(() => ({
  open: vi.fn(), save: vi.fn(), invoke: vi.fn(), enqueue: vi.fn(), confirm: vi.fn(), choose: vi.fn(), collision: vi.fn(), client: {},
  settings: { maxConcurrentUploads: 1, maxConcurrentDownloads: 1, encryptionDefaultMode: 'standard', encryptionProtectMetadata: true, videoUploadMode: 'file' },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open, save: mocks.save }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.client }));
vi.mock('../../src/context/SettingsContext', () => ({ useSettings: () => ({ settings: mocks.settings, updateSetting: vi.fn() }) }));
vi.mock('../../src/context/UploadChoiceContext', () => ({ useUploadChoice: () => ({ chooseUploadProtection: mocks.choose }) }));
vi.mock('../../src/context/ConfirmContext', () => ({ useConfirm: () => ({ confirm: mocks.confirm, chooseDownloadCollision: mocks.collision }) }));
vi.mock('../../src/utils', async () => ({ isAndroidPlatform: false, pickWithFallback: async (pick: () => Promise<unknown>) => pick(), showFileDialogFallback: vi.fn(), sanitizeFilename: (await vi.importActual<typeof import('../../src/utils/files')>('../../src/utils/files')).sanitizeFilename, formatBytes: (size: number) => String(size) }));
vi.mock('../../src/services/desktopTransferEngine', async () => ({ ...(await vi.importActual('../../src/services/desktopTransferEngine')),
  listDesktopTransfers: vi.fn(async () => []), listenToDesktopTransfers: vi.fn(async () => () => {}), configureDesktopTransferLimits: vi.fn(async () => {}), enqueueDesktopTransfers: mocks.enqueue,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); mocks.enqueue.mockResolvedValue([]); mocks.choose.mockResolvedValue('store'); mocks.confirm.mockResolvedValue(true); mocks.collision.mockResolvedValue('keep_both'); mocks.invoke.mockResolvedValue({ state: 'plain', protection_mode: 'standard' }); });

describe('transfer ownership at user action time', () => {
  it('rejects an upload if the account changes while its file picker is open', async () => {
    let finishPicker!: (paths: string[]) => void;
    mocks.open.mockImplementation(() => new Promise(resolve => { finishPicker = resolve; }));
    const { result, rerender } = renderHook(({ owner }) => useFileUpload(7, null, true, '', owner), { initialProps: { owner: 'account-a' } });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.handleManualUpload().catch(error => error); });
    await waitFor(() => expect(mocks.open).toHaveBeenCalled());
    rerender({ owner: 'account-b' });
    await act(async () => { finishPicker(['/tmp/file.txt']); await pending; });
    expect(await pending).toEqual(new Error('ACCOUNT_CHANGED'));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.choose).not.toHaveBeenCalled();
  });
  it('rejects a download after an account change before inspecting account-relative encryption metadata', async () => {
    let finishPicker!: (path: string) => void;
    mocks.save.mockImplementation(() => new Promise(resolve => { finishPicker = resolve; }));
    const { result, rerender } = renderHook(({ owner }) => useFileDownload(null, true, '', owner), { initialProps: { owner: 'account-a' } });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.queueDownload(77, 'file.txt', null, 10).catch(error => error); });
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    rerender({ owner: 'account-b' });
    await act(async () => { finishPicker('/tmp/file.txt'); await pending; });
    expect(await pending).toEqual(new Error('ACCOUNT_CHANGED'));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith('cmd_get_file_encryption_info', expect.anything());
  });
  it('binds encryption inspection to the initiating owner and ignores its late response', async () => {
    let finishInfo!: (value: unknown) => void;
    mocks.save.mockResolvedValue('/tmp/file.txt');
    mocks.invoke.mockImplementation((command: string) => command === 'cmd_get_file_encryption_info'
      ? new Promise(resolve => { finishInfo=resolve; }) : Promise.resolve(undefined));
    const { result,rerender } = renderHook(({owner}) => useFileDownload(null,true,'',owner),{initialProps:{owner:'account-a'}});
    let pending!: Promise<unknown>;
    act(() => { pending=result.current.queueDownload(77,'file.txt',null,10).catch(error => error); });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('cmd_get_file_encryption_info',{messageId:77,folderId:null,ownerId:'account-a'}));
    rerender({owner:'account-b'});
    await act(async () => { finishInfo({state:'plain',protection_mode:'standard'}); await pending; });
    expect(await pending).toEqual(new Error('ACCOUNT_CHANGED'));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('keeps an explicit Saved Messages source when a bulk download starts from another folder', async () => {
    mocks.open.mockResolvedValue('/tmp');
    const { result } = renderHook(() => useFileDownload(null, true, '', 'account-a'));
    await act(async () => result.current.queueBulkDownload([{ id: 77, name: 'saved.txt', folder_id: null, size: 10 } as never], 900));
    expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({ ownerId: 'account-a', folderId: null, messageId: 77 })]);
  });
});

describe('download collision choices at callers', () => {
  it('attaches an explicit replacement choice to a single durable download', async () => {
    mocks.save.mockResolvedValue('/tmp/existing.txt');
    mocks.collision.mockResolvedValue('replace');
    const { result } = renderHook(() => useFileDownload(null, true, '', 'account-a'));
    await act(async () => result.current.queueDownload(77, 'original.txt', null, 10));
    expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({ collisionPolicy: 'replace', savePath: '/tmp/existing.txt', ownerId: 'account-a' })]);
  });
  it('applies one skip choice to every file in a bulk enqueue', async () => {
    mocks.open.mockResolvedValue('/tmp');
    mocks.collision.mockResolvedValue('skip');
    const { result } = renderHook(() => useFileDownload(null, true, '', 'account-a'));
    await act(async () => result.current.queueBulkDownload([
      { id: 77, name: 'same.txt', folder_id: null, size: 10 } as never,
      { id: 78, name: 'SAME.txt', folder_id: 4, size: 10 } as never,
    ], 900));
    expect(mocks.collision).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith([
      expect.objectContaining({ collisionPolicy: 'skip', folderId: null, messageId: 77 }),
      expect.objectContaining({ collisionPolicy: 'skip', folderId: 4, messageId: 78 }),
    ]);
  });
  it('does not enqueue or request credentials when collision selection is cancelled', async () => {
    mocks.save.mockResolvedValue('/tmp/existing.txt');
    mocks.collision.mockResolvedValue(null);
    const { result } = renderHook(() => useFileDownload(null, true, '', 'account-a'));
    await act(async () => result.current.queueDownload(77, 'original.txt', null, 10));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith('cmd_get_file_encryption_info', expect.anything());
  });
  it('rejects an account switch while collision selection is pending', async () => {
    let finish!: (policy: string) => void;
    mocks.save.mockResolvedValue('/tmp/existing.txt');
    mocks.collision.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({ owner }) => useFileDownload(null, true, '', owner), { initialProps: { owner: 'account-a' } });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.queueDownload(77, 'file.txt', null, 10).catch(error => error); });
    await waitFor(() => expect(mocks.collision).toHaveBeenCalled());
    rerender({ owner: 'account-b' });
    await act(async () => { finish('replace'); await pending; });
    expect(await pending).toEqual(new Error('ACCOUNT_CHANGED'));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith('cmd_get_file_encryption_info', expect.anything());
  });
  it('sends sanitized duplicate destinations through one durable batch for backend reservation', async () => {
    mocks.open.mockResolvedValue('/tmp');
    const { result } = renderHook(() => useFileDownload(null, true, '', 'account-a'));
    await act(async () => result.current.queueBulkDownload([
      { id: 80, name: 'report?.txt', folder_id: null } as never,
      { id: 81, name: 'report*.txt', folder_id: null } as never,
    ], null));
    expect(mocks.enqueue).toHaveBeenCalledWith([
      expect.objectContaining({ filename: 'report_.txt', savePath: '/tmp/report_.txt', collisionPolicy: 'keep_both' }),
      expect.objectContaining({ filename: 'report_.txt', savePath: '/tmp/report_.txt', collisionPolicy: 'keep_both' }),
    ]);
  });

});
