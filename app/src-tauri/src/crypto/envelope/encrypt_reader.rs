use crate::crypto::envelope::header::{EnvelopeHeader, KeySlotEntry};
use crate::crypto::envelope::length::{calculate_chunk_count, calculate_ciphertext_length};
use crate::crypto::error::CryptoResult;
use crate::crypto::secret::SecretKey;
use crate::crypto::{kdf, policy, random};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use sha2::{Digest, Sha256};
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, ReadBuf};
use zeroize::Zeroize;

const CHUNK_AAD_DOMAIN: &[u8] = b"telegram-drive:tdenc2:chunk";
const FINAL_AAD_DOMAIN: &[u8] = b"telegram-drive:tdenc2:final";

pub struct EncryptionSession {
    pub file_uuid: [u8; 16],
    pub dek: SecretKey,
    content_key: SecretKey,
    pub nonce_prefix: [u8; 16],
    pub chunk_size: u32,
    pub total_plaintext_length: u64,
    pub chunk_count: u32,
    pub header_bytes: Vec<u8>,
    pub metadata_ct_length: usize,
    pub total_ciphertext_length: u64,
    header_authenticator: [u8; 32],
}

impl EncryptionSession {
    /// Create a production session after callers have wrapped `dek` into one or
    /// more key slots. `metadata_plaintext` is encrypted inside the header.
    pub fn new_with_keys(
        plaintext_length: u64,
        key_slots: Vec<KeySlotEntry>,
        metadata_plaintext: Vec<u8>,
        dek: SecretKey,
        file_uuid: [u8; 16],
        nonce_prefix: [u8; 16],
    ) -> CryptoResult<Self> {
        let chunk_size = policy::DEFAULT_CHUNK_SIZE;
        let header_bytes = EnvelopeHeader::build(
            file_uuid,
            chunk_size,
            key_slots,
            &metadata_plaintext,
            plaintext_length,
            nonce_prefix,
            &dek,
        )?;
        let parsed = EnvelopeHeader::parse(&header_bytes)?;
        parsed.verify_and_decrypt_metadata(&dek)?;
        let total_ciphertext_length =
            calculate_ciphertext_length(plaintext_length, chunk_size, header_bytes.len() as u32)?;
        let content_key = kdf::derive_domain_key_32(dek.expose(), kdf::domains::CONTENT_ENC)?;
        Ok(Self {
            file_uuid,
            dek,
            content_key,
            nonce_prefix,
            chunk_size,
            total_plaintext_length: plaintext_length,
            chunk_count: calculate_chunk_count(plaintext_length, chunk_size),
            metadata_ct_length: parsed.core.encrypted_metadata_length as usize,
            header_authenticator: parsed.core.header_authenticator,
            header_bytes,
            total_ciphertext_length,
        })
    }

    pub fn new_for_test(
        plaintext_length: u64,
        key_slots: Vec<KeySlotEntry>,
        metadata_plaintext: Vec<u8>,
    ) -> CryptoResult<Self> {
        Self::new_with_keys(
            plaintext_length,
            key_slots,
            metadata_plaintext,
            SecretKey::new(random::random_key()),
            random::random_uuid(),
            random::random_nonce_prefix(),
        )
    }

    fn nonce(&self, index: u64) -> [u8; 24] {
        let mut nonce = [0u8; 24];
        nonce[..16].copy_from_slice(&self.nonce_prefix);
        nonce[16..].copy_from_slice(&index.to_le_bytes());
        nonce
    }

    fn chunk_aad(&self, chunk_index: u64, plaintext_offset: u64, length: u32) -> Vec<u8> {
        let mut aad = Vec::with_capacity(CHUNK_AAD_DOMAIN.len() + 74);
        aad.extend_from_slice(CHUNK_AAD_DOMAIN);
        aad.extend_from_slice(&policy::FORMAT_VERSION.to_le_bytes());
        aad.extend_from_slice(&self.file_uuid);
        aad.extend_from_slice(&self.header_authenticator);
        aad.extend_from_slice(&chunk_index.to_le_bytes());
        aad.extend_from_slice(&plaintext_offset.to_le_bytes());
        aad.extend_from_slice(&length.to_le_bytes());
        aad.extend_from_slice(&self.total_plaintext_length.to_le_bytes());
        aad
    }

    fn final_aad(&self) -> Vec<u8> {
        let mut aad = Vec::with_capacity(FINAL_AAD_DOMAIN.len() + 62);
        aad.extend_from_slice(FINAL_AAD_DOMAIN);
        aad.extend_from_slice(&policy::FORMAT_VERSION.to_le_bytes());
        aad.extend_from_slice(&self.file_uuid);
        aad.extend_from_slice(&self.header_authenticator);
        aad.extend_from_slice(&self.chunk_count.to_le_bytes());
        aad.extend_from_slice(&self.total_plaintext_length.to_le_bytes());
        aad
    }
}

enum EncryptState {
    EmittingHeader,
    ReadingChunk,
    CheckingEof,
    EmittingFinalRecord,
    Done,
}

pub struct EncryptingReader<R: AsyncRead + Unpin> {
    inner: R,
    pub session: EncryptionSession,
    state: EncryptState,
    output: Vec<u8>,
    output_position: usize,
    plaintext_chunk: Vec<u8>,
    plaintext_chunk_filled: usize,
    chunk_index: u64,
    plaintext_read: u64,
    plaintext_hasher: Sha256,
    ciphertext_emitted: u64,
}

impl<R: AsyncRead + Unpin> EncryptingReader<R> {
    pub fn new(inner: R, session: EncryptionSession) -> Self {
        Self {
            inner,
            session,
            state: EncryptState::EmittingHeader,
            output: Vec::new(),
            output_position: 0,
            plaintext_chunk: Vec::new(),
            plaintext_chunk_filled: 0,
            chunk_index: 0,
            plaintext_read: 0,
            plaintext_hasher: Sha256::new(),
            ciphertext_emitted: 0,
        }
    }

