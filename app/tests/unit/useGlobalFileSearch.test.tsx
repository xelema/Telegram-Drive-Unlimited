import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalFileSearch } from '../../src/hooks/useGlobalFileSearch';
import type { TelegramFile } from '../../src/types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const file = (name: string): TelegramFile => ({ id: 1, folder_id: 2, name, size: 1, sizeStr: '' });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });

describe('global search lifecycle', () => {
    beforeEach(() => { vi.useFakeTimers(); invoke.mockReset(); });
    afterEach(() => vi.useRealTimers());

    it('debounces typing and normalizes returned file metadata', async () => {
        invoke.mockResolvedValue([file('report.pdf')]);
        const { result, rerender } = renderHook(({ query }) => useGlobalFileSearch(query, 'all', 'account-a'), { initialProps: { query: 're' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        rerender({ query: ' report ' });
        expect(invoke).not.toHaveBeenCalled();
        await tick();
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith('cmd_search_global', { query: 'report', ownerId: 'account-a' });
        expect(result.current.results[0]).toMatchObject({ name: 'report.pdf', sizeStr: '1 Bytes', type: 'file' });
        expect(result.current.isSearching).toBe(false);
    });

    it('keeps the newest results when the older request finishes last', async () => {
        const first = deferred<TelegramFile[]>();
        const second = deferred<TelegramFile[]>();
        invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { result, rerender } = renderHook(({ query }) => useGlobalFileSearch(query, 'all', 'account-a'), { initialProps: { query: 'first' } });
        await tick();
        rerender({ query: 'second' });
        expect(result.current.results).toEqual([]);
        await tick();
        await act(async () => second.resolve([file('second.pdf')]));
        await act(async () => first.resolve([file('first.pdf')]));
        expect(result.current.results.map(row => row.name)).toEqual(['second.pdf']);
        expect(result.current.isSearching).toBe(false);
    });

    it('does not settle a newer search when an obsolete request fails', async () => {
        const first = deferred<TelegramFile[]>();
        const second = deferred<TelegramFile[]>();
        invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { result, rerender } = renderHook(({ query }) => useGlobalFileSearch(query, 'all', 'account-a'), { initialProps: { query: 'first' } });
        await tick();
        rerender({ query: 'second' });
        await tick();
        await act(async () => first.reject(new Error('old connection failure')));
        expect(result.current.isSearching).toBe(true);
        await act(async () => second.resolve([file('second.pdf')]));
        expect(result.current.isSearching).toBe(false);
        expect(result.current.results.map(row => row.name)).toEqual(['second.pdf']);
    });

    it.each(['clear', 'folder', 'unmount'] as const)('discards a late response after %s', async action => {
        const request = deferred<TelegramFile[]>();
        invoke.mockReturnValue(request.promise);
        const { result, rerender, unmount } = renderHook(
            ({ query, scope }: { query: string; scope: 'all' | 'folder' }) => useGlobalFileSearch(query, scope, 'account-a'),
            { initialProps: { query: 'report', scope: 'all' as 'all' | 'folder' } },
        );
        await tick();
        if (action === 'unmount') unmount();
        else rerender({ query: action === 'clear' ? '' : 'report', scope: action === 'folder' ? 'folder' : 'all' });
        await act(async () => request.resolve([file('report.pdf')]));
        if (action !== 'unmount') {
            expect(result.current).toEqual({ results: [], isSearching: false });
        }
    });
    it('discards late results when accounts switch with identical search text', async () => {
        const accountA = deferred<TelegramFile[]>();
        const accountB = deferred<TelegramFile[]>();
        invoke.mockReturnValueOnce(accountA.promise).mockReturnValueOnce(accountB.promise);
        const { result, rerender } = renderHook(({ owner }) => useGlobalFileSearch('report', 'all', owner), { initialProps: { owner: 'account-a' } });
        await tick();
        expect(invoke).toHaveBeenLastCalledWith('cmd_search_global', { query: 'report', ownerId: 'account-a' });
        rerender({ owner: 'account-b' });
        expect(result.current.results).toEqual([]);
        await tick();
        expect(invoke).toHaveBeenLastCalledWith('cmd_search_global', { query: 'report', ownerId: 'account-b' });
        await act(async () => accountB.resolve([file('B-private.pdf')]));
        await act(async () => accountA.resolve([file('A-private.pdf')]));
        expect(result.current.results.map(row => row.name)).toEqual(['B-private.pdf']);
    });

    it('hides cached results immediately on account switch and never searches without an owner', async () => {
        invoke.mockResolvedValueOnce([file('A-private.pdf')]);
        const { result, rerender } = renderHook(({ owner }: { owner: string | null }) => useGlobalFileSearch('report', 'all', owner), { initialProps: { owner: 'account-a' as string | null } });
        await tick();
        expect(result.current.results.map(row => row.name)).toEqual(['A-private.pdf']);
        rerender({ owner: 'account-b' });
        expect(result.current.results).toEqual([]);
        rerender({ owner: null });
        await tick();
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(result.current).toEqual({ results: [], isSearching: false });
    });

    it('does not settle another account search when an obsolete request rejects', async () => {
        const accountA = deferred<TelegramFile[]>();
        const accountB = deferred<TelegramFile[]>();
        invoke.mockReturnValueOnce(accountA.promise).mockReturnValueOnce(accountB.promise);
        const { result, rerender } = renderHook(({ owner }) => useGlobalFileSearch('report', 'all', owner), { initialProps: { owner: 'account-a' } });
        await tick();
        rerender({ owner: 'account-b' });
        await tick();
        await act(async () => accountA.reject(new Error('ACCOUNT_CHANGED')));
        expect(result.current.isSearching).toBe(true);
        await act(async () => accountB.resolve([file('B-private.pdf')]));
        expect(result.current.results.map(row => row.name)).toEqual(['B-private.pdf']);
        expect(result.current.isSearching).toBe(false);
    });

    it('does not revive an obsolete request after switching away and back to the same account', async () => {
        const oldA = deferred<TelegramFile[]>();
        const accountB = deferred<TelegramFile[]>();
        const newA = deferred<TelegramFile[]>();
        invoke.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(accountB.promise).mockReturnValueOnce(newA.promise);
        const { result, rerender } = renderHook(({ owner }) => useGlobalFileSearch('report', 'all', owner), { initialProps: { owner: 'account-a' } });
        await tick();
        rerender({ owner: 'account-b' }); await tick();
        rerender({ owner: 'account-a' }); await tick();
        await act(async () => newA.resolve([file('new-A.pdf')]));
        await act(async () => oldA.resolve([file('obsolete-A.pdf')]));
        await act(async () => accountB.resolve([file('B-private.pdf')]));
        expect(result.current.results.map(row => row.name)).toEqual(['new-A.pdf']);
    });

});
