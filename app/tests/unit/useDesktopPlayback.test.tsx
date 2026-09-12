import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesktopPlayback } from '../../src/hooks/useDesktopPlayback';
import { playbackId, setPlaybackSleepDeadline, toPlaybackFile, type PlaybackMutation, type PlaybackRecord, type PlaybackSnapshot } from '../../src/services/playbackHistory';
import type { TelegramFile } from '../../src/types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const file: TelegramFile = { id: 42, folder_id: null, name: 'book.mp3', size: 10, sizeStr: '10 B', mime_type: 'audio/mpeg' };
const descriptor = toPlaybackFile(file);
let snapshot: PlaybackSnapshot;
let mutations: PlaybackMutation[];

function currentRecord(): PlaybackRecord {
    let record = snapshot.items.find(item => item.mediaId === playbackId('1', descriptor));
    if (!record) {
        record = { ...descriptor, mediaId: '1:saved:42', ownerId: '1', positionMs: 0, durationMs: 120_000,
            completed: false, volume: 0.4, speed: 1.5, updatedAt: Date.now(), bookmarks: [] };
        snapshot.items.push(record);
    }
    return record;
}
function mediaElement(): HTMLAudioElement {
    const media = document.createElement('audio');
    Object.defineProperty(media, 'duration', { configurable: true, value: 120 });
    Object.defineProperty(media, 'readyState', { configurable: true, value: 1 });
    document.body.appendChild(media);
    return media;
}
async function mountPlayback(restart = false, onPlayFile?: (file: TelegramFile) => void) {
    const hook = renderHook(() => useDesktopPlayback(file, 999, '1', restart, onPlayFile));
    const media = mediaElement();
    act(() => hook.result.current.attachMedia(media));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return { ...hook, media };
}

