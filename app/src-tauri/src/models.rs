use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "status", content = "data")]
pub enum AuthState {
    LoggedOut,
    AwaitingCode {
        phone: String,
        phone_code_hash: String,
    },
    AwaitingPassword {
        phone: String,
    },
    LoggedIn,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthResult {
    pub success: bool,
    pub next_step: Option<String>, // "code", "password", "dashboard"
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthCodeDelivery {
    TelegramApp,
    Sms,
    Call,
    FlashCall,
    MissedCall,
    Email,
    EmailSetup,
    Fragment,
    Firebase,
    SmsWord,
    SmsPhrase,
    Unsupported,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthCodeRequestStatus {
    CodeRequired,
    Authorized,
    QrRecommended,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthCodeRequestResult {
    pub status: AuthCodeRequestStatus,
    pub delivery: AuthCodeDelivery,
    pub code_length: Option<i32>,
    pub destination_hint: Option<String>,
    pub fragment_url: Option<String>,
    pub resend_after_seconds: Option<i32>,
    pub next_delivery: Option<AuthCodeDelivery>,
    pub numeric_code: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileMetadata {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub name: String,
    pub size: u64, // Updated to u64
    pub mime_type: Option<String>,
    pub file_ext: Option<String>, // Added field
    pub created_at: String,
    pub icon_type: String,
    /// Encryption state: "plain" | "encrypted_locked" | "encrypted_unlocked" | etc.
    #[serde(default = "default_encryption_state")]
    pub encryption_state: String,
    #[serde(default)]
    pub is_favorite: bool,
    #[serde(default)]
    pub is_pinned: bool,
}

fn default_encryption_state() -> String {
    "plain".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderMetadata {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    /// Telegram public username (e.g. "mychannel"). None if private.
    pub username: Option<String>,
    /// Whether the channel is public (has a username set).
    pub is_public: bool,
    // Local-first grouping & ordering metadata
    pub group_id: Option<i32>,
    pub display_order: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderGroup {
    pub id: i32,
    pub name: String,
    pub color_hex: String,
    pub display_order: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Drive {
    pub chat_id: i64,
    pub name: String,
    pub icon: Option<String>,
}
