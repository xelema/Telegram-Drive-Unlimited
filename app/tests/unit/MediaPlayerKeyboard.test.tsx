import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPlayer } from '../../src/components/desktop/dashboard/MediaPlayer';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    onResized: vi.fn(),
    setFullscreen: vi.fn(),
    isFullscreen: vi.fn(),
    fallback: false,
    adaptiveCalls: 0,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => `asset://localhost${path}` }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ onResized: mocks.onResized, setFullscreen: mocks.setFullscreen, isFullscreen: mocks.isFullscreen }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Keep the real parent AND adaptive child mounted. Only the media transport and
// native window boundary are replaced; both actual keyboard effects run.
vi.mock('../../src/hooks/useAdaptiveStreaming', async () => {
    const { useRef } = await import('react');
    return {
        useAdaptiveStreaming: (url: string) => { mocks.adaptiveCalls++; return ({
            videoRef: useRef<HTMLVideoElement | null>(null),
            phase: 'ready', error: null, tracks: [], loadProgress: 100,
            currentQuality: 'original', setQuality: vi.fn(), adaptiveMode: true,
            setAdaptiveMode: vi.fn(), measuredKbps: 0, useFallback: mocks.fallback,
            fallbackUrl: url, abort: vi.fn(),
        }); },
    };
});

describe('desktop media keyboard ownership', () => {
    beforeEach(() => {
        mocks.fallback = false;
        mocks.adaptiveCalls = 0;
        mocks.onResized.mockReset().mockResolvedValue(() => {});
        mocks.setFullscreen.mockReset().mockResolvedValue(undefined);
        mocks.isFullscreen.mockReset().mockResolvedValue(false);
        mocks.invoke.mockReset().mockImplementation((command: string) => {
            if (command === 'cmd_get_stream_info') return Promise.resolve({ token: 'test-token', base_url: 'http://127.0.0.1:14201' });
            if (command === 'cmd_get_transcode_capabilities') return Promise.resolve({ available: false, variants: [] });
            if (command === 'cmd_workspace_account') return Promise.resolve('1');
            if (command === 'cmd_playback_read' || command === 'cmd_playback_mutate') return Promise.resolve({ ownerId: '1', items: [], queue: [], preferences: { volume: 1, speed: 1 } });
            return Promise.resolve(undefined);
        });
        const paused = new WeakMap<HTMLMediaElement, boolean>();
        vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { paused.set(this, false); return Promise.resolve(); });
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); });
    });

    it.each([false, true])('handles every MP4 key once (native fallback=%s)', async fallback => {
        mocks.fallback = fallback;
        const onNext = vi.fn();
        const onClose = vi.fn();
        const { container, unmount } = render(<MediaPlayer file={{ id: 42, name: 'film.mp4', size: 1, sizeStr: '1 B' }} activeFolderId={1} onClose={onClose} onNext={onNext} />);
        await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
        const video = container.querySelector('video')!;

        fireEvent.keyDown(document.body, { key: ' ' });
        expect(video.paused).toBe(false);
        expect(video.play).toHaveBeenCalledTimes(1);
        expect(video.pause).not.toHaveBeenCalled();
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(onNext).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document.body, { key: 'm' });
        expect(video.muted).toBe(true);
        fireEvent.keyDown(document.body, { key: 'm' });
        expect(video.muted).toBe(false);

        await act(async () => fireEvent.keyDown(document.body, { key: 'f' }));
        expect(mocks.setFullscreen).toHaveBeenCalledTimes(1);
        expect(mocks.setFullscreen).toHaveBeenLastCalledWith(true);
        await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
        expect(mocks.setFullscreen).toHaveBeenLastCalledWith(false);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);

        unmount();
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('preserves text entry, browser shortcuts and focused button activation', async () => {
        const onNext = vi.fn();
        const { container } = render(<>
            <MediaPlayer file={{ id: 42, name: 'film.mp4', size: 1, sizeStr: '1 B' }} activeFolderId={1} onClose={vi.fn()} onNext={onNext} />
            <input aria-label="Notes" />
            <div contentEditable suppressContentEditableWarning><span>Editable caption</span></div>
            <button>Custom action</button>
        </>);
        await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
        fireEvent.keyDown(screen.getByLabelText('Notes'), { key: 'ArrowRight' });
        fireEvent.keyDown(screen.getByText('Editable caption'), { key: 'l' });
        fireEvent.keyDown(screen.getByRole('button', { name: 'Custom action' }), { key: ' ' });
        fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
        expect(onNext).not.toHaveBeenCalled();
        expect(container.querySelector('video')!.play).not.toHaveBeenCalled();
        expect(mocks.setFullscreen).not.toHaveBeenCalled();
    });

    it('controls audio in this viewer without touching another video on the page', async () => {
        const { container } = render(<><video data-testid="other-video" /><MediaPlayer file={{ id: 2, name: 'talk.mp3', size: 1, sizeStr: '1 B' }} activeFolderId={null} onClose={vi.fn()} /></>);
        await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
        const audio = container.querySelector('audio')!;
        const other = screen.getByTestId('other-video') as HTMLVideoElement;
        fireEvent.keyDown(document.body, { key: ' ' });
        fireEvent.keyDown(document.body, { key: 'm' });
        expect(audio.paused).toBe(false);
        expect(audio.muted).toBe(true);
        expect(other.paused).toBe(true);
        expect(other.muted).toBe(false);
    });

    it('disposes native listeners even when registration resolves after unmount', async () => {
        const resolvers: Array<(dispose: () => void) => void> = [];
        mocks.onResized.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
        const { container, unmount } = render(<MediaPlayer file={{ id: 42, name: 'film.mp4', size: 1, sizeStr: '1 B' }} activeFolderId={1} onClose={vi.fn()} />);
        await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
        expect(resolvers).toHaveLength(2);
        unmount();
        const dispose = vi.fn();
        await act(async () => resolvers.forEach(resolve => resolve(dispose)));
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('plays an approved offline MP4 without stream or remux requests and still saves progress', async () => {
        const { container, unmount } = render(<MediaPlayer file={{ id: 42, folder_id: null, name: 'film.mp4', size: 1, sizeStr: '1 B' }} activeFolderId={9} ownerId="1" localPath="/owned/workspace/offline/film.mp4" onClose={vi.fn()} />);
        const video = container.querySelector('video')!;
        expect(video.src).toBe('asset://localhost/owned/workspace/offline/film.mp4');
        Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
        Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('cmd_playback_read', { ownerId: '1' }));
        await act(async () => fireEvent.loadedMetadata(video));
        video.currentTime = 30;
        unmount();
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('cmd_playback_mutate', expect.objectContaining({ ownerId: '1', mutation: expect.objectContaining({ type: 'progress', positionMs: 30_000, file: expect.objectContaining({ folderId: null }) }) })));
        expect(mocks.adaptiveCalls).toBe(0);
        expect(mocks.invoke.mock.calls.some(([command]) => ['cmd_get_stream_info', 'cmd_prepare_fmp4_stream', 'cmd_get_transcode_capabilities'].includes(command))).toBe(false);
    });
});
