# Architecture Remediation — Phase 0 Baseline

Recorded: 2026-08-22 (America/Los_Angeles)

## Purpose

This document freezes the starting conditions for the architecture remediation work. It records the implementation branch, preserves the pre-existing working-tree changes, establishes the current automated validation baseline, and defines the cross-platform acceptance matrix that subsequent phases must satisfy.

Phase 0 changes no application or service source code.

## Source-control baseline

- Implementation branch: `codex/architecture-remediation`
- Base branch: `main`
- Base commit: `40308fc01930699e21c7f2b7aad77245d3b31791`
- Repository version at baseline: `3.0.0`
- Baseline working tree: intentionally dirty before the branch was created
- Preservation rule: do not reset, clean, overwrite, or accidentally absorb the files below into unrelated remediation work

### Pre-existing working-tree changes

| State | File | Phase 0 SHA-256 |
| --- | --- | --- |
| Modified | `app/src/components/mobile/MobileDashboard.tsx` | `8c583dff8dcef76fb1fcf839e4b7eb0ea6be4e66345068c06cf397aefd283082` |
| Untracked | `app/src/components/mobile/MobileMediaPlayer.tsx` | `d327449286f7d83ff082ecf7f6f9cbbe772b0f52135f645f522bb28fa7cceb8e` |
| Untracked | `app/src/components/mobile/MobileSupporterCard.tsx` | `d1e4969bf9b7c4c8daa5ff3e7b5ccedb837bc186f60f44874083ec04de4326a6` |
| Untracked | `app/tests/unit/MobileMediaPlayer.test.tsx` | `980d00b035527ac1fbd35df080c781eb77ad552b5fcf061966fdfcc5b88d63bf` |
| Untracked | `app/tests/unit/MobileSupporterCard.test.tsx` | `16808f846c91a0e5368484e6ae2e2d36754a5f8d8e513213bd2cbbb976fbf947` |

At baseline, the tracked dashboard change contains 182 insertions and 32 deletions. Untracked files are not represented by `git diff --stat`, so the hashes above are the authoritative Phase 0 fingerprints for all five files.

## Reproducibility environment

| Tool | Version |
| --- | --- |
| Node.js | `v24.2.0` |
| npm | `11.4.2` |
| rustc | `1.92.0 (ded5c06cf 2025-12-08)` |
| Cargo | `1.92.0 (344c4567c 2025-10-21)` |

These versions describe the successful baseline run; they do not replace the repository's declared version constraints or lockfiles.

## Automated validation baseline

All required Phase 0 commands passed against the dirty working tree on `codex/architecture-remediation`.

| Area | Command and working directory | Result | Baseline evidence |
| --- | --- | --- | --- |
| Frontend production build | `cd app && npm run build` | PASS | TypeScript and Vite completed; 2,357 modules transformed |
| Frontend unit tests | `cd app && npm test` | PASS | 19 files; 66 tests passed; 0 failed |
| Localization checks | `cd app && npm run i18n:check` | PASS WITH KNOWN DEBT | 554 typed keys generated; locale structure, variables, and types passed |
| Rust library tests | `cd app/src-tauri && cargo test --lib` | PASS | 88 tests passed; 0 failed |
| Supporter Worker type-check | `cd supporter-service && npm run check` | PASS | TypeScript completed with no errors |
| Supporter Worker tests | `cd supporter-service && npm test` | PASS | 2 files; 16 tests passed; 0 failed |

### Known non-blocking baseline warnings

- The localization validator reports 16 copied-English-debt warnings. These are tracked baseline warnings, not structural/type failures.
- The UI literal scanner reports 546 findings in 46 shipping-component files and explicitly assigns extraction to Phase 3.
- The production build warns that the Tauri dialog plugin is both statically and dynamically imported, so the dynamic import does not create a separate chunk.
- The production build reports minified chunks above 500 kB. The largest reported JavaScript outputs are approximately 1.30 MB for the main index chunk and 1.12 MB for the desktop dashboard chunk.

Later phases must not increase warning debt without an explicit, reviewed reason. A phase that targets one of these warnings should reduce it and update this record or its successor evidence.

## Required acceptance layers

Every remediation phase must be verified at the narrowest relevant layer and must finish with the complete automated baseline above. Platform validation is additive: passing browser or unit tests does not establish native desktop or Android compatibility.

1. **Static and unit layer:** TypeScript build, frontend tests, localization check, Rust library tests, Worker type-check, and Worker tests.
2. **Browser layer:** desktop-width Chromium smoke coverage and existing Playwright visual coverage for UI changes.
3. **Native desktop layer:** packaged or development Tauri application on Windows, macOS, Linux/X11, and Linux/Wayland.
4. **Android layer:** debug build/device coverage followed by a clean minified release build and release smoke test.
5. **Data-safety layer:** for storage, database, encryption, sharing, sync, or migration changes, test with a disposable copy of realistic existing user state and verify rollback/recovery behavior.

## Platform acceptance matrix

Status `DEFINED — NOT YET EXECUTED` means Phase 0 has established the gate, but has not certified that platform. Each applicable row must be executed after implementation and before the remediation is declared release-ready.

