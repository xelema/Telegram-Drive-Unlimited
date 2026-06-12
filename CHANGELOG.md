# Changelog

## [1.8.8] - 2026-06-12

### Features & Caching Polish

- **Enterprise-Grade Remote Upload**
  - Integrated dual-phase remote file upload from direct HTTP/HTTPS URLs.
  - Added frontend dialog `RemoteUploadModal` for URL input and destination folder selection.
  - Implemented backend download cache manager (`cmd_upload_from_url`) with disk space pre-flight checks, resumable downloads using HTTP `Range` headers, SOCKS5/MTProto proxy routing config, oneshot cancellation tracking, and bandwidth throttling.
  - Integrated dual-phase progress states and progress bars in `UploadQueue` UI.

---

## [1.8.7] - 2026-06-09

### Bug Fixes & Windows Enhancements

- **Windows Filename Sanitization**
  - Added filename sanitization to strip colons (`:`) and other invalid OS characters from target filenames, preventing Windows OS from refusing to save downloads or writing streams to NTFS Alternate Data Streams (ADS).
- **Cache Download Integrity**
  - Added strict file size verification in backend caching logic to detect interrupted downloads or server connection drop-offs. Prevents truncated files from being cached and causing FFmpeg remux parsing errors (like `Invalid data found while parsing box`).

---

## [1.8.4] - 2026-06-03

### Bug Fixes & UI Enhancements

- **Grid Virtualizer Cache Invalidation**
  - Resolved layout overlapping issues where "Upload File" and "Upload Folder" buttons overlapped with files in the Grid view by forcing virtualizer remeasurement on layout changes.

---

## [1.8.3] - 2026-06-03

### Bug Fixes & UI Enhancements

- **Cross-Platform Video Streaming Resolution**
  - Resolved dynamic CORS blocking behavior across client webviews, rectifying media loading and playback errors on Windows, macOS, and Linux.
- **File Grid UI & Layout Alignment**
  - Corrected card shifting and overlapping behaviors within the file explorer's grid layout.
  - Configured automated scroll reset and virtualizer cache purging during directory navigation.

---

## [1.8.2] - 2026-06-03

### Streaming Hotfix: Cross-Platform Video Playback Correction

- **CORS Configuration Update**
  - Updated CORS configuration on local streaming and API servers to use dynamic origin matching.
  - Resolved video playback failures (`TypeError: Failed to fetch` / `TypeError: Load failed`) on Windows, macOS, and Linux clients by explicitly supporting platform-specific custom schemes and WebKit's `null` origin.

---

## [1.8.1] - 2026-06-03

### Features, Security & Architecture (MimoPro Cleanups Part 2)

- **User Interface Enhancements**
  - Optimized the media player controls by standardizing close and fullscreen overlay buttons.
  - Refined layout geometries for player circle buttons and balanced spacing gaps.
  - Integrated a new periodic interstitial ad flow, featuring timed countdowns and automated clicks/focus dismissal logic.

- **Storage & Backend Stability Fixes**
  - Recreated missing mobile capability rules to support compilation of Tauri configuration context.
  - Corrected progress field mappings (`downloadedBytes`) in UI progress bars and download queues.
  - Resolved dynamic import resolution behavior for local builds.
  - Expanded Content Security Policy (CSP) rules to permit ad network script invocations.

- **Improved Accessibility Support**
  - Auto-enabled performance and reduced-motion modes using platform media queries.
  - Wrapped major component views in granular error boundaries to prevent app-wide crashes.

---

## [1.8.0] - 2026-06-02

### Features, Security & Architecture (MimoPro Analysis Cleanups)

- **Critical Fixes**
  - Synchronized versions across `package.json`, `tauri.conf.json`, and `Cargo.toml`.
  - Replaced hardcoded `localhost` references in `sharing.rs` with `127.0.0.1` to ensure local loopback resolution works reliably.
  - Removed misleading mock rate limit headers (`x-ratelimit-limit`, etc.) from API endpoint responses.

