import { useCallback, useEffect, useRef, useState } from 'react';
import type { TelegramFile } from '../types';
import { getCurrentAccountId } from '../services/currentAccount';
import {
    fromPlaybackFile, mutatePlayback, playbackId, readPlayback, toPlaybackFile,
    playbackSleepDeadline, setPlaybackSleepDeadline, PLAYBACK_SLEEP_CHANGED,
    type PlaybackBookmark, type PlaybackFile, type PlaybackMutation, type PlaybackRecord, type PlaybackSnapshot,
} from '../services/playbackHistory';

interface PlaybackView {
    ownerId: string | null;
    loading: boolean;
    error: string | null;
    positionMs: number;
    durationMs: number;
    completed: boolean;
    volume: number;
    speed: number;
    bookmarks: PlaybackBookmark[];
    queue: PlaybackFile[];
}
const initial: PlaybackView = {
    ownerId: null, loading: true, error: null, positionMs: 0, durationMs: 0,
    completed: false, volume: 1, speed: 1, bookmarks: [], queue: [],
};
type Controls = {
    restart: () => Promise<void>;
    finish: () => Promise<void>;
    bookmark: (label: string) => Promise<void>;
    removeBookmark: (positionMs: number) => Promise<void>;
    playQueued: (file: PlaybackFile) => Promise<void>;
    removeQueued: (file: PlaybackFile) => Promise<void>;
};

