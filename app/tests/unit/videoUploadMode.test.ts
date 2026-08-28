import { describe, expect, it } from 'vitest';
import {
  effectiveVideoUploadMode,
  supportsTelegramMediaUpload,
} from '../../src/services/videoUploadMode';

describe('video upload mode', () => {
  it('recognizes MP4-family video paths case-insensitively', () => {
    expect(supportsTelegramMediaUpload('/videos/clip.MP4')).toBe(true);
    expect(supportsTelegramMediaUpload('https://example.com/clip.m4v?download=1')).toBe(true);
    expect(supportsTelegramMediaUpload('/videos/clip.mov')).toBe(true);
    expect(supportsTelegramMediaUpload('/videos/clip.mkv')).toBe(false);
  });

  it('uses media only for compatible unprotected videos', () => {
    expect(effectiveVideoUploadMode('clip.mp4', { mode: 'standard' }, 'media')).toBe('media');
    expect(effectiveVideoUploadMode('clip.mp4', { mode: 'vault' }, 'media')).toBe('file');
    expect(effectiveVideoUploadMode('clip.mp4', { mode: 'standard' }, 'file')).toBe('file');
    expect(effectiveVideoUploadMode('notes.txt', { mode: 'standard' }, 'media')).toBe('file');
  });
});
