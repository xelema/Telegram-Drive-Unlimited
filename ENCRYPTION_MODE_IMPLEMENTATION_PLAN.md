# Telegram Drive — Encryption Mode Implementation Plan

**Implementation target:** DeepSeek V4 Pro  
**Document type:** repository-specific engineering and security handoff  
**Scope:** plan only; this document does not authorize implementation  
**Status:** ready for architecture review  
**Prepared:** July 25, 2026  
**Proposed encrypted-format identifier:** `TDENC1`  

---

## 1. Executive decision

Add client-side, application-layer encryption before files are uploaded to Telegram and authenticated decryption after they are downloaded. Telegram Cloud Chats use client-to-server encryption, while Telegram documents end-to-end encryption separately for one-to-one Secret Chats. Telegram Drive stores files in cloud-chat/channel-style locations, so its encryption mode must protect file bytes before they enter the existing Telegram upload pipeline. It must not claim to convert a Telegram channel into a Telegram Secret Chat. See Telegram's [MTProto Cloud Chat description](https://core.telegram.org/mtproto) and [Secret Chat/file-encryption description](https://core.telegram.org/api/end-to-end).

The recommended product has three upload choices:

1. **Standard transfer** — the existing plaintext behavior, unchanged.
2. **Encrypted with vault** — a random key is generated for each file and wrapped by the user's unlocked vault key.
3. **Encrypted with a file key** — a random key is generated for the file and wrapped by a user-supplied passphrase, generated recovery key, or both. Adding an optional vault recovery slot must be an explicit choice.

The encryption default must remain **Off** for existing installations and upgrades. Enabling encryption changes only future uploads. Existing Telegram files are never rewritten, migrated, renamed, or deleted without a separate, explicit migration action.

The recommended technical design is a versioned, chunked, random-access authenticated-encryption envelope implemented entirely in Rust. It uses a random 256-bit data-encryption key (DEK) per file, XChaCha20-Poly1305 for authenticated encryption, Argon2id for passphrase-derived wrapping keys, HKDF-SHA-256 for domain-separated keys derived from high-entropy key material, and a narrow vault abstraction backed by Tauri Stronghold after a platform spike. Do not implement a cipher, MAC, KDF, random generator, or constant-time comparison manually.

This is a high-risk security feature. DeepSeek may implement it only in the phased order in this document. The encrypted format must not ship as generally available until the format, key lifecycle, threat model, parser, and test vectors have received an independent security review.

---

## 2. Non-negotiable requirements

1. **No regression for plaintext files.** With encryption disabled, upload, URL upload, folder ZIP upload, download, cancel, retry, queue persistence, rename, move, copy, delete, search, share, previews, thumbnails, archive inspection, original streaming, adaptive streaming, REST API behavior, Android foreground transfers, themes, localization, and ad/sponsor functionality must behave as they do before this project.
2. **Encryption happens before Telegram.** Telegram, Telegram CDN storage, channel members, and anyone possessing only the Telegram message must receive ciphertext, not plaintext.
3. **Authentication happens before release.** No downloaded chunk is exposed to a file, preview renderer, HTTP response, archive parser, or media process until its AEAD tag has been verified.
4. **Keys never enter ordinary settings.** Passphrases, raw keys, vault keys, DEKs, decrypted metadata, and key-export material must not be stored in `settings.json`, `uploadQueue`, `downloadQueue`, `api_settings.json`, SQLite plaintext columns, URLs, logs, captions, telemetry, notifications, or frontend local storage.
5. **One random DEK per file.** A password is never used directly to encrypt file content. It derives a key-encryption key (KEK), which wraps a random file DEK.
6. **Every file is independently recoverable.** Damage to or key loss for one file must not cryptographically corrupt other files.
7. **Fail closed.** Unsupported versions, excessive KDF parameters, malformed headers, missing final records, wrong keys, changed metadata, reordered chunks, truncated ciphertext, and invalid tags must return stable error codes and no plaintext output.
8. **Do not silently weaken security.** A low-memory device must not silently reduce KDF parameters, retain plaintext caches, publish an incomplete Android file, or fall back to unencrypted upload.
9. **Use explicit representations.** APIs and share routes must distinguish `plaintext` from `ciphertext`; they must never guess when the distinction could disclose data.
10. **Ads remain isolated and intact.** Do not alter `DesktopAdBanner`, `AdGateway`, `AdsterraBanner`, sponsor URLs, ad timing, dismissal, or click behavior as part of encryption work. Include them in the baseline regression suite because the shared app shell and local Actix server are touched.
11. **Maintain appearance support.** Light, dark, default, preset, and user-created themes are not in encryption scope and must continue to work in all new dialogs and states through semantic theme tokens.
12. **All new user-facing text is localized.** Add typed keys to every supported locale and test LTR, RTL, long strings, pluralization, key/error formatting, and screen-reader labels. Never put a passphrase or filename into a translator-controlled error template unnecessarily.

---

## 3. What “encrypted transfer” means

The intended data path is:

```text
local file / URL temp / folder ZIP
             |
             v
      Rust encryption adapter
  metadata + authenticated chunks
             |
             v
  existing grammers upload_stream
             |
             v
  Telegram stores only TDENC1 bytes
```

The inverse path is:

```text
Telegram TDENC1 bytes
          |
          v
Rust header parser + key resolver
          |
          v
authenticate requested ciphertext chunk
          |
          v
release plaintext to one approved sink:
download / preview / range stream / archive / transcode
```

The mode protects file contents and, in the recommended privacy setting, the original filename, MIME type, timestamps, and application metadata. It does not hide the Telegram account, destination channel, upload/download timing, approximate ciphertext size, the fact that an encrypted object exists, data visible after the user exports a decrypted copy, or activity on a compromised unlocked device.

### 3.1 Threats in scope

- Telegram or a Telegram-session observer reading stored file contents.
- A channel member obtaining the Telegram document without its key.
- A copied Telegram message or downloaded `.tdenc` object being opened without its key.
- Accidental ciphertext corruption, truncation, chunk substitution, reordering, or metadata modification.
- Theft of app data while the vault is locked, subject to the security of the vault passphrase and platform storage.
- Cross-file key compromise: disclosure of one file key must not reveal another file.
- Plaintext leakage through app-created previews, thumbnails, transcode outputs, archives, transfer queues, logs, and crashes.

### 3.2 Explicit non-goals

- Protection against malware, debuggers, memory inspection, screenshots, or keyloggers on an unlocked device.
- Anonymous usage or hiding Telegram traffic metadata.
- Retrofactive encryption of existing files merely because the setting is enabled.
- Recovery without a vault backup, recovery key, or valid file passphrase.
- A claim of formal verification, FIPS validation, or independent audit until those activities actually occur.
- Telegram Secret Chat compatibility.

---

## 4. Repository findings and integration boundaries

DeepSeek must read the named files before changing them. Do not infer the architecture from this plan alone.

