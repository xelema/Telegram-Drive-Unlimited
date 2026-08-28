import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  isArchiveFile,
  isAudioFile,
  isImageFile,
  isMediaFile,
  isPdfFile,
  isVideoFile,
  sanitizeFilename,
} from '../../src/utils/files';
import { filterAndRankFiles, fuzzyScore, type FileSearchFilters } from '../../src/services/fileSearch';
import { classifyFileExtension, matchesSizeFacet } from '../../src/services/searchPolicy';
import { describeFileActions, resolvePublicFolderUsername } from '../../src/components/desktop/dashboard/fileActionDescriptors';
import type { TelegramFile, TelegramFolder } from '../../src/types';

describe('file utilities', () => {
  it('preserves current byte formatting boundaries', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536, 1)).toBe('1.5 KB');
  });

  it('classifies supported names case-insensitively', () => {
    expect(isImageFile('PHOTO.HEIC')).toBe(true);
    expect(isVideoFile('clip.MP4')).toBe(true);
    expect(isAudioFile('voice.opus')).toBe(true);
    expect(isMediaFile('clipmp4')).toBe(true);
    expect(isVideoFile('recording.bin', 'video/mp4')).toBe(true);
    expect(isAudioFile('recording.bin', 'audio/aac')).toBe(true);
    expect(isPdfFile('report.PDF')).toBe(true);
    expect(isArchiveFile('backup.7Z')).toBe(true);
  });

  it('sanitizes platform-reserved filename characters', () => {
    expect(sanitizeFilename(' ../bad:name?.txt ')).toBe('_bad_name_.txt');
    expect(sanitizeFilename('...')).toBe('file');
  });
});

describe('file action policy', () => {
  it('selects the existing preview behavior by file kind', () => {
    expect(describeFileActions({ name: 'Movies', type: 'folder' } as TelegramFile).previewAction).toBe('open');
    expect(describeFileActions({ name: 'clip.mp4' } as TelegramFile).previewAction).toBe('play');
    expect(describeFileActions({ name: 'report.pdf' } as TelegramFile).previewAction).toBe('view_pdf');
    expect(describeFileActions({ name: 'notes.txt' } as TelegramFile).previewAction).toBe('preview');
  });

  it('uses current and legacy public-folder usernames', () => {
    const file = { name: 'photo.jpg', folder_id: 7 } as TelegramFile;
    expect(resolvePublicFolderUsername(file, [{ id: 7, username: 'current' } as TelegramFolder], null)).toBe('current');
    expect(resolvePublicFolderUsername(file, [{ id: 7, channel: { username: 'legacy' } } as unknown as TelegramFolder], null)).toBe('legacy');
  });
});

describe('search policy', () => {
  const files: TelegramFile[] = [
    { id: 1, name: 'Holiday Photo.jpg', file_ext: 'jpg', size: 2_000, sizeStr: '2 KB', created_at: '2026-08-01T00:00:00Z' },
    { id: 2, name: 'Project Notes.pdf', file_ext: 'pdf', size: 20 * 1024 * 1024, sizeStr: '20 MB', created_at: '2025-01-01T00:00:00Z' },
  ];

  it('keeps fuzzy ranking deterministic', () => {
    expect(fuzzyScore('Project Notes.pdf', 'pnotes')).not.toBeNull();
    expect(fuzzyScore('Holiday Photo.jpg', 'xyz')).toBeNull();
  });

  it('uses exact size boundaries and extension groups', () => {
    expect(matchesSizeFacet(10 * 1024 * 1024 - 1, 'small')).toBe(true);
    expect(matchesSizeFacet(10 * 1024 * 1024, 'medium')).toBe(true);
    expect(matchesSizeFacet(100 * 1024 * 1024, 'large')).toBe(true);
    expect(classifyFileExtension('PDF')).toBe('document');
    expect(classifyFileExtension('unknown')).toBe('other');
  });

  it('filters and ranks without mutating the source array', () => {
    const filters: FileSearchFilters = { scope: 'folder', type: 'document', size: 'medium', date: 'any' };
    expect(filterAndRankFiles(files, 'notes', filters).map(file => file.id)).toEqual([2]);
    expect(files.map(file => file.id)).toEqual([1, 2]);
  });
});
