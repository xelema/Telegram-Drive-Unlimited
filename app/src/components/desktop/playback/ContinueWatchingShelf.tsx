import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ListPlus, Play, RotateCcw, Trash2 } from 'lucide-react';
import type { TelegramFile } from '../../../types';
import {
    fromPlaybackFile, mutatePlayback, playbackTime, PLAYBACK_CHANGED, readPlayback,
    type PlaybackFile, type PlaybackMutation, type PlaybackSnapshot,
} from '../../../services/playbackHistory';

export interface ContinueWatchingShelfProps {
    ownerId: string;
    onPlay: (file: TelegramFile, options?: { restart?: boolean }) => void;
}

export function ContinueWatchingShelf({ ownerId, onPlay }: ContinueWatchingShelfProps) {
    const { t } = useTranslation();
    const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [showFinished, setShowFinished] = useState(false);
    const generation = useRef(0);
    const currentOwner = useRef(ownerId);
    currentOwner.current = ownerId;
    const refresh = useCallback(async () => {
        const request = ++generation.current;
        try {
            const next = await readPlayback(ownerId);
            if (request === generation.current) { setSnapshot(next); setError(null); }
        } catch {
            if (request === generation.current) setError('playback.load_error');
        } finally {
            if (request === generation.current) setLoading(false);
        }
    }, [ownerId]);
    useEffect(() => {
        setSnapshot(null); setLoading(true);
        void refresh();
        const changed = (event: Event) => {
            if ((event as CustomEvent<{ ownerId: string }>).detail?.ownerId === ownerId) void refresh();
        };
        window.addEventListener(PLAYBACK_CHANGED, changed);
        return () => { generation.current++; window.removeEventListener(PLAYBACK_CHANGED, changed); };
    }, [ownerId, refresh]);
    const update = async (mutation: PlaybackMutation) => {
        try { await mutatePlayback(ownerId, mutation); }
        catch { if (currentOwner.current === ownerId) setError('playback.save_error'); }
    };
    const play = async (file: PlaybackFile, restart = false) => {
        try {
            if (restart) await mutatePlayback(ownerId, { type: 'restart', file });
            await mutatePlayback(ownerId, { type: 'remove_queue', file });
            if (currentOwner.current === ownerId) onPlay(fromPlaybackFile(file), { restart });
        } catch { if (currentOwner.current === ownerId) setError('playback.open_error'); }
    };
    const owned = snapshot?.ownerId === ownerId ? snapshot : null;
    const items = owned?.items.filter(item => showFinished ? item.completed : !item.completed && item.positionMs > 0) ?? [];

    return <section aria-labelledby="continue-playback-title" className="quiet-surface space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h2 id="continue-playback-title" className="font-semibold text-app-text">{t('playback.title')}</h2><p className="mt-1 text-xs text-app-text-secondary">{t('playback.subtitle')}</p></div>
            <label className="flex items-center gap-2 text-xs text-app-text-secondary"><input type="checkbox" checked={showFinished} onChange={event => setShowFinished(event.target.checked)} />{t('playback.show_finished')}</label>
        </div>
        {loading && <p role="status" className="text-sm text-app-text-secondary">{t('playback.loading_history')}</p>}
        {error && <div role="alert" className="flex items-center gap-2 text-sm text-app-danger">{t(error)}<button type="button" className="quiet-control px-2 py-1" onClick={() => void refresh()}>{t('playback.retry')}</button></div>}
        {!loading && items.length === 0 && <p className="text-sm text-app-text-secondary">{t(showFinished ? 'playback.empty_finished' : 'playback.empty_history')}</p>}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map(item => <article key={item.mediaId} className="rounded-lg border border-app-border p-3">
                <button type="button" onClick={() => void play(item, item.completed)} className="flex w-full items-center gap-2 text-start text-sm font-medium text-app-text"><Play className="h-4 w-4 shrink-0 text-app-accent" /><span className="truncate">{item.name}</span></button>
                <div className="mt-2 h-1 overflow-hidden rounded bg-app-border-subtle" role="progressbar" aria-label={t('playback.progress_label', { name: item.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.durationMs ? Math.round(item.positionMs / item.durationMs * 100) : 0}><div className="h-full bg-app-accent" style={{ width: `${item.durationMs ? Math.min(100, item.positionMs / item.durationMs * 100) : 0}%` }} /></div>
                <p className="mt-1 text-xs tabular-nums text-app-text-tertiary">{playbackTime(item.positionMs)} / {playbackTime(item.durationMs)}{item.bookmarks.length > 0 ? ` · ${t('playback.bookmark_count', { count: item.bookmarks.length })}` : ''}</p>
                <div className="mt-3 flex flex-wrap items-center gap-1 text-xs">
                    <button type="button" className="quiet-control flex items-center gap-1 px-2 py-1" onClick={() => void play(item, true)}><RotateCcw className="h-3.5 w-3.5" />{t('playback.restart')}</button>
                    <button type="button" className="quiet-control flex items-center gap-1 px-2 py-1" onClick={() => void update({ type: 'enqueue', files: [item] })}><ListPlus className="h-3.5 w-3.5" />{t('playback.queue')}</button>
                    {!item.completed && <button type="button" className="quiet-control flex items-center gap-1 px-2 py-1" onClick={() => void update({ type: 'finish', file: item, durationMs: item.durationMs })}><Check className="h-3.5 w-3.5" />{t('playback.finished')}</button>}
                    <button type="button" className="quiet-control ms-auto p-1.5" aria-label={t('playback.forget', { name: item.name })} onClick={() => void update({ type: 'forget', file: item })}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
            </article>)}
        </div>
        {(owned?.queue.length ?? 0) > 0 && <div className="space-y-2 border-t border-app-border-subtle pt-3">
            <div className="flex items-center justify-between text-sm"><h3 className="font-medium">{t('playback.up_next', { count: owned!.queue.length })}</h3><button type="button" className="quiet-control px-2 py-1 text-xs" onClick={() => void update({ type: 'clear_queue' })}>{t('playback.clear_queue')}</button></div>
            {owned!.queue.map((item, index) => <div key={`${item.folderId ?? 'saved'}:${item.messageId}`} className="flex items-center gap-2 text-sm">
                <span className="text-xs tabular-nums text-app-text-tertiary">{index + 1}</span><button type="button" className="min-w-0 flex-1 truncate text-start hover:text-app-accent" onClick={() => void play(item)}>{item.name}</button><button type="button" className="quiet-control p-1.5" aria-label={t('playback.remove_queue', { name: item.name })} onClick={() => void update({ type: 'remove_queue', file: item })}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>)}
        </div>}
    </section>;
}
