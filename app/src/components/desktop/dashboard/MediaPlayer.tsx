import { useEffect, useState, useRef, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { TelegramFile } from '../../../types';
import { isVideoFile, isAudioFile } from '../../../utils';
import { AdaptiveMediaPlayer } from './AdaptiveMediaPlayer';
import { shouldHandleMediaShortcut } from '../../../services/mediaKeyboard';
import { useDesktopPlayback } from '../../../hooks/useDesktopPlayback';
import { PlaybackControls } from '../playback/PlaybackControls';
import i18n from '../../../i18n';

interface StreamInfo {
    token: string;
    base_url: string;
    operation_token?: string | null;
}

interface MediaPlayerProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
    ownerId?: string;
    restart?: boolean;
    onPlayFile?: (file: TelegramFile) => void;
    /** Path returned by the account-scoped offline file service. */
    localPath?: string;
}

function isMp4Video(name: string): boolean {
    return name.toLowerCase().endsWith('.mp4');
}

export function MediaPlayer({ file, onClose, onNext, onPrev, currentIndex, totalItems, activeFolderId, ownerId, restart, onPlayFile, localPath }: MediaPlayerProps) {
    const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const sourceFolder = file.folder_id === undefined ? activeFolderId : file.folder_id;
    const playback = useDesktopPlayback(file, sourceFolder, ownerId, restart, onPlayFile);

    const toggleFullscreen = useCallback(async () => {
        try {
            const win = getCurrentWindow();
            const fs = await win.isFullscreen();
            await win.setFullscreen(!fs);
            setIsFullscreen(!fs);
        } catch {
            // Not running in Tauri — fall back to webview fullscreen
            const el = containerRef.current;
            if (!el) return;
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else {
                el.requestFullscreen().catch(() => {});
            }
        }
    }, []);

    // Sync isFullscreen when OS changes fullscreen (e.g. Escape / green button)
    useEffect(() => {
        let mounted = true;
        let unlistenFn: (() => void) | undefined;
        const attach = async () => {
            const dispose = await getCurrentWindow().onResized(async () => {
                if (!mounted) return;
                try {
                    const fs = await getCurrentWindow().isFullscreen();
                    if (mounted) setIsFullscreen(fs);
                } catch {}
            });
            if (mounted) unlistenFn = dispose;
            else dispose();
        };
        void attach().catch(() => {});
        return () => {
            mounted = false;
            unlistenFn?.();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setStreamInfo(null);
        if (localPath) return;
        invoke<StreamInfo>('cmd_get_stream_info').then(info => {
            if (!cancelled) setStreamInfo(info);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [localPath]);

    const folderIdParam = sourceFolder !== null ? sourceFolder.toString() : 'home';
    const streamCredential = streamInfo?.operation_token
        ? `&credential=${encodeURIComponent(streamInfo.operation_token)}`
        : '';
    const streamUrl = localPath ? convertFileSrc(localPath) : streamInfo
        ? `${streamInfo.base_url}/stream/${folderIdParam}/${file.id}?token=${encodeURIComponent(streamInfo.token)}${streamCredential}`
        : null;

    const isVideo = isVideoFile(file.name);
    const isAudio = isAudioFile(file.name);
    const isMp4 = isMp4Video(file.name);

    useEffect(() => {
        // The adaptive child owns its own controls. Keeping this listener alive
        // while it is mounted toggles playback twice for a single keypress.
        if (isMp4 && streamUrl && !localPath) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleMediaShortcut(e)) return;

            const key = e.key.toLowerCase();

            if (e.key === 'ArrowRight' || key === 'l') {
                e.preventDefault();
                onNext?.();
                return;
            }

            if (e.key === 'ArrowLeft' || key === 'j') {
                e.preventDefault();
                onPrev?.();
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }

            if (key === 'f') {
                e.preventDefault();
                toggleFullscreen();
            }

            if (key === 'm') {
                e.preventDefault();
                const media = containerRef.current?.querySelector('video, audio') as HTMLMediaElement | null;
                if (media) {
                    media.muted = !media.muted;
                }
            }

            if (e.key === ' ') {
                e.preventDefault();
                const media = containerRef.current?.querySelector('video, audio') as HTMLMediaElement | null;
                if (media) {
                    media.paused ? media.play().catch(() => {}) : media.pause();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isMp4, streamUrl, localPath, onClose, onNext, onPrev, toggleFullscreen]);

    // MP4 files: use adaptive streaming with quality controls + throttling
    if (isMp4 && streamUrl && !localPath) {
        return (
            <AdaptiveMediaPlayer
                file={file}
                streamUrl={streamUrl}
                activeFolderId={sourceFolder}
                onClose={onClose}
                onNext={onNext}
                onPrev={onPrev}
                currentIndex={currentIndex}
                totalItems={totalItems}
                playback={playback}
            />
        );
    }

    return (
        <div className={`viewer-overlay fixed inset-0 z-[200] animate-in fade-in duration-150 ${isFullscreen ? 'p-0' : 'flex items-center justify-center p-4'}`} onClick={onClose}>
            <div ref={containerRef} className={`relative ${isFullscreen ? 'w-full h-full' : 'w-full max-w-6xl flex flex-col items-center'}`} onClick={e => e.stopPropagation()}>
                <div className={`viewer-toolbar absolute z-30 ${isFullscreen ? 'end-4 top-4' : '-top-10 end-0'}`}>
                    <button
                        onClick={toggleFullscreen}
                        className="viewer-control"
                        title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                    >
                        {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
                    </button>
                    <button
                        onClick={onClose}
                        className="viewer-control"
                        title="Close (Esc)"
                        aria-label="Close media player"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <button
                    onClick={onPrev}
                    className={`viewer-navigation absolute start-2 top-1/2 z-10 -translate-y-1/2 ${isFullscreen ? 'start-4' : ''}`}
                    title="Previous (ArrowLeft / J)"
                    aria-label="Previous file"
                >
                    <ChevronLeft className="h-5 w-5 rtl:rotate-180" />
                </button>

                <button
                    onClick={onNext}
                    className={`viewer-navigation absolute end-2 top-1/2 z-10 -translate-y-1/2 ${isFullscreen ? 'end-4' : ''}`}
                    title="Next (ArrowRight / L)"
                    aria-label="Next file"
                >
                    <ChevronRight className="h-5 w-5 rtl:rotate-180" />
                </button>

                <div className={`flex items-center justify-center overflow-hidden bg-black ${isFullscreen ? 'h-full w-full rounded-none shadow-none' : 'viewer-panel aspect-video w-full'}`}>
                    {!streamUrl ? (
                        <div className="flex flex-col items-center gap-4 text-white">
                            <div className="w-10 h-10 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>
                            <p>Preparing stream...</p>
                        </div>
                    ) : isVideo ? (
                        <video
                            ref={playback.attachMedia}
                            src={streamUrl}
                            controls
                            controlsList="nodownload"
                            autoPlay
                            className="w-full h-full object-contain"
                        />
                    ) : isAudio ? (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-telegram-primary/20 to-black">
                            <div className="w-32 h-32 rounded-full bg-telegram-surface flex items-center justify-center mb-8 shadow-xl animate-pulse-slow">
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 text-telegram-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                            </div>
                            <audio ref={playback.attachMedia} src={streamUrl} controls autoPlay className="w-full max-w-md" />
                        </div>
                    ) : (
                        <div className="text-white">Unsupported media type</div>
                    )}
                </div>

                {!isFullscreen && <div className="mt-3 max-w-full text-center">
                    <h3 className="max-w-2xl truncate text-ui font-medium text-white" title={file.name}>{file.name}</h3>
                    <p className="text-metadata text-white/45">
                        {i18n.t(localPath ? 'playback.offline_source' : 'playback.remote_source')}
                        {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                            <span className="ms-2">• {currentIndex + 1}/{totalItems}</span>
                        )}
                    </p>
                </div>}

                {!isFullscreen && <PlaybackControls playback={playback} />}

                {/* Keyboard shortcut hints */}
                {!isFullscreen && <div className="mt-2 flex items-center gap-4 text-[10px] text-white/25 select-none">
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/40 text-[9px] font-mono">← →</kbd> Navigate
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/40 text-[9px] font-mono">Space</kbd> Play/Pause
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/40 text-[9px] font-mono">F</kbd> Fullscreen
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/40 text-[9px] font-mono">Esc</kbd> {i18n.t("common.close")}
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/40 text-[9px] font-mono">M</kbd> Mute
                    </span>
                </div>}
            </div>
        </div>
    );
}