- **Dependency Upgrades**
  - Upgraded deprecated dependencies (`base64` to `0.22`, `rand` to `0.9`).
  - Standardized Tauri plugin version strings (`tauri-plugin-dialog`, `tauri-plugin-updater`, `tauri-plugin-process`) to consistently use version `"2"`.

- **Dead Code Cleanup**
  - Completely removed empty `DropZoneContext.tsx` and removed the `<DropZoneProvider>` wrapper from `App.tsx`.
  - Cleaned up unused state variables (`_internalDragFileId`) and unused hook exports (`isNetworkError`, `forceLogout`, `handleDownload`).
  - Removed dead settings fields (`proxySecret`, `ProxyConfig.secret`).

- **Security Enhancements**
  - Implemented secure `bcrypt` hashing (work factor `12`) for folder share passwords.
  - Swapped direct comparisons in API key verification for constant-time checks using `constant_time_eq` to prevent timing attacks.

- **Architecture & Code Deduplication**
  - Extracted shared byte-range parsing and chunk calculation logic for downloads and media streaming.
  - Consolidated duplicate MP4 container box header navigation and box validations into a single module.
  - Unified duplicate password hashing and verification code.
  - Corrected field naming inconsistency (`uploadedBytes` to `downloadedBytes` inside `DownloadItem`).

---

## [1.7.9] - 2026-06-02

### Features & Fixes

- **Folder Rename Bug Fix** — Resolved an issue where renaming a folder in the sidebar failed because the capture-phase click listener unmounted the context menu before the button's action could execute.
- **Media Player Styling** — Equalized the close and fullscreen circle buttons to standard sizes with a small gap between them.

---

## [1.7.8] - 2026-06-01

### Features & Enhancements

- **Major UI improvements**
- **Complete media player revamp**
- **Multiple bug fixes**

---

## [1.7.0] - 2026-05-29

### Features & Documentation

- **Pre-built Android APK Update** — Updated the sidelined APK build release reference to `v2.1.0-beta` in the documentation.
- **Android App Gallery** — Added an extensive screenshots section highlighting the beautiful mobile interface layout, theme views, and active queue transfers.
- **Desktop Bump to v1.7.0** — Bumped desktop versions to v1.7.0 for the synchronized release.

---

## [1.6.9] - 2026-05-29

### Features & Enhancements

- **Android Compilation Fixes** — Cleaned build configuration files to prevent deepLinkProtocols syntax conflicts.
- **Mobile Shell & macOS Entitlements** — Configured custom shell integration capabilities and set up macOS entitlements plists.

---

## [1.6.8] - 2026-05-25

### Features & Fixes

- **In-App Update Permission Fix** — Granted the `"process:allow-restart"` capability permission in `src-tauri/capabilities/default.json` to allow the frontend updater to safely relaunch the app after installing an update.

---

## [1.6.7] - 2026-05-23

### Features & Fixes

- **Windows Build & Git Checkout Fix** — Untracked and ignored `app/.npm-cache` files from Git to fix "Filename too long" checkouts and build errors on Windows platforms.
- **Tauri signing key security** — Replaced updater signing key with a password-protected keypair and restored the secret password integration in the CI pipeline.

---

## [1.6.6] - 2026-05-22

### Features & Fixes

- **Tauri Updater Integration & Dedicated UI** — Fully integrated and resolved production updater configurations.
  - **Updater Build Artifacts**: Set `createUpdaterArtifacts` to `true` in `tauri.conf.json` to generate signing signatures (`.sig`) and the `latest.json` manifest dynamically during production builds.
  - **In-App Update Interface**: Added a native "Check for Updates" control panel within the General Settings tab, complete with a visual download progress bar, status toasts, and automatic "Update & Restart" integration.
  - **Promise Safety**: Handled fire-and-forget background update-check Promises by appending explicit `.catch` error logging to prevent unhandled rejection behaviors.
  - **Automated Workflow Releases**: Enhanced the GitHub Release CI workflow to automatically parse and extract only the latest release notes from `CHANGELOG.md` dynamically using `awk`.

---

## [1.6.5] - 2026-05-21

### Features & Enhancements

