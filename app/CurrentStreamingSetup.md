# Current Streaming Setup — Telegram-Drive

> Handoff document for LLM analysis. Last updated: June 4, 2026.

## Project Overview

**Telegram-Drive** (`/Users/cameronamer/Documents/TelegramicBackUP_01/app`) is a Tauri v2 (Rust backend + React/TypeScript frontend) desktop app that turns a Telegram account into a cloud storage drive. It streams video files directly from Telegram's servers through a local proxy server to an HTML5 player.

### Tech Stack
- **Backend:** Rust (Tauri v2, Actix-web 4, tokio, grammers-client git rev `d07f96f`, mp4parse 0.17)
- **Frontend:** React 18 + TypeScript, mp4box ^2.3.0, hls.js
- **Build:** Vite, Cargo

---

## Current Architecture (Streaming Data Flow)

```
Frontend (React + mp4box.js + MSE/HLS.js)
    │
    ▼ HTTP Range requests
Tauri Streaming Server (Actix-web on localhost:14201)
    │  build_media_response() → grammers-client iter_download()
    ▼
Telegram MTProto API (upload.getFile)
```

### Three Playback Paths

1. **MSE (MediaSource Extensions)** — for fragmented MP4s. mp4box.js parses the stream, segments it, and feeds to `<video>` via SourceBuffer.
2. **HLS transcoding** — FFmpeg re-encodes to HLS variants (360p–1080p), served via hls.js or native Safari HLS.
3. **Native `<video>` fallback** — for progressive (non-fragmented) MP4s and non-MP4 files. Player handles Range requests directly.

### New (This Session): fMP4 Remux Pipeline

A fourth path was added: when a progressive MP4 is detected, the frontend triggers a backend FFmpeg stream-copy remux (`ffmpeg -c copy -movflags frag_keyframe+empty_moov+default_base_moof`) to convert it to fragmented MP4 on-the-fly. The remuxed file is served via a new `/fmp4/...` Actix route, and the frontend switches the MSE pipeline to it once ready.

---

## Files to Examine (in priority order)

### ⭐ Backend — Core Streaming (most critical)

| File | Role |
|------|------|
| `src-tauri/src/server.rs` | **The streaming proxy.** `build_media_response()` handles `Range` headers, `skip_chunks` alignment (recently fixed — see below), and Actix route setup. `parse_range_header()` parses HTTP Range headers. |
| `src-tauri/src/transcode.rs` | HLS transcode pipeline: FFmpeg detection, original file caching (`cache_original`), `run_transcode()` for HLS encoding, Actix routes for playlists/segments. Uses `TranscodeManager` with job state machine. See `QUALITY_PRESETS`. |
| `src-tauri/src/fmp4_remux.rs` | **New.** FFmpeg stream-copy remux (progressive MP4 → fragmented MP4). `run_fmp4_remux()` uses `-c copy -movflags frag_keyframe+empty_moov+default_base_moof`. Tauri command `cmd_prepare_fmp4_stream` and Actix serving route. **Known: no cancellation support yet** (sender kept alive). |
| `src-tauri/src/commands/streaming.rs` | `cmd_get_stream_info` returns token + base URL to frontend. `StreamConfig` holds token + port. |
| `src-tauri/src/commands/video_metadata.rs` | `cmd_get_video_metadata` / `cmd_get_video_metadata_batch` — downloads first 2MB of MP4, parses with `mp4parse` for duration/codec/dimensions. |
| `src-tauri/src/mp4_utils.rs` | `scan_video_tkhd_dimensions()` — walks moov/trak/tkhd boxes to extract resolution. `find_box()` helper. |
| `src-tauri/src/lib.rs` | Module registration, Tauri command handler list, state management (`TelegramState`, `TranscodeManager` as `Arc<TranscodeManager>`, `StreamConfig`). Actix server startup. |
| `src-tauri/src/commands/mod.rs` | `TelegramState` definition (client, peer_cache, cancelled_transfers). Module re-exports. |
| `src-tauri/src/upload_service.rs` | Secondary streaming path — also calls `build_media_response()`. |
| `src-tauri/src/api_routes.rs` | REST API routes; `api_download_file` calls `build_media_response()`. |
| `src-tauri/src/share_routes.rs` | Share link routes; also calls `build_media_response()`. |
| `src-tauri/Cargo.toml` | Dependencies: `grammers-client` (git rev `d07f96f`), `actix-web 4`, `tokio`, `mp4parse 0.17`. |
| `src-tauri/tauri.conf.json` | CSP config (recently relaxed for ad networks). |

### ⭐ Frontend — Playback Engine (most critical)