function milliseconds(seconds: number): number {
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

export function useDesktopPlayback(
    file: TelegramFile,
    folderId: number | null,
    expectedOwner?: string,
    restartRequested = false,
    onPlayFile?: (file: TelegramFile) => void,
) {
    const [media, setMedia] = useState<HTMLMediaElement | null>(null);
    const [state, setState] = useState<PlaybackView>(initial);
    const [sleepUntil, setSleepUntil] = useState<number | null>(null);
    const [sleepRemaining, setSleepRemaining] = useState(0);
    const controls = useRef<Controls | null>(null);
    const restartHandledRef = useRef<string | null>(null);
    const fileRef = useRef(file);
    const onPlayRef = useRef(onPlayFile);
    fileRef.current = file;
    onPlayRef.current = onPlayFile;
    const sourceFolder = file.folder_id === undefined ? folderId : file.folder_id;
    const identity = `${sourceFolder ?? 'saved'}:${file.id}`;

    useEffect(() => {
        if (!media) return;
        let disposed = false;
        let ready = false;
        let owner: string | null = null;
        let history: PlaybackRecord | undefined;
        let queue: PlaybackFile[] = [];
        let mayPersist = (fileRef.current.encryption_state ?? 'plain') === 'plain';
        let lastRender = 0;
        let restored = false;
        let restartInFlight = false;
        const restartKey = `${expectedOwner ?? ''}:${identity}`;
        const explicitRestart = restartRequested && restartHandledRef.current !== restartKey;
        const descriptor = toPlaybackFile(fileRef.current, sourceFolder);
        setState({ ...initial, error: mayPersist ? null : 'playback.protected_history' });

        const reportError = (reason: unknown) => {
            if (disposed) return;
            const accountChanged = String(reason).includes('ACCOUNT_');
            if (accountChanged) {
                mayPersist = false;
                owner = null;
                queue = [];
                history = undefined;
                media.pause();
            }
            setState(previous => ({ ...previous, ownerId: accountChanged ? null : previous.ownerId,
                queue: accountChanged ? [] : previous.queue, loading: false, error: accountChanged
                ? 'playback.account_changed'
                : 'playback.persistence_error' }));
        };
        const publish = () => {
            if (disposed) return;
            setState(previous => ({ ...previous, ownerId: owner, loading: !ready,
                positionMs: milliseconds(media.currentTime), durationMs: milliseconds(media.duration),
                completed: history?.completed ?? false, volume: media.muted ? 0 : media.volume,
                speed: media.playbackRate, bookmarks: history?.bookmarks ?? [], queue,
            }));
        };
        const accept = (snapshot: PlaybackSnapshot) => {
            history = snapshot.items.find(item => item.mediaId === playbackId(snapshot.ownerId, descriptor));
            queue = snapshot.queue;
            publish();
        };
        const mutate = async (mutation: PlaybackMutation) => {
            if (!owner || !mayPersist) return null;
            try {
                const snapshot = await mutatePlayback(owner, mutation);
                if (!disposed) { accept(snapshot); setState(previous => ({ ...previous, error: null })); }
                return snapshot;
            } catch (reason) {
                reportError(reason);
                throw reason;
            }
        };
        const save = () => {
            if (!ready || !owner || !mayPersist || !restored) return;
            void mutate({ type: 'progress', file: descriptor,
                positionMs: milliseconds(media.currentTime), durationMs: milliseconds(media.duration),
                volume: media.muted ? 0 : media.volume, speed: media.playbackRate,
            }).catch(reportError);
        };
        const applyResume = () => {
            if (!ready || restored) return;
            const duration = milliseconds(media.duration);
            if (media.readyState === 0 && duration === 0) return;
            const position = history?.completed || explicitRestart ? 0 : (history?.positionMs ?? 0);
            try { media.currentTime = (duration > 0 ? Math.min(position, Math.max(0, duration - 50)) : position) / 1000; }
            catch { return; }
            restored = true;
            publish();
        };
        const restart = async () => {
            if (restartInFlight) return;
            restartInFlight = true;
            try {
                await mutate({ type: 'restart', file: descriptor });
                if (disposed) return;
                if (history) history.completed = false;
                media.currentTime = 0;
                restored = true;
                publish();
                await media.play();
            } finally { restartInFlight = false; }
        };
        const playQueued = async (next: PlaybackFile) => {
            if (!onPlayRef.current) return;
            save();
            const snapshot = await mutate({ type: 'remove_queue', file: next });
            if (snapshot && !disposed) onPlayRef.current(fromPlaybackFile(next));
        };
        const finish = async (advance: boolean) => {
            if (history) history.completed = true;
            media.pause();
            publish();
            const snapshot = await mutate({ type: 'finish', file: descriptor, durationMs: milliseconds(media.duration) });
            if (advance && snapshot && !disposed && onPlayRef.current) {
                const next = snapshot.queue.find(item => playbackId(snapshot.ownerId, item) !== playbackId(snapshot.ownerId, descriptor));
                if (next) await playQueued(next);
            }
        };
        controls.current = {
            restart,
            finish: () => finish(false),
            bookmark: async label => { await mutate({ type: 'bookmark', file: descriptor, positionMs: milliseconds(media.currentTime), label }); },
            removeBookmark: async positionMs => { await mutate({ type: 'remove_bookmark', file: descriptor, positionMs }); },
            playQueued,
            removeQueued: async next => { await mutate({ type: 'remove_queue', file: next }); },
        };
        const onMetadata = () => { applyResume(); publish(); };
        const onTime = () => {
            if (Date.now() - lastRender >= 1000) { lastRender = Date.now(); publish(); }
        };
        const onPlay = () => {
            if (history?.completed && ready && !restartInFlight) void restart().catch(reportError);
        };
        const onEnded = () => { void finish(true).catch(reportError); };
        const onPreference = () => { publish(); save(); };
        const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
        media.addEventListener('loadedmetadata', onMetadata);
        media.addEventListener('durationchange', onMetadata);
        media.addEventListener('timeupdate', onTime);
        media.addEventListener('pause', save);
        media.addEventListener('play', onPlay);
        media.addEventListener('ended', onEnded);
        media.addEventListener('volumechange', onPreference);
        media.addEventListener('ratechange', onPreference);
        document.addEventListener('visibilitychange', onVisibility);
        const timer = window.setInterval(save, 5000);

        void (async () => {
            owner = expectedOwner ?? await getCurrentAccountId();
            if (typeof owner !== 'string' || !owner) throw new Error('ACCOUNT_REQUIRED');
            const snapshot = await readPlayback(owner);
            if (disposed) return;
            accept(snapshot);
            if (explicitRestart && mayPersist) {
                await mutate({ type: 'restart', file: descriptor });
                restartHandledRef.current = restartKey;
            }
            if (disposed) return;
            media.volume = history?.volume ?? snapshot.preferences.volume;
            media.muted = media.volume === 0;
            media.playbackRate = history?.speed ?? snapshot.preferences.speed;
            ready = true;
            applyResume();
            publish();
            if (queue.some(item => playbackId(owner!, item) === playbackId(owner!, descriptor))) {
                await mutate({ type: 'remove_queue', file: descriptor });
            }
        })().catch(reportError);

        return () => {
            save();
            disposed = true;
            controls.current = null;
            window.clearInterval(timer);
            media.removeEventListener('loadedmetadata', onMetadata);
            media.removeEventListener('durationchange', onMetadata);
            media.removeEventListener('timeupdate', onTime);
            media.removeEventListener('pause', save);
            media.removeEventListener('play', onPlay);
            media.removeEventListener('ended', onEnded);
            media.removeEventListener('volumechange', onPreference);
            media.removeEventListener('ratechange', onPreference);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [media, identity, expectedOwner, restartRequested, sourceFolder]);

    useEffect(() => {
        if (!state.ownerId) { setSleepUntil(null); return; }
        const ownerId = state.ownerId;
        const changed = () => setSleepUntil(playbackSleepDeadline(ownerId));
        changed();
        window.addEventListener(PLAYBACK_SLEEP_CHANGED, changed);
        return () => window.removeEventListener(PLAYBACK_SLEEP_CHANGED, changed);
    }, [state.ownerId]);

    useEffect(() => {
        if (sleepUntil === null) { setSleepRemaining(0); return; }
        const check = () => {
            const remaining = Math.max(0, sleepUntil - Date.now());
            setSleepRemaining(remaining);
            if (remaining === 0) {
                media?.pause();
                setSleepUntil(null);
                if (state.ownerId) setPlaybackSleepDeadline(state.ownerId, null);
            }
        };
        check();
        const timer = window.setInterval(check, 1000);
        return () => window.clearInterval(timer);
    }, [media, sleepUntil, state.ownerId]);

    const run = useCallback(async (action: (value: Controls) => Promise<void>) => {
        if (!controls.current) return false;
        try { await action(controls.current); return true; }
        catch {
            setState(previous => previous.error === 'playback.account_changed' ? previous : ({ ...previous, error: 'playback.save_error' }));
            return false;
        }
    }, []);

    return {
        ...state,
        historyAvailable: Boolean(state.ownerId) && !state.loading && (file.encryption_state ?? 'plain') === 'plain',
        attachMedia: setMedia,
        restart: () => run(value => value.restart()),
        finish: () => run(value => value.finish()),
        addBookmark: (label: string) => run(value => value.bookmark(label)),
        removeBookmark: (positionMs: number) => run(value => value.removeBookmark(positionMs)),
        playQueued: (next: PlaybackFile) => run(value => value.playQueued(next)),
        removeQueued: (next: PlaybackFile) => run(value => value.removeQueued(next)),
        seek: (positionMs: number) => { if (media) { media.currentTime = Math.max(0, Math.min(positionMs, milliseconds(media.duration) || positionMs)) / 1000; } },
        skip: (seconds: number) => { if (media) media.currentTime = Math.max(0, Math.min(media.currentTime + seconds, Number.isFinite(media.duration) ? media.duration : Infinity)); },
        setSpeed: (speed: number) => { if (media && speed >= 0.5 && speed <= 2) media.playbackRate = speed; },
        setVolume: (volume: number) => { if (media) { media.volume = Math.max(0, Math.min(volume, 1)); media.muted = volume === 0; } },
        setSleepMinutes: (minutes: number) => {
            if (state.ownerId) setPlaybackSleepDeadline(state.ownerId, minutes > 0 ? Date.now() + minutes * 60_000 : null);
        },
        sleepRemaining,
        canPlayQueue: Boolean(onPlayFile),
    };
}

export type DesktopPlayback = ReturnType<typeof useDesktopPlayback>;
