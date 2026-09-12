import type { TelegramFile } from '../types';
import type { QueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { formatBytes } from '../utils';

type ListedFile = TelegramFile & { icon_type?: TelegramFile['type'] };

export interface FolderLoadChunk {
  ownerId: string;
  folderId: number | null;
  requestId: string;
  files: ListedFile[];
}

export interface FolderLoadResult extends FolderLoadChunk {
  complete: boolean;
}

export function isCurrentFolderLoadChunk(
  payload: FolderLoadChunk,
  folderId: number | null,
  requestId: string,
  ownerId: string,
): boolean {
  return payload.ownerId === ownerId && payload.folderId === folderId && payload.requestId === requestId;
}

export function normalizeListedFile(
  file: TelegramFile & { icon_type?: TelegramFile['type'] },
): TelegramFile {
  return {
    ...file,
    sizeStr: formatBytes(file.size),
    type: file.icon_type ?? file.type ?? 'file',
  };
}

export function mergeFileChunk(
  files: Map<number, TelegramFile>,
  chunk: Array<TelegramFile & { icon_type?: TelegramFile['type'] }>,
): TelegramFile[] {
  for (const file of chunk) {
    const normalized = normalizeListedFile(file);
    files.set(normalized.id, normalized);
  }
  return Array.from(files.values());
}

export function fileQueryKey(ownerId: string | null, folderId: number | null, view = 'folder') {
  // Keep the existing prefix so mutation invalidation also reaches account-scoped queries.
  return ['files', view, folderId, ownerId] as const;
}

interface FolderRefreshOptions {
  ownerId: string;
  folderId: number | null;
  requestId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  cachedFiles?: TelegramFile[];
  onFiles: (files: TelegramFile[]) => void;
  onProgress: (progress: { active: boolean; count: number }) => void;
}

/** Retain cached rows while streaming. Only the matching, authoritative terminal
 * snapshot can prune them; event delivery order is never a completion signal. */
export async function refreshFolderFiles(options: FolderRefreshOptions): Promise<TelegramFile[]> {
  const { ownerId, folderId, requestId, signal, onFiles, onProgress } = options;
  const files = new Map<number, TelegramFile>();
  let closed = false;
  let unlisten: (() => void) | undefined;
  const isCurrent = () => !closed && !signal.aborted && options.isCurrent();
  const check = () => { if (!isCurrent()) throw new DOMException('File refresh was cancelled', 'AbortError'); };
  const close = () => { closed = true; unlisten?.(); unlisten = undefined; };
  const sourceFiles = (values: ListedFile[]) => values.map(file => {
    if (file.folder_id !== undefined && file.folder_id !== folderId) throw new Error('File refresh returned a different folder');
    return { ...file, folder_id: folderId };
  });
  const publish = (values: ListedFile[]) => {
    check();
    const next = mergeFileChunk(files, sourceFiles(values));
    onFiles(next);
    onProgress({ active: true, count: next.length });
  };
  mergeFileChunk(files, sourceFiles(options.cachedFiles ?? []));
  signal.addEventListener('abort', close, { once: true });
  try {
    check();
    try {
      const cached = await invoke<ListedFile[]>('cmd_get_cached_files', { folderId, ownerId });
      publish(cached);
    } catch (error) {
      check();
      if (/ACCOUNT_/.test(String(error))) throw error;
      // A temporary cache read failure must not discard the query's previous rows.
      onProgress({ active: true, count: files.size });
    }
    const stop = await listen<FolderLoadChunk>('folder-load-chunk', ({ payload }) => {
      if (!isCurrent() || !isCurrentFolderLoadChunk(payload, folderId, requestId, ownerId)) return;
      // A malformed/foreign chunk cannot establish an authoritative result.
      if (!Array.isArray(payload.files) || payload.files.some(file => file.folder_id !== undefined && file.folder_id !== folderId)) return;
      publish(payload.files);
    });
    unlisten = stop;
    if (!isCurrent()) { stop(); unlisten = undefined; check(); }
    const result = await invoke<FolderLoadResult>('cmd_get_files', { folderId, requestId, ownerId });
    check();
    if (!result || typeof result.ownerId !== 'string') throw new Error('File refresh did not return its account identity');
    if (result.ownerId !== ownerId) throw new Error('ACCOUNT_CHANGED');
    if (!isCurrentFolderLoadChunk(result, folderId, requestId, ownerId)) throw new Error('File refresh returned a different request');
    if (result.complete === true) {
      if (!Array.isArray(result.files)) throw new Error('File refresh did not return a completed snapshot');
      const authoritative = sourceFiles(result.files);
      files.clear();
      return mergeFileChunk(files, authoritative);
    }
    return Array.from(files.values());
  } catch (error) {
    check();
    if (/ACCOUNT_/.test(String(error))) { onFiles([]); throw error; }
    if (files.size > 0) return Array.from(files.values());
    throw error;
  } finally {
    if (isCurrent()) onProgress({ active: false, count: files.size });
    close();
    signal.removeEventListener('abort', close);
  }
}

export function updateFileQueryData(
  queryClient: QueryClient,
  folderId: number | null,
  messageIds: ReadonlySet<number>,
  update: (file: TelegramFile) => TelegramFile | null,
  ownerId?: string,
): void {
  queryClient.setQueriesData<TelegramFile[]>({ queryKey: ['files'],
    predicate: query => ownerId === undefined || query.queryKey.length >= 3 && query.queryKey[query.queryKey.length - 1] === ownerId,
  }, current => {
    if (!current) return current;
    let changed = false;
    const next = current.flatMap(file => {
      if ((file.folder_id ?? null) !== folderId || !messageIds.has(file.id)) return [file];
      changed = true;
      const updated = update(file);
      return updated ? [updated] : [];
    });
    return changed ? next : current;
  });
}

export async function invalidateFolderFileQueries(
  queryClient: QueryClient,
  folderId: number | null,
  ownerId?: string,
): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) => ownerId === undefined || query.queryKey[query.queryKey.length - 1] === ownerId;
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['files', 'folder', folderId], predicate }),
    queryClient.invalidateQueries({ queryKey: ['files', folderId], predicate }),
  ]);
}


export async function invalidateOwnedFileQueries(queryClient: QueryClient, ownerId: string): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['files'], predicate: query => query.queryKey.length >= 3 && query.queryKey[query.queryKey.length - 1] === ownerId });
}