| Boundary | Current implementation | Encryption consequence |
|---|---|---|
| Desktop/mobile upload queue | `app/src/hooks/useFileUpload.ts`; pending entries are persisted through Tauri Store | Add non-secret encryption intent/profile IDs only. A restarted custom-key upload becomes `waiting_for_unlock`; never persist the passphrase or an in-memory handle. |
| Telegram upload | `app/src-tauri/src/commands/fs.rs`; `cmd_upload_file_inner` wraps a file in `ProgressReader`, calls `upload_stream`, then sends a document | Insert an `EncryptingReader` before `upload_stream`. Grammers requires an exact length, so `TDENC1` must calculate ciphertext length from plaintext size before reading. Preserve progress, throttling, retry, flood-wait, cancellation, and cleanup. |
| URL upload | `cmd_upload_from_url` in `fs.rs` downloads/resumes to a temp file, then uploads | Keep URL resume behavior; encrypt the completed temp file on the Telegram leg. Clean it on every terminal path. |
| Folder upload | `useFileUpload.ts` and ZIP commands create a temporary ZIP | ZIP first, encrypt second, upload third. The one encrypted object represents the ZIP. |
| Download/export | `cmd_download_file` in `fs.rs` currently writes Telegram chunks directly to the destination/cache path | Write to an adjacent `.part` or private Android cache lease, authenticate/decrypt in Rust, flush/sync, atomically publish only after the final record verifies. Delete partial plaintext after cancel/failure. |
| File listing/search | `cmd_get_files`, `cmd_search_global`, `models::FileMetadata`, and `src/types.ts::TelegramFile` derive names/types from Telegram document/caption data | Add encryption state and logical metadata. Opaque remote names require a local encrypted header/index cache. Locked files must render predictable placeholders. Plain file results remain byte-for-byte compatible. |
| Preview/thumbnail | `commands/preview.rs` stores full previews and thumbnails in app cache | Do not store plaintext derivatives for encrypted files in these existing directories. Serve authenticated plaintext through a tokenized loopback route and encrypt any persistent derived cache. |
| Original byte-range streaming | `server.rs::build_media_response` maps HTTP ranges directly to Telegram ranges | Generalize this into a logical byte source. An encrypted source maps plaintext ranges to full ciphertext chunks, authenticates them, and slices only after verification. |
| Video metadata/streaming | `commands/video_metadata.rs`, `commands/streaming.rs`, `transcode.rs`, and `fmp4_remux.rs` assume Telegram bytes are media bytes | Route all reads through the logical byte source. Encrypt persistent originals, HLS segments, playlists, and remux outputs at rest or manage them as short-lived plaintext leases. |
| Archive inspection/extraction | `commands/archive.rs` downloads into memory or OS temp files; REST bulk archive also downloads raw bytes | Decrypt before parsing. Use bounded memory where possible. Any unavoidable RAR/7z/FFmpeg plaintext temp must use the lease manager, strict permissions, TTL, startup cleanup, and visible policy. |
| Sharing | `commands/sharing.rs` records link data in `shares.db`; `share_routes.rs` streams Telegram media through `build_media_response` | Add representation and encrypted-file policy. Ciphertext share is safe by default. Decrypted shares require explicit authorization and must never collect a key over untrusted plain HTTP. |
| REST upload/download | `api_routes.rs` writes multipart uploads to temp and streams downloads through `build_media_response` | Add encryption intent/profile and explicit representation. A locked vault returns HTTP 423. Never accept a key in a URL or loggable header. |
| SQLite | `db.rs` initializes `shares.db` with shares, groups, and folder metadata; no migration-version table | Add versioned, transactional migrations and new encryption tables. Keep old tables compatible. Never store raw secret values. |
| Settings | `SettingsContext.tsx` stores ordinary preferences in `settings.json` | Only non-secret preferences may be added: default mode, metadata privacy, auto-lock duration, strict-temp policy, and profile ID. |
| Android | upload/download commands copy `content://` files through private cache and publish via JNI MediaStore; upload foreground service is queue driven | Encrypt after private URI import. Decrypt to private cache, verify, then publish. Notifications must not reveal keys or private filenames. Background/restart behavior must wait for unlock rather than downgrade. |
| App lifecycle | `lib.rs` manages Tauri commands, the loopback server, REST server, state, and exit cleanup | Add `CryptoState`; lock and zeroize it on logout, exit, suspend/background, idle timeout, and explicit Lock. Cancel key-dependent work or leave it resumable as `waiting_for_unlock`. |

Current Rust dependencies include hashing and bcrypt but no file AEAD, password KDF for encryption, secret-memory wrapper, or secure vault plugin. Crypto must remain in Rust; React receives metadata, status, and opaque handles only.

---

## 5. Product model and user-visible modes

### 5.1 Global setting

Add an **Encryption & privacy** settings category with:

- `Default upload protection`: Standard / Encrypted with vault.
- `Protect filenames and metadata`: on by default when encryption is selected.
- `Auto-lock vault`: Immediately / 1 / 5 / 15 / 30 / 60 minutes / Never (with warning).
- `Lock when app enters background or system sleeps`: on by default.
- `Temporary plaintext policy`: Balanced / Strict.
- `Remember unlock on this device`: off by default; only offer after platform credential-storage support passes review.
- Vault status, last backup date, backup/export action, import/recovery action, Rotate vault wrapper, and Lock now.

These are ordinary preferences except the vault contents and secret-bearing recovery material. Resetting settings must not delete the vault or keys. Deleting a vault must require a separate destructive flow with consequences and confirmation.

### 5.2 Upload-time selection

Every upload entry point needs an effective mode:

- Standard.
- Vault encrypted.
- Custom file protection:
  - passphrase;
  - generated 256-bit recovery key/key file;
  - both;
  - optional “also allow my vault to unlock this file.”

Drag/drop, file picker, Android share intent, folder upload, URL upload, retry, and REST upload must resolve the same `UploadProtectionIntent`. Quick uploads use the configured default; the queue must expose an Edit protection action before work starts.

For multiple files, the dialog must clearly distinguish:

- one passphrase wrapping separate random DEKs for all selected files;
- a separate generated key per file;
- one vault profile wrapping separate random DEKs.

Never reuse one DEK across files.

### 5.3 Encrypted-file states

Add states to Rust and TypeScript models:

```text
plain
encrypted_unlocked
encrypted_locked
encrypted_key_missing
encrypted_unsupported_version
encrypted_corrupt
encrypted_verifying
```

File cards/list rows need a quiet lock badge, accessible label, and state-specific actions. Do not infer state solely from the filename extension; use the magic header where bytes are available and a non-authoritative remote marker only to avoid downloading every header during a locked listing.

### 5.4 Key terminology

Use these exact product concepts consistently:

- **Vault passphrase:** user-memorized secret that unlocks the local vault.
- **Vault key:** random application key protected by the vault; never shown by default.
- **File key / DEK:** random key that encrypts exactly one file.
- **Recovery key:** high-entropy exportable secret that can unwrap a file or vault backup.
- **Key profile:** non-secret reference to a configured protection method.
- **Share password:** protects access to a share page; it is not an encryption key.

---

## 6. Cryptographic architecture

### 6.1 Required primitives

Recommended initial suite:

