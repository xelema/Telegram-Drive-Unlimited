import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));

vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'windows' }));

import {
  FFMPEG_WINDOWS_DOWNLOAD_URL,
  openFfmpegWindowsDownloads,
} from '../../src/components/shared/FfmpegInstallNotice';

describe('FFmpeg Windows download link', () => {
  beforeEach(() => {
    openMock.mockReset();
  });

  it('uses the native shell opener when available', async () => {
    openMock.mockResolvedValue(undefined);

    await openFfmpegWindowsDownloads();

    expect(openMock).toHaveBeenCalledWith(FFMPEG_WINDOWS_DOWNLOAD_URL);
  });

  it('uses a protected browser fallback when the native opener fails', async () => {
    openMock.mockRejectedValue(new Error('shell unavailable'));
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openFfmpegWindowsDownloads();

    expect(windowOpen).toHaveBeenCalledWith(
      FFMPEG_WINDOWS_DOWNLOAD_URL,
      '_blank',
      'noopener,noreferrer',
    );
    windowOpen.mockRestore();
  });
});
