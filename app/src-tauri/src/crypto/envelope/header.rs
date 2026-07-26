use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::kdf;
use crate::crypto::policy;
use crate::crypto::secret::SecretKey;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashSet;

type HmacSha256 = Hmac<Sha256>;

const HEADER_MAC_DOMAIN: &[u8] = b"telegram-drive:tdenc2:header-mac";
const METADATA_AAD_DOMAIN: &[u8] = b"telegram-drive:tdenc2:metadata";

#[derive(Debug, Clone)]
pub struct CoreHeader {
    pub format_version: u16,
    pub file_uuid: [u8; 16],
    pub cipher_suite: u16,
    /// Complete header length, including slots and encrypted metadata.
    pub header_length: u32,
    pub chunk_size: u32,
    pub key_slot_table_length: u32,
    pub encrypted_metadata_length: u32,
    pub total_plaintext_length: u64,
    pub nonce_prefix: [u8; 16],
    pub header_authenticator: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySlotEntry {
    pub kind: u8,
    pub slot_id: u8,
    pub kdf_algorithm: u16,
    pub argon2_memory_kib: u32,
    pub argon2_iterations: u32,
    pub argon2_parallelism: u32,
    pub salt: [u8; 16],
    pub wrap_nonce: [u8; 24],
    pub wrapped_dek: [u8; 48],
}

#[derive(Debug, Clone)]
pub struct EnvelopeHeader {
    pub core: CoreHeader,
    pub key_slots: Vec<KeySlotEntry>,
    pub encrypted_metadata: Vec<u8>,
    raw_header: Vec<u8>,
}

fn u16_at(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

fn u32_at(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ])
}

fn u64_at(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
    ])
}

fn record_nonce(prefix: &[u8; 16], index: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[..16].copy_from_slice(prefix);
    nonce[16..].copy_from_slice(&index.to_le_bytes());
    nonce
}

impl CoreHeader {
    pub fn parse(data: &[u8]) -> CryptoResult<Self> {
        if data.len() < policy::CORE_HEADER_SIZE {
            return Err(CryptoError::truncated());
        }
        if &data[..6] == policy::EXPERIMENTAL_TDENC1_MAGIC {
            return Err(CryptoError::unsupported_version(1));
        }
        if &data[..6] != policy::MAGIC {
            return Err(CryptoError::header_invalid("Invalid envelope magic"));
        }

        let format_version = u16_at(data, 6);
        if format_version != policy::FORMAT_VERSION {
            return Err(CryptoError::unsupported_version(format_version));
        }
        let cipher_suite = u16_at(data, 24);
        if cipher_suite != policy::CIPHER_SUITE_XCHACHA20_POLY1305 {
            return Err(CryptoError::header_invalid("Unsupported cipher suite"));
        }

        let header_length = u32_at(data, 26);
        if !(policy::CORE_HEADER_SIZE..=policy::MAX_HEADER_LENGTH)
            .contains(&(header_length as usize))
        {
            return Err(CryptoError::header_invalid(
                "Header length is outside policy",
            ));
        }

        let chunk_size = policy::validate_chunk_size(u32_at(data, 30))?;
        let key_slot_table_length = u32_at(data, 34);
        if key_slot_table_length == 0
            || key_slot_table_length as usize % policy::KEY_SLOT_SIZE != 0
            || key_slot_table_length as usize
                > policy::MAX_KEY_SLOTS.saturating_mul(policy::KEY_SLOT_SIZE)
        {
            return Err(CryptoError::header_invalid("Invalid key-slot table length"));
        }

        let encrypted_metadata_length = u32_at(data, 38);
        if encrypted_metadata_length != 0
            && (encrypted_metadata_length < policy::AEAD_TAG_LENGTH as u32
                || encrypted_metadata_length as usize
                    > policy::MAX_METADATA_LENGTH + policy::AEAD_TAG_LENGTH)
        {
            return Err(CryptoError::header_invalid(
                "Invalid encrypted metadata length",
            ));
        }

        let expected_header_length = policy::CORE_HEADER_SIZE
            .checked_add(key_slot_table_length as usize)
            .and_then(|value| value.checked_add(encrypted_metadata_length as usize))
            .ok_or_else(CryptoError::size_overflow)?;
        if expected_header_length != header_length as usize {
            return Err(CryptoError::header_invalid(
                "Header component lengths do not match complete header length",
            ));
        }

        let mut file_uuid = [0u8; 16];
        file_uuid.copy_from_slice(&data[8..24]);
        let mut nonce_prefix = [0u8; 16];
        nonce_prefix.copy_from_slice(&data[50..66]);
        let mut header_authenticator = [0u8; 32];
        header_authenticator.copy_from_slice(&data[66..98]);

        Ok(Self {
            format_version,
            file_uuid,
            cipher_suite,
            header_length,
            chunk_size,
            key_slot_table_length,
            encrypted_metadata_length,
            total_plaintext_length: u64_at(data, 42),
            nonce_prefix,
            header_authenticator,
        })
    }

