import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdaptiveMediaPlayer } from '../../src/components/desktop/dashboard/AdaptiveMediaPlayer';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  progressiveCallback: null as (() => void) | null,
  streamUrls: [] as string[],
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onResized: vi.fn().mockResolvedValue(() => {}),
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/hooks/useAdaptiveStreaming', () => ({
  useAdaptiveStreaming: (streamUrl: string, _fileName: string, onProgressiveDetected?: () => void) => {
    mocks.streamUrls.push(streamUrl);
    mocks.progressiveCallback = onProgressiveDetected || null;
    return {
      videoRef: { current: null },
      phase: 'error',
      error: "Invalid data found while parsing box of type '=\u00ca\u0001\u00c0' at position 75037999.",
      tracks: [],
      loadProgress: 0,
      currentQuality: 'original',
      setQuality: vi.fn(),
      adaptiveMode: true,
      setAdaptiveMode: vi.fn(),
      measuredKbps: 0,
      seek: vi.fn(),
      useFallback: true,
      fallbackUrl: streamUrl,
      abort: vi.fn(),
    };
  },
}));

describe('AdaptiveMediaPlayer native fallback', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.progressiveCallback = null;
    mocks.streamUrls.length = 0;
  });

  it('keeps parser and background-remux state from covering playable native video', async () => {
    let finishRemux: ((value: { url: string; output_file_key: string; status: string }) => void) | undefined;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'cmd_get_transcode_capabilities') {
        return Promise.resolve({ available: true, variants: [], mode: 'original' });
      }
      if (command === 'cmd_prepare_fmp4_stream') {
        return new Promise(resolve => { finishRemux = resolve; });
      }
      return Promise.resolve(undefined);
    });

    const streamUrl = 'http://127.0.0.1:14201/stream/home/42?token=session-token';
    const { container } = render(
      <AdaptiveMediaPlayer
        file={{ id: 42, name: 'tail-moov.mp4', size: 80_000_000, sizeStr: '76.3 MB' }}
        activeFolderId={null}
        onClose={vi.fn()}
        streamUrl={streamUrl}
      />,
    );

    await waitFor(() => expect(mocks.progressiveCallback).toBeTypeOf('function'));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('cmd_get_transcode_capabilities'));

    act(() => mocks.progressiveCallback?.());

    expect(screen.queryByText('Playback Error')).toBeNull();
    expect(screen.queryByText('Converting to streaming format...')).toBeNull();

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    fireEvent.loadedData(video!);
    fireEvent.playing(video!);

    await act(async () => {
      finishRemux?.({ url: '/fmp4/0_42.mp4', output_file_key: '0_42', status: 'ready' });
      await Promise.resolve();
    });

    expect(screen.queryByText('Playback Error')).toBeNull();
    expect(screen.queryByText('Converting to streaming format...')).toBeNull();
    expect(mocks.streamUrls.every(url => url.startsWith(streamUrl))).toBe(true);
  });
});
