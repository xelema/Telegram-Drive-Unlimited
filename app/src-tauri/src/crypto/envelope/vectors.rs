#[cfg(test)]
mod tests {
    use crate::crypto::envelope::decrypt_reader::DecryptReader;
    use crate::crypto::envelope::encrypt_reader::{EncryptingReader, EncryptionSession};
    use crate::crypto::envelope::header::{EnvelopeHeader, KeySlotEntry};
    use crate::crypto::envelope::key_slot::{unwrap_dek, wrap_dek_with_nonce, KeySlotContext};
    use crate::crypto::policy;
    use crate::crypto::secret::SecretKey;
    use base64::Engine;
    use tokio::io::AsyncReadExt;

    const VECTOR_UUID: [u8; 16] = [0x11; 16];
    const VECTOR_NONCE_PREFIX: [u8; 16] = [0x22; 16];
    const VECTOR_WRAP_NONCE: [u8; 24] = [0x33; 24];
    const VECTOR_SALT: [u8; 16] = [0x44; 16];
    const VECTOR_DEK: [u8; 32] = [0x55; 32];
    const VECTOR_WRAPPING_KEY: [u8; 32] = [0x66; 32];

    fn deterministic_session(
        plaintext_length: u64,
        metadata: &[u8],
    ) -> (EncryptionSession, SecretKey) {
        let dek = SecretKey::new(VECTOR_DEK);
        let wrapping_key = SecretKey::new(VECTOR_WRAPPING_KEY);
        let context = KeySlotContext {
            file_uuid: &VECTOR_UUID,
            format_version: policy::FORMAT_VERSION,
        };
        let wrapped_dek = wrap_dek_with_nonce(
            &context,
            &dek,
            &wrapping_key,
            policy::SlotKind::Vault as u8,
            0,
            policy::KdfAlgorithm::HkdfSha256 as u16,
            0,
            0,
            0,
            &VECTOR_SALT,
            VECTOR_WRAP_NONCE,
        )
        .unwrap();
        let slot = KeySlotEntry {
            kind: policy::SlotKind::Vault as u8,
            slot_id: 0,
            kdf_algorithm: policy::KdfAlgorithm::HkdfSha256 as u16,
            argon2_memory_kib: 0,
            argon2_iterations: 0,
            argon2_parallelism: 0,
            salt: VECTOR_SALT,
            wrap_nonce: VECTOR_WRAP_NONCE,
            wrapped_dek,
        };
        (
            EncryptionSession::new_with_keys(
                plaintext_length,
                vec![slot],
                metadata.to_vec(),
                dek,
                VECTOR_UUID,
                VECTOR_NONCE_PREFIX,
            )
            .unwrap(),
            wrapping_key,
        )
    }

    async fn encrypt(plaintext: &[u8], metadata: &[u8]) -> (Vec<u8>, SecretKey) {
        let (session, wrapping_key) = deterministic_session(plaintext.len() as u64, metadata);
        let expected_length = session.total_ciphertext_length;
        let mut reader = EncryptingReader::new(std::io::Cursor::new(plaintext.to_vec()), session);
        let mut ciphertext = Vec::new();
        reader.read_to_end(&mut ciphertext).await.unwrap();
        assert_eq!(ciphertext.len() as u64, expected_length);
        (ciphertext, wrapping_key)
    }

    fn resolve_dek(header: &EnvelopeHeader, wrapping_key: &SecretKey) -> SecretKey {
        let slot = header.key_slots.first().unwrap();
        unwrap_dek(
            &KeySlotContext {
                file_uuid: &header.core.file_uuid,
                format_version: header.core.format_version,
            },
            &slot.wrapped_dek,
            &slot.wrap_nonce,
            wrapping_key,
            slot.kind,
            slot.slot_id,
            slot.kdf_algorithm,
            slot.argon2_memory_kib,
            slot.argon2_iterations,
            slot.argon2_parallelism,
            &slot.salt,
        )
        .unwrap()
    }

