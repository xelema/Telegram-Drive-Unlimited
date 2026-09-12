import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/i18n';
import { PhotoSlideshow } from '../../src/components/workspace/PhotoSlideshow';
import { WorkspaceThumbnail } from '../../src/components/workspace/MediaTimeline';
import type { WorkspaceFile } from '../../src/services/workspace';

const invoke = vi.hoisted(() => vi.fn());
const setFullscreen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke, convertFileSrc: (path: string) => path }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setFullscreen }) }));
const files: WorkspaceFile[] = [
    { id: 42, folder_id: null, key: 'saved:42', name: 'Saved.jpg' },
    { id: 42, folder_id: 9, key: '9:42', name: 'Travel.jpg' },
    { id: 7, folder_id: 9, key: '9:7', name: 'Last.jpg' },
].map(file => ({ ...file, size: 1, sizeStr: '1 B', tags: [], collectionIds: [], folderName: 'Photos', encryption_state: 'plain' }));
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('workspace image viewing and resource lifetime', () => {
    beforeEach(() => { setFullscreen.mockClear(); invoke.mockReset().mockImplementation(async (command, args) => command === 'cmd_workspace_asset' ? `asset://${args.key}` : undefined); });
    afterEach(() => vi.useRealTimers());

    it('keeps a normal image paused and navigates duplicate message IDs by file key', async () => {
        vi.useFakeTimers();
        render(<PhotoSlideshow ownerId="1" files={files} initialKey="9:42" onClose={vi.fn()} onFavorite={vi.fn()} />);
        await settle();
        fireEvent.load(screen.getByAltText('Travel.jpg'));
        await act(async () => vi.advanceTimersByTimeAsync(20_000));
        expect(screen.getByAltText('Travel.jpg')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }));
        await settle();
        expect(screen.getByAltText('Last.jpg')).toBeTruthy();
    });

    it('starts an explicit slideshow only after its image loads', async () => {
        vi.useFakeTimers();
        render(<PhotoSlideshow ownerId="1" files={files} autoPlay onClose={vi.fn()} onFavorite={vi.fn()} />);
        await settle();
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(screen.getByAltText('Saved.jpg')).toBeTruthy();
        fireEvent.load(screen.getByAltText('Saved.jpg'));
        await act(async () => vi.advanceTimersByTimeAsync(5000));
        expect(screen.getByAltText('Travel.jpg')).toBeTruthy();
    });

    it('ignores vertical gestures, supports horizontal swipe and safely handles cancellation', async () => {
        render(<PhotoSlideshow ownerId="1" files={files} onClose={vi.fn()} onFavorite={vi.fn()} />);
        await settle();
        const area = screen.getByTestId('photo-gesture-area');
        fireEvent.touchStart(area, { touches: [{ identifier: 1, clientX: 200, clientY: 100 }] });
        fireEvent.touchEnd(area, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 400 }] });
        expect(screen.getByAltText('Saved.jpg')).toBeTruthy();
        fireEvent.touchStart(area, { touches: [{ identifier: 1, clientX: 300, clientY: 100 }] });
        fireEvent.touchEnd(area, { changedTouches: [{ identifier: 1, clientX: 50, clientY: 110 }] });
        await settle();
        expect(screen.getByAltText('Travel.jpg')).toBeTruthy();
        fireEvent.touchCancel(area);
        fireEvent.touchEnd(area, { changedTouches: [] });
    });

    it('exits native fullscreen before closing and cleans up fullscreen on unmount', async () => {
        const onClose = vi.fn();
        const { unmount } = render(<PhotoSlideshow ownerId="1" files={files} onClose={onClose} onFavorite={vi.fn()} />);
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Fullscreen', exact: true }));
        await settle();
        expect(setFullscreen).toHaveBeenLastCalledWith(true);
        fireEvent.keyDown(document, { key: 'Escape' });
        await settle();
        expect(setFullscreen).toHaveBeenLastCalledWith(false);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Fullscreen', exact: true }));
        await settle();
        unmount();
        await settle();
        expect(setFullscreen).toHaveBeenLastCalledWith(false);
    });

    it.each(['thumbnail', 'slideshow'])('cancels obsolete %s requests and never displays their late result', async mode => {
        const pending: Array<{ args: Record<string, string>; resolve: (path: string) => void }> = [];
        invoke.mockImplementation((command, args) => command === 'cmd_workspace_asset' ? new Promise(resolve => pending.push({ args, resolve })) : Promise.resolve());
        const view = (file: WorkspaceFile) => mode === 'thumbnail'
            ? <WorkspaceThumbnail ownerId="1" file={file} />
            : <PhotoSlideshow ownerId="1" files={[file]} initialKey={file.key} onClose={vi.fn()} onFavorite={vi.fn()} />;
        const { rerender, container, unmount } = render(view(files[0]));
        rerender(view(files[1]));
        expect(invoke).toHaveBeenCalledWith('cmd_workspace_cancel_asset', { ownerId: '1', requestId: pending[0].args.requestId });
        await act(async () => pending[0].resolve('asset://old'));
        expect(container.querySelector('img')).toBeNull();
        await act(async () => pending[1].resolve('asset://current'));
        expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://current');
        rerender(view(files[2]));
        unmount();
        expect(invoke).toHaveBeenCalledWith('cmd_workspace_cancel_asset', { ownerId: '1', requestId: pending[2].args.requestId });
    });
});
