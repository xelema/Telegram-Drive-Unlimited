use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::secret::SecretKey;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};

const SLOT_AAD_DOMAIN: &[u8] = b"telegram-drive:tdenc2:key-slot";

/// Context for key-slot wrapping and unwrapping.
pub struct KeySlotContext<'a> {
    pub file_uuid: &'a [u8; 16],
    pub format_version: u16,
}

#[allow(clippy::too_many_arguments)]
fn build_slot_aad(
    ctx: &KeySlotContext<'_>,
    kind: u8,
    slot_id: u8,
    kdf_algorithm: u16,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: &[u8; 16],
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(SLOT_AAD_DOMAIN.len() + 50);
    aad.extend_from_slice(SLOT_AAD_DOMAIN);
    aad.extend_from_slice(&ctx.format_version.to_le_bytes());
    aad.extend_from_slice(ctx.file_uuid);
    aad.push(kind);
    aad.push(slot_id);
    aad.extend_from_slice(&kdf_algorithm.to_le_bytes());
    aad.extend_from_slice(&memory_kib.to_le_bytes());
    aad.extend_from_slice(&iterations.to_le_bytes());
    aad.extend_from_slice(&parallelism.to_le_bytes());
    aad.extend_from_slice(salt);
    aad
}

/// Wrap a DEK with a caller-provided nonce. This is exposed for immutable test
/// vectors; production callers should use [`wrap_dek`].
#[allow(clippy::too_many_arguments)]
pub fn wrap_dek_with_nonce(
    ctx: &KeySlotContext<'_>,
    dek: &SecretKey,
    wrapping_key: &SecretKey,
    kind: u8,
    slot_id: u8,
    kdf_algorithm: u16,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: &[u8; 16],
    wrap_nonce: [u8; 24],
) -> CryptoResult<[u8; 48]> {
    let cipher = XChaCha20Poly1305::new_from_slice(wrapping_key.expose())
        .map_err(|_| CryptoError::internal("Invalid wrapping key"))?;
    let aad = build_slot_aad(
        ctx,
        kind,
        slot_id,
        kdf_algorithm,
        memory_kib,
        iterations,
        parallelism,
        salt,
    );
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&wrap_nonce),
            Payload {
                msg: dek.expose(),
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::internal("DEK wrap failed"))?;
    if ciphertext.len() != 48 {
        return Err(CryptoError::internal("Unexpected wrapped DEK length"));
    }
    let mut wrapped = [0u8; 48];
    wrapped.copy_from_slice(&ciphertext);
    Ok(wrapped)
}

/// Wrap a DEK using XChaCha20-Poly1305 and a complete random 24-byte nonce.
#[allow(clippy::too_many_arguments)]
pub fn wrap_dek(
    ctx: &KeySlotContext<'_>,
    dek: &SecretKey,
    wrapping_key: &SecretKey,
    kind: u8,
    slot_id: u8,
    kdf_algorithm: u16,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: &[u8; 16],
) -> CryptoResult<([u8; 48], [u8; 24])> {
    let nonce = crate::crypto::random::random_wrap_nonce();
    let wrapped = wrap_dek_with_nonce(
        ctx,
        dek,
        wrapping_key,
        kind,
        slot_id,
        kdf_algorithm,
        memory_kib,
        iterations,
        parallelism,
        salt,
        nonce,
    )?;
    Ok((wrapped, nonce))
}

/// Unwrap a DEK using the complete nonce stored in the slot.
#[allow(clippy::too_many_arguments)]
pub fn unwrap_dek(
    ctx: &KeySlotContext<'_>,
    wrapped_dek: &[u8; 48],
    wrap_nonce: &[u8; 24],
    wrapping_key: &SecretKey,
    kind: u8,
    slot_id: u8,
    kdf_algorithm: u16,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: &[u8; 16],
) -> CryptoResult<SecretKey> {
    let cipher = XChaCha20Poly1305::new_from_slice(wrapping_key.expose())
        .map_err(|_| CryptoError::internal("Invalid wrapping key"))?;
    let aad = build_slot_aad(
        ctx,
        kind,
        slot_id,
        kdf_algorithm,
        memory_kib,
        iterations,
        parallelism,
        salt,
    );
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(wrap_nonce),
            Payload {
                msg: wrapped_dek,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::wrong_key_or_corrupt())?;
    if plaintext.len() != 32 {
        return Err(CryptoError::wrong_key_or_corrupt());
    }
    let mut dek = [0u8; 32];
    dek.copy_from_slice(&plaintext);
    Ok(SecretKey::new(dek))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_nonce_round_trip_and_mutation_failure() {
        let uuid = [3u8; 16];
        let salt = [4u8; 16];
        let nonce = [5u8; 24];
        let dek = SecretKey::new([6u8; 32]);
        let wrapping_key = SecretKey::new([7u8; 32]);
        let ctx = KeySlotContext {
            file_uuid: &uuid,
            format_version: 2,
        };
        let wrapped =
            wrap_dek_with_nonce(&ctx, &dek, &wrapping_key, 1, 0, 2, 0, 0, 0, &salt, nonce).unwrap();
        let unwrapped = unwrap_dek(
            &ctx,
            &wrapped,
            &nonce,
            &wrapping_key,
            1,
            0,
            2,
            0,
            0,
            0,
            &salt,
        )
        .unwrap();
        assert_eq!(dek.expose(), unwrapped.expose());

        let mut mutated_nonce = nonce;
        mutated_nonce[23] ^= 1;
        assert!(unwrap_dek(
            &ctx,
            &wrapped,
            &mutated_nonce,
            &wrapping_key,
            1,
            0,
            2,
            0,
            0,
            0,
            &salt,
        )
        .is_err());
    }
}
