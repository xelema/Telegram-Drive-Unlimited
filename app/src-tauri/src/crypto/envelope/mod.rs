pub mod decrypt_reader;
pub mod encrypt_reader;
pub mod header;
pub mod key_slot;
pub mod length;
pub mod range;
pub mod vectors;

pub use header::{CoreHeader, EnvelopeHeader, KeySlotEntry};
pub use key_slot::{unwrap_dek, wrap_dek, KeySlotContext};
pub use length::{calculate_chunk_count, calculate_ciphertext_length};
pub use range::plaintext_range_to_ciphertext_records;
