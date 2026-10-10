# TDENC2 frozen-format beta

The format shipped by 3.9.8 and retained for 4.0.0 is version 2. The beta freezes these bytes; it does not claim an independent cryptographic review. Standard uploads remain the default. Sharing and legacy migration remain disabled. `mode_alpha` is a legacy compatibility field, not a new rollout switch. A future incompatible format needs a new version and an explicit migration decision.

The authoritative implementations are `crypto/envelope/{header,key_slot,encrypt_reader,decrypt_reader,length}.rs`, `crypto/kdf.rs`, `crypto/policy.rs`, `crypto/vault/{file,export}.rs` and `commands/fs.rs`. All integers below are unsigned little-endian unless specified. Strings and domains are UTF-8 bytes without a terminating zero. Concatenation has no padding.

## Envelope layout

The file is complete header, content records in order, then one final record. No record-length prefixes or trailing bytes are permitted. Cipher suite 1 is XChaCha20-Poly1305 with a 32-byte key, 24-byte nonce and 16-byte authentication tag appended to ciphertext.

| Offset | Bytes | Core field |
|---|---:|---|
| 0 | 6 | ASCII `TDENC2` |
| 6 | 2 | Format version 2 |
| 8 | 16 | Random file UUID |
| 24 | 2 | Cipher suite 1 |
| 26 | 4 | Complete header length |
| 30 | 4 | Plaintext chunk size (writer: 1,048,576) |
| 34 | 4 | Key-slot table length |
| 38 | 4 | Encrypted metadata length, including its tag; zero if absent |
| 42 | 8 | Total plaintext length |
| 50 | 16 | Random nonce prefix |
| 66 | 32 | HMAC-SHA-256 header authenticator |
| 98 | variable | Key-slot table, then encrypted metadata |

The 66-byte prefix ends before the authenticator. Each slot is 104 bytes: kind u8, unique slot ID u8, KDF u16, Argon2 memory KiB u32, iterations u32, parallelism u32, salt 16 bytes, independent wrapping nonce 24 bytes, wrapped DEK 48 bytes (32 bytes plus tag). Kind/KDF pairs are vault 1/HKDF 2, passphrase 2/Argon2id 1, recovery 3/HKDF 2. HKDF slots require all Argon2 fields zero. The current transfer path creates vault and/or passphrase slots and does not consume recovery slots.

Argon2id is version 0x13 with a 32-byte output. Current writers use 65,536 KiB, 3 iterations, parallelism 1; readers admit memory 65,536–262,144 KiB, iterations 3–100, parallelism 1–8. The passphrase is its supplied UTF-8 bytes without normalization. HKDF-SHA-256 file wrapping uses the slot salt, the master key as IKM, and info `telegram-drive:file-wrap:v2` + UUID + kind u8 + ID u8. Slot wrapping AAD is `telegram-drive:tdenc2:key-slot` + version u16 + UUID + kind + ID + KDF u16 + memory u32 + iterations u32 + parallelism u32 + salt. The independent wrapping nonce is stored in the slot; it is not derived from the content nonce.

HKDF-SHA-256 with no salt and the DEK as IKM derives separate 32-byte keys with info `telegram-drive:header-auth:v2`, `telegram-drive:metadata-enc:v2`, and `telegram-drive:content-enc:v2`. The header HMAC covers `telegram-drive:tdenc2:header-mac` + prefix + encoded slots + encrypted metadata. Metadata AAD is `telegram-drive:tdenc2:metadata` + prefix + slots. Its nonce is the prefix + u64::MAX. The authenticator must verify before metadata is used.

Protected metadata is serialized compact JSON in field order: `schema_version` (1), `original_name`, `mime_type`, and optional `sync_path`. Absent `sync_path` is omitted, not null. It is a relative Folder Sync placement path, for example `docs/2026/fixed-answer.bin`; consumers still validate safe placement. Metadata is absent when metadata protection is off. Names and paths stay encrypted inside the header; Telegram can still observe account, destination, time and ciphertext size.

Content record i (starting at zero) encrypts up to chunk_size plaintext bytes. Its nonce is prefix + i u64. Its AAD is `telegram-drive:tdenc2:chunk` + version u16 + UUID + header authenticator + i u64 + plaintext offset u64 + this plaintext length u32 + total plaintext length u64. The last content record can be short; an empty file has no content records. This binds ordering, offsets and declared length.