describe('persistent desktop playback session', () => {
    beforeEach(() => {
        snapshot = { ownerId: '1', items: [], queue: [], preferences: { volume: 0.4, speed: 1.5 } };
        mutations = [];
        invoke.mockReset().mockImplementation(async (command: string, args?: { ownerId: string; mutation: PlaybackMutation }) => {
            if (command === 'cmd_workspace_account') return '1';
            if (command === 'cmd_playback_read') return structuredClone(snapshot);
            if (command !== 'cmd_playback_mutate') throw new Error(`Unexpected command ${command}`);
            expect(args?.ownerId).toBe('1');
            const mutation = args!.mutation;
            mutations.push(mutation);
            if (mutation.type === 'remove_queue') {
                snapshot.queue = snapshot.queue.filter(item => playbackId('1', item) !== playbackId('1', mutation.file));
            } else if (mutation.type === 'progress') {
                const record = currentRecord();
                if (!record.completed) record.positionMs = mutation.positionMs;
                record.durationMs = mutation.durationMs; record.speed = mutation.speed; record.volume = mutation.volume;
            } else if (mutation.type === 'finish') {
                const record = currentRecord(); record.completed = true; record.positionMs = mutation.durationMs;
            } else if (mutation.type === 'restart') {
                const record = currentRecord(); record.completed = false; record.positionMs = 0;
            } else if (mutation.type === 'bookmark') {
                currentRecord().bookmarks.push({ positionMs: mutation.positionMs, label: mutation.label });
            } else if (mutation.type === 'remove_bookmark') {
                currentRecord().bookmarks = currentRecord().bookmarks.filter(bookmark => bookmark.positionMs !== mutation.positionMs);
            }
            return structuredClone(snapshot);
        });
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
            this.dispatchEvent(new Event('play')); return Promise.resolve();
        });
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
            this.dispatchEvent(new Event('pause'));
        });
    });
    afterEach(async () => {
        cleanup();
        setPlaybackSleepDeadline('1', null);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        vi.useRealTimers();
    });

    it('restores position/preferences and saves the explicit Saved Messages identity on close', async () => {
        currentRecord().positionMs = 45_000;
        const { media, result, unmount } = await mountPlayback();
        expect(media.currentTime).toBe(45);
        expect(media.volume).toBe(0.4);
        expect(media.playbackRate).toBe(1.5);
        expect(result.current.ownerId).toBe('1');
        media.currentTime = 62;
        unmount();
        await waitFor(() => expect(mutations.some(mutation => mutation.type === 'progress' && mutation.positionMs === 62_000 && mutation.file.folderId === null)).toBe(true));
        expect(currentRecord().positionMs).toBe(62_000);
    });

    it('keeps completion through periodic saves and begins again only on restart', async () => {
        currentRecord().positionMs = 40_000;
        const { media, result } = await mountPlayback();
        await act(async () => result.current.finish());
        expect(currentRecord().completed).toBe(true);
        await act(async () => fireEvent.pause(media));
        expect(currentRecord().completed).toBe(true);
        await act(async () => result.current.restart());
        expect(currentRecord().completed).toBe(false);
        expect(media.currentTime).toBe(0);
        expect(media.play).toHaveBeenCalledTimes(1);
    });

    it('saves named bookmarks at the current position and seeks back to them', async () => {
        const { media, result } = await mountPlayback();
        media.currentTime = 22;
        await act(async () => result.current.addBookmark('Useful explanation'));
        expect(result.current.bookmarks).toEqual([{ positionMs: 22_000, label: 'Useful explanation' }]);
        media.currentTime = 80;
        act(() => result.current.seek(22_000));
        expect(media.currentTime).toBe(22);
        await act(async () => result.current.removeBookmark(22_000));
        expect(result.current.bookmarks).toEqual([]);
    });

    it('consumes the current queue entry and advances to the next only after persisting completion', async () => {
        const next = { ...descriptor, folderId: 7, messageId: 8, name: 'next.mp3' };
        snapshot.queue = [descriptor, next];
        const onPlay = vi.fn();
        const { media } = await mountPlayback(false, onPlay);
        await waitFor(() => expect(snapshot.queue).toEqual([next]));
        await act(async () => fireEvent.ended(media));
        await waitFor(() => expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 8, folder_id: 7, name: 'next.mp3' })));
        expect(currentRecord().completed).toBe(true);
        expect(snapshot.queue).toEqual([]);
        expect(mutations.findIndex(mutation => mutation.type === 'finish')).toBeLessThan(mutations.findIndex(mutation => mutation.type === 'remove_queue' && mutation.file.messageId === 8));
    });

    it('preserves the last position across media element switches without repeating a requested restart', async () => {
        currentRecord().positionMs = 45_000;
        const { media, result } = await mountPlayback(true);
        expect(media.currentTime).toBe(0);
        media.currentTime = 32;
        const replacement = mediaElement();
        act(() => result.current.attachMedia(replacement));
        await waitFor(() => expect(replacement.currentTime).toBe(32));
        expect(mutations.filter(mutation => mutation.type === 'restart')).toHaveLength(1);
    });

    it('pauses when the sleep timer expires', async () => {
        const { media, result } = await mountPlayback();
        vi.useFakeTimers();
        act(() => result.current.setSleepMinutes(1));
        const before = vi.mocked(media.pause).mock.calls.length;
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(media.pause).toHaveBeenCalledTimes(before + 1);
        expect(result.current.sleepRemaining).toBe(0);
    });

    it('keeps a sleep timer across queued player remounts', async () => {
        const first = await mountPlayback();
        act(() => first.result.current.setSleepMinutes(30));
        first.unmount();
        const second = await mountPlayback();
        expect(second.result.current.sleepRemaining).toBeGreaterThan(29 * 60_000);
        expect(second.result.current.sleepRemaining).toBeLessThanOrEqual(30 * 60_000);
    });

    it('does not read or write history for a mismatched account', async () => {
        invoke.mockRejectedValue(new Error('ACCOUNT_CHANGED'));
        const { result, media } = await mountPlayback();
        expect(result.current.error).toBe('playback.account_changed');
        expect(result.current.historyAvailable).toBe(false);
        expect(media.pause).toHaveBeenCalled();
        expect(mutations).toEqual([]);
    });

    it('clears stale queue controls and pauses if the account changes during an action', async () => {
        const next = { ...descriptor, messageId: 8, folderId: 7, name: 'next.mp3' };
        snapshot.queue = [next];
        const onPlay = vi.fn();
        const { result, media } = await mountPlayback(false, onPlay);
        invoke.mockRejectedValue(new Error('ACCOUNT_CHANGED'));
        await act(async () => result.current.playQueued(next));
        expect(result.current.ownerId).toBeNull();
        expect(result.current.queue).toEqual([]);
        expect(result.current.historyAvailable).toBe(false);
        expect(result.current.error).toBe('playback.account_changed');
        expect(media.pause).toHaveBeenCalled();
        expect(onPlay).not.toHaveBeenCalled();
    });
});