    fn encode_prefix(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(policy::CORE_PREFIX_SIZE);
        bytes.extend_from_slice(policy::MAGIC);
        bytes.extend_from_slice(&self.format_version.to_le_bytes());
        bytes.extend_from_slice(&self.file_uuid);
        bytes.extend_from_slice(&self.cipher_suite.to_le_bytes());
        bytes.extend_from_slice(&self.header_length.to_le_bytes());
        bytes.extend_from_slice(&self.chunk_size.to_le_bytes());
        bytes.extend_from_slice(&self.key_slot_table_length.to_le_bytes());
        bytes.extend_from_slice(&self.encrypted_metadata_length.to_le_bytes());
        bytes.extend_from_slice(&self.total_plaintext_length.to_le_bytes());
        bytes.extend_from_slice(&self.nonce_prefix);
        debug_assert_eq!(bytes.len(), policy::CORE_PREFIX_SIZE);
        bytes
    }

    pub fn chunk_count(&self) -> u32 {
        crate::crypto::envelope::length::calculate_chunk_count(
            self.total_plaintext_length,
            self.chunk_size,
        )
    }
}

impl KeySlotEntry {
    fn validate(&self) -> CryptoResult<()> {
        match (self.kind, self.kdf_algorithm) {
            (kind, kdf)
                if kind == policy::SlotKind::Vault as u8
                    && kdf == policy::KdfAlgorithm::HkdfSha256 as u16 =>
            {
                if self.argon2_memory_kib != 0
                    || self.argon2_iterations != 0
                    || self.argon2_parallelism != 0
                {
                    return Err(CryptoError::header_invalid(
                        "Vault slot contains unexpected Argon2 parameters",
                    ));
                }
            }
            (kind, kdf)
                if kind == policy::SlotKind::Passphrase as u8
                    && kdf == policy::KdfAlgorithm::Argon2id as u16 =>
            {
                policy::validate_argon2_params(
                    self.argon2_memory_kib,
                    self.argon2_iterations,
                    self.argon2_parallelism,
                )?;
            }
            (kind, kdf)
                if kind == policy::SlotKind::RecoveryKey as u8
                    && kdf == policy::KdfAlgorithm::HkdfSha256 as u16 =>
            {
                if self.argon2_memory_kib != 0
                    || self.argon2_iterations != 0
                    || self.argon2_parallelism != 0
                {
                    return Err(CryptoError::header_invalid(
                        "Recovery slot contains unexpected Argon2 parameters",
                    ));
                }
            }
            _ => {
                return Err(CryptoError::header_invalid(
                    "Unsupported key-slot kind or KDF combination",
                ));
            }
        }
        Ok(())
    }