The final record uses nonce prefix + (u64::MAX−1). Its 52-byte plaintext is chunk count u32, total plaintext length u64, SHA-256 of all plaintext (32 bytes), and eight reserved zero bytes. Its AAD is `telegram-drive:tdenc2:final` + version u16 + UUID + header authenticator + chunk count u32 + total plaintext length u64. Ciphertext plus tag is exactly 68 bytes. The decoder verifies the final digest, counts, length and reserved bytes and refuses trailing bytes. Individual authenticated chunks can stream to session-scoped viewers; a complete downloaded file is published only after final verification.

Reader policy: 1–8 unique slots, chunk sizes 65,536–16,777,216 bytes, complete header at most 65,536 bytes. Although the metadata plaintext policy also says 65,536, the complete-header ceiling is tighter: with n slots, at most 65,536−98−104n−16 metadata plaintext bytes fit. Exact ciphertext length is header length + plaintext length + 16×ceil(plaintext/chunk_size) + 68, bounded by application writer/transfer policy at 2,000,000,000 bytes; the low-level header parser and streaming decoder do not independently enforce that total-size cap. `TDENC1` is quarantined and rejected; it is never reinterpreted as TDENC2.

## Interrupted uploads

The resumable upload journal stores the original header and source fingerprint. Continuation parses and authenticates that header, checks plaintext size, default chunk size, protection mode, and exact metadata bytes, unwraps every slot with the credentials supplied now, and requires all slots to yield the same DEK. `EncryptionSession::from_header` then reuses the UUID, nonce prefix, DEK and complete header. Re-reading the unchanged plaintext from the beginning reproduces exactly the same ciphertext; acknowledged Telegram parts can be skipped by the part-upload layer. It does not start encrypting at an arbitrary plaintext offset without recomputing the final hash.

A changed source fingerprint or incompatible credentials/header/metadata starts a fresh envelope with fresh randomness and a new upload session. Never reuse a nonce/key pair for changed plaintext. Native journeys cover vault and standalone passphrase envelopes over 10 MiB, interrupted part uploads, process restart, continued headers and authenticated download. Live Telegram acceptance remains UNRUN.

## Vault and recovery container compatibility

`TDVLT2` vaults and `TDREC2` recovery bundles have a 64-byte header: magic 6, version u16 (2), Argon2 memory/iterations/parallelism u32 each, salt 16, nonce 24, ciphertext length u32. XChaCha20-Poly1305 encrypts the binary vault payload with the Argon2-derived key. AAD is respectively `telegram-drive:persistent-vault:v2` or `telegram-drive:recovery-bundle:v2`, followed by the complete header. Lengths and KDF policy are checked before derivation. Recovery ciphertext permits a payload up to 1 MiB. The binary payload is magic `TDVPL2` (6 bytes), creation timestamp i64 (8), vault master key (32), profile count u16, then profiles sorted by ID: ID byte length u16, UTF-8 ID bytes, 32-byte key. At most 64 profiles, ID length 1–128 bytes, duplicate IDs and trailing bytes rejected. Recovery replacement archives the old encrypted vault; it does not modify remote envelopes.

Vault and per-file preparations use at most two shared blocking workers, outside the state mutex. Other derivations, such as encrypted settings sync, have independent blocking calls and are not included in this bound. At writer settings the shared preparation pool admits up to 128 MiB of Argon2 memory; maximum accepted settings admit up to 512 MiB. A detached canceled worker retains its permit until finished and cannot commit. Commit revalidates state/session revision and captured file identity/content. A successful atomic replacement is the commit point; later backup cleanup failure is reported in the log without reverting live key state.

## Immutable compatibility evidence

`app/src-tauri/test-support/crypto-vectors/manifest.json` records public inputs and SHA-256 checksums. The 3.9.8 files came from local tag `v3.9.8`, commit `10f470617fd24d955acfda00350d535e1551be48`, using its unchanged encoders with public deterministic entropy and a fixed vault fixture constructor. The dependency versions are recorded; this is source-level compatibility evidence, not an installed historical-binary run. The current vector adds optional `sync_path`. Native child-process journeys reproduce both envelopes byte for byte, reconstruct a continuation, decrypt saved envelopes with the historical vault, restore the historical recovery bundle, restart, and reject truncation, reordered records, bit flips, trailing bytes and an unrelated key without publishing plaintext. The fixture decoder stages plaintext in memory until final verification; this corruption journey does not exercise live Telegram download staging.

No coverage-guided fuzz harness is added under the E2E-only policy. Proposed owner decision: authorize a separate non-release research harness for parser/decryptor fuzzing, preserving saved failing inputs as native journeys. The owner must commission an independent cryptographic review before general availability; neither local journeys nor format freezing substitute for that review.
