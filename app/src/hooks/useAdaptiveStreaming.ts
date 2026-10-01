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

function debugAdaptiveStreaming(...args: unknown[]): void {
    if (import.meta.env.DEV) console.debug(...args);
}

function getErrorName(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('name' in error)) return undefined;
    return typeof error.name === 'string' ? error.name : undefined;
}

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
const MOOV_RETRY_BYTES = 524288;       // 512KB — retry with larger range before tail lookup
const MOOV_TAIL_BYTES = 524288;        // 512KB — tail fetch for moov-at-end files
const MOOV_FALLBACK_TIMEOUT_MS = 3000;
const PROGRESSIVE_CACHE_WARM_BYTES = 3145728; // 3MB — pre-warm HTTP cache for native <video> moov discovery

// When a progressive (non-fragmented) MP4 is detected and we fall back to
// native <video>, the native player must make a Range request to the end
// of the file to find the moov atom. This round-trip through the backend
// to Telegram is slow, causing buffering delays on large files.
//
// By pre-fetching the tail ourselves before triggering the fallback, we
// populate the browser's HTTP cache. When the native player requests the
// same range moments later, it's a cache hit and playback initializes
// almost instantly.
function warmProgressiveMoovCache(streamUrl: string, fileSize: number): void {
    const warmBytes = Math.min(PROGRESSIVE_CACHE_WARM_BYTES, fileSize);
    const tailStart = Math.max(0, fileSize - warmBytes);

    debugAdaptiveStreaming('[AdaptiveStreaming] 🔥 warmProgressiveMoovCache: pre-fetching last', warmBytes, 'bytes from offset', tailStart);

    fetch(streamUrl, {
        headers: { Range: `bytes=${tailStart}-` },
        // This request exists only to populate the browser cache before the
        // native video element asks for the same tail range.
        cache: 'default',
    }).then(() => {
        debugAdaptiveStreaming('[AdaptiveStreaming] 🔥 warmProgressiveMoovCache: cache warmed successfully');
    }).catch(() => {
        // Native playback can still perform its own range request.
    });
}

// Scans for the 'moov' box fourcc, validates its size, and returns
// the isolated box data with its absolute file offset. Used for
// moov-at-end files to avoid feeding non-contiguous mdat fragments
// that cause mp4box parsing errors on Windows WebView2.
const MAX_MOOV_BOX_BYTES = 64 * 1024 * 1024;

function readBoxSize(
    view: DataView,
    offset: number,
    limit: number,
): { size: number; headerSize: number } | null {
    if (offset < 0 || offset + 8 > limit) return null;

    const size32 = view.getUint32(offset);
    if (size32 === 0) return { size: limit - offset, headerSize: 8 };
    if (size32 !== 1) {
        return size32 >= 8 ? { size: size32, headerSize: 8 } : null;
    }

    if (offset + 16 > limit) return null;
    const size64 = view.getBigUint64(offset + 8);
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const size = Number(size64);
    return size >= 16 ? { size, headerSize: 16 } : null;
}

function boxTypeAt(view: DataView, offset: number): string {
    return String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7),
    );
}

function hasMovieHeaderChild(view: DataView, start: number, end: number): boolean {
    let childOffset = start;
    while (childOffset + 8 <= end) {
        const child = readBoxSize(view, childOffset, end);
        if (!child || childOffset + child.size > end) return false;
        if (boxTypeAt(view, childOffset) === 'mvhd') return true;
        childOffset += child.size;
    }
    return false;
}