    pub fn parse(data: &[u8], offset: usize) -> CryptoResult<Self> {
        let end = offset
            .checked_add(policy::KEY_SLOT_SIZE)
            .ok_or_else(CryptoError::size_overflow)?;
        if end > data.len() {
            return Err(CryptoError::truncated());
        }
        let slot = &data[offset..end];
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&slot[16..32]);
        let mut wrap_nonce = [0u8; 24];
        wrap_nonce.copy_from_slice(&slot[32..56]);
        let mut wrapped_dek = [0u8; 48];
        wrapped_dek.copy_from_slice(&slot[56..104]);

        let parsed = Self {
            kind: slot[0],
            slot_id: slot[1],
            kdf_algorithm: u16_at(slot, 2),
            argon2_memory_kib: u32_at(slot, 4),
            argon2_iterations: u32_at(slot, 8),
            argon2_parallelism: u32_at(slot, 12),
            salt,
            wrap_nonce,
            wrapped_dek,
        };
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn encode(&self) -> CryptoResult<Vec<u8>> {
        self.validate()?;
        let mut bytes = Vec::with_capacity(policy::KEY_SLOT_SIZE);
        bytes.push(self.kind);
        bytes.push(self.slot_id);
        bytes.extend_from_slice(&self.kdf_algorithm.to_le_bytes());
        bytes.extend_from_slice(&self.argon2_memory_kib.to_le_bytes());
        bytes.extend_from_slice(&self.argon2_iterations.to_le_bytes());
        bytes.extend_from_slice(&self.argon2_parallelism.to_le_bytes());
        bytes.extend_from_slice(&self.salt);
        bytes.extend_from_slice(&self.wrap_nonce);
        bytes.extend_from_slice(&self.wrapped_dek);
        debug_assert_eq!(bytes.len(), policy::KEY_SLOT_SIZE);
        Ok(bytes)
    }
}

