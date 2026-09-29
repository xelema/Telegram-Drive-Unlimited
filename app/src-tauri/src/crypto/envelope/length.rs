use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::policy;

/// Calculate the exact TDENC2 ciphertext length. `complete_header_length`
/// includes the core header, every key slot, encrypted metadata (if present),
/// and the keyed header authenticator.
pub fn calculate_ciphertext_length(
    plaintext_length: u64,
    chunk_size: u32,
    complete_header_length: u32,
) -> CryptoResult<u64> {
    policy::validate_chunk_size(chunk_size)?;
    let header_length = complete_header_length as usize;
    if !(policy::CORE_HEADER_SIZE..=policy::MAX_HEADER_LENGTH).contains(&header_length) {
        return Err(CryptoError::header_invalid(
            "Complete header length is outside policy",
        ));
    }

    let chunk_count = calculate_chunk_count(plaintext_length, chunk_size) as u64;
    let chunk_tags = chunk_count
        .checked_mul(policy::AEAD_TAG_LENGTH as u64)
        .ok_or_else(CryptoError::size_overflow)?;
    let total = u64::from(complete_header_length)
        .checked_add(plaintext_length)
        .ok_or_else(CryptoError::size_overflow)?
        .checked_add(chunk_tags)
        .ok_or_else(CryptoError::size_overflow)?
        .checked_add(policy::FINAL_RECORD_CIPHERTEXT_SIZE as u64)
        .ok_or_else(CryptoError::size_overflow)?;

    if total > policy::MAX_CIPHERTEXT_SIZE {
        return Err(CryptoError::telegram_limit());
    }
    Ok(total)
}

pub fn calculate_chunk_count(plaintext_length: u64, chunk_size: u32) -> u32 {
    if plaintext_length == 0 {
        return 0;
    }
    let size = u64::from(chunk_size);
    plaintext_length.div_ceil(size) as u32
}