    pub fn total_ciphertext_length(&self) -> u64 {
        self.session.total_ciphertext_length
    }

    fn queue_output(&mut self, bytes: Vec<u8>) {
        self.ciphertext_emitted = self.ciphertext_emitted.saturating_add(bytes.len() as u64);
        self.output = bytes;
        self.output_position = 0;
    }

    fn encrypt_ready_chunk(&mut self) -> std::io::Result<()> {
        let cipher = XChaCha20Poly1305::new_from_slice(self.session.content_key.expose())
            .map_err(|_| std::io::Error::other("Invalid content key"))?;
        let length = self.plaintext_chunk_filled;
        self.plaintext_hasher
            .update(&self.plaintext_chunk[..length]);
        let aad = self
            .session
            .chunk_aad(self.chunk_index, self.plaintext_read, length as u32);
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&self.session.nonce(self.chunk_index)),
                Payload {
                    msg: &self.plaintext_chunk[..length],
                    aad: &aad,
                },
            )
            .map_err(|_| std::io::Error::other("Content encryption failed"))?;
        self.plaintext_read += length as u64;
        self.chunk_index += 1;
        self.plaintext_chunk.zeroize();
        self.plaintext_chunk.clear();
        self.plaintext_chunk_filled = 0;
        self.queue_output(ciphertext);
        Ok(())
    }

    fn build_final_record(&mut self) -> std::io::Result<Vec<u8>> {
        let digest = self.plaintext_hasher.clone().finalize();
        let mut plaintext = vec![0u8; policy::FINAL_RECORD_PLAINTEXT_SIZE];
        plaintext[..4].copy_from_slice(&self.session.chunk_count.to_le_bytes());
        plaintext[4..12].copy_from_slice(&self.session.total_plaintext_length.to_le_bytes());
        plaintext[12..44].copy_from_slice(&digest);
        let cipher = XChaCha20Poly1305::new_from_slice(self.session.content_key.expose())
            .map_err(|_| std::io::Error::other("Invalid content key"))?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&self.session.nonce(policy::FINAL_RECORD_NONCE_INDEX)),
                Payload {
                    msg: &plaintext,
                    aad: &self.session.final_aad(),
                },
            )
            .map_err(|_| std::io::Error::other("Final record encryption failed"))?;
        plaintext.zeroize();
        Ok(ciphertext)
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for EncryptingReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        destination: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.as_mut().get_mut();
        loop {
            if this.output_position < this.output.len() {
                let available = this.output.len() - this.output_position;
                let count = available.min(destination.remaining());
                destination
                    .put_slice(&this.output[this.output_position..this.output_position + count]);
                this.output_position += count;
                if this.output_position == this.output.len() {
                    this.output.clear();
                    this.output_position = 0;
                }
                return Poll::Ready(Ok(()));
            }

            match this.state {
                EncryptState::EmittingHeader => {
                    this.queue_output(this.session.header_bytes.clone());
                    this.state = EncryptState::ReadingChunk;
                }
                EncryptState::ReadingChunk => {
                    if this.plaintext_read >= this.session.total_plaintext_length {
                        this.state = EncryptState::CheckingEof;
                        continue;
                    }
                    if this.plaintext_chunk.is_empty() {
                        let remaining = this.session.total_plaintext_length - this.plaintext_read;
                        let target = remaining.min(u64::from(this.session.chunk_size)) as usize;
                        this.plaintext_chunk.resize(target, 0);
                        this.plaintext_chunk_filled = 0;
                    }
                    let start = this.plaintext_chunk_filled;
                    let mut read_buffer = ReadBuf::new(&mut this.plaintext_chunk[start..]);
                    match Pin::new(&mut this.inner).poll_read(cx, &mut read_buffer) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                        Poll::Ready(Ok(())) => {
                            let read = read_buffer.filled().len();
                            if read == 0 {
                                return Poll::Ready(Err(std::io::Error::new(
                                    std::io::ErrorKind::UnexpectedEof,
                                    "Plaintext source became shorter during encryption",
                                )));
                            }
                            this.plaintext_chunk_filled += read;
                            if this.plaintext_chunk_filled == this.plaintext_chunk.len() {
                                if let Err(error) = this.encrypt_ready_chunk() {
                                    return Poll::Ready(Err(error));
                                }
                            }
                        }
                    }
                }
                EncryptState::CheckingEof => {
                    let mut extra = [0u8; 1];
                    let mut read_buffer = ReadBuf::new(&mut extra);
                    match Pin::new(&mut this.inner).poll_read(cx, &mut read_buffer) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                        Poll::Ready(Ok(())) if !read_buffer.filled().is_empty() => {
                            return Poll::Ready(Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "Plaintext source became longer during encryption",
                            )));
                        }
                        Poll::Ready(Ok(())) => {
                            this.state = EncryptState::EmittingFinalRecord;
                        }
                    }
                }
                EncryptState::EmittingFinalRecord => {
                    let final_record = match this.build_final_record() {
                        Ok(record) => record,
                        Err(error) => return Poll::Ready(Err(error)),
                    };
                    let final_total = this
                        .ciphertext_emitted
                        .saturating_add(final_record.len() as u64);
                    if final_total != this.session.total_ciphertext_length {
                        return Poll::Ready(Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "Emitted ciphertext length differs from declared length",
                        )));
                    }
                    this.queue_output(final_record);
                    this.state = EncryptState::Done;
                }
                EncryptState::Done => return Poll::Ready(Ok(())),
            }
        }
    }
}
