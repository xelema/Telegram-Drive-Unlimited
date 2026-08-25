import { describe, expect, it } from 'vitest';
import {
  isCurrentFolderLoadChunk,
  mergeFileChunk,
  type FolderLoadChunk,
} from '../../src/services/fileListRefresh';
import type { TelegramFile } from '../../src/types';
import { QueryClient } from '@tanstack/react-query';
import { updateFileQueryData } from '../../src/services/fileListRefresh';

const chunk = (folderId: number | null, requestId: string): FolderLoadChunk => ({
  folderId,
  requestId,
  files: [{ id: 2, name: 'new.txt', size: 200, sizeStr: '', icon_type: 'file' }],
});

describe('file list refresh generations', () => {
  it('rejects chunks from stale requests and other folders', () => {
    expect(isCurrentFolderLoadChunk(chunk(42, 'current'), 42, 'current')).toBe(true);
    expect(isCurrentFolderLoadChunk(chunk(42, 'stale'), 42, 'current')).toBe(false);
    expect(isCurrentFolderLoadChunk(chunk(7, 'current'), 42, 'current')).toBe(false);
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
});
