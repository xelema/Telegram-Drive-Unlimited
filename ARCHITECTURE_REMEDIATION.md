# Architecture Remediation and Release Handoff

Recorded: 2026-08-22

## Outcome

The stability, security, platform, application-architecture, and supporter-service findings from the architecture review have been remediated without changing stored database formats, encrypted-file formats, settings schemas, supporter token format, or user-facing feature availability.

The implementation preserves the five pre-existing mobile files recorded in `PHASE_0_BASELINE.md`. Their SHA-256 fingerprints remained unchanged through the final validation run.

## Finding closure

| Review finding | Implemented disposition | Regression guard |
| --- | --- | --- |
| Android JNI methods removed by R8 | Reproducible Android overrides retain JNI-reflected methods and apply class-wide R8 rules. The generated release seeds are checked after minification. | `app/scripts/check-android-jni-contract.cjs`; `.github/workflows/android.yml` |
| Android streaming used a nested Actix runtime | The streaming server runs directly on Tauri's Tokio runtime on every target, including Android, and retains graceful shutdown state. | `server::streaming_runtime_tests`; Android release build |
| Production CSP permitted inline scripts | The production WebView policy rejects inline/evaluated scripts and uses an external module entrypoint. Inline styles remain narrowly allowed because the existing React interface generates style attributes; executable document surfaces remain denied. | `app/tests/unit/cspConfiguration.test.ts` |
| Synchronous SQLite blocked async executors | Runtime database access crosses the centralized `db::with_connection` blocking boundary; static and concurrency tests reject direct connection locking and lost updates. | `db::async_boundary_tests` |
| Wayland required manual environment variables | Linux startup detects Wayland before WebView initialization while preserving explicit user overrides and X11 behavior. | `linux_startup::tests` |
| VPN keep-alive used one fixed datacenter IP | The keep-alive probe resolves `api.telegram.org` through DNS for every probe. Explicit datacenter IPs remain only in the separate multi-DC connectivity diagnostic, where they are the endpoints being tested rather than a keep-alive dependency. | `network_keepalive::tests` |
| Mobile capability could affect desktop | The mobile capability declares `platforms: ["android"]`; desktop builds retain only applicable permissions. | `app/tests/unit/platformConfiguration.test.ts` and desktop CI matrix |
| QueryClient lifetime was module-global | `AppProviders` owns one lazily created QueryClient per mounted application tree. | `app/tests/unit/AppProviders.test.tsx` |
| Provider nesting obscured ownership | The provider graph is centralized in `AppProviders` with tested dependency order. | `app/tests/unit/AppProviders.test.tsx` |
| Vault auto-lock polled every 15 seconds | An event-driven deadline supervisor sleeps until the active deadline and is rescheduled by throttled visible user activity. | `crypto::state::tests`; `app/tests/unit/useVaultActivity.test.tsx` |
| Local-server restart slept before rebinding | REST and WebDAV lifecycles await graceful shutdown, use generation ownership, and retry only `AddrInUse` with bounded backoff. | `server_lifecycle::tests` |
| PayPal webhook authenticity | Required PayPal headers, algorithm, timestamp shape, signature encoding, webhook ID, and official certificate hosts are validated before PayPal's authenticated verification postback and before any D1 mutation. The exact raw event text is preserved in the postback; invalid signatures return 401 while temporary verification failures return 503 for retry. Event IDs remain deduplicated and failed processing releases the event for redelivery. | `supporter-service/src/paypal.test.ts`; `supporter-service/src/index.test.ts` |
| D1 lacked independent restore-ready backups | A scheduled workflow exports native D1 SQL, compresses it, writes a SHA-256 sidecar, uploads both to private R2, and verifies the remote object size. | `.github/workflows/supporter-backup.yml`; `SUPPORTER_BACKUP_RECOVERY.md` |
| Offline supporter entitlement handling | The Worker and Rust client verify Ed25519 signatures, fixed token headers, issuer/audience, device binding, and ordered validity dates. Cached access remains active through the configured offline-grace boundary and refresh writes replace state safely on Windows. | Worker crypto tests; `commands::supporter::tests` |

## Automated release gates

A version tag no longer creates a draft release immediately. The release workflow now requires:

1. Frontend unit and architecture-invariant tests.
2. Locale structure and generated-key validation.
3. Android JNI source-contract validation.
4. Production frontend compilation.
5. The complete Rust library test suite.
6. Supporter Worker type-checks, tests, and production bundle dry-run.
7. A reusable universal Android release build with R8 seed, four-ABI, and 16 KB alignment verification.

Only after those gates pass may the draft release and desktop build matrix begin. Normal pull-request desktop CI also runs the frontend tests on Windows, Linux, and macOS before compiling the application.

## Final local evidence

The Phase 10 local validation run completed with:

- 24 frontend test files and 78 tests passing.
- 108 Rust library tests and 8 desktop integration tests passing.
- 36 supporter-service tests passing with TypeScript and Wrangler dry-run checks.
- Six Playwright visual-regression scenarios passing.
- Production frontend compilation and locale/JNI contract checks passing.
- An aarch64 Android release APK and AAB compiling successfully with the shared entitlement changes.

The four-ABI Android artifact gate is enforced in GitHub Actions. The local Phase 10 command intentionally selected only aarch64, so it was not used as evidence for the four-ABI gate.

## Required deployment and device checks

The following steps require repository secrets, external accounts, or physical platforms and therefore cannot be completed by a source-only local run:

1. Configure the R2 backup secrets, manually run `Supporter D1 Backup`, and complete the first restore drill described in `SUPPORTER_BACKUP_RECOVERY.md`.
2. Complete PayPal sandbox checkout, return, recovery activation, refresh, refund/reversal, and post-revocation denial against the deployed Worker.
3. Confirm Android cold start, secure supporter-secret persistence, background/resume, media playback, and offline-grace behavior on a physical supported device.
4. Confirm Wayland startup on a Linux Wayland session and REST/WebDAV restart behavior on native Windows, Linux, and macOS hosts.
5. Review and publish only after the tag-triggered release preflight, universal Android job, and desktop build matrix all pass.

If any deployment or device check fails, keep the GitHub release in draft state and preserve the previous production Worker, D1 binding, and signed application artifacts until the failure is understood.
