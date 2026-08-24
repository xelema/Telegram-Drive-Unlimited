use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::{kdf, policy, random};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};

const RECOVERY_MAGIC: &[u8; 6] = b"TDREC2";
const RECOVERY_VERSION: u16 = 2;
const RECOVERY_AAD_DOMAIN: &[u8] = b"telegram-drive:recovery-bundle:v2";
const RECOVERY_HEADER_SIZE: usize = 64;
const MAX_RECOVERY_PAYLOAD: usize = 1024 * 1024;

fn encode_header(salt: &[u8; 16], nonce: &[u8; 24], ciphertext_length: u32) -> Vec<u8> {
    let mut header = Vec::with_capacity(RECOVERY_HEADER_SIZE);
    header.extend_from_slice(RECOVERY_MAGIC);
    header.extend_from_slice(&RECOVERY_VERSION.to_le_bytes());
    header.extend_from_slice(&policy::ARGON2_MEMORY_FLOOR_KIB.to_le_bytes());
    header.extend_from_slice(&policy::ARGON2_ITERATIONS_FLOOR.to_le_bytes());
    header.extend_from_slice(&policy::ARGON2_PARALLELISM_FLOOR.to_le_bytes());
    header.extend_from_slice(salt);
    header.extend_from_slice(nonce);
    header.extend_from_slice(&ciphertext_length.to_le_bytes());
    debug_assert_eq!(header.len(), RECOVERY_HEADER_SIZE);
    header
}

/// Encrypt an opaque vault payload into a versioned recovery bundle.
pub fn create_recovery_bundle(payload: &[u8], recovery_passphrase: &[u8]) -> CryptoResult<Vec<u8>> {
    if payload.is_empty() || payload.len() > MAX_RECOVERY_PAYLOAD {
        return Err(CryptoError::new(
            crate::crypto::error::CryptoErrorCode::PolicyRejected,
            "Recovery payload is outside policy",
        ));
    }
    if recovery_passphrase.len() < 8 {
        return Err(CryptoError::new(
            crate::crypto::error::CryptoErrorCode::PolicyRejected,
            "Recovery passphrase is too short",
        ));
    }
    let salt = random::random_salt();
    let nonce = random::random_wrap_nonce();
    let key = kdf::derive_passphrase_key(
        recovery_passphrase,
        &salt,
        policy::ARGON2_MEMORY_FLOOR_KIB,
        policy::ARGON2_ITERATIONS_FLOOR,
        policy::ARGON2_PARALLELISM_FLOOR,
    )?;
    let ciphertext_length = payload
        .len()
        .checked_add(policy::AEAD_TAG_LENGTH)
        .ok_or_else(CryptoError::size_overflow)?;
    let header = encode_header(&salt, &nonce, ciphertext_length as u32);
    let mut aad = Vec::with_capacity(RECOVERY_AAD_DOMAIN.len() + header.len());
    aad.extend_from_slice(RECOVERY_AAD_DOMAIN);
    aad.extend_from_slice(&header);
    let cipher = XChaCha20Poly1305::new_from_slice(key.expose())
        .map_err(|_| CryptoError::internal("Invalid recovery key"))?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: payload,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::internal("Recovery export encryption failed"))?;
    if ciphertext.len() != ciphertext_length {
        return Err(CryptoError::internal("Recovery ciphertext length mismatch"));
    }
    let mut bundle = header;
    bundle.extend_from_slice(&ciphertext);
    Ok(bundle)
}

/// Decrypt and authenticate a recovery bundle.
pub fn import_recovery_bundle(bundle: &[u8], recovery_passphrase: &[u8]) -> CryptoResult<Vec<u8>> {
    if bundle.len() < RECOVERY_HEADER_SIZE + policy::AEAD_TAG_LENGTH {
        return Err(CryptoError::truncated());
    }
    if &bundle[..6] != RECOVERY_MAGIC {
        return Err(CryptoError::header_invalid("Invalid recovery magic"));
    }
    let version = u16::from_le_bytes([bundle[6], bundle[7]]);
    if version != RECOVERY_VERSION {
        return Err(CryptoError::unsupported_version(version));
    }
    let memory = u32::from_le_bytes(
        bundle[8..12]
            .try_into()
            .map_err(|_| CryptoError::truncated())?,
    );
    let iterations = u32::from_le_bytes(
        bundle[12..16]
            .try_into()
            .map_err(|_| CryptoError::truncated())?,
    );
    let parallelism = u32::from_le_bytes(
        bundle[16..20]
            .try_into()
            .map_err(|_| CryptoError::truncated())?,
    );
    policy::validate_argon2_params(memory, iterations, parallelism)?;
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&bundle[20..36]);
    let mut nonce = [0u8; 24];
    nonce.copy_from_slice(&bundle[36..60]);
    let ciphertext_length = u32::from_le_bytes(
        bundle[60..64]
            .try_into()
            .map_err(|_| CryptoError::truncated())?,
    ) as usize;
    if !(policy::AEAD_TAG_LENGTH..=MAX_RECOVERY_PAYLOAD + policy::AEAD_TAG_LENGTH)
        .contains(&ciphertext_length)
        || bundle.len() != RECOVERY_HEADER_SIZE + ciphertext_length
    {
        return Err(CryptoError::header_invalid(
            "Invalid recovery ciphertext length",
        ));
    }
    let key =
        kdf::derive_passphrase_key(recovery_passphrase, &salt, memory, iterations, parallelism)?;
    let header = &bundle[..RECOVERY_HEADER_SIZE];
    let mut aad = Vec::with_capacity(RECOVERY_AAD_DOMAIN.len() + header.len());
    aad.extend_from_slice(RECOVERY_AAD_DOMAIN);
    aad.extend_from_slice(header);
    let cipher = XChaCha20Poly1305::new_from_slice(key.expose())
        .map_err(|_| CryptoError::internal("Invalid recovery key"))?;
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &bundle[RECOVERY_HEADER_SIZE..],
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::wrong_key_or_corrupt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_round_trip_and_fail_closed() {
        let payload = b"vault payload";
        let bundle = create_recovery_bundle(payload, b"correct horse battery staple").unwrap();
        assert_eq!(
            import_recovery_bundle(&bundle, b"correct horse battery staple").unwrap(),
            payload
        );
        assert!(import_recovery_bundle(&bundle, b"wrong passphrase").is_err());
        let mut mutated = bundle;
        *mutated.last_mut().unwrap() ^= 1;
        assert!(import_recovery_bundle(&mutated, b"correct horse battery staple").is_err());
    }
}
