# Encryption Remediation Execution Report

Date: 2026-07-26  
Application: Telegram Drive 1.9.9  
Envelope: TDENC2 / format version 2

## Release verdict

The safe encrypted-transfer core is implemented and enabled as an opt-in alpha feature. Standard/plaintext transfers remain the default and retain their existing behavior.

This implementation is suitable for controlled developer and test-account use. It must not be marketed as independently audited or generally available until the platform test matrix, logical-media integrations, recovery drills, and independent security review in the remediation plan are complete.

## Available now

- User-selectable Standard, Vault, File Passphrase, and Vault + File Passphrase upload modes.
- Streaming TDENC2 encryption to Telegram without creating a full ciphertext copy on disk.
- Streaming authenticated decryption to an owner-only partial file followed by atomic publication.
- Authenticated filename and MIME metadata protection.
- Persistent passphrase-protected local vault.
- Vault lock, unlock, timeout auto-lock, background/sleep lock, logout lock, and exit lock.
- Authenticated recovery-bundle export and import.
- Vault passphrase change without rotating the vault key or re-encrypting all files.
- Short-lived, opaque, single-use passphrase prompt tokens; raw passphrases are not persisted in transfer queues.
- Queue pause/retry behavior when a vault or file passphrase is required.
- Encryption badges and protected-name behavior in desktop and mobile file lists.
- Android foreground-upload compatibility and verified MediaStore publication after decryption.
- Upload protection parity for manual selection, drag-and-drop, folder ZIPs, Android cached shares, retries, and remote URL uploads.
- Registry reconstruction by probing strict TDENC2 headers when an encrypted Telegram object is not locally indexed.
- Fail-closed detection for unindexed `.tdenc` / `TDENC2` objects in downloads, previews, thumbnails, local streaming, and REST media routes.
- Encryption settings and the key-loss disclaimer in all 13 production locale files.
- Default, light, dark, and custom theme systems remain intact.

## Security properties implemented

- Full 24-byte XChaCha20-Poly1305 nonces for wrapped file keys.
- Unique random file UUIDs, DEKs, nonce prefixes, operation handles, and prompt-token handles.
- Keyed header authentication and authenticated metadata, chunks, and terminal record.
- Strict bounds for algorithms, KDF cost, chunk size, slot count, metadata, header length, overflows, truncation, and trailing bytes.
- Exact ciphertext-length calculation, including Telegram's post-encryption size limit.
- Argon2id passphrase derivation with bounded accepted parameters.
- Bounded-memory sequential encryption and decryption.
- Wrong-key, mutation, truncation, and appended-data failures occur before unauthenticated plaintext is published.
- Owner-only permissions on decrypted partial files and Unix remote-upload temporary files.
- TDENC1 remains quarantined and is never reinterpreted as TDENC2.
- Registry changes occur after successful remote delete/move/copy operations, with explicit reconciliation errors where atomicity across Telegram and SQLite is impossible.

## Intentionally unavailable and fail-closed

These operations remain disabled only for encrypted objects. Their existing plaintext behavior is unchanged.

- In-app encrypted image, PDF, archive, audio, and video preview.
- Encrypted thumbnails, HLS/fMP4 playback, transcoding, and range streaming.
- Plaintext share links for encrypted files and encrypted share-package creation.
- REST/local-server plaintext exposure of encrypted objects.
- Encrypted remote rename; Telegram media is immutable and this needs an authenticated metadata strategy.
- Plaintext-to-encrypted migration, decrypt-in-place migration, key-slot rewrap UI, vault-key rotation, and full format migration.

The capability handshake reports sharing and migration as unavailable. These paths do not silently serve ciphertext as if it were plaintext.

## Verification completed

- `cargo check --message-format=short`: pass.
- `cargo test --lib -- --nocapture`: 23 passed, 0 failed.
- TDENC2 known-answer, boundary, length, range, mutation, truncation, trailing-byte, nonce, prompt-token, recovery, restart, wrong-passphrase, and passphrase-change tests: pass.
- `npm run build`: pass.
- `npm run i18n:check`: structure, variables, generated types, and scanner execution pass.
- `git diff --check`: pass.

The repository-wide `cargo fmt --check` still reports a large pre-existing formatting baseline across unrelated Rust files. No whole-repository formatting rewrite was performed because it would create an unsafe, noisy mechanical diff over the user's existing work.

## Known release blockers

1. Implement the mandatory logical plaintext source and migrate previews, thumbnails, PDF, media, archive, share, REST, and streaming consumers.
2. Add failure-injection integration tests against an isolated Telegram test account.
3. Run recovery drills on macOS, Windows, Linux, and Android.
4. Complete the broader language plan's manual RTL, long-string, CJK, accessibility, and legal-language review. The current i18n tooling also reports pre-existing copied-English and UI-literal warnings outside the encryption section.
5. Add fuzz/property targets and dependency/license review.
6. Commission an independent cryptographic design and code audit before general availability.
7. Rehearse the feature kill switch while proving existing encrypted read/export/recovery access remains available.

## Recommended rollout

Keep Standard as the default. Use the current build with isolated test Telegram data first, then move to an explicit opt-in beta only after remote transfer, cancellation, retry, registry-loss, and recovery drills pass. Do not claim general availability until the independent review and remaining consumer parity work are complete.

