use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::policy;
use crate::crypto::secret::SecretKey;
use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use sha2::Sha256;

/// Derive a 256-bit key from a passphrase using Argon2id.
pub fn derive_passphrase_key(
    passphrase: &[u8],
    salt: &[u8; 16],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> CryptoResult<SecretKey> {
    let (memory_kib, iterations, parallelism) =
        policy::validate_argon2_params(memory_kib, iterations, parallelism)?;

    let params = Params::new(
        memory_kib,
        iterations,
        parallelism,
        Some(policy::ARGON2_OUTPUT_LENGTH),
    )
    .map_err(|e| CryptoError::internal(format!("Invalid Argon2 params: {}", e)))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut output = [0u8; 32];
    argon2
        .hash_password_into(passphrase, salt, &mut output)
        .map_err(|e| CryptoError::internal(format!("Argon2 hash failed: {}", e)))?;

    Ok(SecretKey::new(output))
}

/// Derive a domain-separated key from high-entropy key material using HKDF-SHA-256.
pub fn derive_domain_key(ikm: &[u8], domain: &[u8], output_len: usize) -> CryptoResult<Vec<u8>> {
    let hkdf = Hkdf::<Sha256>::new(None, ikm);
    let mut output = vec![0u8; output_len];
    hkdf.expand(domain, &mut output)
        .map_err(|e| CryptoError::internal(format!("HKDF expand failed: {}", e)))?;
    Ok(output)
}

/// Derive a 32-byte domain-separated key using HKDF-SHA-256.
pub fn derive_domain_key_32(ikm: &[u8], domain: &[u8]) -> CryptoResult<SecretKey> {
    let output = derive_domain_key(ikm, domain, 32)?;
    let mut key = [0u8; 32];
    key.copy_from_slice(&output);
    Ok(SecretKey::new(key))
}

/// Derive a file-specific wrapping key from a vault/recovery master key. The
/// per-slot salt and file UUID prevent cross-file key reuse.
pub fn derive_file_wrapping_key(
    master_key: &SecretKey,
    file_uuid: &[u8; 16],
    salt: &[u8; 16],
    slot_kind: u8,
    slot_id: u8,
) -> CryptoResult<SecretKey> {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), master_key.expose());
    let mut info = Vec::with_capacity(domains::FILE_WRAP.len() + 18);
    info.extend_from_slice(domains::FILE_WRAP);
    info.extend_from_slice(file_uuid);
    info.push(slot_kind);
    info.push(slot_id);
    let mut output = [0u8; 32];
    hkdf.expand(&info, &mut output)
        .map_err(|_| CryptoError::internal("File wrapping-key derivation failed"))?;
    Ok(SecretKey::new(output))
}

/// Domain separation labels for HKDF.
pub mod domains {
    pub const VAULT_KEK: &[u8] = b"telegram-drive:vault-kek:v2";
    pub const FILE_WRAP: &[u8] = b"telegram-drive:file-wrap:v2";
    pub const METADATA_ENC: &[u8] = b"telegram-drive:metadata-enc:v2";
    pub const CONTENT_ENC: &[u8] = b"telegram-drive:content-enc:v2";
    pub const HEADER_AUTH: &[u8] = b"telegram-drive:header-auth:v2";
    pub const CACHE_ENC: &[u8] = b"telegram-drive:cache-enc:v1";
    pub const SEARCH_INDEX: &[u8] = b"telegram-drive:search-index:v1";
    pub const RECOVERY_EXPORT: &[u8] = b"telegram-drive:recovery-export:v2";
}