| Purpose | Primitive | Rule |
|---|---|---|
| Content and encrypted metadata | XChaCha20-Poly1305 | 256-bit random per-file DEK; independent authenticated chunks. Use a maintained audited library such as RustCrypto's [`chacha20poly1305`](https://docs.rs/chacha20poly1305/latest/chacha20poly1305/), not custom cipher code. |
| Password-to-KEK | Argon2id v1.3 | Persist salt and parameters in the key slot. RFC 9106's constrained recommendation is 64 MiB, 3 iterations, 4 lanes, 128-bit salt and 256-bit output; benchmark desktop and mobile without silently falling below an approved floor. See [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html). |
| High-entropy key derivation | HKDF-SHA-256 | Domain-separate wrapping, metadata, search, cache, and export keys. See [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html). |
| Header/content commitments | SHA-256 | Already present; use only for non-secret commitments and final plaintext digest, never as password KDF. |
| Randomness | operating-system CSPRNG | Generate every DEK, file UUID, salt, nonce prefix, recovery key, and handle with OS randomness. No timestamps, message IDs, counters alone, `Math.random`, or Telegram-provided entropy. |
| Secret lifetime | zeroizing secret types | Use `zeroize`/`secrecy`-style wrappers, avoid `Clone`, avoid `Debug`, allocate correct capacity, and zeroize on drop. RustCrypto documents the limits and guarantees of [`zeroize`](https://docs.rs/zeroize/latest/zeroize/). |
| Vault persistence | `CryptoVault` trait; Stronghold candidate | Keep the implementation behind a Rust trait. Tauri's [Stronghold plugin](https://v2.tauri.app/plugin/stronghold/) lists Windows, Linux, macOS, Android, and iOS support and an Argon2 initialization path, but it must pass a repository-specific lifecycle, backup, mobile, and recovery spike before adoption. |

XChaCha20-Poly1305 has a 192-bit nonce and is exposed by the current RustCrypto crate. Libsodium's [XChaCha20-Poly1305 documentation](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305) and [encrypted-stream documentation](https://doc.libsodium.org/secret-key_cryptography/secretstream) are useful construction references. Libsodium `secretstream` is a strong sequential-stream option, but the existing product relies on byte-range video/PDF access. A purely sequential format would require full decryption before seeking and would regress large-file behavior. The proposed indexed framing preserves random access while retaining independently authenticated records.

### 6.2 Mandatory pre-implementation ADR

Before writing production crypto, create `app/docs/adr/ADR-00XX-encrypted-file-envelope.md` and obtain approval for:

- exact binary encoding and endianness;
- nonce construction and maximum chunk count;
- header authentication and key-slot binding;
- Argon2id parameter floor, ceiling, calibration target, and parallel execution limit;
- maximum header, metadata, key-slot, file, and chunk sizes;
- selected crate versions, feature flags, audit history, MSRV, Android support, and supply-chain policy;
- representation of zero-length files and the final record;
- whether compliance requirements need an AES-based alternative suite;
- independent reviewer and golden-vector process.

DeepSeek must not replace this gate with “industry standard” prose. The ADR needs byte-level test vectors.

### 6.3 Key hierarchy

```text
Vault passphrase --Argon2id--> vault unlock KEK
                                  |
                                  v
                         unwrap random vault key
                                  |
                      HKDF domain-separated KEK
                                  |
                                  v
Random file DEK <--------- wrapped vault key slot
      |
      +---- encrypt metadata
      +---- encrypt content chunks
      +---- encrypt final digest record

Custom file passphrase --Argon2id--> file wrapping KEK --wrap--> same file DEK
Generated recovery key ----HKDF-----> file wrapping KEK --wrap--> same file DEK
```

A file can contain several independent key slots wrapping the same DEK. This supports a passphrase plus recovery key, or file passphrase plus optional vault recovery, without encrypting the content twice. Key-slot removal or addition in embedded headers still requires a re-upload in version 1; do not imply instant rekeying.

### 6.4 Proposed `TDENC1` envelope

This is a design proposal, not a license to improvise. The ADR may refine byte counts but must keep the invariants.

```text
+-----------------------------+
| fixed prefix + core header  | magic, version, suite, sizes, chunk size,
|                             | file UUID, nonce prefix, limits
+-----------------------------+
| key slot table              | slot kind/id, KDF params, salt,
|                             | wrap nonce, wrapped 32-byte DEK + tag
+-----------------------------+
| encrypted private metadata  | filename, MIME, logical timestamps,
|                             | app format version + AEAD tag
+-----------------------------+
| encrypted chunk 0 + tag     |
| encrypted chunk 1 + tag     | fixed-size plaintext chunks except final
| ...                         |
+-----------------------------+
| encrypted final record      | chunk count, plaintext length,
|                             | SHA-256 digest + AEAD tag
+-----------------------------+
```

Required invariants:

- Magic and format version are fixed and checked before allocation.
- All integer fields use one documented endian order.
- Default plaintext chunk size is proposed as 1 MiB; ADR limits must allow tuning without changing nonce logic.
- Every file gets a random 32-byte DEK, 16-byte file UUID, and 16-byte nonce prefix.
- Content nonce is `nonce_prefix[16] || big_endian_u64(chunk_index)`. The DEK is unique per file. The ADR must prove the maximum index cannot wrap.
- Metadata and final records use reserved nonce indices that cannot collide with content indices.
- Every AEAD record uses canonical AAD containing the format/suite, file UUID, authenticated core-header commitment, record type, chunk index, plaintext offset/length, total plaintext length, and total chunk count.
- Each key slot's AEAD AAD contains the file UUID, format version, core-header commitment, slot kind/ID, and exact KDF parameters.
- A post-unlock header MAC/commitment authenticates the complete canonical header so slot-table tampering cannot be misreported as ordinary corruption.
- Original filename and MIME are inside encrypted metadata when metadata protection is on. Telegram receives an opaque ASCII filename such as `tdrive_<base32-file-id>.tdenc` and a minimal version marker.
- The final authenticated record is mandatory even for a zero-byte file. Full downloads verify its digest before publication. Random-range responses authenticate every returned chunk but need not hash unrelated chunks.
- Parsers enforce small fixed bounds before allocation or KDF work: proposed maximum 64 KiB header, 8 key slots, 64 KiB metadata, approved chunk-size range, approved Argon2 memory/time/parallelism range, and the application's existing Telegram-size limit.
- Unknown critical fields and unsupported versions fail closed. Non-critical forward-compatible TLVs may be skipped only if the ADR defines them.

### 6.5 Exact ciphertext length

`grammers_client::Client::upload_stream` requires the upload length before reading. Implement and test a pure checked-arithmetic function:

```text
ciphertext_length =
    prefix_and_header_length
  + encrypted_metadata_plain_length + AEAD_TAG_LENGTH
  + plaintext_length
  + data_chunk_count * AEAD_TAG_LENGTH
  + final_record_plain_length + AEAD_TAG_LENGTH
```

All additions, multiplications, conversions to `usize`, and Telegram-limit comparisons must be checked. Preflight the ciphertext length, not just the plaintext length. A plaintext file near the existing 2 GiB cap can become too large after encryption and must be rejected before upload starts with an actionable error.

### 6.6 Why not encrypt directly with the user's password

Wrapping a random DEK allows several safe capabilities without re-encrypting content under the same password: multiple unlock methods, generated recovery keys, per-file isolation, future recipients, and vault rotation. Argon2id makes password guessing expensive but cannot turn a weak password into high entropy. UI strength feedback and recovery warnings are required, but arbitrary composition rules are not a substitute for entropy.

---

## 7. Key lifecycle and vault behavior

Follow the lifecycle categories in [NIST SP 800-57 Part 1 Rev. 5](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final): generation, storage, distribution/export, use, replacement, recovery, revocation, archival, and destruction.

### 7.1 Vault creation

1. User chooses a vault passphrase and confirms it.
2. Rust calibrates/validates approved Argon2id parameters and generates a random salt.
3. Rust generates a random 32-byte vault key.
4. The vault key is stored only through `CryptoVault`; the vault snapshot is protected by the passphrase-derived key.
5. The app immediately offers an encrypted recovery bundle and verifies the user can re-enter/import it before marking backup complete.
6. No password hint may contain the passphrase. Recovery language must state that support cannot restore a lost key.

### 7.2 Unlock and session

- A Tauri command accepts the passphrase, performs KDF/unlock in Rust, clears the IPC input as quickly as practicable, and returns an opaque random `UnlockSessionId`, not key bytes.
- `CryptoState` holds zeroizing keys in Rust memory. It must not derive `Debug`, serialize, clone casually, or cross into React.
- Subsequent commands pass a short-lived opaque key/profile handle. Handles are random, scoped to the app process and operation class, and invalid after lock/restart.
- Unlock attempts are serialized and rate-limited. Attacker-controlled encrypted headers cannot trigger unbounded concurrent Argon2 operations.
- Wrong key and corrupt header produce a generic authentication failure to unauthenticated interfaces; the UI can give safe recovery guidance without exposing oracle detail.

### 7.3 Auto-lock

Lock and zeroize on:

- explicit Lock now;
- configured idle timeout;
- logout;
- app exit;
- OS sleep/session lock where platform hooks exist;
- mobile background after the configured grace period;
- vault deletion;
- fatal crypto-state error.

When locking, revoke handles, stop serving decrypted routes, evict plaintext memory, remove plaintext leases, and transition queued encrypted operations to cancelled or `waiting_for_unlock` according to whether they can be safely resumed. Never continue by uploading plaintext.

### 7.4 Recovery/export

Define a versioned encrypted key-bundle format distinct from `TDENC1`. It must include only required vault/profile records, KDF parameters, creation/version metadata, and an integrity check. Export is re-encrypted under a newly entered recovery passphrase or generated recovery key; do not copy the live Stronghold snapshot as the public backup contract.

Recovery validation tests must cover new-device import, wrong passphrase, partial/corrupt bundle, duplicate import, older version, and recovery followed by successful decrypt of a golden encrypted file.

### 7.5 Rekey and rotation semantics

- **Change vault passphrase:** rewrap the vault snapshot; file ciphertext is unchanged.
- **Rotate vault key:** add a migration job that unwraps each accessible DEK with the old vault key and creates replacement files/key records. Because version-1 slots are embedded in Telegram objects, this is a network operation unless a reviewed sidecar scheme is added.
- **Change per-file passphrase/recovery slot:** re-upload an equivalent ciphertext object with new slots, verify it, update DB mapping, then optionally delete the old message.
- **Re-encrypt plaintext or change metadata privacy:** upload new first, verify, then delete old only after explicit confirmation.

Never describe a network re-upload as an instant local key rotation.

---

## 8. Rust architecture

Create a cohesive crypto subsystem instead of adding crypto calls to every command:

```text
app/src-tauri/src/crypto/
  mod.rs
  error.rs                 stable internal/user/API error codes
  policy.rs                limits, suites, KDF policy, feature flag
  secret.rs                non-Debug zeroizing wrappers
  random.rs                OS-CSPRNG facade
  kdf.rs                   Argon2id + HKDF domain separation
  envelope/
    mod.rs
    header.rs              bounded canonical parser/encoder
    key_slot.rs
    length.rs              checked exact-length calculations
    encrypt_reader.rs      AsyncRead state machine
    decrypt_reader.rs      sequential authenticated reader
    range.rs               plaintext-to-ciphertext range mapping
    vectors.rs             golden fixtures/test helpers
  vault/
    mod.rs                 CryptoVault trait
    stronghold.rs          candidate implementation
    memory.rs              tests only
    export.rs
  registry.rs              message/header record lookup
  byte_source.rs           Plain/Encrypted logical media abstraction
  cache.rs                 encrypted derived cache
  lease.rs                 bounded temporary plaintext leases
  state.rs                 handles, auto-lock, session lifecycle
```

### 8.1 Core interfaces

Define interfaces before integration:

```rust
trait CryptoVault {
    fn create(...);
    fn unlock(...);
    fn lock(...);
    fn save_profile(...);
    fn load_wrapping_key(...);
    fn export_bundle(...);
    fn import_bundle(...);
}

trait LogicalMediaSource {
    fn metadata(&self) -> LogicalMediaMetadata;
    async fn read_range(&self, plaintext_range: Range<u64>) -> Result<Bytes, CryptoError>;
    async fn stream_all(&self) -> Result<...>;
}

enum MediaRepresentation {
    Plaintext,
    Ciphertext,
}
```

Use real Rust signatures and lifetime/async choices appropriate to the codebase; the above shows responsibility boundaries. `server.rs`, REST download, share download, preview, metadata, archive, and transcode must call the same logical source rather than each implementing decryption.

### 8.2 Encrypting upload reader

`EncryptingReader<R: AsyncRead>` is a state machine that emits header, encrypted metadata, authenticated data chunks, and final record. It must:

- accept an immutable encryption session containing all generated keys/nonces/header bytes;
- use bounded buffers (proposed 1 MiB plus overhead per active upload);
- handle arbitrary `poll_read` buffer sizes correctly;
- never emit a partially formed record as complete;
- hash plaintext incrementally for the final record;
- check source size/identity and abort if the file changes during encryption;
- expose plaintext and ciphertext counters separately;
- zeroize plaintext buffers and keys after success, error, or cancellation;
- generate a new DEK/nonce set if a retry can observe changed plaintext;
- reproduce the same bytes only when retrying an immutable source with the same session.

Pipeline placement:

```text
source -> plaintext progress/hash -> EncryptingReader -> ciphertext throttle/progress -> grammers
```

The UI progress denominator should remain the logical plaintext size for familiarity; diagnostics may show network ciphertext bytes. Bandwidth reservations and Telegram limits use ciphertext size.

### 8.3 Authenticated download sink

Refactor the direct download loop into a reusable copy operation:

```text
TelegramCipherSource -> TDENC1 parser -> key resolver -> authenticated plaintext -> AtomicOutput
```

`AtomicOutput` writes beside the requested desktop destination as a randomized `.part`, or to app-private Android cache. Only after every required chunk and final record verify does it flush, sync, close, and atomically rename/publish. Cancellation, wrong key, corruption, I/O error, lost connection, and process recovery remove or quarantine the partial file. Android MediaStore JNI is invoked only after successful verification.

### 8.4 Random-access logical source

For an encrypted plaintext range:

1. Validate requested logical range against authenticated plaintext length.
2. Map it to the first and last full encrypted content records.
3. Map ciphertext offsets to Telegram's 512 KiB CDN alignment requirements already handled in `server.rs`.
4. Fetch complete records plus tags.
5. Authenticate each record with its expected index/AAD.
6. Slice verified plaintext to the requested range.
7. Return accurate plaintext `Content-Length`, `Content-Range`, MIME, and filename.

Do not stream a ciphertext fragment directly into an AEAD open call. Never release unauthenticated partial plaintext while waiting for the remainder/tag.

---

## 9. Persistence and database migration

Add a schema-version mechanism before new tables. Migrations must run in a transaction, be idempotent, preserve all existing rows, and have startup tests from both an empty database and a copy of the current schema.

Proposed non-secret registry table:

```sql
CREATE TABLE encrypted_files (
  folder_key          TEXT NOT NULL,
  message_id          INTEGER NOT NULL,
  file_uuid           BLOB NOT NULL,
  envelope_version    INTEGER NOT NULL,
  cipher_suite        INTEGER NOT NULL,
  ciphertext_size     INTEGER NOT NULL,
  remote_name         TEXT NOT NULL,
  key_profile_id      TEXT,
  header_blob         BLOB,
  header_sha256       BLOB,
  record_state        TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  last_verified_at    INTEGER,
  PRIMARY KEY(folder_key, message_id)
);
```

`header_blob` is the already-public encrypted envelope header, cached to avoid repeated Telegram range reads. It must not contain plaintext metadata or raw keys. If a future local search index is persisted, encrypt it with a domain-separated index key; the recommended version-1 approach is to decrypt cached headers after vault unlock and build an in-memory search index.

Proposed profile table contains only non-secret descriptors and Stronghold locators:

```sql
CREATE TABLE encryption_profiles (
  id                  TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  kind                TEXT NOT NULL,
  vault_locator       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  is_deleted          INTEGER NOT NULL DEFAULT 0
);
```

Never place a passphrase, recovery key, KEK, DEK, decrypted filename, key export, or reusable unlock token in SQLite.

### 9.1 Registry consistency

- Upload: send ciphertext, obtain Telegram message ID, verify marker/header, then insert the registry row. If registry insert fails, leave the Telegram object intact and schedule reconciliation; do not delete user data automatically.
- Delete: delete Telegram message first, then registry/cache rows. A failed metadata cleanup is recoverable.
- Move/copy: forwarding creates new message IDs. Capture returned IDs or resolve by file UUID, create destination rows, verify them, and only then delete the source for a move.
- Rename under protected metadata: version 1 re-encrypts/re-uploads atomically. Plain files keep current caption-based rename.
- Folder deletion: clean registry rows only for confirmed deleted messages/folder.
- Startup reconciliation: scan only recognized markers, fetch bounded headers, validate, and rebuild missing rows without requiring content download.

Old app versions will see opaque `.tdenc` files and can download ciphertext but cannot decrypt it. This is acceptable rollback behavior; plaintext objects remain fully compatible.

---

## 10. Command, type, and event contracts

### 10.1 Shared types

Additive fields on `FileMetadata`/`TelegramFile`:

```ts
type EncryptionState =
  | 'plain'
  | 'encrypted_unlocked'
  | 'encrypted_locked'
  | 'encrypted_key_missing'
  | 'encrypted_unsupported_version'
  | 'encrypted_corrupt';

interface FileEncryptionInfo {
  state: EncryptionState;
  envelopeVersion?: number;
  profileId?: string;
  metadataProtected?: boolean;
  ciphertextSize?: number;
}
```

Preserve existing `name`, `size`, `sizeStr`, `type`, and folder behavior. When unlocked, `name`/`size` represent logical plaintext metadata. When locked/private, return localized presentation data separately rather than placing a translated placeholder in the model.

Queue items may add:

```ts
protection?: { mode: 'standard' | 'vault' | 'file_key'; profileId?: string };
status?: existing statuses | 'waiting_for_unlock' | 'encrypting' | 'decrypting' | 'verifying';
```

No raw secret or unlock handle is persisted with a queue item. In-memory operation handles belong in a separate non-persisted map.

### 10.2 Tauri commands

Suggested commands:

- `cmd_get_encryption_capabilities`
- `cmd_get_encryption_settings`
- `cmd_update_encryption_settings` (non-secret preferences only)
- `cmd_create_vault`
- `cmd_unlock_vault`
- `cmd_lock_vault`
- `cmd_get_vault_status`
- `cmd_export_vault_recovery`
- `cmd_import_vault_recovery`
- `cmd_generate_recovery_key`
- `cmd_unlock_file`
- `cmd_forget_file_unlock`
- `cmd_verify_encrypted_file`
- `cmd_rekey_encrypted_file`
- `cmd_migrate_file_to_encrypted`
- `cmd_export_ciphertext`

Prefer extending upload/download request structs over proliferating parallel encrypted commands. A single controller path with a `ProtectionIntent`/`Representation` makes parity more testable. Register commands in `lib.rs` and scope Tauri capabilities narrowly.

### 10.3 Stable errors

Define a serializable code plus localized-safe context:

```text
CRYPTO_VAULT_LOCKED
CRYPTO_KEY_REQUIRED
CRYPTO_WRONG_KEY_OR_CORRUPT
CRYPTO_UNSUPPORTED_VERSION
CRYPTO_HEADER_INVALID
CRYPTO_POLICY_REJECTED
CRYPTO_KDF_LIMIT_EXCEEDED
CRYPTO_AUTH_FAILED
CRYPTO_TRUNCATED
CRYPTO_SIZE_OVERFLOW
CRYPTO_TELEGRAM_LIMIT
CRYPTO_TEMP_POLICY_BLOCKED
CRYPTO_RECOVERY_REQUIRED
```

Logs may include code, format version, message ID, folder ID, stage, and byte counts. They must not include keys, passphrases, header blobs, decrypted metadata, original private names, local source paths in security events, or raw request bodies.

### 10.4 Progress events

Keep existing upload/download event names and payload fields for compatibility. Add optional `phase` and dual counters:

```text
preparing -> deriving_key -> encrypting/uploading -> verifying -> complete
waiting_for_unlock -> decrypting/downloading -> verifying -> publishing -> complete
```

Do not produce two competing percent bars. The main percent remains logical source/output progress; status text explains the phase.

---

## 11. Feature-preservation design

### 11.1 Uploads, cancellation, retry, and queues

- Standard uploads follow the unchanged code branch.
- Vault/file-key upload uses the same concurrency scheduler, bandwidth manager, flood-wait behavior, cancellation set, and progress event contract.
- KDF work is not multiplied by chunk count; derive/unwrap once per operation/profile.
- Persist only protection mode/profile ID. After restart, custom-key jobs wait for unlock.
- Cancel clears crypto buffers and both plaintext/ciphertext temporary artifacts.
- Retry never silently changes encryption mode. If the source changed, start a new encryption session and surface that fact.
- Android foreground service remains active for encrypted transfers but notifications use safe generic labels if metadata is protected.

### 11.2 File listing, sort, filter, and search

- Plain files keep Telegram-derived metadata.
- Encrypted files use cached encrypted headers and reveal private metadata only after a matching key is unlocked.
- Locked private files display an opaque label and encrypted size; type-specific thumbnails/icons are not inferred from hidden extensions.
- On unlock, decrypt headers in a bounded worker pool, update the in-memory index, and refresh results without duplicating rows.
- Search, name/type sort, duplicate detection, and category filters operate on decrypted in-memory metadata while unlocked.
- When locked, return explicit `partial_results: true`/locked counts in API responses instead of pretending no match exists.

Do not implement remote deterministic filename hashes in version 1. They leak equality and complicate substring search. An encrypted local header cache plus in-memory index is safer and adequate until measured otherwise.

### 11.3 Preview, thumbnails, PDF, and image loading

- Generalize the loopback server with a short-lived, session-bound preview token.
- `cmd_get_preview` may retain the current file-path result for plain files and return a typed tokenized URL for encrypted files.
- The encrypted URL route reads only authenticated plaintext through `LogicalMediaSource` and sends `Cache-Control: no-store` for sensitive responses.
- Thumbnail creation decrypts into bounded memory, decodes only after authentication, then encrypts the derived thumbnail under a domain-separated cache key before disk storage.
- Existing plaintext thumbnail/preview cache behavior remains unchanged.
- Lock immediately invalidates URLs and cache-key handles.
- Enforce decoded-pixel, compressed-size, timeout, and concurrency limits to prevent malicious encrypted images from exhausting memory.

### 11.4 Original and adaptive media streaming

- `build_media_response` becomes a shared logical response builder; its plain source preserves current 512 KiB Telegram CDN alignment logic.
- Encrypted range mapping fetches/authenticates whole encryption records and returns logical plaintext ranges.
- `video_metadata.rs` reads through the same source; moov-box logic must never see ciphertext.
- FFmpeg/remux input uses a one-time loopback URL or bounded plaintext lease. Prefer loopback streaming.
- HLS playlists, segments, cached originals, and remux outputs derived from encrypted files must be encrypted at rest under a session/cache key and decrypted only by tokenized loopback routes.
- Existing plaintext transcode caches remain compatible and separately keyed/named.
- Cancel/clear-cache/lock/logout/exit removes encrypted derived-cache keys and all active plaintext leases.

### 11.5 Archives

- ZIP listing may use authenticated decrypted memory within existing archive byte limits.
- RAR/7z libraries currently need random-access files. Route those through `PlaintextLeaseManager` in Balanced mode.
- Lease files use app-private directories, randomized names, owner-only permissions where supported, no original filename, no backup/indexing intent, strict size/time caps, startup cleanup, and deletion on every path.
- Strict mode rejects operations that cannot be completed without plaintext-on-disk and explains why; it never falls back silently.
- Extracted entries uploaded back to Telegram inherit an explicit chosen protection mode. Default to the source archive's protection profile, not Standard.

Deletion of ordinary files is not a reliable guarantee of sanitization on every modern storage device. Describe lease cleanup as risk reduction, not “secure erase”; NIST's current media-sanitization guidance treats sanitization as a media- and threat-dependent process: [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final).

### 11.6 Rename, copy, move, delete, and duplicate detection

- Plain operations remain unchanged.
- Ciphertext copy/forward does not require a key; clone the registry record to the new Telegram message ID after verification.
- Move must record the destination before deleting the source.
- Protected-metadata rename is atomic upload-new/verify/swap/delete-old in version 1. Add progress and cancellation. Future encrypted sidecar metadata can optimize this only after a separate ADR.
- Delete must not require unlock; deleting ciphertext is valid.
- Duplicate detection for unlocked encrypted files may compare the authenticated final digest after explicit verification. Do not expose or upload plaintext hashes. Locked files cannot be declared duplicates based only on ciphertext.

### 11.7 Sharing

Existing share-password bcrypt and file encryption are distinct controls.

Offer:

1. **Share encrypted file (default):** current share route serves exact `.tdenc` ciphertext. The recipient needs Telegram Drive/a future decrypt utility and receives the key separately. The share server never sees a DEK.
2. **Share decrypted copy (explicit):** only while the vault/file is unlocked, with a strong warning and short expiry. The server decrypts authenticated chunks in memory. Allow only loopback, or a separately configured HTTPS endpoint. Never render a key-entry page over plain LAN HTTP.
3. **Future recipient-encrypted share:** add X25519/age-style recipient slots so no shared passphrase is needed. This is recommended phase 2, not version-1 scope.

The current server binds to loopback; preserve that safe default. Do not broaden it to `0.0.0.0` for this work. A link password controls HTTP access but must never automatically become a file KEK.

### 11.8 REST API

Add additive response metadata: encrypted state, supported envelope version, logical size when unlocked, ciphertext size, and available representations.

- Upload multipart fields: `protection_mode=standard|vault|profile`, `profile_id`, `protect_metadata`. The referenced profile must already be unlocked in the app process.
- Do not accept passphrases/recovery keys in query parameters or headers. If a future unlock endpoint is added, it requires a separate security review, POST body, loopback-only binding, rate limits, no request logging, and short-lived handle response.
- Encrypted download requires `representation=ciphertext|plaintext`. Default to ciphertext for encrypted objects. Plaintext requires an unlocked file and API authorization; otherwise return 423.
- Range semantics are relative to the selected representation.
- Thumbnail/media-info endpoints return 423 while locked, not corrupt placeholders.
- REST bulk archive decrypts through the shared source and follows temporary-plaintext policy.
- Existing endpoints for plain files keep response bodies/statuses unless adding optional fields.

### 11.9 Themes, accessibility, localization, and ads

- Build dialogs from current semantic UI primitives so default, light, dark, built-in presets, and custom user themes remain supported.
- Never encode “encrypted” solely through color. Pair a lock icon, label, and accessible state.
- Passphrase visibility toggle, Caps Lock warning, focus restoration, screen-reader announcements, and keyboard-only flows are required.
- Test Arabic RTL and the longest supported translations. Recovery keys remain LTR/monospace inside RTL layout with safe isolation.
- Run `npm run i18n:check`; add all keys to all locales before a phase is complete.
- Verify sponsor gateway, desktop banner, Android ad surface, local `/ad-banner`, countdown/dismissal, and click-through after local server changes.

---

## 12. Privacy modes and metadata

Provide two clearly explained policies:

### Recommended: content + private metadata

- Opaque Telegram filename/caption.
- Original filename, MIME, logical size, and app metadata encrypted in `TDENC1`.
- Approximate ciphertext size and timing remain visible.
- Requires header cache/unlock for rich listings.

### Compatibility option: content only

- File bytes encrypted, but original Telegram filename/caption and MIME remain visible.
- Faster locked listings and current rename behavior.
- UI must plainly state the leakage; do not label this “full privacy.”

The application can default to private metadata after onboarding, but it must preserve a visible per-upload summary so users know what Telegram can still see.

Optional future padding can obscure exact length by padding the final plaintext record to configured buckets. It increases storage/transfer costs, interacts with Telegram limits, and must not be in the first release.

---

## 13. Phased implementation plan for DeepSeek V4 Pro

Each phase must be a reviewable change set with its own tests and rollback. Do not combine phases to move faster.

### Phase 0 — Baseline, threat model, and ADR

Tasks:

1. Read all files named in section 4 plus current language/design implementation plans.
2. Record baseline commands and screenshots for desktop and Android where available.
3. Create a feature-parity matrix covering every row in section 11, including ads and themes.
4. Add characterization tests around plaintext exact-length upload, download atomicity, range parsing/alignment, cache cleanup, queue persistence, and DB migration.
5. Write the crypto-envelope ADR and threat model.
6. Build throwaway benchmarks/prototypes for:
   - XChaCha chunk throughput on desktop and Android;
   - Argon2id memory/latency and concurrency;
   - exact-length `EncryptingReader` through `upload_stream`-compatible AsyncRead behavior;
   - encrypted plaintext-range mapping across Telegram alignment;
   - Stronghold create/unlock/save/restart/import on every supported target.
7. Select/pin dependencies only after audit/MSRV/platform review.

Exit gate:

- Baseline suite is green.
- ADR has byte layout, formulas, limits, known-answer vectors, and independent reviewer approval.
- No production feature flag is exposed yet.

### Phase 1 — Isolated crypto core

Tasks:

1. Add `crypto/` modules, stable errors, policy limits, secret wrappers, and test-only in-memory vault.
2. Implement canonical bounded header encode/parse.
3. Implement key slots, Argon2id/HKDF wrapping, exact length, sequential encryption/decryption, random range mapping, and final-record verification.
4. Produce committed golden vectors for:
   - zero bytes;
   - one byte;
   - chunk-size minus/at/plus one;
   - multiple chunks;
   - Unicode and RTL filenames;
   - maximum metadata within policy;
   - every supported slot kind.
5. Add property tests and parser fuzz targets.

Exit gate:

- Core has no Telegram, Tauri, Actix, React, SQLite, or filesystem dependency except test adapters.
- Every header/chunk bit-flip, deletion, duplication, reordering, wrong key, wrong AAD, truncation, and trailing-byte case fails safely.
- Miri/sanitizer-capable tests and `cargo audit`/dependency policy checks pass in CI.

### Phase 2 — Vault, schema, and lifecycle

Tasks:

1. Add transactional schema migrations and registry/profile repositories.
2. Implement `CryptoVault` Stronghold backend after the spike, plus recovery bundle import/export.
3. Add `CryptoState`, opaque handle registry, KDF concurrency guard, auto-lock timer, lifecycle hooks, and zeroization on logout/exit.
4. Add vault Tauri commands and settings UI behind developer-only `encryption_mode_alpha`.
5. Add recovery-flow tests and corruption/restart tests.

Exit gate:

- No secret appears in settings/queue/SQLite/log snapshots.
- Vault recovery works on a clean app-data directory.
- Lock invalidates all handles and decrypted routes.
- Existing database starts with no user-visible change.

### Phase 3 — Encrypted upload and recognition

Tasks:

1. Add `ProtectionIntent` to upload request types and in-memory queue operations.
2. Implement `EncryptingReader` and integrate it into local, URL, folder-ZIP, REST, and Android upload paths.
3. Add opaque remote naming and registry commit/reconciliation.
4. Extend file metadata/types and render locked/encrypted cards/rows without enabling decrypt actions broadly.
5. Preserve cancel/retry/progress/throttling/concurrency and validate ciphertext Telegram limits.

Exit gate:

- Telegram contains only `TDENC1` bytes for encrypted tests.
- Standard upload fixtures are unchanged.
- Pulling a key mid-transfer cannot lead to plaintext fallback.
- Crash/restart leaves either a valid ciphertext message or a reconcilable orphan, never a mixed-format success.

### Phase 4 — Download, export, and key prompts

Tasks:

1. Add header detection/registry lookup and key-resolution prompts.
2. Integrate authenticated sequential decryption and `AtomicOutput` into desktop/Android downloads.
3. Add raw ciphertext export and full verify actions.
4. Add queue `waiting_for_unlock`, decrypting, verifying, and publishing phases.
5. Test wrong key, corruption, disk full, cancel at every stage, Android JNI failure, and existing filename collision behavior.

Exit gate:

- A plaintext destination is never visible before full authentication.
- Android MediaStore receives only verified output.
- Plain download behavior/progress remains compatible.

### Phase 5 — Preview, thumbnails, range streaming, and media

Tasks:

1. Introduce `LogicalMediaSource` and migrate `build_media_response` without changing plain behavior.
2. Add tokenized encrypted preview/range routes and authenticated range mapping.
3. Migrate image/PDF/video metadata paths.
4. Add encrypted derived-cache format and thumbnail serving.
5. Migrate FFmpeg, adaptive HLS, original cache, and fMP4 remux paths; implement lease fallback only where unavoidable.
6. Invalidate all routes/cache handles on lock.

Exit gate:

- Encrypted image/PDF previews and video seeking work on first open and subsequent ranges.
- No encrypted-file thumbnail, full preview, original, HLS segment, playlist, or remux artifact is stored plaintext outside a tracked lease.
- Plain media performance stays within the budget in section 15.

### Phase 6 — Operations, archives, sharing, REST API

Tasks:

1. Integrate move/copy/delete/rename and registry reconciliation.
2. Migrate ZIP/RAR/7z listing/extraction and REST bulk archive through logical sources/leases.
3. Add encrypted-vs-decrypted share options and enforce transport policy.
4. Add explicit REST representations, lock responses, and encryption metadata.
5. Add unlocked in-memory search/sort/filter/category/duplicate logic for private metadata.

Exit gate:

- Every row in the feature matrix works for plain, vault-encrypted, file-passphrase, generated-key, locked, wrong-key, and corrupt cases.
- Share/API cannot expose plaintext without explicit representation and an unlocked key.

### Phase 7 — Complete product UI, mobile, i18n, accessibility

Tasks:

1. Finish settings, upload protection picker, file unlock, recovery, rekey, migration, strict-temp, and security-explanation flows.
2. Match desktop/mobile behavior and Android background transitions.
3. Add all localization keys/locales and typed-key checks.
4. Test default/light/dark/presets/custom themes, RTL, reduced motion, performance mode, keyboard, screen reader, text scaling, and narrow layouts.
5. Add safe clipboard behavior: explicit copy, reveal timer, and optional clear only if the app can prove the clipboard still contains the value it placed.

Exit gate:

- No hard-coded untranslated user text.
- Keys are never announced unintentionally by screen readers or exposed in accessibility snapshots after hiding.
- All theme/ad/app-shell regression checks pass.

### Phase 8 — Migration tool, hardening, staged release

Tasks:

1. Add explicit plaintext-to-encrypted migration with upload-new/verify/delete-old transaction semantics, dry-run size estimate, resumable job state, and rollback.
2. Run fuzzing, fault injection, crash recovery, low-disk, low-memory, slow-network, flood-wait, proxy/VPN, multi-transfer, and malicious-header suites.
3. Commission independent crypto/security review and resolve findings.
4. Release in stages: internal developer flag, opt-in alpha, opt-in beta, stable opt-in. Never silently turn on for existing users.
5. Publish format/recovery documentation and a compatibility statement.

Exit gate:

- Definition of done in section 18 is met.
- Rollback leaves plaintext behavior intact and encrypted objects downloadable as ciphertext.
- Encryption is not described as audited until review is complete.

---

## 14. Test strategy

### 14.1 Unit and known-answer tests

- Exact envelope encoding and decoding.
- Exact length formula across boundary/max values.
- Nonce derivation uniqueness and index overflow rejection.
- KDF parameter encoding, floor/ceiling rejection, and known Argon2id vectors.
- Every slot type wraps/unwraps the same DEK.
- Chunk AAD includes all required fields.
- Final record/digest and zero-byte behavior.
- Secret types do not implement serialization or `Debug`.

### 14.2 Property/fuzz tests

- Arbitrary bytes into the header parser never panic or allocate beyond limits.
- Any accepted envelope round-trips.
- Any selected plaintext range equals the same slice from a full authenticated decrypt.
- Random mutation cannot produce accepted changed plaintext.
- Checked length math never wraps.
- Random chunking of `AsyncRead`/`AsyncWrite` yields identical output.

### 14.3 Integration matrix

Run each applicable workflow for:

| File state | Key state |
|---|---|
| Plain legacy | n/a |
| Vault encrypted, public metadata | unlocked / locked |
| Vault encrypted, private metadata | unlocked / locked |
| File passphrase | correct / wrong / absent |
| Generated recovery key | correct / wrong / absent |
| Multiple slots | each slot independently |
| Unsupported envelope | n/a |
| Corrupt/truncated envelope | n/a |

Workflows: local upload, URL upload, folder ZIP, REST upload, download, retry, cancel, restart, list, search, sort, filter, thumbnail, preview, PDF, media info, original seek, HLS, remux, archive list/extract, rename, move, copy, delete, share, REST representation/range, cache clear, logout, sleep/background, recovery import, theme switch, language/RTL, sponsor surfaces.

File boundaries: 0, 1, chunk−1, chunk, chunk+1, multiple chunks, Unicode filenames, no extension, long safe filename, near Telegram limit, low disk, Android `content://`, image decompression bomb fixture, malformed archive.

### 14.4 Failure injection

Inject failure after every state transition:

- KDF completes;
- header emitted;
- any upload chunk;
- Telegram upload completes but message send fails;
- message send succeeds but DB commit fails;
- any download chunk;
- final tag before digest check;
- file flush/sync/rename;
- Android MediaStore copy;
- move forward before source delete;
- rekey upload before old delete;
- lock during preview/range/transcode/archive;
- process termination with active plaintext lease.

Every test asserts Telegram object status, registry status, queue status, key state, destination visibility, and temp/cache cleanup.

### 14.5 Security assertions in CI

- Secret-pattern scan of settings, SQLite, queue stores, logs, crash fixtures, and generated filenames.
- Dependency audit and deny-list for duplicate/unmaintained crypto crates.
- Fuzz corpus replay.
- Golden vector compatibility on macOS, Windows, Linux, and Android build/test targets.
- Release builds do not expose developer crypto diagnostics or keys.

---

## 15. Performance and resource budgets

Establish measured baselines in phase 0; then enforce these initial targets or document approved changes:

- Plain transfers: no more than 2% throughput regression and no extra file copy.
- Encrypted transfer: at least 80% of plain throughput on the same network/disk after KDF, with bounded memory.
- Active encrypted upload/download memory: approximately one to two content chunks plus protocol buffers; no whole-file buffering.
- KDF: one derivation per unlock/unique passphrase operation, serialized or tightly bounded; target interactive latency selected per platform with RFC-approved minimum parameters.
- Range stream: fetch only the encryption records intersecting the requested range plus Telegram alignment overhead.
- First header scan: bounded small range, cached thereafter.
- Thumbnail: bounded compressed bytes, decoded pixels, time, and concurrency.
- Lock: revoke routes/handles immediately and finish zeroization/lease cleanup promptly without blocking UI indefinitely.

Record plaintext and ciphertext counters separately. Storage statistics should show logical size to an unlocked user and ciphertext/network size in diagnostics; do not quietly mix the two.

---

## 16. Rollout, compatibility, and rollback

Use independent flags:

```text
encryption_core_available       compiled capability
encryption_mode_alpha          developer UI
encrypted_upload_enabled       creation
encrypted_read_enabled         decrypt/preview
encrypted_share_enabled        share representations
encrypted_migration_enabled    bulk rewrite
```

Rules:

- Read support may ship before create support.
- Killing create support must not remove read/export support.
- A failed rollout disables new encrypted uploads while retaining unlock, download, verify, and ciphertext export.
- Database migrations are additive. Old plaintext rows need no backfill.
- The encrypted format version is immutable after release; changes create `TDENC2`, not ambiguous parsing.
- Never automatically delete the only known decryptable object.
- Keep an emergency “Export ciphertext” path even when a format is unsupported or a key is absent.

---

## 17. Additional encryption/privacy features worth adding

### Recommended for the first complete release

- Encrypted filenames/metadata.
- Per-file integrity verification and visible last-verified status.
- Vault auto-lock and system-sleep/background lock.
- Generated recovery keys and verified recovery bundle.
- Multiple key slots per file.
- Raw ciphertext export.
- Encrypted derived caches plus a strict no-plaintext-temp mode.
- Explicit encrypted/decrypted share representations.
- In-memory private search index while unlocked.
- Atomic plaintext-to-encrypted migration.

### Recommended follow-up

- Device pairing via a short-lived authenticated QR exchange.
- Public-key recipient slots for sharing without a shared passphrase.
- Efficient encrypted sidecar manifests for rename/rekey without content re-upload.
- Optional size padding.
- Hardware/biometric-backed device unlock where each platform provides a reviewed implementation.
- Standalone open-source decrypt utility with golden-vector compatibility.
- Key-compromise workflow: mark profile compromised, inventory affected files, migrate safely, and retain recovery audit trail without filenames/secrets.

### Do not add casually

- Hidden backdoor/recovery service.
- Server-uploaded escrow keys.
- Home-grown mnemonic encoding without checksum/versioning.
- Deterministic content encryption or convergent encryption for deduplication; it leaks equality and enables confirmation attacks.
- Reusing Telegram auth/session keys.
- Reusing the REST API key or share password as a file key.
- Clipboard auto-clear that overwrites unrelated user clipboard contents.
- Claims of secure deletion for ordinary SSD temp files.

---

## 18. Definition of done

The project is complete only when all are true:

1. Standard/plain behavior passes the baseline feature-parity suite.
2. Encrypted bytes are produced before Telegram and independently confirmed not to contain recoverable plaintext/metadata under the chosen privacy mode.
3. A random DEK is used per file and only approved key slots wrap it.
4. Wrong keys, corrupt headers, modified/reordered/missing chunks, truncation, malicious KDF values, and unsupported versions fail closed.
5. No unauthenticated plaintext reaches a destination, renderer, HTTP client, parser, or media tool.
6. Desktop and Android uploads/downloads preserve progress, cancellation, retry, bandwidth, and background behavior.
7. Listing, search, sort, preview, thumbnails, PDF, video seek, adaptive streaming, archive operations, rename, move, copy, delete, sharing, REST API, and migration have explicit encrypted-file tests.
8. Persistent encrypted-file derivatives are encrypted; unavoidable plaintext leases are tracked and policy-controlled.
9. No keys or private metadata appear in settings, queues, SQLite plaintext, captions, URLs, logs, analytics, crash fixtures, or notifications.
10. Recovery was tested from a clean device profile; loss consequences are documented.
11. Lock/logout/sleep/background/exit invalidate handles and decrypted routes and clean leases.
12. All supported languages, RTL, accessibility, reduced motion, performance mode, light/dark/default/preset/custom themes pass.
13. All ad/sponsor functionality passes regression tests and was not coupled to crypto state.
14. Golden vectors, format documentation, dependency versions, and recovery docs are committed.
15. An independent security review approved the envelope and key lifecycle, and findings are resolved or explicitly accepted.
16. Rollback disables encrypted creation without stranding already encrypted user data.

---

## 19. Instructions to DeepSeek V4 Pro

1. Treat this document as the scope and sequencing contract, not as permission to improvise cryptography.
2. Begin by reading the repository and producing the phase-0 artifacts. Do not edit production upload/download paths before the ADR and characterization tests are approved.
3. Preserve the dirty worktree and existing design/language changes. Do not reset, overwrite, or reformat unrelated files.
4. Use small, reviewable commits grouped by phase and responsibility. No phase may leave Standard mode broken.
5. Before each phase, list files to change, invariants, tests, and rollback. After it, report exact commands/results and remaining risks.
6. Centralize encryption/decryption in the Rust crypto subsystem and logical media adapter. Reject duplicated crypto loops in previews, API routes, shares, archives, or transcode code.
7. Keep secrets out of React and persistent stores. Where a passphrase must cross Tauri IPC once, minimize its lifetime and never log/serialize it.
8. Never silently fall back to plaintext, weaker KDF settings, content-only metadata, unencrypted caches, or a broader network bind.
9. If a required library/platform behavior is uncertain, stop that phase and produce a focused spike/ADR update. Do not “make it work” with an unreviewed construction.
10. Do not mark a phase complete because it compiles. Complete its exit gate and feature matrix.
11. Do not turn encryption on by default or delete source plaintext in migration until independent review and staged-release approval.
12. Any conflict between convenience and the security invariants must be raised as an explicit product/security decision.

---

## 20. Primary references

- Telegram, [MTProto Mobile Protocol — Cloud Chats use server-client encryption](https://core.telegram.org/mtproto).
- Telegram, [End-to-End Encryption, Secret Chats — encrypted file behavior](https://core.telegram.org/api/end-to-end).
- IETF, [RFC 9106 — Argon2 Memory-Hard Function](https://www.rfc-editor.org/rfc/rfc9106.html).
- IETF, [RFC 5869 — HMAC-based Extract-and-Expand Key Derivation Function](https://www.rfc-editor.org/rfc/rfc5869.html).
- NIST, [SP 800-57 Part 1 Rev. 5 — Recommendation for Key Management](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final).
- NIST, [SP 800-88 Rev. 2 — Guidelines for Media Sanitization](https://csrc.nist.gov/pubs/sp/800/88/r2/final).
- Libsodium, [Encrypted streams and file encryption](https://doc.libsodium.org/secret-key_cryptography/secretstream).
- Libsodium, [ChaCha20-Poly1305/XChaCha20-Poly1305](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305).
- RustCrypto, [`chacha20poly1305` crate documentation](https://docs.rs/chacha20poly1305/latest/chacha20poly1305/).
- RustCrypto, [`argon2` crate documentation](https://docs.rs/argon2/latest/argon2/).
- RustCrypto, [`zeroize` crate documentation](https://docs.rs/zeroize/latest/zeroize/).
- Tauri, [Stronghold plugin documentation](https://v2.tauri.app/plugin/stronghold/).

