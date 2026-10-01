use crate::crypto::envelope::header::EnvelopeHeader;
use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::secret::SecretKey;
use crate::crypto::{kdf, policy};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use sha2::{Digest, Sha256};

const CHUNK_AAD_DOMAIN: &[u8] = b"telegram-drive:tdenc2:chunk";
const FINAL_AAD_DOMAIN: &[u8] = b"telegram-drive:tdenc2:final";

/// Incremental authenticated TDENC2 body decoder. Construct it from the
/// complete header, then feed only bytes after `header_length`.
pub struct DecryptReader {
    header: EnvelopeHeader,
    content_key: SecretKey,
    metadata_plaintext: Vec<u8>,
    plaintext_position: u64,
    chunk_index: u32,
    plaintext_hasher: Sha256,
    final_record_verified: bool,
    buffer: Vec<u8>,
}

impl DecryptReader {
    pub fn new(header_bytes: &[u8], dek: SecretKey) -> CryptoResult<Self> {
        let header = EnvelopeHeader::parse(header_bytes)?;
        let metadata_plaintext = header.verify_and_decrypt_metadata(&dek)?;
        let content_key = kdf::derive_domain_key_32(dek.expose(), kdf::domains::CONTENT_ENC)?;
        Ok(Self {
            header,
            content_key,
            metadata_plaintext,
            plaintext_position: 0,
            chunk_index: 0,
            plaintext_hasher: Sha256::new(),
            final_record_verified: false,
            buffer: Vec::new(),
        })
    }

    pub fn plaintext_length(&self) -> u64 {
        self.header.core.total_plaintext_length
    }

    pub fn file_uuid(&self) -> &[u8; 16] {
        &self.header.core.file_uuid
    }

    pub fn metadata_plaintext(&self) -> &[u8] {
        &self.metadata_plaintext
    }

