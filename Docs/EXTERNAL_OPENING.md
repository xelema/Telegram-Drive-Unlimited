# External opening inventory and acceptance

Caller inventory reviewed before restrictions (2026-10-02):

| Boundary | Callers and produced destinations |
|---|---|
| Shell `open` | `AuthWizard` (Telegram API setup, existing Trust Wallet LTC/BTC links, auth gateway); `HelpCenterDialog` (GitHub issues); `SettingsTabs` (author site/repository); `SupporterSettingsSection` (PayPal approval, terms, help); `FfmpegInstallNotice` (FFmpeg download); `services/sponsorLinks.ts` (existing campaign) |
| Opener `openUrl` | `MobileSupporterCard` (PayPal, terms, help); `MobileDashboard` (privacy/author/repository); `useUpdateCheck` (release page) |
| Opener `revealItemInDir` | `useFileDownload` (newly saved files and durable queued-job paths) |
| Native `cmd_open_file_externally` | `DesktopDashboard` (offline/downloaded asset); `PdfViewer` (app preview or provided offline file); `MobileMediaPlayer` (existing Android JNI path) |

Desktop shell URLs permit only HTTP, HTTPS and mailto. Opener URL scopes use the same schemes, and reveal-in-directory remains permitted; generic opener open-path is not granted. Sponsor destination validation and its `window.open(..., 'noopener,noreferrer')` fallback are untouched. The Android native file-opening branch is untouched.

Desktop native opening requires a successfully produced, account-scoped regular file. Downloads are registered after publication. Exact recorded cache and ready offline paths retain their private-directory, removal and protection checks on every external open, including files registered earlier. Arbitrary files, substituted symlinks, protected cache records and other accounts remain refused. Historical workspace and flat desktop cache filenames remain supported. A missing previously migrated registration cannot be recreated silently. User-chosen download folders remain eligible for new app-produced downloads, but cannot be adopted through legacy cache migration.

Registration computes SHA-256 and records identity from the actual open handle. External opening can reuse that digest when every identity field and its account/cache context matches. A changed identity runs a full hash: different content is refused; identical content refreshes the identity for subsequent opens. Registration, identities, proofs and invalidation epochs use the existing per-account key/value store without a schema migration. A normal restart preserves reuse. Old registrations missing identity fields pay one full verification before becoming eligible.

The verified handle remains alive through the final identity/protection/account check and OS dispatch. The OS opener accepts a path, so replacement after the final check and before the OS opens that path remains an unavoidable race. Hashing uses at most two blocking workers and 64 KiB buffers. No Telegram request, new dependency, UI string or budget increase is added.

## Accepted metadata trade-off

The owner approved verified-digest reuse on 2026-10-03. Matching metadata is not proof of current contents. POSIX identity uses device, inode, size, modification time and status-change time with nanosecond fields. An unprivileged POSIX process cannot set status-change time directly. Windows uses the handle's volume serial and 128-bit file ID where available (64-bit file-index fallback), plus size and `FILE_BASIC_INFO` LastWriteTime/ChangeTime at their 100 ns precision. A same-user Windows process with write access may set ChangeTime; this is a weaker protection accepted by the owner. File-ID reuse, metadata rollback or a privileged attacker can also defeat metadata-based inference. [POSIX stat fields](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/sys_stat.h.html), [Windows basic information](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info).

Missing or zero identity fields always fall back to full hashing. Filesystem eligibility is conservative: APFS on macOS; NTFS/ReFS after successful handle-based volume queries on Windows. Unknown filesystems, FAT/exFAT, HFS/HFS+ and all Linux mounts retain full hashing. HFS catalog timestamps have second precision, and Linux nanosecond fields can still carry coarse per-jiffy values unless kernel/filesystem multigrain timestamp support is qualified. Failed Windows volume queries, including unsupported SMB volume management, retain full hashing. These are code paths, not claims of machine acceptance. Only this Mac's APFS path has been executed. [Apple HFS dates](https://developer.apple.com/library/archive/technotes/tn/tn1150.html), [Windows volume query](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew), [Linux timestamp semantics](https://docs.kernel.org/filesystems/multigrain-ts.html).

Account sign-out/switch and Clear cache persist an account epoch change before cache deletion. Pinned survivors therefore require a fresh hash. A failed epoch write disables reuse for the process; logout continues its secure cleanup. A session-file identity also fences replaced logins. Cache proofs reject removal/protection changes at verification and handoff. Changed files never receive an updated identity until their hash matches the original digest and a transaction rechecks the registration and epoch.

