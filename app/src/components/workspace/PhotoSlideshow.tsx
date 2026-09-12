import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeft, ArrowRight, Maximize, Minimize, Pause, Play, Shuffle, Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceFile } from '../../services/workspace';
import { useModalFocus } from '../../hooks/useModalFocus';
import { shouldHandleMediaShortcut } from '../../services/mediaKeyboard';

interface PhotoSlideshowProps {
    ownerId: string;
    files: WorkspaceFile[];
    initialKey?: string;
    autoPlay?: boolean;
    onClose: () => void;
    onFavorite: (file: WorkspaceFile) => void;
}

export function PhotoSlideshow({ ownerId, files, initialKey, autoPlay = false, onClose, onFavorite }: PhotoSlideshowProps) {
    const { t } = useTranslation();
    const panel = useRef<HTMLDivElement>(null);
    const [currentKey, setCurrentKey] = useState(initialKey ?? files[0]?.key ?? '');
    const [playing, setPlaying] = useState(autoPlay);
    const [shuffle, setShuffle] = useState(false);
    const [seconds, setSeconds] = useState(5);
    const [asset, setAsset] = useState<{ identity: string; source: string } | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
    const [fullscreen, setFullscreen] = useState(false);
    const [fullscreenError, setFullscreenError] = useState(false);
    const nativeFullscreen = useRef(false);
    const touch = useRef<{ id: number; x: number; y: number } | null>(null);
    const index = Math.max(0, files.findIndex(file => file.key === currentKey));
    const file = files[index];
    const identity = `${ownerId}:${file?.key ?? ''}`;
    const source = asset?.identity === identity ? asset.source : null;

    const exitFullscreen = useCallback(async () => {
        if (panel.current && document.fullscreenElement === panel.current) await document.exitFullscreen?.();
        if (nativeFullscreen.current) {
            await getCurrentWindow().setFullscreen(false);
            nativeFullscreen.current = false;
        }
        setFullscreen(false);
    }, []);
    const close = useCallback(() => {
        void exitFullscreen().catch(() => undefined).finally(onClose);
    }, [exitFullscreen, onClose]);
    const escape = useCallback(() => {
        if (document.fullscreenElement === panel.current || nativeFullscreen.current) {
            void exitFullscreen().catch(() => setFullscreenError(true));
        } else close();
    }, [close, exitFullscreen]);
    useModalFocus(panel, escape);
    const toggleFullscreen = useCallback(async () => {
        setFullscreenError(false);
        try {
            if (document.fullscreenElement === panel.current || nativeFullscreen.current) {
                await exitFullscreen();
            } else if (typeof panel.current?.requestFullscreen === 'function') {
                await panel.current.requestFullscreen();
                setFullscreen(true);
            } else {
                await getCurrentWindow().setFullscreen(true);
                nativeFullscreen.current = true;
                setFullscreen(true);
            }
        } catch { setFullscreenError(true); }
    }, [exitFullscreen]);
    const move = useCallback((delta: number) => setCurrentKey(current => {
        if (files.length === 0) return '';
        const at = Math.max(0, files.findIndex(file => file.key === current));
        const step = shuffle && delta > 0 && files.length > 1 ? 1 + Math.floor(Math.random() * (files.length - 1)) : delta;
        return files[(at + step + files.length) % files.length].key;
    }), [files, shuffle]);

    useEffect(() => {
        let active = true; let settled = false;
        const requestId = crypto.randomUUID();
        setAsset(null); setError(false); setLoaded(false);
        if (file) void invoke<string>('cmd_workspace_asset', { ownerId, key: file.key, thumbnail: false, requestId })
            .then(path => { if (active) setAsset({ identity, source: convertFileSrc(path) }); })
            .catch(() => { if (active) setError(true); }).finally(() => { settled = true; });
        return () => {
            active = false;
            if (file && !settled) void invoke('cmd_workspace_cancel_asset', { ownerId, requestId }).catch(() => undefined);
        };
    }, [ownerId, file?.key, identity, attempt]);
    useEffect(() => {
        if (!playing || !source || !loaded || !visible || files.length < 2) return;
        const timer = window.setTimeout(() => move(1), seconds * 1000);
        return () => window.clearTimeout(timer);
    }, [playing, source, loaded, visible, seconds, move, files.length]);
    useEffect(() => {
        const visibility = () => setVisible(document.visibilityState !== 'hidden');
        const changed = () => setFullscreen(document.fullscreenElement === panel.current || nativeFullscreen.current);
        document.addEventListener('visibilitychange', visibility);
        document.addEventListener('fullscreenchange', changed);
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            document.removeEventListener('fullscreenchange', changed);
            void exitFullscreen().catch(() => undefined);
        };
    }, [exitFullscreen]);
    useEffect(() => {
        const handle = (event: KeyboardEvent) => {
            if (!shouldHandleMediaShortcut(event)) return;
            if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
            else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
            else if (event.key === ' ' || event.code === 'Space') { event.preventDefault(); setPlaying(value => !value); }
            else if (event.key.toLowerCase() === 'f') { event.preventDefault(); void toggleFullscreen(); }
        };
        window.addEventListener('keydown', handle);
        return () => window.removeEventListener('keydown', handle);
    }, [move, toggleFullscreen]);
    useEffect(() => { if (files.length === 0) onClose(); }, [files.length, onClose]);

    if (!file) return null;
    return <div ref={panel} role="dialog" aria-modal="true" aria-label={t(autoPlay ? 'workspace.slideshow' : 'workspace.image_viewer')} tabIndex={-1} className="fixed inset-0 z-[90] flex flex-col bg-black text-white">
        <header className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
            <div className="min-w-0 flex-1"><p className="truncate text-sm">{file.name}</p><p className="text-xs text-white/60" aria-live="polite">{index + 1} / {files.length}</p></div>
            <button type="button" aria-label={t('workspace.favorite_file', { name: file.name })} aria-pressed={file.is_favorite} onClick={() => onFavorite(file)} className="min-h-11 min-w-11 rounded-xl hover:bg-white/10"><Star className={`mx-auto h-5 w-5 ${file.is_favorite ? 'fill-amber-400 text-amber-400' : ''}`} /></button>
            <button type="button" aria-label={t(fullscreen ? 'workspace.exit_fullscreen' : 'workspace.fullscreen')} onClick={() => void toggleFullscreen()} className="min-h-11 min-w-11 rounded-xl hover:bg-white/10">{fullscreen ? <Minimize className="mx-auto h-5 w-5" /> : <Maximize className="mx-auto h-5 w-5" />}</button>
            <button type="button" aria-label={t('common.close')} onClick={close} className="min-h-11 min-w-11 rounded-xl hover:bg-white/10"><X className="mx-auto h-5 w-5" /></button>
        </header>
        {fullscreenError && <p role="status" className="px-4 pt-2 text-xs text-amber-200">{t('workspace.fullscreen_failed')}</p>}
        <div className="flex min-h-0 flex-1 items-center justify-center p-4" data-testid="photo-gesture-area" style={{ touchAction: 'pan-y' }}
            onTouchStart={event => {
                const point = event.touches.length === 1 ? event.touches[0] : null;
                touch.current = point ? { id: point.identifier, x: point.clientX, y: point.clientY } : null;
            }}
            onTouchCancel={() => { touch.current = null; }}
            onTouchEnd={event => {
                const start = touch.current; touch.current = null;
                if (!start) return;
                const point = Array.from(event.changedTouches).find(point => point.identifier === start.id);
                if (!point) return;
                const dx = point.clientX - start.x; const dy = point.clientY - start.y;
                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
            }}>
            {source ? <img key={identity} src={source} alt={file.name} className="max-h-full max-w-full object-contain" onLoad={() => setLoaded(true)} onError={() => { setAsset(null); setError(true); setLoaded(false); }} />
                : <div className="space-y-3 text-center"><p role={error ? 'alert' : 'status'} className="text-sm text-white/70">{t(error ? 'workspace.preview_failed' : 'common.loading')}</p>{error && <button type="button" onClick={() => setAttempt(value => value + 1)} className="min-h-11 rounded-xl bg-white/15 px-4 text-sm">{t('workspace.retry_preview')}</button>}</div>}
        </div>
        <footer className="flex flex-wrap items-center justify-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <button type="button" aria-label={t('workspace.previous')} onClick={() => move(-1)} className="min-h-11 min-w-11 rounded-xl hover:bg-white/10"><ArrowLeft className="mx-auto h-5 w-5" /></button>
            <button type="button" aria-label={t(playing ? 'workspace.pause' : 'common.play')} aria-pressed={playing} onClick={() => setPlaying(value => !value)} className="min-h-11 min-w-11 rounded-xl bg-white/15">{playing ? <Pause className="mx-auto h-5 w-5" /> : <Play className="mx-auto h-5 w-5" />}</button>
            <button type="button" aria-label={t('workspace.next')} onClick={() => move(1)} className="min-h-11 min-w-11 rounded-xl hover:bg-white/10"><ArrowRight className="mx-auto h-5 w-5" /></button>
            <button type="button" aria-label={t('workspace.shuffle')} aria-pressed={shuffle} onClick={() => setShuffle(value => !value)} className={`min-h-11 min-w-11 rounded-xl ${shuffle ? 'bg-white/20' : ''}`}><Shuffle className="mx-auto h-5 w-5" /></button>
            <label className="flex items-center gap-2 px-3 text-xs">{t('workspace.interval')}<select className="min-h-11 rounded-xl bg-white/15 px-3" value={seconds} onChange={event => setSeconds(Number(event.target.value))}>{[3, 5, 10, 20].map(value => <option key={value} value={value} className="text-black">{t('workspace.seconds', { count: value })}</option>)}</select></label>
        </footer>
    </div>;
}