    /// Authenticate and decrypt one independently addressed data record. This
    /// powers seekable media without persisting plaintext or replaying every
    /// preceding record. The authenticated header fixes the chunk layout.
    pub fn decrypt_chunk_at(&self, chunk_index: u32, ciphertext: &[u8]) -> CryptoResult<Vec<u8>> {
        if chunk_index >= self.header.core.chunk_count() {
            return Err(CryptoError::header_invalid("Chunk index out of range"));
        }
        let plaintext_offset = u64::from(chunk_index) * u64::from(self.header.core.chunk_size);
        let plaintext_length = self
            .header
            .core
            .total_plaintext_length
            .saturating_sub(plaintext_offset)
            .min(u64::from(self.header.core.chunk_size)) as usize;
        if ciphertext.len() != plaintext_length + policy::AEAD_TAG_LENGTH {
            return Err(CryptoError::truncated());
        }
        let cipher = XChaCha20Poly1305::new_from_slice(self.content_key.expose())
            .map_err(|_| CryptoError::internal("Invalid content key"))?;
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&self.nonce(u64::from(chunk_index))),
                Payload {
                    msg: ciphertext,
                    aad: &self.chunk_aad(
                        u64::from(chunk_index),
                        plaintext_offset,
                        plaintext_length as u32,
                    ),
                },
            )
            .map_err(|_| CryptoError::auth_failed())?;
        if plaintext.len() != plaintext_length {
            return Err(CryptoError::auth_failed());
        }
        Ok(plaintext)
    }

    pub fn is_complete(&self) -> bool {
        self.final_record_verified
    }

    fn nonce(&self, index: u64) -> [u8; 24] {
        let mut nonce = [0u8; 24];
        nonce[..16].copy_from_slice(&self.header.core.nonce_prefix);
        nonce[16..].copy_from_slice(&index.to_le_bytes());
        nonce
    }

    fn chunk_aad(&self, chunk_index: u64, plaintext_offset: u64, length: u32) -> Vec<u8> {
        let mut aad = Vec::with_capacity(CHUNK_AAD_DOMAIN.len() + 74);
        aad.extend_from_slice(CHUNK_AAD_DOMAIN);
        aad.extend_from_slice(&policy::FORMAT_VERSION.to_le_bytes());
        aad.extend_from_slice(&self.header.core.file_uuid);
        aad.extend_from_slice(&self.header.core.header_authenticator);
        aad.extend_from_slice(&chunk_index.to_le_bytes());
        aad.extend_from_slice(&plaintext_offset.to_le_bytes());
        aad.extend_from_slice(&length.to_le_bytes());
        aad.extend_from_slice(&self.header.core.total_plaintext_length.to_le_bytes());
        aad
    }

    fn final_aad(&self) -> Vec<u8> {
        let mut aad = Vec::with_capacity(FINAL_AAD_DOMAIN.len() + 62);
        aad.extend_from_slice(FINAL_AAD_DOMAIN);
        aad.extend_from_slice(&policy::FORMAT_VERSION.to_le_bytes());
        aad.extend_from_slice(&self.header.core.file_uuid);
        aad.extend_from_slice(&self.header.core.header_authenticator);
        aad.extend_from_slice(&self.header.core.chunk_count().to_le_bytes());
        aad.extend_from_slice(&self.header.core.total_plaintext_length.to_le_bytes());
        aad
    }

    fn next_plaintext_length(&self) -> usize {
        let remaining = self
            .header
            .core
            .total_plaintext_length
            .saturating_sub(self.plaintext_position);
        remaining.min(u64::from(self.header.core.chunk_size)) as usize
    }

    fn decrypt_next_chunk(
        &mut self,
        ciphertext: &[u8],
        plaintext_length: usize,
    ) -> CryptoResult<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new_from_slice(self.content_key.expose())
            .map_err(|_| CryptoError::internal("Invalid content key"))?;
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&self.nonce(u64::from(self.chunk_index))),
                Payload {
                    msg: ciphertext,
                    aad: &self.chunk_aad(
                        u64::from(self.chunk_index),
                        self.plaintext_position,
                        plaintext_length as u32,
                    ),
                },
            )
            .map_err(|_| CryptoError::auth_failed())?;
        if plaintext.len() != plaintext_length {
            return Err(CryptoError::auth_failed());
        }
        self.plaintext_hasher.update(&plaintext);
        self.plaintext_position += plaintext.len() as u64;
        self.chunk_index += 1;
        Ok(plaintext)
    }

    fn verify_final_record(&mut self, ciphertext: &[u8]) -> CryptoResult<()> {
        let cipher = XChaCha20Poly1305::new_from_slice(self.content_key.expose())
            .map_err(|_| CryptoError::internal("Invalid content key"))?;
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&self.nonce(policy::FINAL_RECORD_NONCE_INDEX)),
                Payload {
                    msg: ciphertext,
                    aad: &self.final_aad(),
                },
            )
            .map_err(|_| CryptoError::auth_failed())?;
        if plaintext.len() != policy::FINAL_RECORD_PLAINTEXT_SIZE {
            return Err(CryptoError::auth_failed());
        }
        let recorded_chunk_count = u32::from_le_bytes(
            plaintext[..4]
                .try_into()
                .map_err(|_| CryptoError::auth_failed())?,
        );
        let recorded_length = u64::from_le_bytes(
            plaintext[4..12]
                .try_into()
                .map_err(|_| CryptoError::auth_failed())?,
        );
        if recorded_chunk_count != self.header.core.chunk_count()
            || recorded_length != self.header.core.total_plaintext_length
            || self.chunk_index != recorded_chunk_count
            || self.plaintext_position != recorded_length
            || plaintext[44..52].iter().any(|byte| *byte != 0)
        {
            return Err(CryptoError::auth_failed());
        }
        let expected_digest = self.plaintext_hasher.clone().finalize();
        if plaintext[12..44] != expected_digest[..] {
            return Err(CryptoError::auth_failed());
        }
        self.final_record_verified = true;
        Ok(())
    }

    /// Feed a sequential fragment of the ciphertext body and return only fully
    /// authenticated plaintext records.
    pub fn feed(&mut self, ciphertext_body: &[u8]) -> CryptoResult<Vec<u8>> {
        if self.final_record_verified {
            if ciphertext_body.is_empty() {
                return Ok(Vec::new());
            }
            return Err(CryptoError::header_invalid(
                "Trailing bytes after final record",
            ));
        }
        self.buffer.extend_from_slice(ciphertext_body);
        let mut plaintext_output = Vec::new();

        while self.chunk_index < self.header.core.chunk_count() {
            let plaintext_length = self.next_plaintext_length();
            let ciphertext_length = plaintext_length
                .checked_add(policy::AEAD_TAG_LENGTH)
                .ok_or_else(CryptoError::size_overflow)?;
            if self.buffer.len() < ciphertext_length {
                return Ok(plaintext_output);
            }
            let record: Vec<u8> = self.buffer.drain(..ciphertext_length).collect();
            let plaintext = self.decrypt_next_chunk(&record, plaintext_length)?;
            plaintext_output.extend_from_slice(&plaintext);
        }

        if self.buffer.len() >= policy::FINAL_RECORD_CIPHERTEXT_SIZE {
            let final_record: Vec<u8> = self
                .buffer
                .drain(..policy::FINAL_RECORD_CIPHERTEXT_SIZE)
                .collect();
            self.verify_final_record(&final_record)?;
            if !self.buffer.is_empty() {
                return Err(CryptoError::header_invalid(
                    "Trailing bytes after final record",
                ));
            }
        }
        Ok(plaintext_output)
    }

    pub fn finish(&self) -> CryptoResult<()> {
        if !self.final_record_verified || !self.buffer.is_empty() {
            return Err(CryptoError::truncated());
        }
        Ok(())
    }
}