| Target | Required build/runtime gate | Required smoke coverage | Evidence to retain | Phase 0 status |
| --- | --- | --- | --- | --- |
| Desktop browsers | Production frontend build plus `npm run visual:test` in `app` | Authentication shell; dashboard load; folder navigation; upload/download controls; preview/media open-close; settings; responsive desktop/mobile breakpoints; keyboard and basic accessibility interactions | Command log, Playwright report, and changed snapshots reviewed for intentional differences | DEFINED — NOT YET EXECUTED |
| macOS native | Tauri development run and signed/release-equivalent package build on a supported macOS runner | Fresh launch and upgrade launch; Telegram authentication; file list/navigation; upload/download/cancel/retry; preview/media; drag/drop; native dialogs; deep links; updater path where testable; settings persistence; clean quit/relaunch | OS/architecture, package identity, logs, screenshots for changed UI, and smoke checklist | DEFINED — NOT YET EXECUTED |
| Windows native | Tauri development run and release-equivalent installer/package build on a supported Windows runner | Same native core flow plus Windows path/name rules, WebView behavior, installer upgrade, file dialogs, drag/drop, firewall/local-service messaging, and long/non-ASCII paths | OS/architecture, installer type, logs, screenshots for changed UI, and smoke checklist | DEFINED — NOT YET EXECUTED |
| Linux/X11 native | Tauri development run and release-equivalent package build in an X11 session | Native core flow plus file dialogs, drag/drop, tray/window lifecycle if applicable, media playback, local service reachability, and desktop integration | Distribution/version, architecture, display server, package type, logs, and smoke checklist | DEFINED — NOT YET EXECUTED |
| Linux/Wayland native | Tauri development run and release-equivalent package build in a Wayland session | Native core flow plus portal-backed dialogs, drag/drop, clipboard, scaling, window/fullscreen behavior, media playback, and local service reachability | Distribution/version, compositor, architecture, package type, logs, and smoke checklist | DEFINED — NOT YET EXECUTED |
| Android debug | `npm run tauri android dev` or the repository-supported equivalent on an emulator and at least one physical-device class when available | Cold start; QR/phone authentication path as supported; mobile dashboard; touch navigation; upload/download; preview/media; supporter UI; rotation/resume/background; permission denial/retry; offline/reconnect | Device/API level, ABI, debug build log, relevant Logcat output, and smoke checklist | DEFINED — NOT YET EXECUTED |
| Android minified release | Clean `npm run tauri android build` release pipeline (or repository-supported equivalent) with minification/resource shrinking enabled and release signing supplied by CI/release environment | Install/upgrade the release artifact; repeat critical debug flows; verify reflection/JNI/serialization paths; confirm no release-only crashes or missing classes; relaunch after process death | Commit, Gradle variant, minifier mapping/usage artifacts, APK/AAB checksum, device/API level, and release smoke checklist | DEFINED — NOT YET EXECUTED |

## Cross-platform critical-flow checklist

Use this checklist for every applicable platform row. A feature may be marked not applicable only with a reason in the retained evidence.

- Existing-user upgrade starts without destructive migration or silent data loss.
- Fresh authentication and restored authentication both reach the expected dashboard.
- Saved Messages and folder/channel navigation preserve selection and refresh behavior.
- Upload, download, progress, cancellation, retry, and Telegram cooldown behavior remain functional.
- File preview and supported media playback open, navigate, recover from errors, and close cleanly.
- Rename, move, share, delete, search, and multi-select behavior remain intact where exposed.
- Encryption/vault lock, unlock, protected-file failure behavior, and recovery workflows fail closed and preserve existing content.
- Sync, WebDAV, REST/local access, deep-link, and supporter/license flows retain their prior defaults and authorization boundaries.
- Settings and locale choices persist after quit/relaunch; untranslated or clipped UI introduced by the phase is rejected.
- Offline, timeout, permission-denied, malformed-input, and unavailable-service paths provide a recoverable result without crashing.
- Keyboard, touch, focus, screen-reader labels, scaling, and narrow/wide layout behavior are checked where the platform supports them.
- Logs and crash reports contain no credentials, Telegram content, file content, recovery material, or unnecessary personal identifiers.

## Regression and change-control rules

- Keep each later phase independently reviewable; do not mix unrelated refactors with behavior fixes.
- Add or update tests before changing high-risk boundaries such as migrations, encryption envelopes, sync deletion planning, local servers, payments, and platform bridges.
- Preserve backward compatibility for stored settings, databases, encrypted files, deep links, share links, recovery codes, and existing supporter entitlements unless a versioned migration is explicitly designed and tested.
- Never validate destructive migration or sync scenarios against the only copy of user data.
- Re-run the complete automated baseline after resolving phase-specific failures; do not waive a failure because an unrelated command passes.
- Compare the five pre-existing-file fingerprints before any operation that could replace or discard working-tree content. Expected edits to those files must be deliberate and separately attributable.
- Record platform, artifact, commit, and observed result for manual checks. “Works locally” without that context is not release evidence.

## Phase 0 exit record

- [x] Isolated implementation branch created from the current commit.
- [x] Existing modified and untracked files recorded and fingerprinted.
- [x] Existing working tree preserved without reset or clean.
- [x] Frontend production build passed.
- [x] Frontend unit suite passed.
- [x] Localization validation/scanning passed with known debt recorded.
- [x] Rust library suite passed.
- [x] Supporter Worker type-check and unit suite passed.
- [x] Required desktop browser, native desktop, and Android acceptance targets defined.
- [x] No application or service source code changed by Phase 0.
