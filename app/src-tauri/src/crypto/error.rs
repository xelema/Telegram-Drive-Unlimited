use serde::Serialize;

/// Stable error codes for crypto operations.
/// Never include keys, passphrases, or plaintext in error messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CryptoErrorCode {
    VaultLocked,
    KeyRequired,
    WrongKeyOrCorrupt,
    UnsupportedVersion,
    HeaderInvalid,
    PolicyRejected,
    KdfLimitExceeded,
    AuthFailed,
    Truncated,
    SizeOverflow,
    TelegramLimit,
    TempPolicyBlocked,
    RecoveryRequired,
    InternalError,
    IoError,
}

#[derive(Debug, Clone, Serialize)]
pub struct CryptoError {
    pub code: CryptoErrorCode,
    #[serde(skip_serializing)]
    pub message: String,
}

impl CryptoError {
    pub fn new(code: CryptoErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn vault_locked() -> Self {
        Self::new(CryptoErrorCode::VaultLocked, "Vault is locked")
    }

    pub fn key_required() -> Self {
        Self::new(CryptoErrorCode::KeyRequired, "Key is required to decrypt this file")
    }

    pub fn wrong_key_or_corrupt() -> Self {
        Self::new(
            CryptoErrorCode::WrongKeyOrCorrupt,
            "Wrong key or corrupt data",
        )
    }

    pub fn unsupported_version(version: u16) -> Self {
        Self::new(
            CryptoErrorCode::UnsupportedVersion,
            format!("Unsupported envelope version: {}", version),
        )
    }

    pub fn header_invalid(detail: impl Into<String>) -> Self {
        Self::new(CryptoErrorCode::HeaderInvalid, detail.into())
    }

    pub fn auth_failed() -> Self {
        Self::new(CryptoErrorCode::AuthFailed, "Authentication failed")
    }

    pub fn truncated() -> Self {
        Self::new(CryptoErrorCode::Truncated, "Data truncated")
    }

    pub fn size_overflow() -> Self {
        Self::new(CryptoErrorCode::SizeOverflow, "Size overflow")
    }

    pub fn telegram_limit() -> Self {
        Self::new(
            CryptoErrorCode::TelegramLimit,
            "File exceeds Telegram size limit after encryption",
        )
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(CryptoErrorCode::InternalError, msg.into())
    }
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)
    }
}

impl std::error::Error for CryptoError {}

impl From<std::io::Error> for CryptoError {
    fn from(e: std::io::Error) -> Self {
        Self::new(CryptoErrorCode::IoError, format!("IO error: {}", e))
    }
}

pub type CryptoResult<T> = Result<T, CryptoError>;