- **REST API Enhancements (Actix-web & Rust)** — Fully implemented the comprehensive REST API extension in Rust/Actix-web with backwards-compatible response structures.
  - **Refined Folder Navigation**: Resolved `folder_id` query handling into three deterministic query states: all files when omitted, root-only when `?folder_id=`, and subfolder files when filtering specifically by a folder ID.
  - **Standardized Pagination Envelope**: Wrapped collections in a clean payload format featuring a `data` array, `pagination` metrics (`page`, `limit`, `total_items`, `total_pages`), and a `filters` echo block.
  - **Advanced Query Parameters**: Introduced server-side sorting (`sort_by`, `sort_order`) and robust filters for MIME type, file size bounds, and creation date ranges.
  - **Sparse Fieldsets**: Added a `?fields=` selector enabling clients to request specific metadata subsets to reduce bandwidth overhead.
  - **Bulk Operations & Global Search**: Added `POST /api/v1/files/bulk` for batch moves and deletes, and `GET /api/v1/files/search` supporting the full pagination envelope.
  - **Rate Limiting Integration**: Injected simulated API rate-limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) to standard responses.

---

## [1.6.0] - 2026-05-21

### Features & Fixes

- **"Copy Telegram Link" Feature** — Added a right-click context menu option to copy raw `t.me` message links for files in public channels (`https://t.me/{username}/{message_id}`). If the channel is private, the item displays in a disabled state with a descriptive tooltip.
- **Tauri 2 Tokio Runtime Panic Fix** — Fixed the `there is no reactor running` panic caused by `tokio::task::spawn_blocking` executing outside of a Tokio runtime context within the Bandwidth Manager. Replaced the asynchronous task with a lightweight, synchronous write, resolving the panic completely.

---

## [1.5.0] - 2026-05-19

### Feature

- **VPN Optimizer & Proxy Configuration** — Added robust support for toggling VPN mode to optimize network connection timeouts, retry limits, backoff delays, adaptive polling, flood wait handling, and peer caches. Fully integrated proxy configuration (SOCKS5 and MTProto) to allow custom routing and bypass geo-blocks.

---

## [1.4.2] - 2026-05-18

### Feature

- **Folder Upload with Automatic Zipping** — Support uploading entire folders directly, automatically compressing them into highly-optimized zip archives before transfer.

---

## [1.1.7] - 2026-05-01

### Feature

- Added a donation button and popup modal to the main login screen to support the project via PayPal, Litecoin, and Bitcoin.

---

## [1.1.6] - 2026-04-28

### Fix

- Fixed process not terminating on Ctrl+C (SIGINT) when launched from a terminal.
  The Actix-web streaming server and grammers network runner were running on
  non-daemon threads with no shutdown signal wired to process exit, causing the
  application to hang indefinitely after the main window closed. The app now
  registers a RunEvent::Exit handler that gracefully stops both background
  services before the process exits.

---

## [1.1.5] - 2026-04-27

### Hotfix

- **CI fix: AppImage patch step now runs cleanly** — Replaced the fragile `grep -oP` Perl lookahead (which exited with code 2 under `set -euo pipefail`) with a safe `awk`-based `.desktop` file lookup. Added `APPIMAGE_EXTRACT_AND_RUN=1` so `appimagetool` doesn't require the FUSE kernel module on GitHub Actions runners.

---

## [1.1.4] - 2026-04-27

### Hotfix

- **Deeper AppImage EGL fix for Arch/rolling-release Linux** — Added a CI post-build patching step that strips the Ubuntu-bundled `libEGL`, `libGL`, `libGLdispatch`, `libGLX`, and `libGLESv2` from the AppImage squashfs and replaces the `AppRun` wrapper with one that: normalises the locale to `C.UTF-8`, sets `NO_AT_BRIDGE=1` to silence ATK warnings, auto-detects `EGL_PLATFORM` from `$WAYLAND_DISPLAY`/`$DISPLAY`, points GLVND at the system ICD vendor dirs, preloads the system `libEGL.so.1`, and orders `LD_LIBRARY_PATH` so host GPU drivers are always resolved before bundled stubs.

---

## [1.1.3] - 2026-04-27

### Hotfix