impl EnvelopeHeader {
    pub fn parse(data: &[u8]) -> CryptoResult<Self> {
        let core = CoreHeader::parse(data)?;
        let complete_length = core.header_length as usize;
        if data.len() < complete_length {
            return Err(CryptoError::truncated());
        }

        let slot_count = core.key_slot_table_length as usize / policy::KEY_SLOT_SIZE;
        let mut key_slots = Vec::with_capacity(slot_count);
        let mut slot_ids = HashSet::with_capacity(slot_count);
        for index in 0..slot_count {
            let offset = policy::CORE_HEADER_SIZE + index * policy::KEY_SLOT_SIZE;
            let slot = KeySlotEntry::parse(data, offset)?;
            if !slot_ids.insert(slot.slot_id) {
                return Err(CryptoError::header_invalid("Duplicate key-slot ID"));
            }
            key_slots.push(slot);
        }

        let metadata_offset = policy::CORE_HEADER_SIZE + core.key_slot_table_length as usize;
        let metadata_end = metadata_offset
            .checked_add(core.encrypted_metadata_length as usize)
            .ok_or_else(CryptoError::size_overflow)?;
        if metadata_end != complete_length || metadata_end > data.len() {
            return Err(CryptoError::truncated());
        }
        let encrypted_metadata = data[metadata_offset..metadata_end].to_vec();

        Ok(Self {
            core,
            key_slots,
            encrypted_metadata,
            raw_header: data[..complete_length].to_vec(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build(
        file_uuid: [u8; 16],
        chunk_size: u32,
        key_slots: Vec<KeySlotEntry>,
        metadata_plaintext: &[u8],
        total_plaintext_length: u64,
        nonce_prefix: [u8; 16],
        dek: &SecretKey,
    ) -> CryptoResult<Vec<u8>> {
        policy::validate_chunk_size(chunk_size)?;
        if key_slots.is_empty() || key_slots.len() > policy::MAX_KEY_SLOTS {
            return Err(CryptoError::header_invalid("Invalid key-slot count"));
        }
        if metadata_plaintext.len() > policy::MAX_METADATA_LENGTH {
            return Err(CryptoError::header_invalid("Metadata exceeds policy"));
        }

        let mut slot_ids = HashSet::with_capacity(key_slots.len());
        let mut slot_bytes = Vec::with_capacity(key_slots.len() * policy::KEY_SLOT_SIZE);
        for slot in &key_slots {
            if !slot_ids.insert(slot.slot_id) {
                return Err(CryptoError::header_invalid("Duplicate key-slot ID"));
            }
            slot_bytes.extend_from_slice(&slot.encode()?);
        }

        let metadata_ciphertext_length = if metadata_plaintext.is_empty() {
            0usize
        } else {
            metadata_plaintext
                .len()
                .checked_add(policy::AEAD_TAG_LENGTH)
                .ok_or_else(CryptoError::size_overflow)?
        };
        let complete_header_length = policy::CORE_HEADER_SIZE
            .checked_add(slot_bytes.len())
            .and_then(|value| value.checked_add(metadata_ciphertext_length))
            .ok_or_else(CryptoError::size_overflow)?;
        if complete_header_length > policy::MAX_HEADER_LENGTH {
            return Err(CryptoError::header_invalid("Header exceeds policy"));
        }

        let core = CoreHeader {
            format_version: policy::FORMAT_VERSION,
            file_uuid,
            cipher_suite: policy::CIPHER_SUITE_XCHACHA20_POLY1305,
            header_length: complete_header_length as u32,
            chunk_size,
            key_slot_table_length: slot_bytes.len() as u32,
            encrypted_metadata_length: metadata_ciphertext_length as u32,
            total_plaintext_length,
            nonce_prefix,
            header_authenticator: [0u8; 32],
        };
        let prefix = core.encode_prefix();

        let encrypted_metadata = if metadata_plaintext.is_empty() {
            Vec::new()
        } else {
            let metadata_key = kdf::derive_domain_key_32(dek.expose(), kdf::domains::METADATA_ENC)?;
            let cipher = XChaCha20Poly1305::new_from_slice(metadata_key.expose())
                .map_err(|_| CryptoError::internal("Invalid metadata key"))?;
            let mut aad =
                Vec::with_capacity(METADATA_AAD_DOMAIN.len() + prefix.len() + slot_bytes.len());
            aad.extend_from_slice(METADATA_AAD_DOMAIN);
            aad.extend_from_slice(&prefix);
            aad.extend_from_slice(&slot_bytes);
            cipher
                .encrypt(
                    XNonce::from_slice(&record_nonce(&nonce_prefix, policy::METADATA_NONCE_INDEX)),
                    Payload {
                        msg: metadata_plaintext,
                        aad: &aad,
                    },
                )
                .map_err(|_| CryptoError::internal("Metadata encryption failed"))?
        };
        if encrypted_metadata.len() != metadata_ciphertext_length {
            return Err(CryptoError::internal(
                "Metadata ciphertext length did not match declaration",
            ));
        }

        let header_key = kdf::derive_domain_key_32(dek.expose(), kdf::domains::HEADER_AUTH)?;
        let mut mac = <HmacSha256 as Mac>::new_from_slice(header_key.expose())
            .map_err(|_| CryptoError::internal("Invalid header authentication key"))?;
        mac.update(HEADER_MAC_DOMAIN);
        mac.update(&prefix);
        mac.update(&slot_bytes);
        mac.update(&encrypted_metadata);
        let authenticator = mac.finalize().into_bytes();

        let mut header = Vec::with_capacity(complete_header_length);
        header.extend_from_slice(&prefix);
        header.extend_from_slice(&authenticator);
        header.extend_from_slice(&slot_bytes);
        header.extend_from_slice(&encrypted_metadata);
        debug_assert_eq!(header.len(), complete_header_length);
        Ok(header)
    }

    /// Verify the keyed header authenticator and decrypt authenticated metadata.
    pub fn verify_and_decrypt_metadata(&self, dek: &SecretKey) -> CryptoResult<Vec<u8>> {
        let prefix = &self.raw_header[..policy::CORE_PREFIX_SIZE];
        let authenticated_tail = &self.raw_header[policy::CORE_HEADER_SIZE..];
        let header_key = kdf::derive_domain_key_32(dek.expose(), kdf::domains::HEADER_AUTH)?;
        let mut mac = <HmacSha256 as Mac>::new_from_slice(header_key.expose())
            .map_err(|_| CryptoError::internal("Invalid header authentication key"))?;
        mac.update(HEADER_MAC_DOMAIN);
        mac.update(prefix);
        mac.update(authenticated_tail);
        mac.verify_slice(&self.core.header_authenticator)
            .map_err(|_| CryptoError::auth_failed())?;

        if self.encrypted_metadata.is_empty() {
            return Ok(Vec::new());
        }
        let slot_end = policy::CORE_HEADER_SIZE + self.core.key_slot_table_length as usize;
        let slot_bytes = &self.raw_header[policy::CORE_HEADER_SIZE..slot_end];
        let mut aad =
            Vec::with_capacity(METADATA_AAD_DOMAIN.len() + prefix.len() + slot_bytes.len());
        aad.extend_from_slice(METADATA_AAD_DOMAIN);
        aad.extend_from_slice(prefix);
        aad.extend_from_slice(slot_bytes);
        let metadata_key = kdf::derive_domain_key_32(dek.expose(), kdf::domains::METADATA_ENC)?;
        let cipher = XChaCha20Poly1305::new_from_slice(metadata_key.expose())
            .map_err(|_| CryptoError::internal("Invalid metadata key"))?;
        cipher
            .decrypt(
                XNonce::from_slice(&record_nonce(
                    &self.core.nonce_prefix,
                    policy::METADATA_NONCE_INDEX,
                )),
                Payload {
                    msg: &self.encrypted_metadata,
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::auth_failed())
    }

    pub fn raw_bytes(&self) -> &[u8] {
        &self.raw_header
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_slot() -> KeySlotEntry {
        KeySlotEntry {
            kind: policy::SlotKind::Vault as u8,
            slot_id: 0,
            kdf_algorithm: policy::KdfAlgorithm::HkdfSha256 as u16,
            argon2_memory_kib: 0,
            argon2_iterations: 0,
            argon2_parallelism: 0,
            salt: [1u8; 16],
            wrap_nonce: [2u8; 24],
            wrapped_dek: [3u8; 48],
        }
    }

    #[test]
    fn metadata_and_header_authentication_round_trip() {
        let dek = SecretKey::new([9u8; 32]);
        let header = EnvelopeHeader::build(
            [4u8; 16],
            policy::DEFAULT_CHUNK_SIZE,
            vec![sample_slot()],
            br#"{"name":"private.png"}"#,
            123,
            [5u8; 16],
            &dek,
        )
        .unwrap();
        let parsed = EnvelopeHeader::parse(&header).unwrap();
        assert_eq!(
            parsed.verify_and_decrypt_metadata(&dek).unwrap(),
            br#"{"name":"private.png"}"#
        );

        let mut mutated = header;
        *mutated.last_mut().unwrap() ^= 1;
        let parsed = EnvelopeHeader::parse(&mutated).unwrap();
        assert!(parsed.verify_and_decrypt_metadata(&dek).is_err());
    }

    #[test]
    fn rejects_truncated_metadata_and_duplicate_slots() {
        let dek = SecretKey::new([9u8; 32]);
        let header = EnvelopeHeader::build(
            [4u8; 16],
            policy::DEFAULT_CHUNK_SIZE,
            vec![sample_slot()],
            b"metadata",
            0,
            [5u8; 16],
            &dek,
        )
        .unwrap();
        assert!(EnvelopeHeader::parse(&header[..header.len() - 1]).is_err());
        assert!(EnvelopeHeader::build(
            [4u8; 16],
            policy::DEFAULT_CHUNK_SIZE,
            vec![sample_slot(), sample_slot()],
            b"",
            0,
            [5u8; 16],
            &dek,
        )
        .is_err());
    }
}
