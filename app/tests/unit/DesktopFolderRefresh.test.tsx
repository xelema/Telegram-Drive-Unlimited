import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../../src/components/desktop/DesktopDashboard';
import { fileQueryKey, type FolderLoadChunk, type FolderLoadResult } from '../../src/services/fileListRefresh';
import type { TelegramFile } from '../../src/types';
import '../../src/i18n';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), sync: vi.fn(),
  connection: { accountId: '100' as string | null, activeFolderId: 42 as number | null },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/hooks/useTelegramConnection', () => ({ useTelegramConnection: () => ({
  ...mocks.connection, store: {}, folders: [{ id: 42, name: 'Folder' }], groups: [],
  isConnected: true, isSyncing: false, setActiveFolderId: vi.fn(), handleSyncFolders: mocks.sync,
}) }));
vi.mock('../../src/context/SettingsContext', async () => {
  const { DEFAULT_SETTINGS } = await import('../../src/config/defaultSettings');
  return { useSettings: () => ({ settings: { ...DEFAULT_SETTINGS, driveTourSeen: true }, updateSetting: vi.fn(), updateSettings: vi.fn(), isLoaded: true }) };
});
vi.mock('../../src/context/ConfirmContext', () => ({ useConfirm: () => ({ confirm: vi.fn() }) }));
vi.mock('../../src/context/SupporterContext', () => ({ useSupporter: () => ({ status: { state: 'inactive', ad_free: false } }) }));
vi.mock('../../src/hooks/useFileUpload', () => ({ useFileUpload: () => ({ uploadQueue: [] }) }));
vi.mock('../../src/hooks/useFileDownload', () => ({ useFileDownload: () => ({ downloadQueue: [], queueBulkDownload: vi.fn() }) }));
vi.mock('../../src/hooks/useGlobalFileSearch', () => ({ useGlobalFileSearch: () => ({ results: [], isSearching: false }) }));
vi.mock('../../src/components/desktop/dashboard/Sidebar', () => ({ Sidebar: (props: any) => <nav>
  <button onClick={() => props.onSmartViewChange(null)}>Open folder</button>
  <button onClick={() => props.onSmartViewChange('recents')}>Open recents</button>
  <button onClick={() => props.onSmartViewChange('large')}>Open large</button>
  <button onClick={() => props.onSmartViewChange('offline')}>Open offline</button>
  <button onClick={props.onSync}>Refresh folder</button>
</nav> }));
vi.mock('../../src/components/desktop/dashboard/FileExplorer', () => ({ FileExplorer: (props: any) => <section aria-label="Files">
  <output data-testid="scan-state">{props.syncProgress.active ? 'scanning' : 'settled'}</output>
  {props.files.map((file: TelegramFile) => <div key={`${file.folder_id}:${file.id}`}><p>{file.name}</p>
    <button onClick={() => props.onToggleFavorite(file)}>Favorite {file.name}</button>
    <button onClick={() => props.onTogglePinned(file)}>Pin {file.name}</button>
    <output data-testid={`favorite-${file.id}`}>{String(Boolean(file.is_favorite))}</output>
  </div>)}
  {props.error && <p role="alert">{String(props.error)}</p>}
</section> }));
vi.mock('../../src/components/desktop/dashboard/TopBar', () => ({ TopBar: () => null }));
vi.mock('../../src/components/desktop/dashboard/TransferCenter', () => ({ TransferCenter: () => null }));
vi.mock('../../src/components/desktop/dashboard/ExternalDropBlocker', () => ({ ExternalDropBlocker: () => null }));
vi.mock('../../src/components/desktop/dashboard/DesktopAdBanner', () => ({ DesktopAdBanner: () => null }));
vi.mock('../../src/components/desktop/sync/SyncDashboard', () => ({ SyncDashboard: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const file = (id: number, name: string, folder_id: number | null = 42): TelegramFile => ({ id, folder_id, name, size: 1, sizeStr: '1 B' });
type Request = { ownerId: string; folderId: number | null; requestId: string };
type Scan = { request: Request; response: ReturnType<typeof deferred<FolderLoadResult>> };

describe('DesktopDashboard refresh reconciliation', () => {
  let scans: Scan[];
  let handlers: Array<(event: { payload: FolderLoadChunk }) => void>;
  let client: QueryClient;
  let cacheRead: (request: Request) => Promise<TelegramFile[]>;
  const terminal = (scan: Scan, files: TelegramFile[], complete = true) => scan.response.resolve({ ...scan.request, complete, files });
  const emit = (scan: Scan, files: TelegramFile[]) => handlers.forEach(handler => handler({ payload: { ...scan.request, files } }));
  const mount = () => render(<QueryClientProvider client={client}><Dashboard onLogout={vi.fn()} /></QueryClientProvider>);
  const rerender = (view: ReturnType<typeof mount>) => view.rerender(<QueryClientProvider client={client}><Dashboard onLogout={vi.fn()} /></QueryClientProvider>);
  const open = async () => { fireEvent.click(screen.getByRole('button', { name: 'Open folder' })); await waitFor(() => expect(scans).toHaveLength(1)); return scans[0]; };
  const names = () => [...screen.getByRole('region', { name: 'Files' }).querySelectorAll('p')].map(node => node.textContent);

  beforeEach(() => {
    scans = [];
    handlers = [];
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    mocks.connection = { accountId: '100', activeFolderId: 42 };
    mocks.sync.mockReset().mockResolvedValue(undefined);
    cacheRead = async request => request.ownerId === '100' ? [file(1, 'A.txt'), file(2, 'B.txt')] : [file(2, 'Other account.txt')];
    mocks.invoke.mockReset().mockImplementation((command: string, request: Request) => {
      if (command === 'cmd_get_cached_files') return cacheRead(request);
      if (command === 'cmd_get_files') { const response = deferred<FolderLoadResult>(); scans.push({ request, response }); return response.promise; }
      if (command === 'cmd_get_file_activity') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    mocks.listen.mockReset().mockImplementation(async (event: string, handler: (event: { payload: FolderLoadChunk }) => void) => {
      if (event === 'folder-load-chunk') handlers.push(handler);
      // Retain the function to simulate an event already queued before unlisten.
      return vi.fn();
    });
  });

  it('replaces cached A+B with remote B after one successful scan, including missing chunk delivery', async () => {
    mount();
    const scan = await open();
    expect(names()).toEqual(['A.txt', 'B.txt']);
    await act(async () => terminal(scan, [file(2, 'B refreshed.txt')]));
    await waitFor(() => expect(names()).toEqual(['B refreshed.txt']));
    expect(client.getQueryData<TelegramFile[]>(fileQueryKey('100', 42))?.map(file => file.id)).toEqual([2]);
    act(() => emit(scan, [file(1, 'Late A.txt')]));
    expect(names()).toEqual(['B refreshed.txt']);
  });

  it('keeps cached A when a scan fails after returning only B and C', async () => {
    mount();
    const scan = await open();
    act(() => emit(scan, [file(2, 'B refreshed.txt'), file(3, 'C.txt')]));
    await act(async () => scan.response.reject(new Error('offline')));
    await waitFor(() => expect(screen.getByTestId('scan-state').textContent).toBe('settled'));
    expect(names()).toEqual(['A.txt', 'B refreshed.txt', 'C.txt']);
  });

  it('rejects late work after switching accounts, including A→B→A', async () => {
    const view = mount();
    const firstA = await open();
    mocks.connection.accountId = '200';
    rerender(view);
    await waitFor(() => expect(scans).toHaveLength(2));
    expect(names()).toEqual(['Other account.txt']);
    mocks.connection.accountId = '100';
    rerender(view);
    await waitFor(() => expect(scans).toHaveLength(3));
    const currentA = scans[2];
    await act(async () => { terminal(currentA, [file(2, 'Current A.txt')]); });
    await waitFor(() => expect(names()).toEqual(['Current A.txt']));
    await act(async () => {
      emit(firstA, [file(7, 'Late first A.txt')]);
      terminal(firstA, [file(7, 'Late first A.txt')]);
      emit(scans[1], [file(8, 'Late B.txt')]);
      terminal(scans[1], [file(8, 'Late B.txt')]);
    });
    expect(names()).toEqual(['Current A.txt']);
  });

  it('lets a newer refresh supersede an in-flight generation without accepting its late chunks', async () => {
    mount();
    const old = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh folder' }));
    await waitFor(() => expect(scans).toHaveLength(2));
    expect(scans[1].request.requestId).not.toBe(old.request.requestId);
    await act(async () => terminal(scans[1], [file(2, 'Newest.txt')]));
    await waitFor(() => expect(names()).toEqual(['Newest.txt']));
    await act(async () => { emit(old, [file(1, 'Stale.txt')]); terminal(old, [file(1, 'Stale.txt')]); });
    expect(names()).toEqual(['Newest.txt']);
  });

  it('does not overwrite a smart view when its previous folder scan finishes', async () => {
    mount();
    const scan = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Open recents' }));
    await waitFor(() => expect(names()).toEqual([]));
    await act(async () => { emit(scan, [file(7, 'Old folder.txt')]); terminal(scan, [file(7, 'Old folder.txt')]); });
    expect(names()).toEqual([]);
    expect(screen.getByTestId('scan-state').textContent).toBe('settled');
  });

  it('does not repopulate a query from late chunks after Dashboard unmounts', async () => {
    const view = mount();
    const scan = await open();
    view.unmount();
    const snapshot = client.getQueryData(fileQueryKey('100', 42));
    await act(async () => { emit(scan, [file(9, 'After close.txt')]); terminal(scan, [file(9, 'After close.txt')]); });
    expect(client.getQueryData(fileQueryKey('100', 42))).toEqual(snapshot);
  });
  it('binds activity, storage-insight and offline smart reads to their account', async () => {
    mocks.invoke.mockImplementation((command: string) => Promise.resolve(command === 'cmd_get_storage_insight' ? { files: [] } : []));
    const view = mount();
    for (const [label, command] of [['Open recents','cmd_get_file_activity'],['Open large','cmd_get_storage_insight'],['Open offline','cmd_get_offline_files']]) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(mocks.invoke.mock.calls.some(([name,args]) => name === command && args.ownerId === '100')).toBe(true));
    }
    mocks.connection.accountId = '200'; rerender(view);
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([name,args]) => name === 'cmd_get_offline_files' && args.ownerId === '200')).toBe(true));
  });

  it('writes the owning account and Saved Messages source and updates only matching owner queries', async () => {
    mocks.connection.activeFolderId = null;
    mount(); const scan = await open();
    const saved = file(42,'Saved.txt',null);
    await act(async () => terminal(scan,[saved]));
    await waitFor(() => expect(names()).toEqual(['Saved.txt']));
    client.setQueryData(fileQueryKey('200',null),[saved]);
    fireEvent.click(screen.getByRole('button',{name:'Favorite Saved.txt'}));
    await waitFor(() => expect(screen.getByTestId('favorite-42').textContent).toBe('true'));
    expect(mocks.invoke).toHaveBeenCalledWith('cmd_set_file_activity_flag',expect.objectContaining({ownerId:'100',folderId:null,messageId:42,flag:'favorite',value:true}));
    expect(client.getQueryData<TelegramFile[]>(fileQueryKey('200',null))?.[0].is_favorite).toBeUndefined();
  });

  it('ignores a late favorite mutation across account A→B→A', async () => {
    const mutation = deferred<void>();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string,args: Request) => command === 'cmd_set_file_activity_flag' ? mutation.promise : original(command,args));
    const view = mount(); const scan = await open();
    await act(async () => terminal(scan,[file(2,'Current.txt')]));
    await waitFor(() => expect(names()).toEqual(['Current.txt']));
    fireEvent.click(screen.getByRole('button',{name:'Favorite Current.txt'}));
    mocks.connection.accountId='200'; rerender(view);
    await waitFor(() => expect(scans).toHaveLength(2));
    mocks.connection.accountId='100'; rerender(view);
    await waitFor(() => expect(scans).toHaveLength(3));
    await act(async () => terminal(scans[2],[file(2,'Current.txt')]));
    await waitFor(() => expect(names()).toEqual(['Current.txt']));
    await act(async () => mutation.resolve());
    expect(screen.getByTestId('favorite-2').textContent).toBe('false');
  });

});
