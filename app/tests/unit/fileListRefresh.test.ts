import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  isCurrentFolderLoadChunk,
  mergeFileChunk,
  refreshFolderFiles,
  invalidateFolderFileQueries,
  fileQueryKey,
  type FolderLoadChunk,
  type FolderLoadResult,
} from '../../src/services/fileListRefresh';
import type { TelegramFile } from '../../src/types';
import { QueryClient } from '@tanstack/react-query';
import { updateFileQueryData } from '../../src/services/fileListRefresh';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));

const chunk = (folderId: number | null, requestId: string): FolderLoadChunk => ({
  ownerId: '100',
  folderId,
  requestId,
  files: [{ id: 2, name: 'new.txt', size: 200, sizeStr: '', icon_type: 'file' }],
});

describe('file list refresh generations', () => {
  it('rejects chunks from stale requests and other folders', () => {
    expect(isCurrentFolderLoadChunk(chunk(42, 'current'), 42, 'current', '100')).toBe(true);
    expect(isCurrentFolderLoadChunk(chunk(42, 'stale'), 42, 'current', '100')).toBe(false);
    expect(isCurrentFolderLoadChunk(chunk(7, 'current'), 42, 'current', '100')).toBe(false);
    expect(isCurrentFolderLoadChunk(chunk(42, 'current'), 42, 'current', '200')).toBe(false);
  });

  it('merges refreshed files without clearing cached rows', () => {
    const files = new Map<number, TelegramFile>([
      [1, { id: 1, name: 'cached.txt', size: 100, sizeStr: '100 B', type: 'file' }],
      [2, { id: 2, name: 'old.txt', size: 150, sizeStr: '150 B', type: 'file' }],
    ]);

    const merged = mergeFileChunk(files, chunk(42, 'current').files);
    expect(merged.map(file => file.name)).toEqual(['cached.txt', 'new.txt']);
    expect(merged[1].sizeStr).toBe('200 Bytes');
  });

  it('updates only the matching folder when message IDs overlap', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<TelegramFile[]>(['files', 'folder', 42], [
      { id: 7, folder_id: 42, name: 'source.txt', size: 1, sizeStr: '1 B' },
    ]);
    queryClient.setQueryData<TelegramFile[]>(['files', 'folder', 99], [
      { id: 7, folder_id: 99, name: 'other.txt', size: 1, sizeStr: '1 B' },
    ]);

    updateFileQueryData(queryClient, 42, new Set([7]), () => null);
    expect(queryClient.getQueryData(['files', 'folder', 42])).toEqual([]);
    expect(queryClient.getQueryData<TelegramFile[]>(['files', 'folder', 99])?.[0].name).toBe('other.txt');
  });

  it('invalidates desktop and mobile folder keys including their account suffixes', async () => {
    const queryClient = new QueryClient();
    const matching = [fileQueryKey('100', 42), fileQueryKey('200', 42), ['files', 42, '100'], ['files', 'folder', 42], ['files', 42]];
    for (const key of matching) queryClient.setQueryData(key, []);
    const other = fileQueryKey('100', 99);
    queryClient.setQueryData(other, []);
    await invalidateFolderFileQueries(queryClient, 42);
    for (const key of matching) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const listed = (id: number, name = `${id}.txt`): TelegramFile => ({ id, folder_id: 42, name, size: 100, sizeStr: '100 B' });
const cached = [listed(1, 'A.txt'), listed(2, 'B-old.txt')];

describe('authoritative folder refresh', () => {
  let emit: (payload: FolderLoadChunk) => void;
  let stop: ReturnType<typeof vi.fn>;
  let terminal: ReturnType<typeof deferred<FolderLoadResult>>;
  let abort: AbortController;
  let current: boolean;
  let onFiles: ReturnType<typeof vi.fn>;
  let onProgress: ReturnType<typeof vi.fn>;
  const result = (files: TelegramFile[], complete = true): FolderLoadResult => ({ ownerId: '100', folderId: 42, requestId: 'current', complete, files });
  const start = (previous?: TelegramFile[]) => refreshFolderFiles({
    ownerId: '100', folderId: 42, requestId: 'current', signal: abort.signal,
    isCurrent: () => current, cachedFiles: previous, onFiles, onProgress,
  });
  const started = () => waitFor(() => expect(native.invoke).toHaveBeenCalledWith('cmd_get_files', { ownerId: '100', folderId: 42, requestId: 'current' }));

  beforeEach(() => {
    current = true;
    abort = new AbortController();
    onFiles = vi.fn();
    onProgress = vi.fn();
    stop = vi.fn();
    terminal = deferred<FolderLoadResult>();
    native.invoke.mockReset().mockImplementation((command: string) => command === 'cmd_get_cached_files' ? Promise.resolve(cached) : terminal.promise);
    native.listen.mockReset().mockImplementation(async (_event, handler) => { emit = payload => handler({ payload }); return stop; });
  });

  it('shows A+B during streaming and removes absent A only after a complete remote B snapshot', async () => {
    const pending = start();
    await started();
    expect(onFiles).toHaveBeenLastCalledWith(expect.arrayContaining(cached.map(file => expect.objectContaining({ id: file.id }))));
    emit(result([listed(2, 'B-new.txt')]));
    expect(onFiles.mock.calls.at(-1)?.[0].map((file: TelegramFile) => file.name)).toEqual(['A.txt', 'B-new.txt']);
    terminal.resolve(result([listed(2, 'B-new.txt')]));
    expect((await pending).map(file => file.name)).toEqual(['B-new.txt']);
    expect(onProgress).toHaveBeenLastCalledWith({ active: false, count: 1 });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('uses the terminal snapshot even when final chunks arrive after command completion', async () => {
    const pending = start();
    await started();
    terminal.resolve(result([listed(3, 'New-remote.txt')]));
    expect((await pending).map(file => file.name)).toEqual(['New-remote.txt']);
    const published = onFiles.mock.calls.length;
    emit(result([listed(1, 'Late-A.txt')]));
    expect(onFiles).toHaveBeenCalledTimes(published);
  });

  it('accepts a complete empty folder as authoritative', async () => {
    const pending = start();
    await started();
    terminal.resolve(result([]));
    expect(await pending).toEqual([]);
  });

  it.each(['failed', 'incomplete'])('preserves cached originals and fresh partial rows after a %s scan', async outcome => {
    const pending = start();
    await started();
    emit(result([listed(2, 'B-new.txt'), listed(3, 'C.txt')]));
    if (outcome === 'failed') terminal.reject(new Error('Telegram is offline'));
    else terminal.resolve(result([], false));
    expect((await pending).map(file => file.name)).toEqual(['A.txt', 'B-new.txt', 'C.txt']);
  });

  it('retains the previous query rows when both the cache read and remote refresh fail', async () => {
    native.invoke.mockImplementation((command: string) => command === 'cmd_get_cached_files' ? Promise.reject(new Error('disk busy')) : terminal.promise);
    const pending = start(cached);
    await started();
    terminal.reject(new Error('offline'));
    expect((await pending).map(file => file.name)).toEqual(['A.txt', 'B-old.txt']);
  });

  it('ignores chunks from another owner, folder, or request', async () => {
    const pending = start();
    await started();
    const published = onFiles.mock.calls.length;
    emit({ ...result([listed(5)]), ownerId: '200' });
    emit({ ...result([listed(6)]), requestId: 'old' });
    emit({ ...result([listed(7)]), folderId: null });
    expect(onFiles).toHaveBeenCalledTimes(published);
    terminal.resolve(result([], false));
    expect((await pending).map(file => file.id)).toEqual([1, 2]);
  });

  it('rejects a foreign-account terminal response and hides the stale displayed account', async () => {
    const pending = start();
    const rejected = expect(pending).rejects.toThrow('ACCOUNT_CHANGED');
    await started();
    terminal.resolve({ ...result([listed(3)]), ownerId: '200' });
    await rejected;
    expect(onFiles).toHaveBeenLastCalledWith([]);
  });

  it.each(['stale source', 'abort'])('cannot publish or reconcile a late %s completion', async reason => {
    const pending = start();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started();
    const published = onFiles.mock.calls.length;
    if (reason === 'abort') { abort.abort(); expect(stop).toHaveBeenCalledOnce(); }
    else current = false;
    emit(result([listed(9)]));
    terminal.resolve(result([listed(9)]));
    await rejected;
    expect(onFiles).toHaveBeenCalledTimes(published);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not publish a late cached response or start a remote scan after cancellation', async () => {
    const cache = deferred<TelegramFile[]>();
    native.invoke.mockReturnValue(cache.promise);
    const pending = start();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    cache.resolve(cached);
    await rejected;
    expect(onFiles).not.toHaveBeenCalled();
    expect(native.listen).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledOnce();
  });
});