| File | Role |
|------|------|
| `src/hooks/useAdaptiveStreaming.ts` | **The MSE pipeline engine.** Uses mp4box.js (`createFile()`, `appendBuffer()`, `initializeSegmentation()`). **Moov discovery** in 3 stages: prefix (128KB) → retry (512KB) → tail (512KB from end). `extractMoovAtom()` isolates moov box. `warmProgressiveMoovCache()` pre-fetches last 3MB for cache warming (new). Falls back to native video for progressive MP4s, calls `onProgressiveDetected` callback (new) for fMP4 remux trigger. |
| `src/components/desktop/dashboard/AdaptiveMediaPlayer.tsx` | **Player shell.** Orchestrates MSE, HLS, and native video modes. Handles fullscreen, volume, quality selection, debug overlay, keyboard shortcuts. **New:** fMP4 remux UI — calls `cmd_prepare_fmp4_stream`, shows "Converting to streaming format..." overlay, switches to fMP4 URL via `restartNonce` restart. |
| `src/components/desktop/dashboard/MediaPlayer.tsx` | Entry-point wrapper that routes to `AdaptiveMediaPlayer`. |
| `src/hooks/moovCache.ts` | IndexedDB cache for moov metadata (track info). `getCachedMoov()` / `setCachedMoov()` with LRU eviction (max 50 entries). `extractCacheKey()` parses stream URL. |
| `src/hooks/useStreamingSettings.ts` | User preferences for quality, adaptive mode. |
| `src/hooks/useVideoMetadata.ts` | Fetches video metadata from backend. |
| `src/hooks/useCachedVariants.ts` | Checks for cached HLS variants. |
| `src/hooks/useNetworkStatus.ts` | Network connectivity monitoring. |
| `src/components/shared/QualitySelector.tsx` | Quality/resolution picker UI component. |
| `src/types.ts` | TypeScript types: `StreamingQuality`, `VideoTrackInfo`, `QUALITY_THROTTLE_MAP`, `ADAPTIVE_THRESHOLDS`. |
| `src/App.tsx` | Root app component. |
| `package.json` | Frontend deps: `mp4box ^2.3.0`, `hls.js`, `@tauri-apps/api`. |

---

## Key Constants Reference

| Constant | Location | Value |
|----------|----------|-------|
| `CHUNK_SIZE` | server.rs | 65,536 (64KB MTProto chunks) |
| `CDN_ALIGNMENT` | server.rs | 524,288 (512KB CDN boundary) |
| `STREAM_PORT` | lib.rs | 14,201 |
| `MOOV_DISCOVERY_BYTES` | useAdaptiveStreaming.ts | 131,072 (128KB) |
| `MOOV_RETRY_BYTES` | useAdaptiveStreaming.ts | 524,288 (512KB) |
| `MOOV_TAIL_BYTES` | useAdaptiveStreaming.ts | 524,288 (512KB) |
| `PROGRESSIVE_CACHE_WARM_BYTES` | useAdaptiveStreaming.ts | 3,145,728 (3MB) |
| `MOOV_FALLBACK_TIMEOUT_MS` | useAdaptiveStreaming.ts | 3,000 |
| `HLS_SEGMENT_TIME` | transcode.rs | 4 (seconds) |
| `MAX_CACHE_BYTES` | transcode.rs | 5,368,709,120 (5GB) |
| `FMP4_DIR` | fmp4_remux.rs | "fmp4" |
| `SEEK_DEBOUNCE_MS` | useAdaptiveStreaming.ts | 300 |
| `SPEED_WINDOW_MS` | useAdaptiveStreaming.ts | 3,000 |
| `SPEED_CHECK_INTERVAL_MS` | useAdaptiveStreaming.ts | 2,000 |

---

## Recent Changes Applied (This Session — June 4, 2026)

### 1. CDN-Safe Byte Alignment (`server.rs`)

**Problem:** Without the `precise` flag on `upload.getFile`, Telegram CDNs round offsets down to CDN chunk boundaries (up to 512KB). The old code aligned `skip_chunks` to 64KB, which is not always a multiple of CDN boundaries. This caused byte misalignment that accumulated across successive HTTP Range requests, eventually corrupting MP4 box parsing (the `ORrI` error at position ~106MB).

**Fix:** `skip_chunks` offsets now aligned to 512KB (524,288) boundaries. Leading bytes are sliced off to serve the exact byte range requested. Added `debug_assert` and logging.

**Key code:** `build_media_response()` in `src-tauri/src/server.rs`, lines ~89-130.

```rust
const CDN_ALIGNMENT: u64 = 524288; // 512 KB
let cdn_aligned_start = (start_byte / CDN_ALIGNMENT) * CDN_ALIGNMENT;
let chunk_index = (cdn_aligned_start / CHUNK_SIZE as u64) as i32;
download_iter = download_iter.chunk_size(CHUNK_SIZE);
if chunk_index > 0 {
    download_iter = download_iter.skip_chunks(chunk_index);
}
bytes_to_skip = (start_byte - cdn_aligned_start) as usize;
```

### 2. Progressive MP4 Cache Pre-Warming (`useAdaptiveStreaming.ts`)

**Problem:** When progressive MP4s fall back to native `<video>`, the browser must make a Range request to the file's tail to find the `moov` atom. This round-trip through the backend → Telegram is slow for large files, causing buffering delays.

**Fix:** A `warmProgressiveMoovCache()` function pre-fetches the last 3MB of the file via `fetch()` before the fallback. This populates the browser's HTTP cache, so the native player's subsequent tail request is a cache hit.

**Key code:** `warmProgressiveMoovCache()` in `src/hooks/useAdaptiveStreaming.ts`, lines ~62-82.

