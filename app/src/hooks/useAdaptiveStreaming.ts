import { useRef, useState, useEffect, useCallback } from 'react';
import { createFile, MP4BoxBuffer } from 'mp4box';
import type { ISOFile } from 'mp4box';
import {
    StreamingQuality,
    VideoTrackInfo,
    QUALITY_THROTTLE_MAP,
    ADAPTIVE_THRESHOLDS,
} from '../types';
import { useStreamingSettings } from './useStreamingSettings';
import { getCachedMoov, setCachedMoov, extractCacheKey } from './moovCache';

// ── Types ────────────────────────────────────────────────────────────

interface Mp4Track {
    id: number;
    type: string;
    codec: string;
    timescale: number;
    duration: number;
    bitrate: number;
    video?: { width: number; height: number };
    audio?: { sample_rate: number; channel_count: number };
}

interface Mp4MovieInfo {
    tracks: Mp4Track[];
    duration: number;
    timescale: number;
    isFragmented: boolean;
    isProgressive: boolean;
    hasIOD: boolean;
    brands: string[];
}

export type PlayerPhase =
    | 'initializing'
    | 'loading'
    | 'ready'
    | 'playing'
    | 'seeking'
    | 'ended'
    | 'error';

interface PlayerState {
    phase: PlayerPhase;
    error: string | null;
    tracks: VideoTrackInfo[];
    loadProgress: number;
    measuredKbps: number;
}

const FALLBACK_EXTENSIONS = ['webm', 'ogg', 'mov', 'mkv', 'avi'];
const SPEED_WINDOW_MS = 3000;
const SPEED_CHECK_INTERVAL_MS = 2000;
const SEEK_DEBOUNCE_MS = 300;
const MOOV_DISCOVERY_BYTES = 131072;   // 128KB — covers ftyp + moov for most files
const MOOV_TAIL_BYTES = 524288;        // 512KB — tail fetch for moov-at-end files
const MOOV_FALLBACK_TIMEOUT_MS = 3000;

function isMp4File(name: string): boolean {
    return name.toLowerCase().endsWith('.mp4');
}

function shouldUseFallback(name: string): boolean {
    const lower = name.toLowerCase();
    return FALLBACK_EXTENSIONS.some(ext => lower.endsWith(`.${ext}`));
}

function mseSupported(): boolean {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
}

export interface UseAdaptiveStreamingResult {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    phase: PlayerPhase;
    error: string | null;
    tracks: VideoTrackInfo[];
    loadProgress: number;
    currentQuality: StreamingQuality;
    setQuality: (q: StreamingQuality) => void;
    adaptiveMode: boolean;
    setAdaptiveMode: (enabled: boolean) => void;
    measuredKbps: number;
    seek: (time: number) => void;
    useFallback: boolean;
    fallbackUrl: string;
    abort: () => void;
}

