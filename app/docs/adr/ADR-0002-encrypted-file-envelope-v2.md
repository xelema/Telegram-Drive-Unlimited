# ADR-0002: TDENC2 Authenticated File Envelope

**Status:** Accepted for application upload/read; independent cryptographic review still required before making external interoperability claims  
**Date:** 2026-07-26  
**Supersedes:** ADR-0001  

## Context

The TDENC1 prototype was internally inconsistent and unsafe to continue: its serialized key slot retained only 12 bytes of a 24-byte XChaCha20 nonce, its header commitment was unkeyed, and its length formula counted metadata twice. TDENC1 objects are preserved as opaque ciphertext but are never decrypted, migrated, or interpreted as TDENC2.

TDENC2 provides a versioned, chunked authenticated envelope for client-side encryption before Telegram upload. All multi-byte integers are little-endian. A format change requires a new magic/version and new test vectors.

## Binary layout

Magic is the six ASCII bytes `TDENC2`; the version field is `2` (`u16`). The fixed core is 98 bytes:

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 6 | Magic `TDENC2` |
| 6 | 2 | Format version |
| 8 | 16 | Random file UUID |
| 24 | 2 | Cipher suite (`1` = XChaCha20-Poly1305) |
| 26 | 4 | Complete header length |
| 30 | 4 | Plaintext chunk size |
| 34 | 4 | Key-slot table length |
| 38 | 4 | Encrypted metadata length, including its AEAD tag |
| 42 | 8 | Total plaintext content length |
| 50 | 16 | Random nonce prefix |
| 66 | 32 | Keyed header authenticator |

The core is followed by one to eight 104-byte key slots, then optional encrypted metadata, content records, and one mandatory 68-byte final record.

Each key slot is encoded as:

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 1 | Kind (`1` vault, `2` passphrase, `3` recovery) |
| 1 | 1 | Unique slot ID |
| 2 | 2 | KDF (`1` Argon2id, `2` HKDF-SHA-256) |
| 4 | 4 | Argon2 memory KiB, or zero for HKDF |
| 8 | 4 | Argon2 iterations, or zero for HKDF |
| 12 | 4 | Argon2 parallelism, or zero for HKDF |
| 16 | 16 | Per-slot random salt |
| 32 | 24 | Complete random XChaCha20 wrap nonce |
| 56 | 48 | Wrapped 32-byte DEK plus 16-byte tag |

Slot IDs must be unique. Slot kind/KDF combinations and Argon2 parameters are validated before any expensive derivation. Current Argon2 policy is 64–256 MiB, 3–100 iterations, and parallelism 1–8; writers use the policy floor pending platform benchmarking.

## Key derivation and wrapping

A file has a random 32-byte DEK. Content, metadata, and header-authentication keys are separately derived from the DEK with HKDF-SHA-256 domains:

- `telegram-drive:content-enc:v2`
- `telegram-drive:metadata-enc:v2`
- `telegram-drive:header-auth:v2`

Vault slots first derive a file-specific wrapping key using the slot salt and an info value containing `telegram-drive:file-wrap:v2`, file UUID, slot kind, and slot ID. Passphrase slots derive their wrapping key directly with the serialized Argon2id parameters and salt. The DEK is wrapped with XChaCha20-Poly1305.

Key-slot AAD is the domain `telegram-drive:tdenc2:key-slot` followed by version, file UUID, slot kind, slot ID, KDF, Argon2 fields, and salt. A slot cannot be copied to another file or changed without authentication failure.

## Header and metadata authentication

The 66-byte core prefix excludes the 32-byte authenticator. The authenticator is HMAC-SHA-256 over:

`"telegram-drive:tdenc2:header-mac" || core_prefix || slot_table || encrypted_metadata`

Metadata is optional. When present, it is XChaCha20-Poly1305 encrypted with nonce index `u64::MAX`. Its AAD is:

`"telegram-drive:tdenc2:metadata" || core_prefix || slot_table`

The current metadata schema contains the original filename and MIME type. When metadata protection is disabled, the metadata record is absent rather than counted as a zero-length tagged record.

## Content and final record

Nonces are `nonce_prefix[16] || index:u64`. Content indices begin at zero. The final record uses `u64::MAX - 1`; metadata uses `u64::MAX`.

Each content record encrypts at most `chunk_size` plaintext bytes. Its AAD is:

`"telegram-drive:tdenc2:chunk" || version:u16 || file_uuid || header_authenticator || chunk_index:u64 || plaintext_offset:u64 || plaintext_length:u32 || total_plaintext_length:u64`

The mandatory final plaintext is 52 bytes: chunk count (`u32`), total plaintext length (`u64`), SHA-256 of all plaintext content (32 bytes), and eight reserved zero bytes. Its AAD is:

`"telegram-drive:tdenc2:final" || version:u16 || file_uuid || header_authenticator || chunk_count:u32 || total_plaintext_length:u64`

Readers authenticate the complete header before emitting plaintext, authenticate each record before writing its plaintext, require the final record, and reject truncation, reordering, mutation, trailing data, source growth, and source shrinkage.

## Exact length

For `P` plaintext bytes, chunk size `C`, complete header length `H`, and `N = ceil(P/C)` (zero when `P` is zero):

`ciphertext_length = H + P + (N × 16) + 68`

`H = 98 + (slot_count × 104) + encrypted_metadata_length`

Encrypted metadata length is zero when absent, otherwise metadata plaintext length plus 16. All arithmetic is checked, and the resulting ciphertext must not exceed Telegram’s configured file limit.

## Operational rules

- TDENC1 is read-only quarantine material. Its magic is rejected as unsupported version 1.
- Plaintext and secrets must not be logged. Passphrases use short-lived, opaque, single-use prompt tokens and are never stored in queues or settings.
- A verified download is written to a unique owner-only partial file, synced, then atomically renamed. Cancellation or authentication failure removes the partial file.
- Registry failure after a successful remote operation is surfaced as reconciliation-required; it is never silently reported as a fully indexed success.
- Existing plaintext upload, download, sharing, preview, and advertisement paths remain unchanged.
- Encrypted sharing, preview, archive, streaming, rename, and local API media routes stay fail-closed until they consume a credential-scoped decrypted media source.

## Verification evidence

The committed tests cover a fixed TDENC2 known-answer vector, zero/one/chunk-boundary sizes, partial `AsyncRead` behavior, full nonce mutation, header/metadata/content mutation, wrong credentials, truncation, trailing bytes, persistent-vault restart, passphrase change, authenticated recovery, and single-use prompt tokens. Recovery must restore the original vault key; importing an invalid bundle must not alter an existing vault.