### 3. FFmpeg fMP4 Remux Pipeline (`fmp4_remux.rs` + frontend)

**Problem:** Progressive MP4s cannot use the MSE pipeline because mp4box's `initializeSegmentation()` crashes on files missing `mvex/mehd` boxes. They always fall back to native `<video>`, which has limited controls and buffering delays.

**Fix:** A new pipeline converts progressive MP4 → fragmented MP4 on-the-fly:

- **Backend** (`src-tauri/src/fmp4_remux.rs`, ~300 lines): `cmd_prepare_fmp4_stream` downloads the original to cache, runs `ffmpeg -c copy -movflags frag_keyframe+empty_moov+default_base_moof`, and serves the fMP4 via `/fmp4/{file_key}/output.mp4`. Uses `TranscodeManager` for cache management.
- **Frontend**: `useAdaptiveStreaming` emits `onProgressiveDetected` callback. `AdaptiveMediaPlayer` calls the Tauri command, shows "Converting to streaming format..." overlay, then switches the MSE pipeline to the fMP4 URL.
- **Registration**: Module registered in `lib.rs`, route added to Actix server in `server.rs`.

**Known issue:** No cancellation support — `_cancel_tx` is kept alive for the duration.

### 4. State Type Fix (`fmp4_remux.rs`)

**Problem:** `TranscodeManager` is managed as `Arc<TranscodeManager>` in Tauri, but the command requested `State<'_, TranscodeManager>`. Tauri v2 does strict `TypeId` matching, so it couldn't resolve the state.

**Fix:** Changed to `State<'_, Arc<TranscodeManager>>` and added `use std::sync::Arc`.

---

## Known Issues / Optimization Opportunities

### High Priority

1. **`precise` flag unavailable** — grammers-client's `DownloadIter` has no `precise()` method. Forking the library or contributing a PR would let us skip 512KB CDN alignment entirely, reducing wasted bandwidth on every range request (up to 512KB discarded per seek).

2. **fMP4 remux requires full file download** — FFmpeg needs seekable input (moov-at-end for progressive MP4s). Currently downloads entire file via `cache_original()`, then remuxes. Could be optimized by:
   - Parallel tail + head fetch (tail for moov, head for streaming)
   - Moov relocation to create a fast-start file before FFmpeg
   - Streaming remux if `-movflags faststart` can work with piped input

3. **HLS commands may have wrong State type** — `transcode.rs` commands use `State<'_, TranscodeManager>` but managed as `Arc<TranscodeManager>`. May fail at runtime (same bug we fixed in `fmp4_remux.rs`).

### Medium Priority

4. **No fMP4 cancellation** — `cmd_prepare_fmp4_stream` keeps cancel sender alive with no way to abort. Blocking on large files. Add a `cmd_cancel_fmp4_remux` command.

5. **No streaming tests** — Only test file is `src-tauri/tests/android_uri_cache_tests.rs` (unrelated). No unit tests for `parse_range_header`, `build_media_response` alignment, moov extraction, or the remux pipeline.

6. **Moov discovery is sequential** — 3 stages in series (prefix → retry → tail). Could parallelize prefix + tail fetch since file size is known early.

### Low Priority / Nice-to-Have

7. **HLS transcode is re-encode, not stream-copy** — `run_transcode()` re-encodes with `-c:v libx264`. Could add a fast stream-copy path for files that already have compatible codecs (similar to fMP4 remux but for HLS container).

8. **fMP4 remux progress callback is hardcoded** — `run_fmp4_remux()` passes `0.5` to the progress callback regardless of actual progress. Either wire up real progress parsing from FFmpeg stderr or remove the callback.

9. **`fmp4RemuxingRef` reset is fragile** — Reset in both success and error paths but could be missed if the async function is interrupted. Consider using a try/finally pattern.

---

## Content Security Policy

Current CSP in `tauri.conf.json`:

```
default-src 'self';
connect-src 'self' https: http://localhost:* https://asset.localhost http://asset.localhost;
media-src 'self' blob: http://localhost:*;
img-src 'self' data: blob: asset: https: https://asset.localhost;
style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-eval' blob: https:;
frame-src 'self' blob: https:;
worker-src 'self' blob:;
```

The streaming server runs on `http://localhost:14201` and is accessed from `https://tauri.localhost` (Tauri v2's secure context origin).

---

## Quick Debug Tips

- **Streaming logs:** Set `RUST_LOG=debug` to see range alignment details in console
- **Frontend logs:** Open DevTools, look for `[AdaptiveStreaming]` and `[AdaptivePlayer]` prefixed messages
- **fMP4 cache:** Stored at `$APPDATA/streaming/fmp4/{folder_id}_{message_id}/output.mp4`
- **HLS cache:** Stored at `$APPDATA/streaming/hls/{folder_id}_{message_id}/{quality}/`
- **Original cache:** Stored at `$APPDATA/streaming/originals/{folder_id}_{message_id}.mp4`
- **Debug overlay:** Press `D` key during playback for MSE/HLS stats
- **Clear transcode cache:** Button in debug overlay (trash icon)
