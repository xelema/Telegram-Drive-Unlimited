import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileMediaPlayer } from '../../src/components/mobile/MobileMediaPlayer';

const { convertFileSrcMock, invokeMock, listenMock } = vi.hoisted(() => ({
  convertFileSrcMock: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: convertFileSrcMock,
  invoke: invokeMock,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const file = {
  id: 42,
  name: 'android-video.mp4',
  size: 8_000_000,
  sizeStr: '7.6 MB',
};

describe('MobileMediaPlayer', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    convertFileSrcMock.mockClear();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_preview') return Promise.resolve('/cache/previews/home_42.mp4');
      return Promise.resolve(undefined);
    });
  });

  it('opens video through the native Android range-stream player', async () => {
    const onClose = vi.fn();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_stream_info') return Promise.resolve({ base_url: 'http://localhost:1421', token: 'secret' });
      return Promise.resolve(undefined);
    });
    render(<MobileMediaPlayer file={file} activeFolderId={null} onClose={onClose} />);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith('cmd_open_android_stream_player', {
      streamUrl: 'http://localhost:1421/stream/home/42?token=secret',
      title: 'android-video.mp4',
      mimeType: 'video/*',
      mediaId: 'home:42',
      preferencesJson: JSON.stringify({
        privateMetadata: true,
        privacyScreen: false,
        orientation: 'auto',
        subtitleScale: 1,
        playbackSpeed: 1,
      }),
    });
    expect(invokeMock.mock.calls.some(([command]) => command === 'cmd_get_preview')).toBe(false);
  });

  it('offers a bounded cached fallback when native streaming cannot start', async () => {
    invokeMock.mockRejectedValueOnce(new Error('player unavailable'));
    const { container } = render(<MobileMediaPlayer file={file} activeFolderId={9} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /download fallback/i }));
    await waitFor(() => expect(container.querySelector('video')).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith('cmd_get_preview', { messageId: 42, folderId: 9 });
    expect(convertFileSrcMock).toHaveBeenCalledWith('/cache/previews/home_42.mp4');
  });

  it('does not download automatically when native streaming fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('temporary player error'));
    render(<MobileMediaPlayer file={file} activeFolderId={9} onClose={vi.fn()} />);

    expect(await screen.findByText('The operation could not be completed. Try again or review the related settings.')).toBeTruthy();
    expect(screen.queryByText(/temporary player error/i)).toBeNull();
    expect(invokeMock.mock.calls.some(([command]) => command === 'cmd_get_preview')).toBe(false);
  });

  it('streams MIME-identified audio instead of pre-downloading it', async () => {
    const audio = { ...file, name: 'recording.bin', mime_type: 'audio/aac' };
    const onClose = vi.fn();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_stream_info') return Promise.resolve({ base_url: 'http://localhost:1421', token: 'secret' });
      return Promise.resolve(undefined);
    });
    render(<MobileMediaPlayer file={audio} activeFolderId={null} onClose={onClose} />);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith('cmd_open_android_stream_player', expect.objectContaining({ mimeType: 'audio/aac' }));
    expect(invokeMock.mock.calls.some(([command]) => command === 'cmd_get_preview')).toBe(false);
  });

  it('preserves the exact protected-stream capability string', async () => {
    const onClose = vi.fn();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'cmd_get_stream_info') return Promise.resolve({
        base_url: 'http://localhost:1421',
        token: 'secret',
        operation_token: '18446744073709551615',
      });
      return Promise.resolve(undefined);
    });
    render(<MobileMediaPlayer file={file} activeFolderId={null} onClose={onClose} />);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith('cmd_open_android_stream_player', expect.objectContaining({
      streamUrl: 'http://localhost:1421/stream/home/42?token=secret&credential=18446744073709551615',
    }));
  });
});
