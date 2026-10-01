import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bookmark, Check, ChevronDown, Clock, ListMusic, RotateCcw, SkipBack, SkipForward, Trash2 } from 'lucide-react';
import type { DesktopPlayback } from '../../../hooks/useDesktopPlayback';
import { playbackTime } from '../../../services/playbackHistory';

export function PlaybackControls({ playback }: { playback: DesktopPlayback }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const [bookmarkLabel, setBookmarkLabel] = useState('');
    return <div className="relative mt-3 w-full max-w-4xl rounded-lg border border-white/15 bg-black/60 p-2 text-xs text-white/80" onClick={event => event.stopPropagation()}>
        <div className="flex flex-wrap items-center justify-center gap-2">
            <button type="button" className="viewer-control" onClick={() => playback.skip(-10)} aria-label={t('playback.skip_back')}><SkipBack className="h-4 w-4" /><span>{t('playback.ten_seconds')}</span></button>
            <button type="button" className="viewer-control" onClick={() => playback.skip(10)} aria-label={t('playback.skip_forward')}><span>{t('playback.ten_seconds')}</span><SkipForward className="h-4 w-4" /></button>
            <span className="tabular-nums text-white/60">{playbackTime(playback.positionMs)} / {playbackTime(playback.durationMs)}</span>
            <label className="flex items-center gap-1">{t('playback.speed')}
                <select aria-label={t('playback.speed_label')} value={playback.speed} onChange={event => playback.setSpeed(Number(event.target.value))} className="rounded bg-neutral-900 px-2 py-1 text-white">
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}
                </select>
            </label>
            <label className="flex items-center gap-2">{t('playback.volume')}
                <input aria-label={t('playback.volume_label')} type="range" min={0} max={1} step={0.05} value={playback.volume} onChange={event => playback.setVolume(Number(event.target.value))} className="w-20" />
            </label>
            <button type="button" className="viewer-control" disabled={!playback.historyAvailable} onClick={() => void playback.restart()} title={t('playback.restart_title')}><RotateCcw className="h-4 w-4" />{t('playback.restart')}</button>
            <button type="button" className="viewer-control" disabled={!playback.historyAvailable || playback.completed} onClick={() => void playback.finish()}><Check className="h-4 w-4" />{t(playback.completed ? 'playback.finished' : 'playback.mark_finished')}</button>
            <button type="button" className="viewer-control" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronDown className={`h-4 w-4 ${expanded ? 'rotate-180' : ''}`} />{t('playback.details')}</button>
        </div>
        {playback.loading && <p role="status" className="mt-2 text-center text-white/60">{t('playback.loading_position')}</p>}
        {playback.error && <p role="status" className="mt-2 text-center text-amber-200">{t(playback.error)}</p>}
        {playback.sleepRemaining > 0 && <p role="status" className="mt-2 text-center text-white/60">{t('playback.timer_remaining', { time: playbackTime(playback.sleepRemaining) })}</p>}
        {expanded && <div className="absolute inset-x-0 bottom-full z-30 mb-2 grid max-h-56 gap-4 overflow-y-auto rounded-lg border border-white/20 bg-neutral-950 p-3 text-start shadow-xl sm:grid-cols-2">
            <section aria-label={t('playback.bookmarks_label')} className="space-y-2">
                <h3 className="flex items-center gap-2 font-medium"><Bookmark className="h-4 w-4" />{t('playback.bookmarks')}</h3>
                <form className="flex gap-2" onSubmit={event => {
                    event.preventDefault();
                    if (!bookmarkLabel.trim()) return;
                    void playback.addBookmark(bookmarkLabel.trim()).then(saved => { if (saved) setBookmarkLabel(''); });
                }}>
                    <input aria-label={t('playback.bookmark_label')} maxLength={100} value={bookmarkLabel} onChange={event => setBookmarkLabel(event.target.value)} placeholder={t('playback.bookmark_placeholder')} className="min-w-0 flex-1 rounded border border-white/20 bg-white/10 px-2 py-1.5 text-white" />
                    <button type="submit" disabled={!playback.historyAvailable || !bookmarkLabel.trim()} className="viewer-control">{t('playback.add')}</button>
                </form>
                {playback.bookmarks.length === 0 && <p className="text-white/50">{t('playback.empty_bookmarks')}</p>}
                {playback.bookmarks.map(bookmark => <div key={bookmark.positionMs} className="flex items-center gap-2">
                    <button type="button" className="min-w-0 flex-1 truncate text-start hover:text-white" onClick={() => playback.seek(bookmark.positionMs)}>{playbackTime(bookmark.positionMs)} · {bookmark.label}</button>
                    <button type="button" className="viewer-control" aria-label={t('playback.remove_bookmark', { label: bookmark.label })} onClick={() => void playback.removeBookmark(bookmark.positionMs)}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>)}
                <label className="flex items-center gap-2 border-t border-white/10 pt-2"><Clock className="h-4 w-4" />{t('playback.sleep_timer')}
                    <select aria-label={t('playback.sleep_timer')} value={playback.sleepRemaining > 0 ? '-1' : '0'} disabled={!playback.ownerId} onChange={event => playback.setSleepMinutes(Number(event.target.value))} className="rounded bg-neutral-900 px-2 py-1 text-white">
                        {playback.sleepRemaining > 0 && <option value="-1">{playbackTime(playback.sleepRemaining)}</option>}
                        <option value="0">{t('playback.off')}</option>{[15, 30, 45, 60, 90].map(minutes => <option key={minutes} value={minutes}>{t('playback.minutes', { count: minutes })}</option>)}
                    </select>
                </label>
            </section>
            <section aria-label={t('playback.queue_label')} className="space-y-2">
                <h3 className="flex items-center gap-2 font-medium"><ListMusic className="h-4 w-4" />{t('playback.up_next', { count: playback.queue.length })}</h3>
                {playback.queue.length === 0 && <p className="text-white/50">{t('playback.empty_queue')}</p>}
                {playback.queue.map(item => <div key={`${item.folderId ?? 'saved'}:${item.messageId}`} className="flex items-center gap-2">
                    <button type="button" disabled={!playback.canPlayQueue} className="min-w-0 flex-1 truncate text-start hover:text-white disabled:opacity-50" onClick={() => void playback.playQueued(item)}>{item.name}</button>
                    <button type="button" className="viewer-control" aria-label={t('playback.remove_queue', { name: item.name })} onClick={() => void playback.removeQueued(item)}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>)}
            </section>
        </div>}
    </div>;
}
