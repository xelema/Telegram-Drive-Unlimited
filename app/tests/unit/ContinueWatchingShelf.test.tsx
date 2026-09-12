import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/i18n';
import { ContinueWatchingShelf } from '../../src/components/desktop/playback/ContinueWatchingShelf';
import type { PlaybackRecord, PlaybackSnapshot } from '../../src/services/playbackHistory';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const record: PlaybackRecord = {
    mediaId: '1:saved:42', ownerId: '1', folderId: null, messageId: 42, name: 'Lecture.mp4', size: 10,
    mimeType: 'video/mp4', encryptionState: 'plain', positionMs: 30_000, durationMs: 120_000,
    volume: 1, speed: 1, completed: false, updatedAt: 1, bookmarks: [],
};
let snapshot: PlaybackSnapshot;

describe('Continue Watching shelf', () => {
    beforeEach(() => {
        snapshot = { ownerId: '1', items: [record, { ...record, mediaId: '1:9:42', folderId: 9, name: 'Finished.mp4', completed: true }], queue: [], preferences: { volume: 1, speed: 1 } };
        invoke.mockReset().mockImplementation(async (command: string, args: { mutation?: { type: string; file?: PlaybackRecord; files?: PlaybackRecord[] } }) => {
            if (command === 'cmd_playback_mutate') {
                const mutation = args.mutation!;
                if (mutation.type === 'enqueue') snapshot.queue.push(...mutation.files!);
                if (mutation.type === 'finish') snapshot.items = snapshot.items.map(item => item.mediaId === mutation.file!.mediaId ? { ...item, completed: true } : item);
            }
            return structuredClone(snapshot);
        });
    });

    it('shows unfinished media, supports queueing, and keeps finished titles separate', async () => {
        render(<ContinueWatchingShelf ownerId="1" onPlay={vi.fn()} />);
        expect(await screen.findByRole('button', { name: 'Lecture.mp4' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Finished.mp4' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Queue', exact: true }));
        expect(await screen.findByText('Up next (1)')).toBeTruthy();
        fireEvent.click(screen.getByLabelText('Show finished'));
        expect(screen.getByRole('button', { name: 'Finished.mp4' })).toBeTruthy();
    });

    it('opens a Saved Messages title using the stored location', async () => {
        const onPlay = vi.fn();
        render(<ContinueWatchingShelf ownerId="1" onPlay={onPlay} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Lecture.mp4' }));
        await waitFor(() => expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 42, folder_id: null }), { restart: false }));
    });

    it('does not open an old account file when an action resolves after switching owner', async () => {
        let resolveMutation!: (value: PlaybackSnapshot) => void;
        const original = invoke.getMockImplementation()!;
        invoke.mockImplementation((command, args) => command === 'cmd_playback_mutate'
            ? new Promise(resolve => { resolveMutation = resolve; })
            : original(command, args));
        const onPlay = vi.fn();
        const { rerender } = render(<ContinueWatchingShelf ownerId="1" onPlay={onPlay} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Lecture.mp4' }));
        await waitFor(() => expect(resolveMutation).toBeTypeOf('function'));
        const oldSnapshot = snapshot;
        snapshot = { ...snapshot, ownerId: '2', items: [], queue: [] };
        rerender(<ContinueWatchingShelf ownerId="2" onPlay={onPlay} />);
        await act(async () => resolveMutation(oldSnapshot));
        expect(onPlay).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Lecture.mp4' })).toBeNull();
    });
});