- **Fixed Arch Linux AppImage crash** — Resolved `EGL_BAD_ALLOC` error on Arch Linux (and other rolling-release distros) caused by bundled Mesa/EGL libraries conflicting with the host GPU driver stack. The app now automatically disables WebKitGTK's DMA-BUF renderer on Linux before the WebView initializes, with no impact to Windows or macOS builds.

---

## [1.0.4] - 2026-02-13

### Fixes

- Finally squashed the grid overlap bug for real. Cards were using CSS `aspect-[4/3]` to size themselves, but the virtualizer was computing row heights separately — at certain window widths these disagreed and rows would bleed into each other. Now both use the same explicit pixel height, so no more overlap regardless of how you resize the window.

### Cleanup

- Went through the whole codebase and ripped out every `console.log` / `console.error` we'd left in from debugging (16 of them). The one in `ErrorBoundary` stays since that's the whole point of an error boundary.
- Got rid of all `as any` casts on the frontend — everything's properly typed now.
- Ran Clippy and fixed all 7 warnings, including a couple of `collapsible_match` ones in `fs.rs` that needed manual refactoring.
- Dropped `clsx`, `tailwind-merge`, and `@tauri-apps/plugin-opener` from `package.json` — none of them were actually imported anywhere.
- General comment cleanup throughout.

---

## [1.0.3] - 2026-02-09

### Bug Fixes

- **Grid Spacing Fix** - Fixed cards overlapping in grid view
- **Dynamic Row Height** - Grid now properly calculates row height based on window size
- **Virtualizer Re-measurement** - Grid correctly updates when resizing window

---

## [1.0.2] - 2026-02-07

### Automated Release Pipeline

- **GitHub Actions Workflow** - Automatic builds triggered on version tags
- **Cross-Platform Builds** - Windows, Linux, macOS (Intel + ARM) built in parallel
- **Signed Updates** - All builds signed with Ed25519 for secure auto-updates
- **Automatic Publishing** - Releases published to GitHub automatically

---

## [1.0.1] - 2026-02-07

### Auto-Update System

- **Automatic Update Checks** - App checks for updates 5 seconds after startup
- **Update Banner** - Beautiful animated banner when new version available
- **One-Click Updates** - Download and install updates with progress indicator
- **Cross-Platform** - Windows, Mac, and Linux users get platform-specific updates

### 🔧 Technical

- Added Tauri updater plugin with Ed25519 signing
- Created `useUpdateCheck` hook for update lifecycle management
- Added `UpdateBanner` component with download progress

---

## [1.0.0] - 2026-02-06 🎉

### First Stable Release

Telegram Drive is now production-ready! This release focuses on performance, reliability, and user experience polish.

### ✨ New Features

- **Virtual Scrolling** - Smooth performance with folders containing 1000+ files
- **Inline Thumbnails** - Image files now display thumbnails directly in the file grid
- **Thumbnail Caching** - Thumbnails are cached locally for instant loading on revisit
- **API Setup Help Guide** - Step-by-step modal explaining how to get Telegram API credentials

### 🚀 Performance Improvements

- Grid and list views now only render visible items (virtualized)
- Responsive column layout adapts to window width
- Lazy loading of thumbnails to reduce initial load time

### 🎨 UI/UX Improvements

- Refined grid spacing (6px gaps between cards)
- Gradient overlay on thumbnail cards for text readability
- Improved light mode support across all components

### 🔧 Technical

- Added `@tanstack/react-virtual` for virtualization
- Separate thumbnail cache directory (`app_data_dir/thumbnails/`)
- FileTypeIcon now supports multiple sizes

---

## [0.6.0] - 2026-02-05

### Reliability Update

- Session persistence (window state, UI state, active folder)
- Network resilience with connection status indicator
- Queue persistence for uploads/downloads
- Light mode UI fixes

---

## [0.5.0] - 2026-02-04

### Drag & Drop Update

- Stable hybrid drag-drop system
- External drop blocker
- GitHub Actions workflow fixes

---

## [0.4.0] - 2026-02-01

### Media & Performance

- Audio/Video streaming player
- Global search filter
- Internal drag & drop between folders
