use crate::crypto::error::{CryptoError, CryptoResult};
use serde::{Deserialize, Serialize};

/// Registry record for an encrypted file in the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedFileRecord {
    pub folder_key: String,
    pub message_id: i32,
    pub file_uuid: Vec<u8>,
    pub envelope_version: u16,
    pub cipher_suite: u16,
    pub ciphertext_size: u64,
    pub plaintext_size: Option<u64>,
    pub remote_name: String,
    pub key_profile_id: Option<String>,
    pub protection_mode: String,
    pub metadata_protected: bool,
    pub header_blob: Option<Vec<u8>>,
    pub header_sha256: Option<Vec<u8>>,
    pub record_state: EncryptedFileState,
    pub reconciliation_state: String,
    pub created_at: i64,
    pub last_verified_at: Option<i64>,
}

/// States an encrypted file record can be in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedFileState {
    Active,
    Verifying,
    Migrating,
    Corrupt,
    Orphaned,
}

/// Encryption profile descriptor (no secrets).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptionProfile {
    pub id: String,
    pub label: String,
    pub kind: ProfileKind,
    pub vault_locator: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileKind {
    Vault,
    FilePassphrase,
    RecoveryKey,
}

/// Lookup result for an encrypted file.
#[derive(Debug, Clone)]
pub enum FileLookupResult {
    /// File is plaintext (not encrypted).
    Plaintext,
    /// File is encrypted and recognized.
    Encrypted(EncryptedFileRecord),
    /// File appears to be encrypted but no registry entry exists.
    UnknownEncrypted,
}

impl EncryptedFileRecord {
    /// Check if the header blob is cached locally.
    pub fn has_header_cache(&self) -> bool {
        self.header_blob.as_ref().is_some_and(|b| !b.is_empty())
    }
}

impl EncryptedFileState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Verifying => "verifying",
            Self::Migrating => "migrating",
            Self::Corrupt => "corrupt",
            Self::Orphaned => "orphaned",
        }
    }
}

/// Insert or update an encrypted-file registry entry. All bind and execution
/// errors are propagated; callers must never report a silently missing record.
pub fn upsert_encrypted_file(
    connection: &sqlite::Connection,
    record: &EncryptedFileRecord,
) -> CryptoResult<()> {
    let query = "INSERT OR REPLACE INTO encrypted_files (
        folder_key, message_id, file_uuid, envelope_version, cipher_suite,
        ciphertext_size, plaintext_size, remote_name, key_profile_id,
        protection_mode, metadata_protected, header_blob, header_sha256,
        record_state, reconciliation_state, created_at, last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    let mut statement = connection
        .prepare(query)
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((1, record.folder_key.as_str()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((2, i64::from(record.message_id)))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((3, record.file_uuid.as_slice()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((4, i64::from(record.envelope_version)))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((5, i64::from(record.cipher_suite)))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((6, record.ciphertext_size as i64))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((7, record.plaintext_size.map(|value| value as i64)))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((8, record.remote_name.as_str()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((9, record.key_profile_id.as_deref()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((10, record.protection_mode.as_str()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((11, if record.metadata_protected { 1i64 } else { 0i64 }))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((12, record.header_blob.as_deref()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((13, record.header_sha256.as_deref()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((14, record.record_state.as_str()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((15, record.reconciliation_state.as_str()))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((16, record.created_at))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((17, record.last_verified_at))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .next()
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    Ok(())
}

pub fn mark_reconciliation_required(
    connection: &sqlite::Connection,
    folder_key: &str,
    message_id: i32,
) -> CryptoResult<()> {
    let mut statement = connection
        .prepare(
            "UPDATE encrypted_files SET reconciliation_state = 'required' \
             WHERE folder_key = ? AND message_id = ?",
        )
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((1, folder_key))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .bind((2, i64::from(message_id)))
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    statement
        .next()
        .map_err(|error| CryptoError::internal(error.to_string()))?;
    Ok(())
}
