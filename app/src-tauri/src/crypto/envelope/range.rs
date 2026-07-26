use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::policy;

/// Map a plaintext byte range to the set of full ciphertext record indices needed.
///
/// Returns (first_record_index, last_record_index) where each record contains
/// one data chunk. The caller must fetch and authenticate all records in this
/// range, then slice the verified plaintext to the requested range.
pub fn plaintext_range_to_ciphertext_records(
    range_start: u64,
    range_end: u64,
    chunk_size: u32,
    total_plaintext_length: u64,
) -> CryptoResult<(u32, u32)> {
    // Validate range
    if range_start > range_end {
        return Err(CryptoError::header_invalid("Invalid range: start > end"));
    }
    if range_end >= total_plaintext_length {
        return Err(CryptoError::header_invalid("Range exceeds file length"));
    }

    let cs = chunk_size as u64;

    let first_chunk = (range_start / cs) as u32;
    let last_chunk = (range_end / cs) as u32;

    Ok((first_chunk, last_chunk))
}

/// Calculate the ciphertext offset for a given chunk index within the data portion.
/// Does not include the header or metadata regions.
pub fn chunk_ciphertext_offset(
    chunk_index: u32,
    chunk_size: u32,
    plaintext_length: u64,
) -> CryptoResult<u64> {
    let cs = chunk_size as u64;
    let tag_size = policy::AEAD_TAG_LENGTH as u64;

    // Each chunk contributes: min(chunk_size, remaining_plaintext) + tag_size
    let full_chunks = plaintext_length / cs;
    let remaining = plaintext_length % cs;

    if (chunk_index as u64) < full_chunks {
        // Full chunk
        Ok(chunk_index as u64 * (cs + tag_size))
    } else if (chunk_index as u64) == full_chunks && remaining > 0 {
        // Partial final chunk
        Ok(full_chunks * (cs + tag_size))
    } else {
        Err(CryptoError::header_invalid("Chunk index out of range"))
    }
}

/// Calculate the total size of the data ciphertext region (all chunks + tags).
pub fn data_ciphertext_size(plaintext_length: u64, chunk_size: u32) -> CryptoResult<u64> {
    let cs = chunk_size as u64;
    let tag_size = policy::AEAD_TAG_LENGTH as u64;

    if plaintext_length == 0 {
        return Ok(0);
    }

    let full_chunks = plaintext_length / cs;
    let remaining = plaintext_length % cs;

    let tags = if remaining > 0 {
        full_chunks + 1
    } else {
        full_chunks
    };

    Ok(plaintext_length + tags * tag_size)
}

/// Calculate the total envelope size from parsed header information.
pub fn total_envelope_size(header_length: u32, data_ct_size: u64) -> CryptoResult<u64> {
    let header_len: u64 = header_length.into();
    let total = header_len
        .checked_add(data_ct_size)
        .ok_or_else(CryptoError::size_overflow)?
        .checked_add(policy::FINAL_RECORD_CIPHERTEXT_SIZE as u64)
        .ok_or_else(CryptoError::size_overflow)?;

    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::policy::DEFAULT_CHUNK_SIZE;

    #[test]
    fn test_range_single_chunk() {
        let (first, last) =
            plaintext_range_to_ciphertext_records(0, 100, DEFAULT_CHUNK_SIZE, 1000).unwrap();
        assert_eq!(first, 0);
        assert_eq!(last, 0);
    }

    #[test]
    fn test_range_cross_chunks() {
        let (first, last) = plaintext_range_to_ciphertext_records(
            500_000,
            1_500_000,
            DEFAULT_CHUNK_SIZE,
            2_000_000,
        )
        .unwrap();
        assert_eq!(first, 0);
        assert_eq!(last, 1);
    }

    #[test]
    fn test_range_at_end() {
        let (first, last) = plaintext_range_to_ciphertext_records(
            1_048_576,
            1_048_576,
            DEFAULT_CHUNK_SIZE,
            1_048_577,
        )
        .unwrap();
        assert_eq!(first, 1);
        assert_eq!(last, 1);
    }

    #[test]
    fn test_range_exceeds_file() {
        let result = plaintext_range_to_ciphertext_records(0, 2000, DEFAULT_CHUNK_SIZE, 1000);
        assert!(result.is_err());
    }

    #[test]
    fn test_chunk_offset_first() {
        let offset = chunk_ciphertext_offset(0, DEFAULT_CHUNK_SIZE, 10_000_000).unwrap();
        assert_eq!(offset, 0);
    }

    #[test]
    fn test_chunk_offset_second() {
        let offset = chunk_ciphertext_offset(1, DEFAULT_CHUNK_SIZE, 10_000_000).unwrap();
        assert_eq!(offset, 1_048_576 + 16);
    }
}