export function extractMoovAtom(
    data: ArrayBuffer,
    dataOffset: number,
): { moovData: ArrayBuffer; moovOffset: number } | null {
    const view = new DataView(data);
    // A suffix range normally starts in the middle of mdat payload, so it is
    // not box-aligned. Search byte-by-byte for a candidate type instead of
    // interpreting arbitrary media bytes as box sizes and jumping through them.
    for (let typeOffset = 4; typeOffset + 4 <= data.byteLength; typeOffset++) {
        if (
            view.getUint8(typeOffset) !== 0x6d ||
            view.getUint8(typeOffset + 1) !== 0x6f ||
            view.getUint8(typeOffset + 2) !== 0x6f ||
            view.getUint8(typeOffset + 3) !== 0x76
        ) {
            continue;
        }

        const boxOffset = typeOffset - 4;
        const box = readBoxSize(view, boxOffset, data.byteLength);
        if (!box || box.size > MAX_MOOV_BOX_BYTES || boxOffset + box.size > data.byteLength) {
            continue;
        }
        if (!hasMovieHeaderChild(view, boxOffset + box.headerSize, boxOffset + box.size)) {
            continue;
        }

        return {
            moovData: data.slice(boxOffset, boxOffset + box.size),
            moovOffset: dataOffset + boxOffset,
        };
    }
    return null;
}

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
    onProgressiveDetected?: () => void,
): UseAdaptiveStreamingResult {
    // ── Ref-based mutable state ──────────────────────────────────────
    const mp4boxRef = useRef<ISOFile | null>(null);
    const mediaSourceRef = useRef<MediaSource | null>(null);
    const sourceBuffersRef = useRef<{ [trackId: number]: SourceBuffer }>({});
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
    const appendQueuesRef = useRef<{ [trackId: number]: ArrayBuffer[] }>({});
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
    // Flag set synchronously by initSegments when initializeSegmentation crashes,
    // allowing the onReady caller to bail out before calling startDownload.
    const segmentationFailedRef = useRef(false);
    const mediaSourceOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    const useFallback = !isMp4File(fileName) || shouldUseFallback(fileName) || !mseSupported();
    // Dynamic fallback: if MSE pipeline fails to init, switch to native <video>
    const [dynamicFallback, setDynamicFallback] = useState(false);
    const effectiveUseFallback = useFallback || dynamicFallback;

    useEffect(() => {
        setDynamicFallback(false);
    }, [streamUrl, fileName]);

    useEffect(() => {
        const kbps = QUALITY_THROTTLE_MAP[settings.quality];
        const bps = kbps > 0 ? kbps * 1024 : 0;
        throttleBpsRef.current = bps;
        debugAdaptiveStreaming('[AdaptiveStreaming] throttle updated', {
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

    const activateNativeFallback = useCallback((reason: string) => {
        if (mediaSourceOpenTimerRef.current) {
            clearTimeout(mediaSourceOpenTimerRef.current);
            mediaSourceOpenTimerRef.current = null;
        }
        console.warn('[AdaptiveStreaming] Falling back to native video:', reason);
        playerPhaseRef.current = 'ready';
        setState(s => ({ ...s, phase: 'ready', error: null }));
        setDynamicFallback(true);
    }, []);

    // ── SourceBuffer append queue ────────────────────────────────────
    const drainAppendQueue = useCallback((trackId: number) => {
        const sb = sourceBuffersRef.current[trackId];
        if (!sb || sb.updating) return;
        const queue = appendQueuesRef.current[trackId];
        if (!queue || queue.length === 0) return;
        try {
            sb.appendBuffer(queue.shift()!);
        } catch (error: unknown) {
            if (getErrorName(error) === 'QuotaExceededError') {
                sb.addEventListener('updateend', () => drainAppendQueue(trackId), { once: true });
            } else {
                console.warn(`[AdaptiveStreaming] appendBuffer error for track ${trackId}:`, error);
            }
        }
    }, []);

    const clearSourceBuffer = useCallback(() => {
        const ms = mediaSourceRef.current;
        if (ms && ms.readyState === 'open') {
            for (const idStr in sourceBuffersRef.current) {
                const trackId = parseInt(idStr, 10);
                const sb = sourceBuffersRef.current[trackId];
                if (sb) {
                    try {
                        appendQueuesRef.current[trackId] = [];
                        try { sb.abort(); } catch { /* ignore */ }
                        if (sb.updating) {
                            sb.addEventListener('updateend', () => {
                                try { ms.removeSourceBuffer(sb); } catch { /* ignore */ }
                            }, { once: true });
                        } else {
                            try { ms.removeSourceBuffer(sb); } catch { /* ignore */ }
                        }
                    } catch { /* already removed */ }
                }
            }
        }
        sourceBuffersRef.current = {};
        appendQueuesRef.current = {};
    }, []);

    const createSourceBuffer = useCallback((codec: string, trackId: number, isAudio: boolean): SourceBuffer | null => {
        const ms = mediaSourceRef.current;
        if (!ms || ms.readyState !== 'open') return null;
        try {
            // mp4box returns raw codec strings like "avc1.42E01E" — wrap in full MIME type
            const container = isAudio ? 'audio/mp4' : 'video/mp4';
            const mimeType = codec.includes('/') ? codec : `${container}; codecs="${codec}"`;
            const sb = ms.addSourceBuffer(mimeType);
            sb.addEventListener('updateend', () => drainAppendQueue(trackId));
            sb.addEventListener('error', () => console.warn(`[AdaptiveStreaming] SourceBuffer error for track ${trackId}`));
            return sb;
        } catch (e) {
            console.error(`[AdaptiveStreaming] Failed to create SourceBuffer for track ${trackId}:`, e);
            return null;
        }
    }, [drainAppendQueue]);

    // ── Start progressive download ───────────────────────────────────
    const startDownload = useCallback((fromOffset: number) => {
        if (!streamUrl || !mp4boxRef.current) return;

        debugAdaptiveStreaming('[AdaptiveStreaming] ⬇️ startDownload from offset=', fromOffset);
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

                debugAdaptiveStreaming('[AdaptiveStreaming] ⬇️ download started, reading stream...');
                const reader = response.body.getReader();
                const downloadStartTime = performance.now();
                totalFetchedRef.current = 0;
                speedSamplesRef.current = [];

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { debugAdaptiveStreaming('[AdaptiveStreaming] ⬇️ stream complete'); break; }
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
                    // ── Handle backward nextOffset (mp4box wants to rewind) ──
                    // For moov-at-end progressive files, the onReady callback
                    // already triggers fMP4 remux before we get here.
                    // For fragmented MP4s, mp4box may request an earlier offset
                    // for interleaved tracks — we can't rewind the HTTP stream,
                    // so just continue feeding sequential data. Each fMP4 fragment
                    // is self-contained so playback continues fine.
                    if (nextOffset < fileStart) {
                        console.warn('[AdaptiveStreaming] ⚠️ mp4box nextOffset regressed from', fileStart, 'to', nextOffset, '— continuing sequential download');
                        fetchOffsetRef.current = fileStart + chunkBuffer.byteLength;
                    } else {
                        fetchOffsetRef.current = nextOffset;
                    }

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
                    debugAdaptiveStreaming('[AdaptiveStreaming] ⬇️ download complete, mp4box flushed');
                    // Do NOT set phase to 'ended' — download completion ≠ playback completion.
                    // The <video> element's 'ended' event or MediaSource 'sourceended' handles that.
                    setState(s => ({ ...s, loadProgress: 100 }));
                }
            } catch (error: unknown) {
                if (getErrorName(error) === 'AbortError') return;
                console.error('[AdaptiveStreaming] Download error:', error);
                if (playerPhaseRef.current !== 'error') {
                    activateNativeFallback(String(error));
                }
            }
        })();
    }, [streamUrl, abortFetch, activateNativeFallback]);

    // ── Quick moov discovery: fetch first 128KB to trigger onReady fast ──
    const discoverMoov = useCallback(async (mp4boxfile: ISOFile, signal: AbortSignal) => {
        debugAdaptiveStreaming('[AdaptiveStreaming] 🔍 discoverMoov: fetching first 128KB...');
        try {
            const resp = await fetch(streamUrl, {
                headers: { Range: `bytes=0-${MOOV_DISCOVERY_BYTES - 1}` },
                signal,
            });
            debugAdaptiveStreaming('[AdaptiveStreaming] 🔍 discoverMoov: response status=', resp.status, 'ok=', resp.ok);
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

            debugAdaptiveStreaming('[AdaptiveStreaming] 🔍 discoverMoov: got', data.byteLength, 'bytes, feeding to mp4box...');
            const mp4boxBuffer = MP4BoxBuffer.fromArrayBuffer(data, 0);
            const nextOffset = mp4boxfile.appendBuffer(mp4boxBuffer);
            debugAdaptiveStreaming('[AdaptiveStreaming] 🔍 discoverMoov: mp4box nextOffset=', nextOffset);
            moovEndOffsetRef.current = nextOffset > 0 ? nextOffset : MOOV_DISCOVERY_BYTES;
            // Save original bytes for the fresh playback file
            discoveryPrefixRef.current = data.slice(0);
            discoveryNextOffsetRef.current = nextOffset || data.byteLength;
        } catch (error: unknown) {
            if (getErrorName(error) !== 'AbortError') {
                console.warn('[AdaptiveStreaming] Moov discovery error:', error);
            }
        }
    }, [streamUrl]);

    // ── Retry moov discovery: extend to 512KB when first 128KB fails ──
    const discoverMoovRetry = useCallback(async (mp4boxfile: ISOFile, signal: AbortSignal) => {
        debugAdaptiveStreaming('[AdaptiveStreaming] 🔄 discoverMoovRetry: extending range from 128KB to 512KB...');
        if (fileSizeRef.current > 0 && fileSizeRef.current <= MOOV_DISCOVERY_BYTES) {
            debugAdaptiveStreaming('[AdaptiveStreaming] 🔄 discoverMoovRetry: file too small for retry, skipping');
            return;
        }
        try {
            const resp = await fetch(streamUrl, {
                headers: { Range: `bytes=${MOOV_DISCOVERY_BYTES}-${MOOV_RETRY_BYTES - 1}` },
                signal,
            });
            debugAdaptiveStreaming('[AdaptiveStreaming] 🔄 discoverMoovRetry: response status=', resp.status, 'ok=', resp.ok);
            if (!resp.ok || signal.aborted || onReadyCalledRef.current) return;

            const data = await resp.arrayBuffer();
            if (signal.aborted || onReadyCalledRef.current) return;

            debugAdaptiveStreaming('[AdaptiveStreaming] 🔄 discoverMoovRetry: got', data.byteLength, 'gap bytes, feeding to mp4box at offset', MOOV_DISCOVERY_BYTES);
            const mp4boxBuffer = MP4BoxBuffer.fromArrayBuffer(data, MOOV_DISCOVERY_BYTES);
            mp4boxfile.appendBuffer(mp4boxBuffer);

            // Extend discovery prefix: combine old 128KB + gap data → full 512KB range
            const oldPrefix = discoveryPrefixRef.current;
            if (oldPrefix) {
                const combined = new Uint8Array(MOOV_DISCOVERY_BYTES + data.byteLength);
                combined.set(new Uint8Array(oldPrefix), 0);
                combined.set(new Uint8Array(data), MOOV_DISCOVERY_BYTES);
                discoveryPrefixRef.current = combined.buffer;
            }
            discoveryNextOffsetRef.current = MOOV_RETRY_BYTES;
        } catch (error: unknown) {
            if (getErrorName(error) !== 'AbortError') {
                console.warn('[AdaptiveStreaming] Moov retry error:', error);
            }
        }
    }, [streamUrl]);

    // ── Tail moov discovery: fetch last 512KB to find moov-at-end ───
    const discoverMoovTail = useCallback(async (mp4boxfile: ISOFile, signal: AbortSignal) => {
        debugAdaptiveStreaming('[AdaptiveStreaming] 🦊 discoverMoovTail: fileSize=', fileSizeRef.current);
        if (fileSizeRef.current <= MOOV_DISCOVERY_BYTES + MOOV_TAIL_BYTES) {
            debugAdaptiveStreaming('[AdaptiveStreaming] 🦊 discoverMoovTail: file too small, skipping');
            return;
        }
        try {
            const tailStart = Math.max(0, fileSizeRef.current - MOOV_TAIL_BYTES);
            debugAdaptiveStreaming('[AdaptiveStreaming] 🦊 discoverMoovTail: fetching bytes', tailStart, '- end');
            const resp = await fetch(streamUrl, {
                headers: { Range: `bytes=${tailStart}-` },
                signal,
            });
            debugAdaptiveStreaming('[AdaptiveStreaming] 🦊 discoverMoovTail: response status=', resp.status, 'ok=', resp.ok);
            if (!resp.ok || !resp.body || signal.aborted || onReadyCalledRef.current) return;

            const data = await resp.arrayBuffer();
            if (signal.aborted || onReadyCalledRef.current) return;

            const moovAtom = extractMoovAtom(data, tailStart);
            if (!moovAtom) {
                console.warn('[AdaptiveStreaming] 🦊 discoverMoovTail: no complete, validated moov box found');
                return;
            }

            debugAdaptiveStreaming('[AdaptiveStreaming] 🦊 discoverMoovTail: feeding isolated moov at offset', moovAtom.moovOffset, 'size', moovAtom.moovData.byteLength);
            // Store discovery state before appendBuffer because MP4Box may invoke
            // onReady synchronously from inside appendBuffer.
            discoverySuffixRef.current = moovAtom.moovData.slice(0);
            discoverySuffixOffsetRef.current = moovAtom.moovOffset;
            moovEndOffsetRef.current = 0;
            mp4boxfile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(moovAtom.moovData, moovAtom.moovOffset));
        } catch (error: unknown) {
            if (getErrorName(error) !== 'AbortError') {
                console.warn('[AdaptiveStreaming] Moov tail discovery error:', error);
            }
        }
    }, [streamUrl]);

    // ── Initialize segments callback ─────────────────────────────────
    const initSegments = useCallback((mp4boxfile: ISOFile) => {
        const tracks = tracksRef.current;
        debugAdaptiveStreaming('[AdaptiveStreaming] 📐 initSegments starting for tracks:', tracks.map(t => t.id));

        // ── Register onSegment BEFORE initializeSegmentation ──────────
        // mp4box docs require onSegment to be set before segmentation starts.
        mp4boxfile.onSegment = (id: number, _user: unknown, buffer: ArrayBuffer, sampleNum: number, _last: boolean) => {
            lastSampleNumRef.current = sampleNum;
            const currentSb = sourceBuffersRef.current[id];
            if (!currentSb || mediaSourceRef.current?.readyState !== 'open') {
                console.warn('[AdaptiveStreaming] 📐 onSegment dropped — SourceBuffer not ready for track', id);
                return;
            }

            debugAdaptiveStreaming('[AdaptiveStreaming] 📐 onSegment: track=', id, 'sample=', sampleNum, 'bytes=', buffer.byteLength);
            
            if (!appendQueuesRef.current[id]) {
                appendQueuesRef.current[id] = [];
            }
            const queue = appendQueuesRef.current[id];

            if (currentSb.updating) {
                queue.push(buffer);
            } else {
                try {
                    currentSb.appendBuffer(buffer);
                } catch (error: unknown) {
                    if (getErrorName(error) === 'QuotaExceededError') {
                        queue.unshift(buffer);
                        currentSb.addEventListener('updateend', () => drainAppendQueue(id), { once: true });
                    } else {
                        console.warn(`[AdaptiveStreaming] appendBuffer failed for track ${id}:`, error);
                    }
                }
            }

            try { mp4boxfile.releaseUsedSamples(id, sampleNum); } catch { /* best-effort */ }
        };

        const initBuffers: { [trackId: number]: ArrayBuffer } = {};
        let hasInitializedAny = false;

        // Loop through all tracks to generate track-specific isolated initialization segments
        for (const track of tracks) {
            const sb = sourceBuffersRef.current[track.id];
            if (!sb) continue;

            // Clear any other track options to keep this one isolated
            for (const t of tracks) {
                try { (mp4boxfile as any).unsetSegmentOptions(t.id); } catch {}
            }
            (mp4boxfile as any).isFragmentationInitialized = false;

            debugAdaptiveStreaming('[AdaptiveStreaming] 📐 initSegments: generating isolated options for track id=', track.id);
            mp4boxfile.setSegmentOptions(track.id, sb as unknown as object, {
                nbSamples: 30,
                rapAlignement: true,
            });

            try {
                const segmentationResult = (mp4boxfile as any).initializeSegmentation();
                if (segmentationResult && segmentationResult.buffer) {
                    initBuffers[track.id] = segmentationResult.buffer;
                    hasInitializedAny = true;
                }
            } catch (e) {
                console.warn(`[AdaptiveStreaming] 📐 Failed to generate init segment for track ${track.id}:`, e);
            }
        }

        // Now restore/set segment options for ALL active tracks together so mp4box segments them during playback
        for (const t of tracks) {
            try { (mp4boxfile as any).unsetSegmentOptions(t.id); } catch {}
        }
        (mp4boxfile as any).isFragmentationInitialized = false;

        for (const track of tracks) {
            const sb = sourceBuffersRef.current[track.id];
            if (sb) {
                mp4boxfile.setSegmentOptions(track.id, sb as unknown as object, {
                    nbSamples: 30,
                    rapAlignement: true,
                });
            }
        }

        if (!hasInitializedAny) {
            console.error('[AdaptiveStreaming] 📐 initSegments: failed to initialize any track segmentation');
            segmentationFailedRef.current = true;
            try { mp4boxfile.stop(); } catch {}
            clearSourceBuffer();
            activateNativeFallback('MP4 segmentation could not be initialized');
            return;
        }

        // Initialize multi-track segmentation state on the file
        try {
            (mp4boxfile as any).initializeSegmentation();
        } catch (e) {
            console.error('[AdaptiveStreaming] 📐 Final initializeSegmentation crashed:', e);
            segmentationFailedRef.current = true;
            try { mp4boxfile.stop(); } catch {}
            clearSourceBuffer();
            activateNativeFallback('MP4 segmentation failed');
            return;
        }

        // Append the isolated track-specific init segments to their respective SourceBuffers
        for (const trackIdStr in initBuffers) {
            const trackId = parseInt(trackIdStr, 10);
            const buf = initBuffers[trackId];
            const sb = sourceBuffersRef.current[trackId];
            if (sb && buf) {
                if (!appendQueuesRef.current[trackId]) {
                    appendQueuesRef.current[trackId] = [];
                }
                appendQueuesRef.current[trackId].push(buf);
                if (!sb.updating) drainAppendQueue(trackId);
            }
        }

        // ── mp4box.start() is REQUIRED for segmentation callbacks to fire ──
        mp4boxfile.start();
    }, [drainAppendQueue, clearSourceBuffer, activateNativeFallback]);

    // ── Build MSE pipeline (shared by onReady and cache-hit paths) ───
    const buildMsePipeline = useCallback((mp4boxfile: ISOFile, tracks: VideoTrackInfo[]) => {
        debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ buildMsePipeline: creating MediaSource, videoRef.current=', !!videoRef.current);
        const ms = new MediaSource();
        mediaSourceRef.current = ms;

        if (mediaSourceOpenTimerRef.current) clearTimeout(mediaSourceOpenTimerRef.current);
        mediaSourceOpenTimerRef.current = setTimeout(() => {
            mediaSourceOpenTimerRef.current = null;
            console.error('[AdaptiveStreaming] 🏗️ MediaSource failed to open within 15s — falling back to native video');
            if (playerPhaseRef.current === 'loading') {
                activateNativeFallback('MediaSource failed to open (timeout)');
            }
        }, 15000);

        ms.addEventListener('sourceopen', () => {
            debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ sourceopen fired!');
            if (mediaSourceOpenTimerRef.current) {
                clearTimeout(mediaSourceOpenTimerRef.current);
                mediaSourceOpenTimerRef.current = null;
            }
            const videoTrack = tracks.find(t => t.type === 'video');
            debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ videoTrack:', videoTrack ? `id=${videoTrack.id} codec=${videoTrack.codec}` : 'NOT FOUND');
            if (!videoTrack?.codec) {
                console.error('[AdaptiveStreaming] 🏗️ No video codec!');
                activateNativeFallback('No supported video codec');
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
                    activateNativeFallback(message);
                }
            };

            // Recreate all source buffers (both video and audio if present)
            let createdCount = 0;
            for (const track of tracks) {
                if (track.codec) {
                    const isAudio = track.type === 'audio';
                    const sb = createSourceBuffer(track.codec, track.id, isAudio);
                    if (sb) {
                        sourceBuffersRef.current[track.id] = sb;
                        createdCount++;
                    }
                }
            }

            const videoSb = sourceBuffersRef.current[videoTrack.id];
            if (!videoSb) {
                activateNativeFallback('Failed to create video SourceBuffer');
                return;
            }

            const prefix = discoveryPrefixRef.current;
            const suffix = discoverySuffixRef.current;
            const suffixOffset = discoverySuffixOffsetRef.current;
            const isMoovInTail = suffix !== null;

            // Must have at least one data source to proceed
            if (!prefix && !suffix) {
                console.error('[AdaptiveStreaming] 🏗️ No discovery data — falling back to native video');
                activateNativeFallback('Missing discovery data');
                return;
            }

            // Set onReady BEFORE feeding data — mp4box may fire it synchronously
            // during appendBuffer, so the callback must be registered first.
            playbackFile.onReady = () => {
                debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ fresh file onReady — setting up segmentation');
                // Patch missing mehd on the *playback* file (the scout file
                // was patched earlier, but this is a fresh mp4box instance
                // with its own moov parsed from the discovery bytes).
                const pbMoov = (playbackFile as any).moov;
                if (pbMoov?.mvex && !pbMoov.mvex.mehd) {
                    debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ Patching missing mehd on playback file');
                    pbMoov.mvex.mehd = { fragment_duration: 0 };
                }
                initSegments(playbackFile);
                // If initSegments triggered fallback (e.g. initializeSegmentation crash),
                // don't start the download — native <video> will handle playback.
                if (segmentationFailedRef.current) {
                    console.warn('[AdaptiveStreaming] 🏗️ segmentation failed — skipping startDownload');
                    return;
                }
                playerPhaseRef.current = 'playing';
                setState(s => ({ ...s, phase: 'playing' }));
                // For moov-at-end: resume from byte 0 to fill contiguously.
                // For moov-in-header: resume from where the prefix ended.
                const resumeOffset = isMoovInTail ? 0 : (discoveryNextOffsetRef.current || (prefix?.byteLength ?? 0));
                debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ starting download from offset=', resumeOffset, 'isMoovInTail=', isMoovInTail);
                startDownload(resumeOffset);
            };

            if (isMoovInTail) {
                // ── Moov-at-end: extract ONLY the moov atom from suffix ──
                // Feeding the entire suffix (which includes mid-mdat media bytes) at a
                // non-contiguous offset triggers mp4box parsing errors like:
                //   "Invalid data found while parsing box of type 't] X'"
                // on platforms with different WebView fetch behavior (e.g. Windows).
                const moovAtom = extractMoovAtom(suffix, suffixOffset);
                if (moovAtom) {
                    debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ moov-at-end: feeding moov atom at offset', moovAtom.moovOffset, 'size', moovAtom.moovData.byteLength);
                    playbackFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(moovAtom.moovData, moovAtom.moovOffset));
                } else {
                    // Never feed an unaligned tail into MP4Box. Native playback
                    // can issue its own byte ranges without parsing media payload
                    // as container metadata.
                    activateNativeFallback('The MP4 movie metadata could not be isolated safely');
                    return;
                }
                discoverySuffixRef.current = null;
            } else if (prefix) {
                // ── Moov-in-header: feed contiguous prefix bytes ──────
                debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ feeding', prefix.byteLength, 'original bytes at offset 0');
                playbackFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(prefix.slice(0), 0));
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
            debugAdaptiveStreaming('[AdaptiveStreaming] 🏗️ MediaSource blob URL set on video element');
        } else {
            console.error('[AdaptiveStreaming] 🏗️ videoRef.current is NULL — cannot set MediaSource src!');
        }
    }, [createSourceBuffer, startDownload, initSegments, activateNativeFallback]);

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
            for (const track of tracksRef.current) {
                try { mp4boxfile.unsetSegmentOptions(track.id); } catch { /* ignore */ }
            }

            clearSourceBuffer();
            const seekInfo = mp4boxfile.seek(targetTime, true);

            // Recreate all source buffers
            for (const track of tracksRef.current) {
                if (track.codec) {
                    const isAudio = track.type === 'audio';
                    const sb = createSourceBuffer(track.codec, track.id, isAudio);
                    if (sb) {
                        sourceBuffersRef.current[track.id] = sb;
                    }
                }
            }

            initSegments(mp4boxfile);

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
                debugAdaptiveStreaming('[AdaptiveStreaming] speed sample', {
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
                            debugAdaptiveStreaming('[AdaptiveStreaming] auto-quality', { from: settings.quality, to: t.quality, measuredKbps: kbps });
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
        if (effectiveUseFallback || !streamUrl) {
            debugAdaptiveStreaming('[AdaptiveStreaming] 🚫 Skipping MSE: useFallback=', effectiveUseFallback, 'streamUrl=', !!streamUrl);
            return;
        }

        debugAdaptiveStreaming('[AdaptiveStreaming] 🚀 Starting initialization for:', fileName);
        playerPhaseRef.current = 'loading';
        onReadyCalledRef.current = false;
        moovEndOffsetRef.current = 0;
        setState(s => ({ ...s, phase: 'loading', error: null, loadProgress: 0 }));
        fileSizeRef.current = 0;
        appendQueuesRef.current = {};
        tracksRef.current = [];
        segmentationFailedRef.current = false;
        let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

        const mp4boxfile = createFile();
        mp4boxRef.current = mp4boxfile;

        mp4boxfile.onError = (_module: string, message: string) => {
            console.error('[AdaptiveStreaming] mp4box error:', message);
            if (playerPhaseRef.current !== 'error') {
                activateNativeFallback(message);
            }
        };

        mp4boxfile.onReady = (info: unknown) => {
            debugAdaptiveStreaming('[AdaptiveStreaming] 📦 onReady FIRED!');
            if (onReadyCalledRef.current) { debugAdaptiveStreaming('[AdaptiveStreaming] 📦 onReady already called, ignoring'); return; }
            onReadyCalledRef.current = true;
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
            abortDiscovery();

            const movieInfo = info as Mp4MovieInfo;
            debugAdaptiveStreaming('[AdaptiveStreaming] 📦 movieInfo:', movieInfo ? `tracks=${movieInfo.tracks?.length} duration=${movieInfo.duration}/${movieInfo.timescale}` : 'NULL');
            if (!movieInfo || !Array.isArray(movieInfo.tracks)) {
                console.error('[AdaptiveStreaming] 📦 Unexpected mp4box response — falling back to native video');
                activateNativeFallback('Unexpected mp4box response');
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
            debugAdaptiveStreaming('[AdaptiveStreaming] 📦 parsed', tracks.length, 'tracks:', tracks.map(t => `${t.type}:${t.codec}`).join(', '));
            tracksRef.current = tracks;
            setState(s => ({ ...s, tracks, loadProgress: 100 }));

            // Progressive (non-fragmented) MP4: mp4box can't segment these files
            // (initializeSegmentation crashes on missing mvex/mehd). Use native <video>.
            if (!movieInfo.isFragmented) {
                debugAdaptiveStreaming('[AdaptiveStreaming] 📦 Progressive MP4 detected — warming moov cache, then falling back to native <video>');
                // Pre-fetch tail to warm the browser's HTTP cache so the native
                // <video> element finds the moov atom instantly.
                if (fileSizeRef.current > 0) {
                    warmProgressiveMoovCache(streamUrl, fileSizeRef.current);
                }
                // Notify parent so it can trigger fMP4 remux in the background.
                // Always fall back to native video — the parent can override
                // later by providing a new stream URL once remux completes.
                if (onProgressiveDetected) {
                    onProgressiveDetected();
                }
                activateNativeFallback('Progressive MP4 detected');
                return;
            }

            // Fragmented MP4 missing mehd box: mp4box v2.3.0 crashes in
            // initializeSegmentation because it accesses
            // this.moov.mvex.mehd.fragment_duration without null-checking.
            // Fix: inject a stub mehd so initializeSegmentation succeeds.
            // Duration of 0 is safe — MSE computes actual duration from
            // segment timestamps (same as DASH/CMAF live streams).
            const moov = (mp4boxfile as any).moov;
            if (moov?.mvex && !moov.mvex.mehd) {
                debugAdaptiveStreaming('[AdaptiveStreaming] 📦 Patching missing mehd on fragmented MP4');
                moov.mvex.mehd = { fragment_duration: 0 };
            }

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

        // ── Global safety net: if nothing works after 10s, fall back to native <video> ──
        const safetyTimer = setTimeout(() => {
            if (onReadyCalledRef.current) return;
            console.error('[AdaptiveStreaming] ⏰ Global safety timer fired — no successful MSE init after 10s, falling back to native video');
            if (playerPhaseRef.current !== 'error') {
                activateNativeFallback('MSE initialization timed out');
            }
            abortFetch();
            abortDiscovery();
        }, 10000);

        function beginMoovDiscovery() {
            const ctrl = new AbortController();
            discoveryAbortRef.current = ctrl;
            discoverMoov(mp4boxfile, ctrl.signal);

            fallbackTimer = setTimeout(async () => {
                debugAdaptiveStreaming('[AdaptiveStreaming] ⏰ Fallback timer fired! onReadyCalled=', onReadyCalledRef.current, 'fileSize=', fileSizeRef.current);
                if (onReadyCalledRef.current) return;

                // Stage 1: Retry with larger range (512KB) before giving up on the header
                const retryCtrl = new AbortController();
                discoveryAbortRef.current = retryCtrl;
                await discoverMoovRetry(mp4boxfile, retryCtrl.signal);
                debugAdaptiveStreaming('[AdaptiveStreaming] ⏰ Retry complete, onReadyCalled=', onReadyCalledRef.current);
                if (onReadyCalledRef.current) return;

                // Stage 2: Try tail for moov-at-end files
                const tailCtrl = new AbortController();
                discoveryAbortRef.current = tailCtrl;
                await discoverMoovTail(mp4boxfile, tailCtrl.signal);
                debugAdaptiveStreaming('[AdaptiveStreaming] ⏰ Tail discovery complete, onReadyCalled=', onReadyCalledRef.current);
                if (!onReadyCalledRef.current) {
                    // An unrecognized or oversized tail should not be pushed
                    // through MP4Box as media data. Let the browser's native
                    // range loader handle it instead.
                    activateNativeFallback('MP4 metadata discovery did not complete');
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
            if (safetyTimer) clearTimeout(safetyTimer);
            if (fallbackTimer) clearTimeout(fallbackTimer);
            if (mediaSourceOpenTimerRef.current) {
                clearTimeout(mediaSourceOpenTimerRef.current);
                mediaSourceOpenTimerRef.current = null;
            }
            abortFetch();
            abortDiscovery();
            try { mp4boxfile.stop(); } catch { /* ignore */ }
            try { mp4boxfile.flush(); } catch { /* ignore */ }
            const ms = mediaSourceRef.current;
            if (ms) {
                if (ms.readyState === 'open') {
                    try { ms.endOfStream(); } catch { /* ignore */ }
                }
                try { clearSourceBuffer(); } catch { /* ignore */ }
            }
            if (videoRef.current) {
                try {
                    const url = videoRef.current.src;
                    videoRef.current.src = "";
                    videoRef.current.load();
                    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
                } catch { /* ignore */ }
            }
            mp4boxRef.current = null;
            mediaSourceRef.current = null;
            sourceBuffersRef.current = {};
            appendQueuesRef.current = {};
            discoveryPrefixRef.current = null;
            discoverySuffixRef.current = null;
        };
    }, [streamUrl, effectiveUseFallback, startDownload, createSourceBuffer, abortFetch, abortDiscovery,
        clearSourceBuffer, initSegments, discoverMoov, discoverMoovRetry, discoverMoovTail, buildMsePipeline,
        fileName, activateNativeFallback]);

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
            if (mediaSourceOpenTimerRef.current) {
                clearTimeout(mediaSourceOpenTimerRef.current);
                mediaSourceOpenTimerRef.current = null;
            }
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