    fn decrypt_in_fragments(ciphertext: &[u8], wrapping_key: &SecretKey) -> (Vec<u8>, Vec<u8>) {
        let header = EnvelopeHeader::parse(ciphertext).unwrap();
        let header_length = header.core.header_length as usize;
        let dek = resolve_dek(&header, wrapping_key);
        let mut reader = DecryptReader::new(&ciphertext[..header_length], dek).unwrap();
        let metadata = reader.metadata_plaintext().to_vec();
        let mut plaintext = Vec::new();
        for fragment in ciphertext[header_length..].chunks(37) {
            plaintext.extend_from_slice(&reader.feed(fragment).unwrap());
        }
        reader.finish().unwrap();
        (plaintext, metadata)
    }

    #[tokio::test]
    async fn deterministic_one_byte_known_answer_vector() {
        let (ciphertext, wrapping_key) = encrypt(b"X", br#"{"name":"x.txt"}"#).await;
        let actual = base64::engine::general_purpose::STANDARD.encode(&ciphertext);
        // Immutable TDENC2 known-answer fixture. Changing this value requires
        // a new envelope version and an explicit vector review.
        const EXPECTED_BASE64: &str = "VERFTkMyAgARERERERERERERERERERERAQDqAAAAAAAQAGgAAAAgAAAAAQAAAAAAAAAiIiIiIiIiIiIiIiIiIiIit7z2o+7K5i1I6DhWw93RdHY1nkOZL15ujAqL/DRTUQ0BAAIAAAAAAAAAAAAAAAAARERERERERERERERERERERDMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM33Ea/edQkku0qAFd1z1ZR2k5Drbm+nJC8OQkgqXailEtBOVbUKzXSMZTQI+0vnEIzU2fDg9e99NJajCjcaW99v8ZDZebH4aULrpyo4itvmOf3V27qdJ0D7GhcJWpazjEPJsBs8n3H0/ceGIsz4mIoIFD9KqGpGz93yGEfGPmaUiPkrOlCn6zWFS5dOzdmTAxHBP3l1td3fyb0PZZbdfgLeG/dX0yA==";
        assert_eq!(actual, EXPECTED_BASE64);
        let (plaintext, metadata) = decrypt_in_fragments(&ciphertext, &wrapping_key);
        assert_eq!(plaintext, b"X");
        assert_eq!(metadata, br#"{"name":"x.txt"}"#);
    }

    #[tokio::test]
    async fn streaming_round_trip_boundaries() {
        let sizes = [
            0usize,
            1,
            policy::DEFAULT_CHUNK_SIZE as usize - 1,
            policy::DEFAULT_CHUNK_SIZE as usize,
            policy::DEFAULT_CHUNK_SIZE as usize + 1,
        ];
        for size in sizes {
            let plaintext = vec![0xA5; size];
            let (ciphertext, wrapping_key) = encrypt(&plaintext, b"").await;
            let (decrypted, metadata) = decrypt_in_fragments(&ciphertext, &wrapping_key);
            assert_eq!(decrypted, plaintext, "boundary size {size}");
            assert!(metadata.is_empty());
        }
    }

    #[tokio::test]
    async fn mutations_truncation_and_trailing_bytes_fail_closed() {
        let (ciphertext, wrapping_key) = encrypt(b"authenticated content", b"").await;
        let header = EnvelopeHeader::parse(&ciphertext).unwrap();
        let header_length = header.core.header_length as usize;
        let dek = resolve_dek(&header, &wrapping_key);

        let mut mutated = ciphertext.clone();
        mutated[header_length] ^= 1;
        let mut reader = DecryptReader::new(&mutated[..header_length], dek.clone()).unwrap();
        assert!(reader.feed(&mutated[header_length..]).is_err());

        let truncated = &ciphertext[..ciphertext.len() - 1];
        let mut reader = DecryptReader::new(&truncated[..header_length], dek.clone()).unwrap();
        for fragment in truncated[header_length..].chunks(17) {
            let _ = reader.feed(fragment).unwrap();
        }
        assert!(reader.finish().is_err());

        let mut trailing = ciphertext;
        trailing.push(0);
        let mut reader = DecryptReader::new(&trailing[..header_length], dek).unwrap();
        assert!(reader.feed(&trailing[header_length..]).is_err());
    }

    #[test]
    fn quarantined_tdenc1_is_not_reinterpreted() {
        let mut legacy = vec![0u8; policy::CORE_HEADER_SIZE];
        legacy[..6].copy_from_slice(policy::EXPERIMENTAL_TDENC1_MAGIC);
        assert!(EnvelopeHeader::parse(&legacy).is_err());
    }
}
