import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/i18n';
import { useFileOperations } from '../../src/hooks/useFileOperations';
import { fileQueryKey } from '../../src/services/fileListRefresh';
import type { TelegramFile } from '../../src/types';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(), success: vi.fn(), error: vi.fn(), select: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/context/ConfirmContext', () => ({ useConfirm: () => ({ confirm: mocks.confirm }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error, info: vi.fn() } }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const file = (name = 'original', folder_id: number | null = null, id = 42): TelegramFile => ({ id, name, folder_id, size: 1, sizeStr: '1 B' });
function setup(owner = 'A', files = [file()], selected = [42]) {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(({ account, values, ids, folder }) => useFileOperations(folder, ids, mocks.select, values, undefined, account), {
        wrapper, initialProps: { account: owner, values: files, ids: selected, folder: 9 },
    });
    return { ...hook, client };
}
beforeEach(() => { vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true); mocks.invoke.mockResolvedValue(undefined); });

describe('file mutation ownership across confirmations and responses', () => {
    it.each(['single', 'bulk'] as const)('does not reinterpret an account A %s delete confirmation as B’s same-numbered file', async kind => {
        const confirmation = deferred<boolean>(); mocks.confirm.mockReturnValue(confirmation.promise);
        const { result, rerender } = setup();
        let pending!: Promise<void>;
        act(() => { pending = kind === 'single' ? result.current.handleDelete(42) : result.current.handleBulkDelete(); });
        rerender({ account: 'B', values: [file('B-private', 7)], ids: [42], folder: 7 });
        await act(async () => { confirmation.resolve(true); await pending; });
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.select).not.toHaveBeenCalled();
        expect(mocks.success).not.toHaveBeenCalled();
    });

    it('resolves a numeric target and Saved Messages source before the confirmation, even within one account', async () => {
        const confirmation = deferred<boolean>(); mocks.confirm.mockReturnValue(confirmation.promise);
        const { result, rerender } = setup();
        let pending!: Promise<void>;
        act(() => { pending = result.current.handleDelete(42); });
        rerender({ account: 'A', values: [file('different channel', 7)], ids: [42], folder: 7 });
        await act(async () => { confirmation.resolve(true); await pending; });
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_delete_file', { ownerId: 'A', messageId: 42, folderId: null });
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });

    it('discards a late old-account delete result without removing or invalidating account B cache', async () => {
        const request = deferred<void>(); mocks.invoke.mockReturnValue(request.promise);
        const { result, rerender, client } = setup();
        const aKey = fileQueryKey('A', null); const bKey = fileQueryKey('B', null);
        client.setQueryData(aKey, [file('A-private')]); client.setQueryData(bKey, [file('B-private')]);
        let pending!: Promise<void>;
        await act(async () => { pending = result.current.handleDelete(42); await Promise.resolve(); });
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_delete_file', { ownerId: 'A', messageId: 42, folderId: null });
        rerender({ account: 'B', values: [file('B-private')], ids: [42], folder: 9 });
        await act(async () => { request.resolve(); await pending; });
        expect(client.getQueryData(bKey)).toEqual([file('B-private')]);
        expect(client.getQueryState(bKey)?.isInvalidated).toBe(false);
        expect(mocks.success).not.toHaveBeenCalled();
    });

    it('updates and invalidates only the successful initiating account’s folder and smart views', async () => {
        const { result, client } = setup();
        const a = fileQueryKey('A', null); const smart = fileQueryKey('A', null, 'favorites'); const b = fileQueryKey('B', null);
        client.setQueryData(a, [file('A-private')]); client.setQueryData(smart, [file('A-private')]); client.setQueryData(b, [file('B-private')]);
        await act(async () => result.current.handleDelete(42));
        expect(client.getQueryData(a)).toEqual([]); expect(client.getQueryData(smart)).toEqual([]);
        expect(client.getQueryData(b)).toEqual([file('B-private')]);
        expect(client.getQueryState(b)?.isInvalidated).toBe(false);
        expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['cmd_delete_file']);
    });

    it.each(['rename', 'move'] as const)('does not apply a late account A %s to B cache or selection', async kind => {
        const request = deferred<void>(); mocks.invoke.mockReturnValue(request.promise);
        const { result, rerender, client } = setup(); const onMoved = vi.fn();
        const b = fileQueryKey('B', null); client.setQueryData(b, [file('B-private')]);
        let pending!: Promise<boolean>;
        act(() => { pending = kind === 'rename' ? result.current.handleRenameFile(file(), 'new-name') : result.current.handleMoveFiles([file()], 10, onMoved); });
        expect(mocks.invoke).toHaveBeenCalledWith(kind === 'rename' ? 'cmd_rename_file' : 'cmd_move_files', expect.objectContaining({ ownerId: 'A' }));
        rerender({ account: 'B', values: [file('B-private')], ids: [42], folder: 9 });
        await act(async () => { request.resolve(); await pending; });
        expect(await pending).toBe(false);
        expect(client.getQueryData(b)).toEqual([file('B-private')]);
        expect(client.getQueryState(b)?.isInvalidated).toBe(false);
        expect(onMoved).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled();
    });

    it('rejects a large move when its original account changes during confirmation', async () => {
        const confirmation = deferred<boolean>(); mocks.confirm.mockReturnValue(confirmation.promise);
        const files = Array.from({ length: 10 }, (_, index) => file(`A-${index}`, null, index + 1));
        const { result, rerender } = setup('A', files, files.map(value => value.id));
        let pending!: Promise<boolean>;
        act(() => { pending = result.current.handleMoveFiles(files, 10, mocks.select, true); });
        rerender({ account: 'B', values: files, ids: files.map(value => value.id), folder: 9 });
        await act(async () => { confirmation.resolve(true); await pending; });
        expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
    });

    it('stops a bulk delete between files when the account changes', async () => {
        const request = deferred<void>(); mocks.invoke.mockReturnValue(request.promise);
        const files = [file('first', null, 1), file('second', 7, 2)];
        const { result, rerender } = setup('A', files, [1, 2]);
        let pending!: Promise<void>;
        await act(async () => { pending = result.current.handleBulkDelete(); await Promise.resolve(); });
        rerender({ account: 'B', values: files, ids: [1, 2], folder: 9 });
        await act(async () => { request.resolve(); await pending; });
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_delete_file', { ownerId: 'A', messageId: 1, folderId: null });
        expect(mocks.select).not.toHaveBeenCalled();
    });
});
