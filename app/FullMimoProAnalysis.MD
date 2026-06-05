# Telegram Drive — Full Repository Analysis

**Date:** June 1, 2026  
**Version:** 1.7.9 (frontend) / 1.7.0 (Cargo.toml — MISMATCH)  
**Stack:** Tauri v2 + Rust (Actix-web) + React 19 + TypeScript + TailwindCSS v4

---

## Table of Contents

1. [Critical Issues](#1-critical-issues)
2. [Version Mismatches & Outdated Dependencies](#2-version-mismatches--outdated-dependencies)
3. [Dead Code & Unused Exports](#3-dead-code--unused-exports)
4. [Security Concerns](#4-security-concerns)
5. [Code Duplication](#5-code-duplication)
6. [Potential Bugs & Logic Issues](#6-potential-bugs--logic-issues)
7. [Architecture & Design Issues](#7-architecture--design-issues)
8. [Frontend-Specific Issues](#8-frontend-specific-issues)
9. [Backend (Rust) Specific Issues](#9-backend-rust-specific-issues)
10. [Testing & CI Gaps](#10-testing--ci-gaps)
11. [Performance Concerns](#11-performance-concerns)
12. [Recommendations Summary](#12-recommendations-summary)

---

## 1. Critical Issues

### 1.1 Version Mismatch: Cargo.toml says `1.7.0`, tauri.conf.json says `1.7.9`

- **File:** `src-tauri/Cargo.toml` line 3 → `version = "1.7.0"`
- **File:** `src-tauri/tauri.conf.json` → `"version": "1.7.9"`
- **File:** `package.json` → `"version": "1.7.9"`
- **Impact:** The Rust binary reports version `1.7.0` via `cmd_get_system_diagnostics`, `env!("CARGO_PKG_VERSION")`, and the API health endpoint. This will confuse users and break version-based update logic. The updater checks tauri.conf.json version but the health endpoint returns the Cargo version.

### 1.2 Share Link Uses `http://localhost` — Not Reachable from External Devices

- **File:** `src-tauri/src/commands/sharing.rs` line: `format!("http://localhost:{}/d/{}", crate::STREAM_PORT, token)`
- **Impact:** Share links generated on a desktop will only work on the same machine. If the streaming server is bound to `0.0.0.0` (which it is), the share link should use the machine's actual IP or a configurable hostname for LAN sharing to work.

### 1.3 API Server Binds to `127.0.0.1` Only — CORS Allows `any_origin`

- **File:** `src-tauri/src/lib.rs` — `restart_api_server` function
- **Impact:** The API server binds to `127.0.0.1` but the CORS policy allows any origin, any method, any header. This is a security mismatch — if the binding is intentional (local only), CORS is overly permissive. If remote access is intended, the binding should be `0.0.0.0`.

### 1.4 Fake Rate Limit Headers

- **File:** `src-tauri/src/api_routes.rs` — `api_list_files`, `api_bulk_files`, `api_search_files`
- **Impact:** All API responses return hardcoded `x-ratelimit-remaining: 99` and `x-ratelimit-limit: 100` headers. There is no actual rate limiting implemented. This misleads API consumers into thinking they are rate-limited when they are not, and provides no actual protection against abuse.

---

## 2. Version Mismatches & Outdated Dependencies

| Issue | Location | Details |
|-------|----------|---------|
| Cargo.toml version `1.7.0` vs tauri.conf.json `1.7.9` | `src-tauri/Cargo.toml` | Must be kept in sync |
| `grammers` pinned to specific git rev `d07f96f` | `src-tauri/Cargo.toml` | Git dependency with no semver — fragile if repo changes |
| `base64 = "0.21"` | `src-tauri/Cargo.toml` | v0.22 is current; 0.21 is deprecated |
| `rand = "0.8"` | `src-tauri/Cargo.toml` | v0.9 is current |
| `tauri-plugin-dialog = "2.6.0"` pinned | `src-tauri/Cargo.toml` | Other tauri plugins use `"2"` (unpinned) — inconsistent |
| `tauri-plugin-updater = "2.9.0"` pinned | `src-tauri/Cargo.toml` | Same inconsistency |
| `tauri-plugin-process = "2.3.1"` pinned | `src-tauri/Cargo.toml` | Same inconsistency |
| `mp4parse = "0.17"` | `src-tauri/Cargo.toml` | v0.17 is current but check for updates |
| `ndk-context = "0.1.1"` | `src-tauri/Cargo.toml` | Very old, check for newer versions |

---

## 3. Dead Code & Unused Exports

### 3.1 DropZoneContext — Completely Empty

- **File:** `src/contexts/DropZoneContext.tsx`
- **Impact:** The context provides an empty interface `{}`, the provider does nothing, and `useDropZone()` is never called in the entire codebase (drag-and-drop uses DOM events directly). This is dead code that adds unnecessary React context nesting.

### 3.2 `_internalDragFileId` State Variable (Unused Prefix)

- **File:** `src/components/desktop/DesktopDashboard.tsx`
- **Impact:** `setInternalDragFileIdState` is used but the `_internalDragFileId` state value is never read. The ref `internalDragRef` is what's actually used. The state setter exists only to trigger re-renders, but the value itself is dead.

### 3.3 `isNetworkError` Function — Never Called

- **File:** `src/hooks/useTelegramConnection.ts`
- **Impact:** `isNetworkError` is defined and returned from the hook but never used by any consumer.

### 3.4 `forceLogout` Function — Never Called

- **File:** `src/hooks/useTelegramConnection.ts`
- **Impact:** `forceLogout` is defined and returned from the hook but never called by any component.

### 3.5 `handleDownload` in useFileOperations — Never Called

- **File:** `src/hooks/useFileOperations.ts`
- **Impact:** `handleDownload` (single file download with save dialog) is defined and returned but never used — the dashboard uses `queueDownload` from `useFileDownload` instead.

### 3.6 `VideoTrackInfo.bitrate` Field — Always Undefined

- **File:** `src/types.ts` and `src/hooks/useAdaptiveStreaming.ts`
- **Impact:** `VideoTrackInfo.bitrate` is populated from `track.bitrate` in mp4box, but mp4box's track object doesn't reliably expose bitrate in the way it's accessed. The field is defined but likely always undefined or 0.

### 3.7 `ProxyConfig.secret` Field — Deprecated

- **File:** `src-tauri/src/vpn_optimizer.rs`
- **Impact:** The `secret` field exists for MTProto proxy support, but the UI comment says "Deprecated — kept for backward compat; no longer surfaced in UI". The proxy type is hardcoded to `socks5` only. This dead field adds confusion.

### 3.8 `TelegramFile.type` Field Inconsistency

- **File:** `src/types.ts` → `type?: 'folder' | 'file'`
- **Impact:** The `type` field is set via `f.icon_type || (f.name.endsWith('/') ? 'folder' : 'file')` in `DesktopDashboard.tsx`, but `icon_type` from the backend is always `"file"`. The folder detection via `endsWith('/')` never triggers because Telegram file names don't end with `/`. Folders are never returned from `cmd_get_files` — they're separate entities. This `type` field is misleading.

### 3.9 `proxySecret` in Settings — Never Used in UI

- **File:** `src/context/SettingsContext.tsx`
- **Impact:** `proxySecret: ''` exists in settings but is never read or written by any UI component.

---









## 4. Security Concerns

### 4.1 SHA-256 Password Hashing Without Proper KDF

- **Files:** `src-tauri/src/share_routes.rs`, `src-tauri/src/commands/sharing.rs`
- **Impact:** Share link passwords are hashed with `SHA-256(password + salt)`. This is not a proper password hashing scheme — SHA-256 is fast and vulnerable to brute-force. Should use `argon2`, `bcrypt`, or at minimum `pbkdf2`.

### 4.2 Session Cookie Without `secure` Flag

- **File:** `src-tauri/src/share_routes.rs`
- **Impact:** The share auth cookie uses `.http_only(true)` and `.same_site(Strict)` but does NOT set `.secure(true)`. Since the share server runs over HTTP (not HTTPS), this is somewhat expected, but the cookie should at least be documented as intentionally insecure.

### 4.3 CSP Allows `unsafe-inline` for Styles

- **File:** `src-tauri/tauri.conf.json`
- **Impact:** `style-src 'self' 'unsafe-inline'` allows inline style injection. While common in React apps, it weakens XSS protection.

### 4.4 CSP Includes Third-Party Ad Domains

- **File:** `src-tauri/tauri.conf.json`
- **Impact:** CSP includes `https://www.highperformanceformat.com` in `connect-src`, `script-src`, and `frame-src`. This is an ad network domain — if compromised, it could inject malicious scripts.

### 4.5 `unsafe` Transmute for JNI Class References

- **File:** `src-tauri/src/lib.rs` (multiple locations)
- **Impact:** `std::mem::transmute_copy` is used to convert JNI global references to JClass. While this works, it bypasses Rust's safety guarantees and could cause undefined behavior if the cached references are invalidated.

### 4.6 API Key Hash Comparison — Timing Attack

- **File:** `src-tauri/src/commands/api_settings.rs`
- **Impact:** `verify_key` uses `==` for string comparison, which is vulnerable to timing attacks. Should use `constant_time_eq` or similar.

---










## 5. Code Duplication

### 5.1 Download/Stream Chunk Logic — Duplicated 3 Times

The exact same byte-range download with chunk alignment, skip logic, and content-length limiting is duplicated in:
1. `src-tauri/src/server.rs` — `stream_media`
2. `src-tauri/src/api_routes.rs` — `api_download_file`
3. `src-tauri/src/share_routes.rs` — `get_shared_file`

Each copy has ~60 lines of identical download iteration logic with the same `CHUNK_SIZE = 65536` alignment pattern. This should be extracted into a shared utility.

### 5.2 MP4 Box Parsing — Duplicated Between `transcode.rs` and `video_metadata.rs`

Both files contain nearly identical implementations of:
- `read_u32_be`
- `find_box` / `find_box_in_range`
- `box_size_at`
- `trak_has_vmhd` / `trak_contains_vmhd`
- `scan_source_resolution` / `scan_video_tkhd_dimensions`

### 5.3 Password Hashing — Duplicated

`hash_password` function is implemented identically in both:
- `src-tauri/src/share_routes.rs`
- `src-tauri/src/commands/sharing.rs`

### 5.4 `cmd_search_global` — Massive Code Duplication

- **File:** `src-tauri/src/commands/fs.rs`
- **Impact:** The `cmd_search_global` function has two nearly identical match arms for `Messages::Messages` and `Messages::Slice` that both parse the same message/document structure. Should be extracted into a helper.

### 5.5 Rate Limit Header Injection — Duplicated 3 Times

The same 3-line rate limit header insertion block is copy-pasted in `api_list_files`, `api_bulk_files`, and `api_search_files` in `api_routes.rs`.








---

## 6. Potential Bugs & Logic Issues

### 6.1 `DownloadItem.uploadedBytes` — Wrong Field Name

- **File:** `src/types.ts` → `DownloadItem` interface
- **Impact:** Download items have `uploadedBytes` instead of `downloadedBytes`. The progress payload from Rust uses `uploaded_bytes` for both upload and download events (the Rust struct is named `ProgressPayload` with `uploaded_bytes`). This is confusing and likely a copy-paste error.

### 6.2 Search Effect Missing `handleGlobalSearch` Dependency

- **File:** `src/components/desktop/DesktopDashboard.tsx`
- **Impact:** The `useEffect` for search has `[searchTerm]` as dependency but calls `handleGlobalSearch` which is a stable callback from `useFileOperations`. While this works because `handleGlobalSearch` is wrapped in `useCallback([], [])`, it's technically a missing dependency per React rules.

### 6.3 `cmd_clean_preview_cache` Only Deletes PDFs

- **File:** `src-tauri/src/commands/preview.rs`
- **Impact:** The function name suggests it cleans all preview cache, but it only deletes `.pdf` files. Image previews and other cached files are not cleaned.

### 6.4 Bandwidth Limit Check Uses Wrong Calculation

- **File:** `src-tauri/src/bandwidth.rs` → `can_transfer`
- **Impact:** `let total = stats.up_bytes + stats.down_bytes + bytes;` — this adds the proposed transfer size to the existing total, but if the transfer actually happens, `add_up`/`add_down` will add the bytes again. The check is correct (pre-flight), but if `can_transfer` passes and the transfer starts, another concurrent transfer could also pass the check before either finishes, potentially exceeding the limit.

### 6.5 `handleFolderRename` Uses `prompt()` as Fallback

- **File:** `src/hooks/useTelegramConnection.ts`
- **Impact:** If `newNameOverride` is not provided, the function falls back to `window.prompt()`, which is inconsistent with the app's UI design and may not work in all Tauri WebView contexts.

### 6.6 Streaming Server Binds to `0.0.0.0` — Accessible on LAN

- **File:** `src-tauri/src/server.rs`
- **Impact:** The streaming server binds to `0.0.0.0:14201`, making it accessible from any device on the local network. Combined with the session token in the URL, this could expose media files to anyone on the same network.

### 6.7 `invoke<any[]>` Type Cast

- **File:** `src/components/desktop/DesktopDashboard.tsx`
- **Impact:** `invoke<any[]>('cmd_get_files', ...)` uses `any[]` type cast, bypassing TypeScript's type safety. Should use `FileMetadata[]` or a proper type.

### 6.8 `processItem` Missing `await` Pattern for Concurrent Uploads

- **File:** `src/hooks/useFileUpload.ts`
- **Impact:** The `maxConcurrentUploads` setting exists in settings but is never used. The upload queue processes items one at a time (`processing` flag prevents concurrent processing). The setting is misleading.

### 6.9 `maxConcurrentDownloads` Setting — Never Used

- **File:** `src/context/SettingsContext.tsx`
- **Impact:** `maxConcurrentDownloads: 6` is defined in settings but downloads also process one at a time.

















---

## 7. Architecture & Design Issues

### 7.1 `Store` Type Import Inconsistency

- **File:** `src/hooks/useTelegramConnection.ts` uses `import { Store } from '@tauri-apps/plugin-store'`
- **File:** `src/hooks/useFileUpload.ts` uses `import type { Store } from '@tauri-apps/plugin-store'`
- **File:** `src/App.tsx` uses `import { load } from '@tauri-apps/plugin-store'`
- **Impact:** The Store type is imported differently across files. The `useTelegramConnection` hook uses `Store.load()` (static method) while `App.tsx` uses the standalone `load()` function. Both work but are inconsistent.

### 7.2 Two Separate Context Directories

- **Files:** `src/context/` (3 files) and `src/contexts/` (1 file)
- **Impact:** The project has two context directories — `src/context/` with `ConfirmContext`, `ThemeContext`, `SettingsContext` and `src/contexts/` with `DropZoneContext`. This is confusing and the `DropZoneContext` is dead code anyway.

### 7.3 No Error Boundaries Around Feature Components

- **File:** `src/App.tsx`
- **Impact:** There's a top-level `ErrorBoundary` but no granular error boundaries around `DesktopDashboard`, `MediaPlayer`, `PdfViewer`, etc. A crash in any component takes down the entire app.

### 7.4 Settings Managed in Two Places

- **Impact:** Frontend settings are in `SettingsContext.tsx` (persisted to `settings.json` via Tauri store), but network/proxy settings are also persisted separately by the Rust backend to `network_settings.json`. There's no single source of truth, and the frontend must explicitly call `cmd_apply_proxy_settings` / `cmd_apply_vpn_settings` to sync.

### 7.5 Mock Code Left in Production

- **File:** `src-tauri/src/commands/fs.rs`
- **Impact:** Multiple functions have `if client_opt.is_none()` blocks that return mock data (e.g., `cmd_create_folder`, `cmd_delete_folder`, `cmd_upload_file`, `cmd_download_file`). These are development stubs that should be removed or gated behind a feature flag.

### 7.6 `DropZoneProvider` Wraps Entire App for No Reason

- **File:** `src/App.tsx`
- **Impact:** `DropZoneProvider` wraps the entire app but provides no functionality (empty context). It adds unnecessary React fiber overhead.

---













### 8.1 Console.log Statements Left in Production Code

Multiple `console.log` and `console.warn` statements remain throughout:
- `src/hooks/useAdaptiveStreaming.ts` — extensive debug logging with emoji prefixes
- `src/hooks/useTelegramConnection.ts` — `[AutoSync]` logs
- `src/hooks/useFileUpload.ts` — `[Upload]` logs
- `src/components/desktop/DesktopDashboard.tsx` — various logs

### 8.2 `useAdaptiveStreaming` — Massive Complexity (~600 lines)

- **File:** `src/hooks/useAdaptiveStreaming.ts`
- **Impact:** This single hook is ~600 lines with 20+ refs, complex state machines, and multiple abort controllers. It should be decomposed into smaller, testable units.

### 8.3 `framer-motion` Used Only for `AnimatePresence`

- **File:** `src/components/desktop/DesktopDashboard.tsx`
- **Impact:** `framer-motion` is imported solely for `AnimatePresence`. This is a large dependency for a single feature. Consider using CSS transitions or a lighter alternative.

### 8.4 MobileDashboard Dynamic Import Pattern

- **File:** `src/App.tsx`
- **Impact:** `MobileDashboard` uses a dynamic import with a variable: `import(\`./components/mobile/${moduleName}\`)`. This pattern may not work well with Vite's code splitting and could cause issues with TypeScript's module resolution. The comment in git history says "build: mock MobileDashboard module declaration for desktop build environment" suggesting this has been a source of build problems.

### 8.5 Missing `key` Props in List Renders

- **File:** `src/components/desktop/dashboard/FileExplorer.tsx`
- **Impact:** In the grid view, virtual rows use `virtualRow.key` but the inner file cards use `file.id` as key. When files are reordered or filtered, this could cause stale renders.

### 8.6 Performance Mode CSS Has High Specificity Overrides

- **File:** `src/App.css`
- **Impact:** `.performance-mode *` selector with `!important` overrides every element. This is heavy-handed and could cause unexpected style breakage.

---














## 9. Backend (Rust) Specific Issues

### 9.1 `std::thread::sleep` in Async Context

- **File:** `src-tauri/src/lib.rs` — `restart_api_server`
- **Impact:** `std::thread::sleep(Duration::from_millis(200))` is called after stopping the old API server. This blocks the thread. Should use `tokio::time::sleep`.

### 9.2 Two Separate Actix Runtimes

- **File:** `src-tauri/src/lib.rs`
- **Impact:** The app spawns two separate `actix_rt::System` instances — one for the streaming server and one for the API server. Each creates its own Tokio runtime on a dedicated OS thread. This doubles memory usage and thread count. They could share a single runtime.

### 9.3 `println!` in Bandwidth Manager

- **File:** `src-tauri/src/bandwidth.rs`
- **Impact:** `println!("[Bandwidth] New day detected...")` should use `log::info!` for consistency with the rest of the codebase.

### 9.4 SQLite Connection Wrapped in `std::sync::Mutex`

- **File:** `src-tauri/src/db.rs`
- **Impact:** The database connection is wrapped in `std::sync::Mutex`, which blocks the async runtime thread when held. For a low-traffic app this is fine, but `tokio::sync::Mutex` or connection pooling would be better.

### 9.5 `chrono` Used Only for Timestamps

- **File:** `src-tauri/src/bandwidth.rs`, `src-tauri/src/commands/sharing.rs`, `src-tauri/src/share_routes.rs`
- **Impact:** The `chrono` crate is a heavy dependency used only for `Local::now().format(...)` and `Utc::now().timestamp()`. These could use `std::time::SystemTime` instead.

### 9.6 `walkdir` Used Only in Transcode Cache

- **File:** `src-tauri/src/transcode.rs`
- **Impact:** The `walkdir` crate is pulled in for cache size calculation and LRU eviction. This could be done with `std::fs::read_dir` recursively.

### 9.7 `zip` Crate with Minimal Features

- **File:** `src-tauri/Cargo.toml` → `zip = { version = "2", default-features = false, features = ["deflate"] }`
- **Impact:** Only `deflate` compression is enabled. If users upload ZIP files created with other compression methods, they may not be readable.

### 9.8 `tauri_plugin_fs` Imported but No FS Commands Used

- **File:** `src-tauri/src/lib.rs` → `.plugin(tauri_plugin_fs::init())`
- **Impact:** The FS plugin is initialized but no Tauri FS commands (like `readFile`, `writeFile`) appear to be used directly from the frontend. The app uses Rust commands for all file operations. This plugin adds unnecessary initialization overhead.

### 9.9 `get_source_height` Reads Entire File Into Memory

- **File:** `src-tauri/src/transcode.rs`
- **Impact:** `get_source_height` calls `std::fs::read(cached_path)` which reads the entire file into memory, then takes only the first 2MB. For large files, this wastes memory. Should read only the first 2MB.

---

## 10. Testing & CI Gaps

### 10.1 No Frontend Tests

- **Impact:** There are zero test files for any React component, hook, or utility function. The `tsconfig.json` has `strict: true` but no test runner is configured.

### 10.2 Single Rust Test File

- **File:** `src-tauri/tests/android_uri_cache_tests.rs`
- **Impact:** Only one test file exists for the entire Rust backend, and it's specifically for Android URI cache. Core logic like `parse_range_header`, `backoff_ms`, password hashing, and MP4 parsing are untested.

### 10.3 No Integration Tests

- **Impact:** No end-to-end or integration tests exist for the API endpoints, streaming server, or share routes.

### 10.4 No Linting Configuration

- **Impact:** No ESLint or clippy configuration files found. The project relies solely on TypeScript's strict mode for frontend quality.

---

## 11. Performance Concerns

### 11.1 Preview Cache Reads Entire Image for Base64

- **File:** `src-tauri/src/commands/preview.rs`
- **Impact:** `tokio::fs::read(&save_path)` reads the entire file into memory for base64 encoding. For large images, this could cause memory spikes.

### 11.2 `cmd_get_files` Scans All Messages

- **File:** `src-tauri/src/commands/fs.rs`
- **Impact:** `cmd_get_files` iterates through ALL messages in a folder with no limit. For folders with thousands of files, this could be very slow and consume significant memory.

### 11.3 No Pagination in Frontend File List

- **File:** `src/components/desktop/DesktopDashboard.tsx`
- **Impact:** The React Query fetches ALL files at once (`cmd_get_files` returns everything). While `@tanstack/react-virtual` handles rendering, the full dataset is held in memory and re-filtered on every search keystroke.

### 11.4 `total_cache_size()` Walks Entire Cache on Every LRU Check

- **File:** `src-tauri/src/transcode.rs`
- **Impact:** `evict_lru()` calls `total_cache_size()` which walks the entire cache directory tree. This is called after every transcode completes. For large caches, this could be slow.

---

## 12. Recommendations Summary

### Immediate Fixes (High Priority)

1. **Sync Cargo.toml version** to `1.7.9` to match tauri.conf.json and package.json
2. **Remove mock code** from production `fs.rs` commands or gate behind `#[cfg(debug_assertions)]`
3. **Extract shared download streaming logic** into a utility to eliminate 3x duplication
4. **Extract shared MP4 box parsing** into a single module
5. **Remove dead DropZoneContext** and `DropZoneProvider` wrapper
6. **Fix `uploadedBytes` naming** in `DownloadItem` to `downloadedBytes`
7. **Remove console.log** statements or use a proper logging library with levels

### Short-Term Improvements

8. Implement actual rate limiting for the API server (or remove fake headers)
9. Use `constant_time_eq` for API key verification
10. Replace SHA-256 password hashing with argon2/bcrypt
11. Make share links use configurable hostname instead of `localhost`
12. Add error boundaries around major feature components
13. Remove unused settings: `maxConcurrentUploads`, `maxConcurrentDownloads`, `proxySecret`
14. Replace `std::thread::sleep` with `tokio::time::sleep` in async contexts

### Long-Term Improvements

15. Add frontend tests (Vitest recommended)
16. Add Rust unit tests for core logic
17. Break `useAdaptiveStreaming` into smaller, composable hooks
18. Consider replacing `framer-motion` with CSS-only transitions
19. Implement file list pagination in the backend
20. Consolidate the two Actix runtimes into one
21. Add ESLint + clippy configuration
22. Consider using `tauri-plugin-sql` instead of raw `sqlite` crate for better async support

---

*Analysis generated by MimoPro — covers all Rust backend files (18 source files), all TypeScript/React frontend files (40+ source files), configuration files, and project structure.*
