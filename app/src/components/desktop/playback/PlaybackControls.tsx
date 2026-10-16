import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bookmark, Check, ChevronDown, Clock, ListMusic, RotateCcw, SkipBack, SkipForward, Trash2 } from 'lucide-react';
import type { DesktopPlayback } from '../../../hooks/useDesktopPlayback';
import { playbackTime } from '../../../services/playbackHistory';
import { Select } from '../../ui/FormControls';

export function PlaybackControls({ playback }: { playback: DesktopPlayback }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const [bookmarkLabel, setBookmarkLabel] = useState('');
    return <div className="playback-controls" onClick={event => event.stopPropagation()}>
        <div className="playback-controls-row">
            <div className="playback-control-group">
                <button type="button" className="viewer-control playback-action" onClick={() => playback.skip(-10)} aria-label={t('playback.skip_back')}><SkipBack className="h-4 w-4" /><span>{t('playback.ten_seconds')}</span></button>
                <button type="button" className="viewer-control playback-action" onClick={() => playback.skip(10)} aria-label={t('playback.skip_forward')}><span>{t('playback.ten_seconds')}</span><SkipForward className="h-4 w-4" /></button>
                <span className="playback-time tabular-nums">{playbackTime(playback.positionMs)} / {playbackTime(playback.durationMs)}</span>
            </div>
            <div className="playback-control-group">
                <label className="playback-field">{t('playback.speed')}
                    <span className="playback-select-wrap"><Select aria-label={t('playback.speed_label')} value={playback.speed} onChange={event => playback.setSpeed(Number(event.target.value))} className="playback-select">
                        {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}
                    </Select><ChevronDown aria-hidden="true" className="playback-select-chevron" /></span>
                </label>
                <label className="playback-field playback-volume">{t('playback.volume')}
                    <input aria-label={t('playback.volume_label')} type="range" min={0} max={1} step={0.05} value={playback.volume} onChange={event => playback.setVolume(Number(event.target.value))} className="playback-volume-input" />
                </label>
            </div>
            <div className="playback-control-group playback-actions">
                <button type="button" className="viewer-control playback-action" disabled={!playback.historyAvailable} onClick={() => void playback.restart()} title={t('playback.restart_title')}><RotateCcw className="h-4 w-4" />{t('playback.restart')}</button>
                <button type="button" className="viewer-control playback-action" disabled={!playback.historyAvailable || playback.completed} onClick={() => void playback.finish()}><Check className="h-4 w-4" />{t(playback.completed ? 'playback.finished' : 'playback.mark_finished')}</button>
                <button type="button" className="viewer-control playback-action" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronDown className={`h-4 w-4 ${expanded ? 'rotate-180' : ''}`} />{t('playback.details')}</button>
            </div>
        </div>
        {playback.loading && <p role="status" className="mt-2 text-center text-white/60">{t('playback.loading_position')}</p>}
        {playback.error && <p role="status" className="mt-2 text-center text-amber-200">{t(playback.error)}</p>}
        {playback.sleepRemaining > 0 && <p role="status" className="mt-2 text-center text-white/60">{t('playback.timer_remaining', { time: playbackTime(playback.sleepRemaining) })}</p>}
        {expanded && <div className="playback-details">
            <section aria-label={t('playback.bookmarks_label')} className="space-y-2">
                <h3 className="flex items-center gap-2 font-medium"><Bookmark className="h-4 w-4" />{t('playback.bookmarks')}</h3>
                <form className="flex gap-2" onSubmit={event => {
                    event.preventDefault();
                    if (!bookmarkLabel.trim()) return;
                    void playback.addBookmark(bookmarkLabel.trim()).then(saved => { if (saved) setBookmarkLabel(''); });
                }}>
                    <input aria-label={t('playback.bookmark_label')} maxLength={100} value={bookmarkLabel} onChange={event => setBookmarkLabel(event.target.value)} placeholder={t('playback.bookmark_placeholder')} className="min-w-0 flex-1 rounded border border-white/20 bg-white/10 px-2 py-1.5 text-white" />
                    <button type="submit" disabled={!playback.historyAvailable || !bookmarkLabel.trim()} className="viewer-control playback-action">{t('playback.add')}</button>
                </form>
                {playback.bookmarks.length === 0 && <p className="text-white/50">{t('playback.empty_bookmarks')}</p>}
                {playback.bookmarks.map(bookmark => <div key={bookmark.positionMs} className="flex items-center gap-2">
                    <button type="button" className="min-w-0 flex-1 truncate text-start hover:text-white" onClick={() => playback.seek(bookmark.positionMs)}>{playbackTime(bookmark.positionMs)} · {bookmark.label}</button>
                    <button type="button" className="viewer-control" aria-label={t('playback.remove_bookmark', { label: bookmark.label })} onClick={() => void playback.removeBookmark(bookmark.positionMs)}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>)}
                <label className="playback-field flex-wrap border-t border-white/10 pt-3"><Clock className="h-4 w-4" />{t('playback.sleep_timer')}
                    <span className="playback-select-wrap"><Select aria-label={t('playback.sleep_timer')} value={playback.sleepRemaining > 0 ? '-1' : '0'} disabled={!playback.ownerId} onChange={event => playback.setSleepMinutes(Number(event.target.value))} className="playback-select">
                        {playback.sleepRemaining > 0 && <option value="-1">{playbackTime(playback.sleepRemaining)}</option>}
                        <option value="0">{t('playback.off')}</option>{[15, 30, 45, 60, 90].map(minutes => <option key={minutes} value={minutes}>{t('playback.minutes', { count: minutes })}</option>)}
                    </Select><ChevronDown aria-hidden="true" className="playback-select-chevron" /></span>
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
