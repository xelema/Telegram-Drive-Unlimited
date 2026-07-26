# ADR-0001: TDENC1 Encrypted File Envelope

**Status:** Superseded by ADR-0002; TDENC1 is quarantined and must never be written or reinterpreted as TDENC2  
**Date:** 2026-07-26  
**Author:** DeepSeek V4 Pro  
**Reviewed by:** Pending independent security review  

## Context

Telegram Drive stores files in Telegram cloud chats. To provide client-side encryption before upload, we need a versioned, chunked, random-access authenticated-encryption envelope.

## Decision

### Format Identifier

Magic bytes: `TDENC1` (6 bytes, ASCII)  
Format version: `1` (u16, little-endian)

### Binary Encoding

All multi-byte integer fields use **little-endian** encoding.

### Envelope Structure

```
Offset  Size    Field
------  ----    -----
0       6       Magic "TDENC1"
6       2       Format version (u16 LE)
8       16      File UUID (random 16 bytes)
24      2       Cipher suite identifier (u16 LE): 1 = XChaCha20-Poly1305
26      4       Header length (u32 LE) — total bytes from offset 0 through end of key slot table
30      4       Chunk size in bytes (u32 LE) — default 1048576 (1 MiB)
34      4       Key slot table length (u32 LE)
38      4       Encrypted metadata length (u32 LE)
42      8       Total plaintext length (u64 LE)
50      16      Nonce prefix (random 16 bytes)
66      32      Header commitment SHA-256 (of bytes 0..65)
98      N       Key slot table
98+N    M       Encrypted metadata (ciphertext + 16-byte AEAD tag)
98+N+M  ...     Encrypted content chunks (each: ciphertext + 16-byte AEAD tag)
...     40+16   Final record (chunk_count:u32, plaintext_len:u64, sha256:32, reserved:8 + 16-byte AEAD tag)
```

### Key Slot Table

Each key slot:
```
Offset  Size    Field
------  ----    -----
0       1       Slot kind: 1=vault, 2=passphrase, 3=recovery_key
1       1       Slot ID (u8)
2       2       KDF algorithm: 1=Argon2id, 2=HKDF-SHA256
4       4       Argon2 memory KiB (u32 LE) — or 0 for HKDF
8       4       Argon2 iterations (u32 LE) — or 0 for HKDF
12      4       Argon2 parallelism (u32 LE) — or 0 for HKDF
16      16      Salt (random 16 bytes)
32      12      Wrap nonce (12 bytes for XChaCha20-Poly1305 key wrapping)
44      48      Wrapped DEK + tag (32 bytes DEK + 16 bytes AEAD tag)
```

Max 8 key slots. Total key slot table ≤ 736 bytes.

### Nonce Construction

- Content chunk nonce: `nonce_prefix[0..16] || u64::to_le_bytes(chunk_index)` (24 bytes total)
- Metadata nonce: `nonce_prefix[0..16] || 0xFFFFFFFFFFFFFFFFu64.to_le_bytes()`
- Final record nonce: `nonce_prefix[0..16] || 0xFFFFFFFFFFFFFFFEu64.to_le_bytes()`
- Key wrap nonce: unique 24-byte random per slot (first 12 bytes used as XChaCha20 nonce for key wrap)

### AEAD AAD (Additional Authenticated Data)

For content chunks:
```
format_version:u16 || file_uuid:16 || chunk_index:u64 || plaintext_offset:u64 || plaintext_length:u32 || total_plaintext_length:u64 || total_chunk_count:u32
```

For metadata:
```
format_version:u16 || file_uuid:16 || record_type:"metadata" || metadata_length:u32 || total_plaintext_length:u64
```

For final record:
```
format_version:u16 || file_uuid:16 || record_type:"final" || chunk_count:u32 || verified_plaintext_length:u64
```

For key slot wrap:
```
format_version:u16 || file_uuid:16 || slot_kind:u8 || slot_id:u8 || kdf_algorithm:u16 || memory_kib:u32 || iterations:u32 || parallelism:u32 || salt:16
```

### Limits

| Parameter | Maximum |
|-----------|---------|
| Header total | 64 KiB |
| Key slots | 8 |
| Encrypted metadata | 64 KiB plaintext |
| Chunk size | 64 KiB – 16 MiB |
| File plaintext | Telegram's 2 GiB limit |
| Argon2 memory | 8 MiB – 256 MiB |
| Argon2 iterations | 1 – 100 |
| Argon2 parallelism | 1 – 8 |

### Exact Ciphertext Length

```
ciphertext_length =
    header_length
  + metadata_plaintext_length + 16  (AEAD tag)
  + plaintext_length
  + chunk_count * 16                (AEAD tags)
  + 56                              (final record: 40 plaintext + 16 tag)
```

All arithmetic must be checked for overflow.

### Cipher Suite 1

- AEAD: XChaCha20-Poly1305 (RustCrypto `chacha20poly1305` crate)
- KDF: Argon2id v1.3 (RustCrypto `argon2` crate) or HKDF-SHA-256 (RustCrypto `hkdf` + `sha2`)
- Secret zeroizing: `zeroize` crate
- Random: OS CSPRNG via `getrandom`

### Golden Test Vectors

See `src/crypto/envelope/vectors.rs` for committed known-answer tests covering:
- Zero bytes
- One byte
- Chunk size minus/at/plus one
- Multiple chunks
- Every slot kind
- Maximum metadata within policy
- Wrong key, corrupt header, truncated, reordered chunks

## Consequences

- Plaintext files are never modified by this format
- Old app versions see opaque `.tdenc` files and can download ciphertext
- The format version is immutable; changes require TDENC2
- Requires independent security review before general availability