export function useAdaptiveStreaming(
    streamUrl: string,
    fileName: string,
): UseAdaptiveStreamingResult {
    // ── Ref-based mutable state ──────────────────────────────────────
    const mp4boxRef = useRef<ISOFile | null>(null);
    const mediaSourceRef = useRef<MediaSource | null>(null);
    const sourceBufferRef = useRef<SourceBuffer | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const discoveryAbortRef = useRef<AbortController | null>(null);
    const fetchOffsetRef = useRef(0);
    const totalFetchedRef = useRef(0);
    const throttleBpsRef = useRef(0);
    const playerPhaseRef = useRef<PlayerPhase>('initializing');
    const isSeekingRef = useRef(false);
    const pendingSeekTimeRef = useRef<number | null>(null);
    const speedSamplesRef = useRef<{ time: number; bytes: number }[]>([]);
    const fileSizeRef = useRef<number>(0);
    const appendQueueRef = useRef<ArrayBuffer[]>([]);
    const lastSampleNumRef = useRef<number>(0);
    const tracksRef = useRef<VideoTrackInfo[]>([]);
    const onReadyCalledRef = useRef(false);
    const moovEndOffsetRef = useRef(0);
    // Original discovery bytes — fed to the fresh playback file so it
    // boots with real source MP4 data, not generated fMP4 init segment.
    const discoveryPrefixRef = useRef<ArrayBuffer | null>(null);
    const discoveryNextOffsetRef = useRef(0);
    // Tail data for moov-at-end files (stored separately with correct offset)
    const discoverySuffixRef = useRef<ArrayBuffer | null>(null);
    const discoverySuffixOffsetRef = useRef(0);

    // ── React state (UI-relevant only) ───────────────────────────────
    const videoRef = useRef<HTMLVideoElement>(null);
    const [state, setState] = useState<PlayerState>({
        phase: 'initializing',
        error: null,
        tracks: [],
        loadProgress: 0,
        measuredKbps: 0,
    });

    const { settings, setQuality, setAdaptiveMode } = useStreamingSettings();

    const needsFallback = !isMp4File(fileName) || shouldUseFallback(fileName) || !mseSupported();
    const [useFallback] = useState(needsFallback);
    // Dynamic fallback: if MSE pipeline fails to init, switch to native <video>
    const [dynamicFallback, setDynamicFallback] = useState(false);
    const effectiveUseFallback = useFallback || dynamicFallback;

    useEffect(() => {
        const kbps = QUALITY_THROTTLE_MAP[settings.quality];
        const bps = kbps > 0 ? kbps * 1024 : 0;
        throttleBpsRef.current = bps;
        console.log('[AdaptiveStreaming] throttle updated', {
            quality: settings.quality,
            throttleBps: bps,
            throttleKbps: kbps,
        });
    }, [settings.quality]);

    // ── Abort helpers ────────────────────────────────────────────────
    const abortFetch = useCallback(() => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
    }, []);

    const abortDiscovery = useCallback(() => {
        if (discoveryAbortRef.current) {
            discoveryAbortRef.current.abort();
            discoveryAbortRef.current = null;
        }
    }, []);

    // ── SourceBuffer append queue ────────────────────────────────────
    const drainAppendQueue = useCallback(() => {
        const sb = sourceBufferRef.current;
        if (!sb || sb.updating) return;
        const queue = appendQueueRef.current;
        if (queue.length === 0) return;
        try {
            sb.appendBuffer(queue.shift()!);
        } catch (e: any) {
            if (e.name === 'QuotaExceededError') {
                sb.addEventListener('updateend', () => drainAppendQueue(), { once: true });
            } else {
                console.warn('[AdaptiveStreaming] appendBuffer error:', e);
            }
        }
    }, []);

    const clearSourceBuffer = useCallback(() => {
        const sb = sourceBufferRef.current;
        const ms = mediaSourceRef.current;
        if (sb && ms && ms.readyState === 'open') {
            try {
                appendQueueRef.current = [];
                if (sb.updating) {
                    sb.addEventListener('updateend', () => {
                        try { ms.removeSourceBuffer(sb); } catch { /* ignore */ }
                    }, { once: true });
                    sb.abort();
                } else {
                    ms.removeSourceBuffer(sb);
                }
            } catch { /* already removed */ }
        }
        sourceBufferRef.current = null;
    }, []);

    const createSourceBuffer = useCallback((codec: string): SourceBuffer | null => {
        const ms = mediaSourceRef.current;
        if (!ms || ms.readyState !== 'open') return null;
        try {
            // mp4box returns raw codec strings like "avc1.42E01E" — wrap in full MIME type
            const mimeType = codec.includes('/') ? codec : `video/mp4; codecs="${codec}"`;
            const sb = ms.addSourceBuffer(mimeType);
            sb.addEventListener('updateend', () => drainAppendQueue());
            sb.addEventListener('error', () => console.warn('[AdaptiveStreaming] SourceBuffer error'));
            return sb;
        } catch (e) {
            console.error('[AdaptiveStreaming] Failed to create SourceBuffer:', e);
            return null;
        }
    }, [drainAppendQueue]);

    // ── Start progressive download ───────────────────────────────────
    const startDownload = useCallback((fromOffset: number) => {
        if (!streamUrl || !mp4boxRef.current) return;

        console.log('[AdaptiveStreaming] ⬇️ startDownload from offset=', fromOffset);
        abortFetch();
        const mp4boxfile = mp4boxRef.current;
        const abortController = new AbortController();
        abortRef.current = abortController;
        fetchOffsetRef.current = fromOffset;

        (async () => {
            try {
                const rangeHeader = fromOffset > 0 ? `bytes=${fromOffset}-` : 'bytes=0-';
                const response = await fetch(streamUrl, {
                    headers: { Range: rangeHeader },
                    signal: abortController.signal,
                });

                if (fileSizeRef.current === 0) {
                    const cr = response.headers.get('content-range');
                    if (cr) {
                        const m = cr.match(/\/(\d+)/);
                        if (m) fileSizeRef.current = parseInt(m[1], 10);
                    }
                    if (fileSizeRef.current === 0) {
                        const cl = response.headers.get('content-length');
                        if (cl) fileSizeRef.current = parseInt(cl, 10);
                    }
                }

                if (!response.body) throw new Error('No response body');

                console.log('[AdaptiveStreaming] ⬇️ download started, reading stream...');
                const reader = response.body.getReader();
                const downloadStartTime = performance.now();
                totalFetchedRef.current = 0;
                speedSamplesRef.current = [];

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { console.log('[AdaptiveStreaming] ⬇️ stream complete'); break; }
                    if (abortController.signal.aborted) break;

                    const chunkBuffer = value.buffer.slice(
                        value.byteOffset,
                        value.byteOffset + value.byteLength,
                    );

                    const throttleBps = throttleBpsRef.current;
                    totalFetchedRef.current += chunkBuffer.byteLength;
                    if (throttleBps > 0) {
                        const expectedMs = (totalFetchedRef.current / throttleBps) * 1000;
                        const actualMs = performance.now() - downloadStartTime;
                        if (expectedMs > actualMs) {
                            await new Promise<void>(r => {
                                const timeout = setTimeout(r, expectedMs - actualMs);
                                abortController.signal.addEventListener('abort', () => {
                                    clearTimeout(timeout);
                                    r();
                                });
                            });
                        }
                    }

                    if (abortController.signal.aborted) break;

                    const fileStart = fetchOffsetRef.current;
                    const mp4boxBuffer = MP4BoxBuffer.fromArrayBuffer(chunkBuffer, fileStart);
                    const nextOffset = mp4boxfile.appendBuffer(mp4boxBuffer);
                    fetchOffsetRef.current = nextOffset;

                    if (fileSizeRef.current > 0 && playerPhaseRef.current === 'loading') {
                        setState(s => ({
                            ...s,
                            loadProgress: Math.min(99, Math.round((nextOffset / fileSizeRef.current) * 100)),
                        }));
                    }

                    const now = performance.now();
                    speedSamplesRef.current.push({ time: now, bytes: chunkBuffer.byteLength });
                    speedSamplesRef.current = speedSamplesRef.current.filter(
                        s => now - s.time < SPEED_WINDOW_MS,
                    );
                }

                if (playerPhaseRef.current !== 'seeking' && playerPhaseRef.current !== 'error') {
                    // Flush mp4box to emit any remaining partial segment,
                    // critical for short videos where the last segment may be incomplete.
                    try { mp4boxfile.flush(); } catch { /* best-effort */ }
                    console.log('[AdaptiveStreaming] ⬇️ download complete, mp4box flushed');
                    // Do NOT set phase to 'ended' — download completion ≠ playback completion.
                    // The <video> element's 'ended' event or MediaSource 'sourceended' handles that.
                    setState(s => ({ ...s, loadProgress: 100 }));
                }
            } catch (err: any) {
                if (err?.name === 'AbortError') return;
                console.error('[AdaptiveStreaming] Download error:', err);
                if (playerPhaseRef.current !== 'error') {
                    playerPhaseRef.current = 'error';
                    setState(s => ({ ...s, phase: 'error', error: String(err) }));
                }
            }
        })();
    }, [streamUrl, abortFetch]);

    // ── Quick moov discovery: fetch first 128KB to trigger onReady fast ──
    const discoverMoov = useCallback(async (mp4boxfile: ISOFile, signal: AbortSignal) => {
        console.log('[AdaptiveStreaming] 🔍 discoverMoov: fetching first 128KB...');
        try {
            const resp = await fetch(streamUrl, {
                headers: { Range: `bytes=0-${MOOV_DISCOVERY_BYTES - 1}` },
                signal,
            });
            console.log('[AdaptiveStreaming] 🔍 discoverMoov: response status=', resp.status, 'ok=', resp.ok);
            if (!resp.ok || !resp.body || signal.aborted) return;

            // Extract file size from Content-Range header
            if (fileSizeRef.current === 0) {
                const cr = resp.headers.get('content-range');
                if (cr) {
                    const m = cr.match(/\/(\d+)/);
                    if (m) fileSizeRef.current = parseInt(m[1], 10);
                }
                if (fileSizeRef.current === 0) {
                    const cl = resp.headers.get('content-length');
                    if (cl) fileSizeRef.current = parseInt(cl, 10);
                }
            }

            const data = await resp.arrayBuffer();
            if (signal.aborted || onReadyCalledRef.current) return;

            console.log('[AdaptiveStreaming] 🔍 discoverMoov: got', data.byteLength, 'bytes, feeding to mp4box...');
            const mp4boxBuffer = MP4BoxBuffer.fromArrayBuffer(data, 0);
            const nextOffset = mp4boxfile.appendBuffer(mp4boxBuffer);
            console.log('[AdaptiveStreaming] 🔍 discoverMoov: mp4box nextOffset=', nextOffset);
            moovEndOffsetRef.current = nextOffset > 0 ? nextOffset : MOOV_DISCOVERY_BYTES;
            // Save original bytes for the fresh playback file
            discoveryPrefixRef.current = data.slice(0);
            discoveryNextOffsetRef.current = nextOffset || data.byteLength;
        } catch (err: any) {
            if (err?.name !== 'AbortError') {
                console.warn('[AdaptiveStreaming] Moov discovery error:', err);
            }
        }
    }, [streamUrl]);

    // ── Tail moov discovery: fetch last 512KB to find moov-at-end ───
    const discoverMoovTail = useCallback(async (mp4boxfile: ISOFile, signal: AbortSignal) => {
        console.log('[AdaptiveStreaming] 🦊 discoverMoovTail: fileSize=', fileSizeRef.current);
        if (fileSizeRef.current <= MOOV_DISCOVERY_BYTES + MOOV_TAIL_BYTES) {
            console.log('[AdaptiveStreaming] 🦊 discoverMoovTail: file too small, skipping');
            return;
        }
        try {
            const tailStart = Math.max(0, fileSizeRef.current - MOOV_TAIL_BYTES);
            console.log('[AdaptiveStreaming] 🦊 discoverMoovTail: fetching bytes', tailStart, '- end');
            const resp = await fetch(streamUrl, {
                headers: { Range: `bytes=${tailStart}-` },
                signal,
            });
            console.log('[AdaptiveStreaming] 🦊 discoverMoovTail: response status=', resp.status, 'ok=', resp.ok);
            if (!resp.ok || !resp.body || signal.aborted || onReadyCalledRef.current) return;

            const data = await resp.arrayBuffer();
            if (signal.aborted || onReadyCalledRef.current) return;

            console.log('[AdaptiveStreaming] 🦊 discoverMoovTail: got', data.byteLength, 'bytes, feeding to mp4box at offset', tailStart);
            const mp4boxBuffer = MP4BoxBuffer.fromArrayBuffer(data, tailStart);
            mp4boxfile.appendBuffer(mp4boxBuffer);
            // Save tail data for the fresh playback file (needed for moov-at-end)
            discoverySuffixRef.current = data.slice(0);
            discoverySuffixOffsetRef.current = tailStart;
            moovEndOffsetRef.current = 0;
        } catch (err: any) {
            if (err?.name !== 'AbortError') {
                console.warn('[AdaptiveStreaming] Moov tail discovery error:', err);
            }
        }
    }, [streamUrl]);

    // ── Build MSE pipeline (shared by onReady and cache-hit paths) ───
    const buildMsePipeline = useCallback((mp4boxfile: ISOFile, tracks: VideoTrackInfo[]) => {
        console.log('[AdaptiveStreaming] 🏗️ buildMsePipeline: creating MediaSource, videoRef.current=', !!videoRef.current);
        const ms = new MediaSource();
        mediaSourceRef.current = ms;

        const openTimeout = setTimeout(() => {
            console.error('[AdaptiveStreaming] 🏗️ MediaSource failed to open within 15s — falling back to native video');
            if (playerPhaseRef.current === 'loading') {
                playerPhaseRef.current = 'error';
                setState(s => ({ ...s, phase: 'error', error: 'MediaSource failed to open (timeout)' }));
                setDynamicFallback(true);
            }
        }, 15000);

        ms.addEventListener('sourceopen', () => {
            console.log('[AdaptiveStreaming] 🏗️ sourceopen fired!');
            clearTimeout(openTimeout);
            const videoTrack = tracks.find(t => t.type === 'video');
            console.log('[AdaptiveStreaming] 🏗️ videoTrack:', videoTrack ? `id=${videoTrack.id} codec=${videoTrack.codec}` : 'NOT FOUND');
            if (!videoTrack?.codec) {
                console.error('[AdaptiveStreaming] 🏗️ No video codec!');
                playerPhaseRef.current = 'error';
                setState(s => ({ ...s, phase: 'error', error: 'No supported video codec' }));
                setDynamicFallback(true);
                return;
            }

            // ── Create a FRESH mp4boxfile for playback ───────────────
            // The scout file already consumed discovery bytes. We create a
            // brand-new file and feed it the ORIGINAL raw MP4 bytes (not a
            // generated fMP4 init segment which would crash mp4box).
            try { mp4boxfile.stop(); } catch {}
            try { mp4boxfile.flush(); } catch {}

            const playbackFile = createFile();
            mp4boxRef.current = playbackFile;

            playbackFile.onError = (_module: string, message: string) => {
                console.error('[AdaptiveStreaming] Playback mp4box error:', message);
                if (playerPhaseRef.current !== 'error') {
                    playerPhaseRef.current = 'error';
                    setState(s => ({ ...s, phase: 'error', error: message }));
                    setDynamicFallback(true);
                }
            };

            const sb = createSourceBuffer(videoTrack.codec);
            console.log('[AdaptiveStreaming] 🏗️ createSourceBuffer result:', !!sb);
            if (!sb) {
                playerPhaseRef.current = 'error';
                setState(s => ({ ...s, phase: 'error', error: 'Failed to create SourceBuffer' }));
                setDynamicFallback(true);
                return;
            }
            sourceBufferRef.current = sb;

            // Feed the original discovery bytes to the fresh file.
            // This is real source MP4 data, not a generated fMP4 init segment.
            const prefix = discoveryPrefixRef.current;
            if (!prefix) {
                console.error('[AdaptiveStreaming] 🏗️ No discovery prefix — falling back to native video');
                playerPhaseRef.current = 'error';
                setState(s => ({ ...s, phase: 'error', error: 'Missing discovery data' }));
                setDynamicFallback(true);
                return;
            }

            // Set onReady BEFORE feeding data — mp4box may fire it synchronously
            // during appendBuffer, so the callback must be registered first.
            playbackFile.onReady = () => {
                console.log('[AdaptiveStreaming] 🏗️ fresh file onReady — setting up segmentation');
                initSegments(playbackFile, sb);
                playerPhaseRef.current = 'playing';
                setState(s => ({ ...s, phase: 'playing' }));
                const resumeOffset = discoveryNextOffsetRef.current || prefix.byteLength;
                console.log('[AdaptiveStreaming] 🏗️ starting download from offset=', resumeOffset);
                startDownload(resumeOffset);
            };

            console.log('[AdaptiveStreaming] 🏗️ feeding', prefix.byteLength, 'original bytes at offset 0');
            playbackFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(prefix.slice(0), 0));

            // If tail discovery ran (moov-at-end), feed the suffix too
            const suffix = discoverySuffixRef.current;
            if (suffix) {
                console.log('[AdaptiveStreaming] 🏗️ feeding', suffix.byteLength, 'tail bytes at offset', discoverySuffixOffsetRef.current);
                playbackFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(suffix.slice(0), discoverySuffixOffsetRef.current));
                discoverySuffixRef.current = null; // free memory
            }

            discoveryPrefixRef.current = null; // free memory
        });

        ms.addEventListener('sourceended', () => {
            playerPhaseRef.current = 'ended';
            setState(s => ({ ...s, phase: 'ended' }));
        });

        if (videoRef.current) {
            videoRef.current.src = URL.createObjectURL(ms);
            // Listen for native video ended event — download completion ≠ playback done
            videoRef.current.addEventListener('ended', () => {
                if (playerPhaseRef.current !== 'error') {
                    playerPhaseRef.current = 'ended';
                    setState(s => ({ ...s, phase: 'ended' }));
                }
            });
            console.log('[AdaptiveStreaming] 🏗️ MediaSource blob URL set on video element');
        } else {
            console.error('[AdaptiveStreaming] 🏗️ videoRef.current is NULL — cannot set MediaSource src!');
        }
    }, [createSourceBuffer, startDownload]);

    // ── Initialize segments callback ─────────────────────────────────
    const initSegments = useCallback((mp4boxfile: ISOFile, sb: SourceBuffer) => {
        const tracks = tracksRef.current;
        const videoTrack = tracks.find(t => t.type === 'video');
        if (!videoTrack || !videoTrack.codec) return;

        console.log('[AdaptiveStreaming] 📐 initSegments: track id=', videoTrack.id, 'codec=', videoTrack.codec);

        // ── Register onSegment BEFORE initializeSegmentation ──────────
        // mp4box docs require onSegment to be set before segmentation starts.
        mp4boxfile.onSegment = (id: number, _user: unknown, buffer: ArrayBuffer, sampleNum: number, _last: boolean) => {
            lastSampleNumRef.current = sampleNum;
            const currentSb = sourceBufferRef.current;
            if (!currentSb || mediaSourceRef.current?.readyState !== 'open') {
                console.warn('[AdaptiveStreaming] 📐 onSegment dropped — SourceBuffer not ready');
                return;
            }

            console.log('[AdaptiveStreaming] 📐 onSegment: sample=', sampleNum, 'bytes=', buffer.byteLength);
            if (currentSb.updating) {
                appendQueueRef.current.push(buffer);
            } else {
                try {
                    currentSb.appendBuffer(buffer);
                } catch (e: any) {
                    if (e.name === 'QuotaExceededError') {
                        appendQueueRef.current.unshift(buffer);
                        currentSb.addEventListener('updateend', () => drainAppendQueue(), { once: true });
                    } else {
                        console.warn('[AdaptiveStreaming] appendBuffer failed:', e);
                    }
                }
            }

            try { mp4boxfile.releaseUsedSamples(id, sampleNum); } catch { /* best-effort */ }
        };

        // nbSamples: 60 means segments emit every ~60 samples (≈2s at 30fps).
        // 1000 was too large and delayed segments indefinitely on short clips.
        mp4boxfile.setSegmentOptions(videoTrack.id, sb as unknown as object, {
            nbSamples: 30,
            rapAlignement: true,
        });
        const initResult = mp4boxfile.initializeSegmentation();
        console.log('[AdaptiveStreaming] 📐 initializeSegmentation result has buffer:', !!initResult?.buffer);

        // Append init segment through the queue so it never collides with
        // SourceBuffer.updating === true during drainAppendQueue.
        if (initResult?.buffer) {
            appendQueueRef.current.push(initResult.buffer);
            if (!sb.updating) drainAppendQueue();
        }

        // ── mp4box.start() is REQUIRED for segmentation callbacks to fire ──
        mp4boxfile.start();
    }, [drainAppendQueue]);

    // ── Seek ─────────────────────────────────────────────────────────
    const seek = useCallback((time: number) => {
        const mp4boxfile = mp4boxRef.current;
        const ms = mediaSourceRef.current;
        if (!mp4boxfile || !ms || ms.readyState !== 'open') return;

        pendingSeekTimeRef.current = time;
        if (isSeekingRef.current) return;
        isSeekingRef.current = true;
        playerPhaseRef.current = 'seeking';
        setState(s => ({ ...s, phase: 'seeking' }));

        setTimeout(() => {
            const targetTime = pendingSeekTimeRef.current;
            if (targetTime === null) { isSeekingRef.current = false; return; }
            pendingSeekTimeRef.current = null;

            abortFetch();

            // Unset old segment options before clearing buffer to prevent stale refs
            const videoTrack = tracksRef.current.find(t => t.type === 'video');
            if (videoTrack) {
                try { mp4boxfile.unsetSegmentOptions(videoTrack.id); } catch { /* ignore */ }
            }

            clearSourceBuffer();
            const seekInfo = mp4boxfile.seek(targetTime, true);

            if (videoTrack && videoTrack.codec) {
                const sb = createSourceBuffer(videoTrack.codec);
                if (sb) {
                    sourceBufferRef.current = sb;
                    initSegments(mp4boxfile, sb);
                }
            }

            if (videoRef.current) videoRef.current.currentTime = seekInfo.time;
            startDownload(seekInfo.offset);
            playerPhaseRef.current = 'playing';
            setState(s => ({ ...s, phase: 'playing' }));
            isSeekingRef.current = false;
        }, SEEK_DEBOUNCE_MS);
    }, [abortFetch, clearSourceBuffer, createSourceBuffer, initSegments, startDownload]);

    // ── Adaptive speed measurement ───────────────────────────────────
    useEffect(() => {
        if (useFallback) return;
        const interval = setInterval(() => {
            const samples = speedSamplesRef.current;
            if (samples.length < 2) return;
            const oldest = samples[0];
            const newest = samples[samples.length - 1];
            const elapsedSec = (newest.time - oldest.time) / 1000;
            if (elapsedSec <= 0) return;
            const totalBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
            const kbps = Math.round((totalBytes * 8) / elapsedSec / 1000);
            setState(s => ({ ...s, measuredKbps: kbps }));

            // Log measured speed separately from throttle cap
            const throttleBps = throttleBpsRef.current;
            if (throttleBps > 0 || kbps > 0) {
                console.log('[AdaptiveStreaming] speed sample', {
                    measuredKbps: kbps,
                    throttleCapKbps: throttleBps > 0 ? Math.round(throttleBps / 1024) : 0,
                    quality: settings.quality,
                    adaptiveMode: settings.adaptiveMode,
                });
            }

            // Adaptive auto-quality: only when NOT throttled (quality === 'original')
            // This prevents the feedback loop where throttled speed is measured
            // and used to downgrade quality, trapping playback at lower settings.
            if (settings.adaptiveMode && playerPhaseRef.current === 'playing' && settings.quality === 'original') {
                for (const t of ADAPTIVE_THRESHOLDS) {
                    if (kbps >= t.minKbps) {
                        if (settings.quality !== t.quality) {
                            console.log('[AdaptiveStreaming] auto-quality', { from: settings.quality, to: t.quality, measuredKbps: kbps });
                            setQuality(t.quality);
                        }
                        break;
                    }
                }
            }
        }, SPEED_CHECK_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [useFallback, settings.adaptiveMode, settings.quality, setQuality]);

    // ── Main initialization effect ───────────────────────────────────
    useEffect(() => {
        if (useFallback || !streamUrl) {
            console.log('[AdaptiveStreaming] 🚫 Skipping MSE: useFallback=', useFallback, 'streamUrl=', !!streamUrl);
            return;
        }

        console.log('[AdaptiveStreaming] 🚀 Starting initialization for:', fileName);
        playerPhaseRef.current = 'loading';
        onReadyCalledRef.current = false;
        moovEndOffsetRef.current = 0;
        setState(s => ({ ...s, phase: 'loading', error: null, loadProgress: 0 }));
        fileSizeRef.current = 0;
        appendQueueRef.current = [];
        tracksRef.current = [];
        let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

        const mp4boxfile = createFile();
        mp4boxRef.current = mp4boxfile;

        mp4boxfile.onError = (_module: string, message: string) => {
            console.error('[AdaptiveStreaming] mp4box error:', message);
            if (playerPhaseRef.current !== 'error') {
                playerPhaseRef.current = 'error';
                setState(s => ({ ...s, phase: 'error', error: message }));
            }
        };

        mp4boxfile.onReady = (info: unknown) => {
            console.log('[AdaptiveStreaming] 📦 onReady FIRED!');
            if (onReadyCalledRef.current) { console.log('[AdaptiveStreaming] 📦 onReady already called, ignoring'); return; }
            onReadyCalledRef.current = true;
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
            abortDiscovery();

            const movieInfo = info as Mp4MovieInfo;
            console.log('[AdaptiveStreaming] 📦 movieInfo:', movieInfo ? `tracks=${movieInfo.tracks?.length} duration=${movieInfo.duration}/${movieInfo.timescale}` : 'NULL');
            if (!movieInfo || !Array.isArray(movieInfo.tracks)) {
                console.error('[AdaptiveStreaming] 📦 Unexpected mp4box response — falling back to native video');
                playerPhaseRef.current = 'error';
                setState(s => ({ ...s, phase: 'error', error: 'Unexpected mp4box response' }));
                setDynamicFallback(true);
                return;
            }

            const tracks: VideoTrackInfo[] = [];
            for (const track of movieInfo.tracks) {
                tracks.push({
                    id: track.id,
                    type: track.video ? 'video' : 'audio',
                    width: track.video?.width,
                    height: track.video?.height,
                    bitrate: track.bitrate,
                    codec: track.codec,
                    duration: movieInfo.duration / movieInfo.timescale,
                });
            }
            console.log('[AdaptiveStreaming] 📦 parsed', tracks.length, 'tracks:', tracks.map(t => `${t.type}:${t.codec}`).join(', '));
            tracksRef.current = tracks;
            setState(s => ({ ...s, tracks, loadProgress: 100 }));

            // Capture accurate resume offset if discovery didn't set one (moov-at-end)
            if (moovEndOffsetRef.current === 0 && fetchOffsetRef.current > 0) {
                moovEndOffsetRef.current = fetchOffsetRef.current;
            }

            // Cache for future replays
            const cacheKey = extractCacheKey(streamUrl);
            if (cacheKey) setCachedMoov(cacheKey, tracks).catch(() => {});

            // Build MSE pipeline
            buildMsePipeline(mp4boxfile, tracks);
        };

        // ── Try cache, then discovery ──────────────────────────────
        const cacheKey = extractCacheKey(streamUrl);
        const onCacheResult = (cachedTracks: VideoTrackInfo[] | null) => {
            if (onReadyCalledRef.current) return;

            if (cachedTracks && cachedTracks.length > 0) {
                // Show cached metadata immediately, then discover moov for real data
                tracksRef.current = cachedTracks;
                setState(s => ({ ...s, tracks: cachedTracks }));
            }
            beginMoovDiscovery();
        };

        function beginMoovDiscovery() {
            const ctrl = new AbortController();
            discoveryAbortRef.current = ctrl;
            discoverMoov(mp4boxfile, ctrl.signal);

            fallbackTimer = setTimeout(async () => {
                console.log('[AdaptiveStreaming] ⏰ Fallback timer fired! onReadyCalled=', onReadyCalledRef.current, 'fileSize=', fileSizeRef.current);
                if (onReadyCalledRef.current) return;
                // Initial 128KB didn't contain moov — try tail for moov-at-end files
                const tailCtrl = new AbortController();
                discoveryAbortRef.current = tailCtrl;
                await discoverMoovTail(mp4boxfile, tailCtrl.signal);
                console.log('[AdaptiveStreaming] ⏰ Tail discovery complete, onReadyCalled=', onReadyCalledRef.current);
                if (!onReadyCalledRef.current) {
                    // Still no moov — download from beginning as last resort
                    console.log('[AdaptiveStreaming] ⏰ Still no moov, starting full download from byte 0');
                    startDownload(0);
                }
            }, MOOV_FALLBACK_TIMEOUT_MS);
        }

        if (cacheKey) {
            getCachedMoov(cacheKey).then(onCacheResult).catch(() => beginMoovDiscovery());
        } else {
            beginMoovDiscovery();
        }

        // ── Cleanup ─────────────────────────────────────────────────
        return () => {
            if (fallbackTimer) clearTimeout(fallbackTimer);
            abortFetch();
            abortDiscovery();
            try { mp4boxfile.stop(); } catch { /* ignore */ }
            try { mp4boxfile.flush(); } catch { /* ignore */ }
            const ms = mediaSourceRef.current;
            if (ms) {
                try { clearSourceBuffer(); } catch { /* ignore */ }
                try {
                    const url = videoRef.current?.src;
                    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
                } catch { /* ignore */ }
            }
            mp4boxRef.current = null;
            mediaSourceRef.current = null;
            sourceBufferRef.current = null;            appendQueueRef.current = [];
            discoveryPrefixRef.current = null;
            discoverySuffixRef.current = null;
        };
    }, [streamUrl, useFallback, startDownload, createSourceBuffer, abortFetch, abortDiscovery,
        clearSourceBuffer, initSegments, discoverMoov, discoverMoovTail, buildMsePipeline, fileName]);

    return {
        videoRef,
        phase: state.phase,
        error: state.error,
        tracks: state.tracks,
        loadProgress: state.loadProgress,
        currentQuality: settings.quality,
        setQuality,
        adaptiveMode: settings.adaptiveMode,
        setAdaptiveMode,
        measuredKbps: state.measuredKbps,
        seek,
        useFallback: effectiveUseFallback,
        fallbackUrl: streamUrl,
        abort: () => {
            abortFetch();
            abortDiscovery();
            const mp4boxfile = mp4boxRef.current;
            if (mp4boxfile) {
                try { mp4boxfile.stop(); } catch {}
                try { mp4boxfile.flush(); } catch {}
            }
            if (mediaSourceRef.current) {
                try { clearSourceBuffer(); } catch {}
            }
            playerPhaseRef.current = 'ended';
        },
    };
}
