import type { TelegramFile } from '../types';
import type { QueryClient } from '@tanstack/react-query';
import { formatBytes } from '../utils';

export interface FolderLoadChunk {
  folderId: number | null;
  requestId: string;
  files: Array<TelegramFile & { icon_type?: TelegramFile['type'] }>;
}

export function isCurrentFolderLoadChunk(
  payload: FolderLoadChunk,
  folderId: number | null,
  requestId: string,
): boolean {
  return payload.folderId === folderId && payload.requestId === requestId;
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

export function updateFileQueryData(
  queryClient: QueryClient,
  folderId: number | null,
  messageIds: ReadonlySet<number>,
  update: (file: TelegramFile) => TelegramFile | null,
): void {
  queryClient.setQueriesData<TelegramFile[]>({ queryKey: ['files'] }, current => {
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
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['files', 'folder', folderId], exact: true }),
    queryClient.invalidateQueries({ queryKey: ['files', folderId], exact: true }),
  ]);
}
