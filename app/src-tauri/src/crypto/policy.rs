//! Crypto policy: limits, suites, and feature flags.

/// Magic bytes for the corrected TDENC2 envelope format.
pub const MAGIC: &[u8; 6] = b"TDENC2";

/// Quarantined prototype magic. Never reinterpret these bytes as TDENC2.
pub const EXPERIMENTAL_TDENC1_MAGIC: &[u8; 6] = b"TDENC1";

/// Current format version.
pub const FORMAT_VERSION: u16 = 2;

/// Cipher suite: XChaCha20-Poly1305.
pub const CIPHER_SUITE_XCHACHA20_POLY1305: u16 = 1;

/// AEAD tag length for Poly1305 (16 bytes).
pub const AEAD_TAG_LENGTH: usize = 16;

/// XChaCha20 nonce length (24 bytes).
pub const XCHACHA_NONCE_LENGTH: usize = 24;

/// XChaCha20 key length (32 bytes).
pub const XCHACHA_KEY_LENGTH: usize = 32;

/// Nonce prefix length (16 random bytes + 8 for chunk index = 24 total).
pub const NONCE_PREFIX_LENGTH: usize = 16;

/// File UUID length (16 bytes).
pub const FILE_UUID_LENGTH: usize = 16;

/// DEK length (32 bytes).
pub const DEK_LENGTH: usize = 32;

/// Salt length for Argon2id (16 bytes).
pub const SALT_LENGTH: usize = 16;

/// Default plaintext chunk size: 1 MiB.
pub const DEFAULT_CHUNK_SIZE: u32 = 1_048_576;

/// Minimum allowed chunk size: 64 KiB.
pub const MIN_CHUNK_SIZE: u32 = 65_536;

/// Maximum allowed chunk size: 16 MiB.
pub const MAX_CHUNK_SIZE: u32 = 16_777_216;

/// Maximum number of key slots per file.
pub const MAX_KEY_SLOTS: usize = 8;

/// Maximum header length (64 KiB).
pub const MAX_HEADER_LENGTH: usize = 65_536;

/// Maximum encrypted metadata plaintext length (64 KiB).
pub const MAX_METADATA_LENGTH: usize = 65_536;

/// Fixed core header size: magic(6) + version(2) + uuid(16) + suite(2) + header_len(4) +
/// chunk_size(4) + slot_table_len(4) + metadata_len(4) + plaintext_len(8) +
/// nonce_prefix(16) + keyed_header_authenticator(32) = 98 bytes.
pub const CORE_HEADER_SIZE: usize = 98;
pub const CORE_PREFIX_SIZE: usize = 66;
pub const HEADER_AUTH_LENGTH: usize = 32;

/// Final record plaintext size: chunk_count(4) + plaintext_len(8) + sha256(32) + reserved(8) = 52 bytes.
/// + AEAD tag(16) = 68 bytes total.
pub const FINAL_RECORD_PLAINTEXT_SIZE: usize = 52;
pub const FINAL_RECORD_CIPHERTEXT_SIZE: usize = FINAL_RECORD_PLAINTEXT_SIZE + AEAD_TAG_LENGTH;

/// Per-key-slot size: kind(1) + id(1) + kdf(2) + mem(4) + iter(4) + para(4) + salt(16) +
/// full XChaCha wrap_nonce(24) + wrapped_dek_tag(48) = 104 bytes.
pub const KEY_SLOT_SIZE: usize = 104;

/// Reserved nonce indices. Content chunks use indices starting at zero.
pub const FINAL_RECORD_NONCE_INDEX: u64 = u64::MAX - 1;
pub const METADATA_NONCE_INDEX: u64 = u64::MAX;

/// Argon2id parameter floor (RFC 9106 constrained recommendation).
pub const ARGON2_MEMORY_FLOOR_KIB: u32 = 65_536; // 64 MiB
pub const ARGON2_MEMORY_CEILING_KIB: u32 = 262_144; // 256 MiB
pub const ARGON2_ITERATIONS_FLOOR: u32 = 3;
pub const ARGON2_ITERATIONS_CEILING: u32 = 100;
pub const ARGON2_PARALLELISM_FLOOR: u32 = 1;
pub const ARGON2_PARALLELISM_CEILING: u32 = 8;
pub const ARGON2_OUTPUT_LENGTH: usize = 32; // 256-bit output

/// Telegram's approximate 2 GiB file size limit.
pub const TELEGRAM_MAX_FILE_SIZE: u64 = 2_000_000_000;

/// Maximum ciphertext size after encryption (must stay under Telegram limit).
pub const MAX_CIPHERTEXT_SIZE: u64 = TELEGRAM_MAX_FILE_SIZE;

/// Key slot kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SlotKind {
    Vault = 1,
    Passphrase = 2,
    RecoveryKey = 3,
}

/// KDF algorithms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum KdfAlgorithm {
    Argon2id = 1,
    HkdfSha256 = 2,
}

/// Encryption feature flags for staged rollout.
#[derive(Debug, Clone)]
pub struct CryptoFeatureFlags {
    pub core_available: bool,
    pub mode_alpha: bool,
    pub upload_enabled: bool,
    pub read_enabled: bool,
    pub share_enabled: bool,
    pub migration_enabled: bool,
}

impl Default for CryptoFeatureFlags {
    fn default() -> Self {
        // TDENC2 upload/read and the persistent vault have passed their local
        // format, mutation, restart, and recovery gates. Credential-safe remote
        // sharing and legacy migration remain independently fail-closed.
        Self {
            core_available: true,
            mode_alpha: true,
            upload_enabled: true,
            read_enabled: true,
            share_enabled: false,
            migration_enabled: false,
        }
    }
}

/// Validate Argon2id parameters against the approved range.
pub fn validate_argon2_params(
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<(u32, u32, u32), crate::crypto::error::CryptoError> {
    use crate::crypto::error::{CryptoError, CryptoErrorCode};

    if !(ARGON2_MEMORY_FLOOR_KIB..=ARGON2_MEMORY_CEILING_KIB).contains(&memory_kib)
        || !(ARGON2_ITERATIONS_FLOOR..=ARGON2_ITERATIONS_CEILING).contains(&iterations)
        || !(ARGON2_PARALLELISM_FLOOR..=ARGON2_PARALLELISM_CEILING).contains(&parallelism)
    {
        return Err(CryptoError::new(
            CryptoErrorCode::PolicyRejected,
            "Argon2 parameters are outside the approved policy range",
        ));
    }

    Ok((memory_kib, iterations, parallelism))
}

/// Validate chunk size is within approved range.
pub fn validate_chunk_size(size: u32) -> Result<u32, crate::crypto::error::CryptoError> {
    use crate::crypto::error::{CryptoError, CryptoErrorCode};

    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&size) {
        return Err(CryptoError::new(
            CryptoErrorCode::PolicyRejected,
            format!(
                "Chunk size {} outside range [{}, {}]",
                size, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE
            ),
        ));
    }
    Ok(size)
}
