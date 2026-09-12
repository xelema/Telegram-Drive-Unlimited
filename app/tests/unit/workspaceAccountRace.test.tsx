import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../../src/hooks/useWorkspace';
import type { WorkspaceSnapshot } from '../../src/services/workspace';

const mocks = vi.hoisted(() => ({ account: vi.fn(), read: vi.fn(), mutate: vi.fn(), index: vi.fn() }));
vi.mock('../../src/services/currentAccount', () => ({ getCurrentAccountId: mocks.account }));
vi.mock('../../src/services/workspace', () => ({ readWorkspace: mocks.read, mutateWorkspace: mocks.mutate, indexWorkspace: mocks.index }));
const snapshot = (ownerId = '1', name = ''): WorkspaceSnapshot => ({ ownerId, files: [], collections: [], searches: [], scans: [{ folderId: null, folderName: name, complete: true, updatedAt: 1 }] });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(() => useWorkspace(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    return { ...hook, client };
}
describe('workspace asynchronous account boundaries', () => {
    beforeEach(() => {
        mocks.account.mockReset().mockResolvedValue('1');
        mocks.read.mockReset().mockImplementation(async owner => snapshot(owner));
        mocks.mutate.mockReset(); mocks.index.mockReset();
    });
    it('ignores an obsolete account lookup after a newer account is known', async () => {
        const old = deferred<string>(); mocks.account.mockReturnValueOnce(old.promise);
        const { result } = setup();
        mocks.account.mockResolvedValue('2');
        await act(async () => result.current.refreshAccount());
        expect(result.current.ownerId).toBe('2');
        await act(async () => old.resolve('1'));
        expect(result.current.ownerId).toBe('2');
    });
    it('does not clear a new account when the old account mutation fails late', async () => {
        const pending = deferred<WorkspaceSnapshot>(); mocks.mutate.mockReturnValue(pending.promise);
        const { result, client } = setup(); await waitFor(() => expect(result.current.data?.ownerId).toBe('1'));
        let mutation!: Promise<unknown>;
        await act(async () => { mutation = result.current.mutate({ type: 'favorite', key: 'saved:42', value: true }).catch(error => error); });
        mocks.account.mockResolvedValue('2'); await act(async () => result.current.refreshAccount());
        await act(async () => { pending.reject(new Error('ACCOUNT_CHANGED')); await mutation; });
        expect(result.current.ownerId).toBe('2'); expect(result.current.accountError).toBeNull();
        expect(client.getQueryData<WorkspaceSnapshot>(['workspace', '2'])?.ownerId).toBe('2');
    });
    it('does not replace a newer index with an older scan response', async () => {
        const older = deferred<WorkspaceSnapshot>(); const newer = deferred<WorkspaceSnapshot>();
        mocks.index.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        const { result, client } = setup(); await waitFor(() => expect(result.current.data?.ownerId).toBe('1'));
        vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
        let first!: Promise<unknown>; let second!: Promise<unknown>;
        act(() => { first = result.current.index([null]); second = result.current.index([9]); });
        await act(async () => { newer.resolve(snapshot('1', 'newer')); await second; });
        await act(async () => { older.resolve(snapshot('1', 'older')); await first; });
        expect(result.current.data?.scans[0].folderName).toBe('newer');
    });
    it('does not let a pending account lookup restore an account rejected by the backend', async () => {
        const { result } = setup(); await waitFor(() => expect(result.current.data?.ownerId).toBe('1'));
        const lookup = deferred<string>(); mocks.account.mockReturnValueOnce(lookup.promise);
        let refresh!: Promise<void>; act(() => { refresh = result.current.refreshAccount(); });
        mocks.mutate.mockRejectedValue(new Error('ACCOUNT_CHANGED'));
        await act(async () => { await result.current.mutate({ type: 'favorite', key: 'saved:42', value: true }).catch(() => undefined); });
        await act(async () => { lookup.resolve('1'); await refresh; });
        expect(result.current.ownerId).toBeNull();
        expect(result.current.accountError).toContain('ACCOUNT_CHANGED');
    });
    it('hides cached account data when a background read rejects the account', async () => {
        const { result } = setup(); await waitFor(() => expect(result.current.data?.ownerId).toBe('1'));
        mocks.read.mockRejectedValue(new Error('ACCOUNT_CHANGED'));
        await act(async () => { await result.current.refetch(); });
        await waitFor(() => expect(result.current.ownerId).toBeNull());
        expect(result.current.data).toBeUndefined();
    });
});