HEIC source validation and internal cache reuse continue to hash fully. Cache LRU timestamp updates invalidate external reuse rather than blessing a new tuple. Consequently a UI flow that prepares or touches a cache before external opening may still read the full contents during preparation and again during opening. Direct repeated opening avoids those reads when identity is unchanged. Unsupported filesystems retain the original full-read costs.

Local native journeys use an opening sink instead of launching another OS application. Browser journeys prove sponsor, terms, fixture PayPal approval and donation links reach the permitted opener; they do not exercise OS browser dispatch or real payment. Installed Tauri/OS checks remain UNRUN: open a plain PDF preview, an offline file and a completed download; reveal the download in Finder/Explorer; verify sponsor/terms/approval links open. Arbitrary files and substituted symlinks must be refused. Record results in [release acceptance](RELEASE_ACCEPTANCE.md).

Final file-capability regressions replace a file after successful hashing and before lease return, through separate native processes and real filesystem replacement. Opening and cache timestamp renewal retain the exact authenticated identity; neither can authorize a replacement by capturing a later identity. The controlled sink does not launch an OS application.

The opt-in measurement on this Mac wrote and synced 2,000,000,000 synthetic bytes, then opened a recorded ready offline copy through the native driver. With no other verification gate running, the debug driver took 213.8 seconds for first registration/opening (4 GB hashed) and 108.8 seconds for the subsequent open (2 GB hashed). This is warm local-storage and debug-code evidence, not release-build, cold-disk or installed-OS dispatch performance. No rehash was skipped. The measurement fixture was removed. Migration performs no Telegram requests: workspace caches scan account metadata one row at a time; an offline copy reads its pack record. Hash buffers remain 64 KiB with at most two workers; registration adds two small per-file records in the existing account database.


## Release-build baseline before reuse

On macOS 15.7.9 (24G830), the x86_64-apple-darwin driver built with Rust 1.92.0 and `cargo build --release --locked --features native-e2e --bin native-e2e-driver -j 4` completed under the optimized release profile confirmed by the build output. Binary SHA-256: `d86cc4288a30b280a0a2a36d44c186ede2ccbe02cf8b197c77759d6b864ff220`. These are separate single-run warm measurements, not installed application/OS dispatch benchmarks. No other verification gate ran during timed opening. The native-e2e build includes hash-byte instrumentation and a controlled opening sink.

| Allocated synthetic bytes | First legacy open seconds | Reuse seconds | First/reuse hashed bytes |
| ---: | ---: | ---: | ---: |
| 2,000,000,000 | 16.223549 | 7.858260 | 4,000,000,000 / 2,000,000,000 |
| 200,000,000 | 1.579457 | 0.789655 | 400,000,000 / 200,000,000 |

The synthetic file writes, fixture record/hard-link setup and driver startup precede timing. Fixture seeding does not hash contents. First opening includes migration registration and validation; reuse retains a complete hash. Hash-byte assertions pass for both files. The private fixtures were removed after a clean driver exit. No Telegram request or real OS application launch occurs.

Cold-cache values are UNMEASURED. No purge was performed: this host offers a system-wide purge utility, but no verified, file-scoped purge was used. Synced writes or restarting the driver are not treated as cold. Release/cold behavior on other hardware, Windows/Linux and installed OS dispatch remain unmeasured.

## Release-build measurements after reuse

The optimized release driver was built on macOS 15.7.9 (24G830), x86_64, Rust/Cargo 1.92.0 with `cargo build --release --locked --features native-e2e --bin native-e2e-driver -j 4`. The build log confirms `release` profile `[optimized]`, completing in 5m 41s on the final rebuild. Binary SHA-256: `03f73fea503ececb3b9cb7908ab2df1e89d9772c775a6d77fcee4e4f447da811`. No verification gate from this pass ran during timing; unrelated host activity was not controlled. These are single-run warm allocated synthetic files with startup, writes/fsync and fixture seeding before timing. No cache purge or real OS application launch occurred. Private fixtures were removed after a clean driver exit.

| Bytes | Before first/reuse seconds | After first/reuse seconds | After first/reuse hashed bytes |
| ---: | ---: | ---: | ---: |
| 2,000,000,000 | 16.223549 / 7.858260 | 10.999386 / 0.005315 | 2,000,000,000 / 0 |
| 200,000,000 | 1.579457 / 0.789655 | 0.969191 / 0.006127 | 200,000,000 / 0 |

The baseline first opens read twice; new first legacy opens read once on APFS, and unchanged repeated opens read zero content bytes. Hash-byte assertions passed for both sizes. Cold-cache, installed OS dispatch and Windows/Linux timing remain unmeasured. Linux always hashes, and unsupported metadata/filesystems retain full reads. Internal cache/HEIC preparation also retains strict hashing; LRU touches cause the next external open to hash again.
