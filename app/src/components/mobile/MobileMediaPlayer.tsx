import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import type { TelegramFile } from '../../types';
import { isAudioFile, isVideoFile } from '../../utils';

interface MobileMediaPlayerProps {
  file: TelegramFile;
  activeFolderId: number | null;
  onClose: () => void;
  preferences?: {
    privateMetadata: boolean;
    privacyScreen: boolean;
    orientation: 'auto' | 'landscape' | 'portrait';
    subtitleScale: number;
    playbackSpeed: number;
  };
}

interface PreviewProgress {
  message_id: number;
  folder_id: number | null;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
}

interface StreamInfo {
  token: string;
  base_url: string;
  operation_token?: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MobileMediaPlayer({ file, activeFolderId, onClose, preferences }: MobileMediaPlayerProps) {
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [usingDownloadFallback, setUsingDownloadFallback] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const isVideo = isVideoFile(file.name, file.mime_type);
  const isAudio = isAudioFile(file.name, file.mime_type);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    setLoading(true);
    setProgress(0);
    setError(null);
    setLocalPath(null);
    setSourceUrl(null);

    const prepareCachedMedia = async () => {
      try {
        unlisten = await listen<PreviewProgress>('preview-progress', ({ payload }) => {
          if (cancelled || payload.message_id !== file.id || payload.folder_id !== activeFolderId) return;
          setProgress(Math.max(0, Math.min(100, payload.percent)));
        });
        if (cancelled) {
          unlisten();
          return;
        }

        const path = await invoke<string>('cmd_get_preview', {
          messageId: file.id,
          folderId: activeFolderId,
        });
        if (cancelled) return;
        if (!path) throw new Error('Android could not prepare a local media file.');

        setLocalPath(path);
        setSourceUrl(convertFileSrc(path));
        setProgress(100);
        setLoading(false);
      } catch (prepareError) {
        if (cancelled) return;
        setError(`Unable to prepare this media file: ${errorMessage(prepareError)}`);
        setLoading(false);
      }
    };

    const prepare = async () => {
      if ((isVideo || isAudio) && !usingDownloadFallback) {
        try {
          const streamInfo = await invoke<StreamInfo>('cmd_get_stream_info');
          if (cancelled) return;
          const folder = activeFolderId === null ? 'home' : String(activeFolderId);
          const credential = streamInfo.operation_token ? `&credential=${encodeURIComponent(streamInfo.operation_token)}` : '';
          const streamUrl = `${streamInfo.base_url}/stream/${folder}/${file.id}?token=${encodeURIComponent(streamInfo.token)}${credential}`;
          await invoke('cmd_open_android_stream_player', {
            streamUrl,
            title: file.name,
            mimeType: file.mime_type && file.mime_type !== 'application/octet-stream'
              ? file.mime_type
              : isVideo ? 'video/*' : 'audio/*',
            mediaId: `${activeFolderId ?? 'home'}:${file.id}`,
            preferencesJson: JSON.stringify(preferences ?? {
              privateMetadata: true,
              privacyScreen: false,
              orientation: 'auto',
              subtitleScale: 1,
              playbackSpeed: 1,
            }),
          });
          if (!cancelled) onClose();
          return;
        } catch (streamError) {
          if (cancelled) return;
          setError(`Unable to start secure streaming: ${errorMessage(streamError)}`);
          setLoading(false);
          return;
        }
      }
      await prepareCachedMedia();
    };

    void prepare();
    return () => {
      cancelled = true;
      unlisten?.();
      videoRef.current?.pause();
      audioRef.current?.pause();
    };
  }, [activeFolderId, attempt, file.id, file.mime_type, file.name, isAudio, isVideo, onClose, preferences, usingDownloadFallback]);

  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const downloadAndPlay = useCallback(() => {
    setUsingDownloadFallback(true);
    setAttempt(value => value + 1);
  }, []);

  const openExternally = useCallback(async () => {
    if (!localPath) return;
    try {
      await invoke('cmd_open_file_externally', { path: localPath });
    } catch (openError) {
      setError(`The Android media app could not be opened: ${errorMessage(openError)}`);
    }
  }, [localPath]);

  const handlePlaybackError = useCallback(() => {
    setError('This file was downloaded, but the Android WebView cannot decode its media format. You can open it with another installed media app.');
  }, []);

  return (
    <div className="fixed inset-0 z-[220] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label={`Playing ${file.name}`}>
      <header className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/80 px-4 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{file.name}</p>
          <p className="mt-0.5 text-[10px] text-white/55">Secure in-app playback</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-full p-2 text-white/75 hover:bg-white/10 hover:text-white" aria-label="Close media player">
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center p-4">
        {loading ? (
          <div className="w-full max-w-sm text-center text-white" role="status">
            <Loader2 className="mx-auto h-9 w-9 animate-spin text-telegram-primary" aria-hidden="true" />
            <p className="mt-4 text-sm font-medium">Opening the Android player…</p>
            <p className="mt-1 text-xs text-white/55">Streaming securely without leaving Telegram Drive.</p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-telegram-primary transition-[width]" style={{ width: `${Math.max(progress, 2)}%` }} />
            </div>
            <p className="mt-2 text-[10px] text-white/45">{progress > 0 ? `${progress}%` : 'Connecting to Telegram…'}</p>
          </div>
        ) : sourceUrl && !error && isVideo ? (
          <video
            ref={videoRef}
            src={sourceUrl}
            controls
            controlsList="nodownload"
            autoPlay
            playsInline
            className="max-h-full w-full object-contain"
            onError={handlePlaybackError}
          />
        ) : sourceUrl && !error && isAudio ? (
          <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/5 p-6">
            <audio
              ref={audioRef}
              src={sourceUrl}
              controls
              autoPlay
              className="w-full"
              onError={handlePlaybackError}
            />
          </div>
        ) : (
          <div className="w-full max-w-md rounded-2xl border border-amber-400/25 bg-amber-400/10 p-5 text-center text-white">
            <AlertTriangle className="mx-auto h-8 w-8 text-amber-300" aria-hidden="true" />
            <h2 className="mt-3 text-sm font-semibold">Playback needs attention</h2>
            <p className="mt-2 text-xs leading-5 text-white/65">{error ?? 'This media type is not supported by the Android player.'}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={retry} className="flex items-center gap-2 rounded-xl bg-telegram-primary px-4 py-2.5 text-xs font-semibold text-white">
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry
              </button>
              {(isVideo || isAudio) && !localPath && (
                <button type="button" onClick={downloadAndPlay} className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-semibold text-white">
                  <Loader2 className="h-4 w-4" aria-hidden="true" /> Download fallback
                </button>
              )}
              {localPath && (
                <button type="button" onClick={() => void openExternally()} className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-semibold text-white">
                  <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open in another app
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
