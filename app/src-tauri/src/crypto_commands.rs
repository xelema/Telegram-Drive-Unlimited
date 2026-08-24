use crate::crypto::error::CryptoError;
use crate::crypto::state::{CryptoState, UnlockSessionId};
use crate::db::DbConnection;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use zeroize::Zeroize;

const CRYPTO_CONTRACT_VERSION: u16 = 2;
const CRYPTO_BACKEND_BUILD_ID: &str = concat!(env!("CARGO_PKG_VERSION"), "-tdenc2");

#[derive(Debug, Clone, Serialize)]
pub struct CryptoFeatureAvailability {
    pub upload: bool,
    pub read: bool,
    pub per_file_passphrase: bool,
    pub recovery: bool,
    pub share: bool,
    pub migration: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CryptoCapabilitiesResponse {
    pub contract_version: u16,
    pub app_version: String,
    pub backend_build_id: String,
    pub availability: String,
    pub blockers: Vec<String>,
    pub vault_backend: String,
    pub readable_formats: Vec<u16>,
    pub writable_formats: Vec<u16>,
    pub features: CryptoFeatureAvailability,

    // Legacy fields remain during the frontend contract migration. They are
    // deliberately false while TDENC1 is quarantined.
    pub core_available: bool,
    pub mode_alpha: bool,
    pub upload_enabled: bool,
    pub read_enabled: bool,
    pub share_enabled: bool,
    pub migration_enabled: bool,
    pub supported_suites: Vec<u16>,
    pub envelope_version: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct CryptoInventoryEntry {
    pub envelope_version: i64,
    pub file_count: i64,
    pub ciphertext_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CryptoInventory {
    pub entries: Vec<CryptoInventoryEntry>,
    pub total_files: i64,
    pub total_ciphertext_bytes: i64,
    pub vault_exists: bool,
    pub experimental_format_quarantined: bool,
}

/// Encryption settings (non-secret preferences only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptionSettings {
    pub default_mode: String, // "standard" | "vault"
    pub protect_metadata: bool,
    pub auto_lock_minutes: u32, // 0 = never (with warning)
    pub lock_on_sleep: bool,
    pub temp_policy: String, // "balanced" | "strict"
    pub remember_device: bool,
}

impl Default for EncryptionSettings {
    fn default() -> Self {
        Self {
            default_mode: "standard".to_string(),
            protect_metadata: true,
            auto_lock_minutes: 15,
            lock_on_sleep: true,
            temp_policy: "balanced".to_string(),
            remember_device: false,
        }
    }
}

/// Vault status response.
#[derive(Debug, Clone, Serialize)]
pub struct VaultStatus {
    pub exists: bool,
    pub is_unlocked: bool,
    pub session_id: Option<UnlockSessionId>,
    pub has_recovery: bool,
    pub created_at: Option<String>,
}

/// File encryption info for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct FileEncryptionInfo {
    pub state: String,
    pub envelope_version: Option<u16>,
    pub profile_id: Option<String>,
    pub protection_mode: Option<String>,
    pub metadata_protected: Option<bool>,
    pub ciphertext_size: Option<u64>,
}

/// Protection intent for upload operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtectionIntent {
    pub mode: String, // "standard" | "vault" | "passphrase" | "vault_and_passphrase"
    pub profile_id: Option<String>,
    pub protect_metadata: Option<bool>,
}

impl Default for ProtectionIntent {
    fn default() -> Self {
        Self {
            mode: "standard".to_string(),
            profile_id: None,
            protect_metadata: None,
        }
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────

/// Get encryption capabilities (feature flags, supported suites).
#[tauri::command]
pub async fn cmd_get_encryption_capabilities(
    crypto_state: State<'_, CryptoState>,
) -> Result<CryptoCapabilitiesResponse, String> {
    let features = crypto_state.get_features();
    Ok(CryptoCapabilitiesResponse {
        contract_version: CRYPTO_CONTRACT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        backend_build_id: CRYPTO_BACKEND_BUILD_ID.to_string(),
        availability: if features.core_available {
            "ready"
        } else {
            "blocked"
        }
        .to_string(),
        blockers: if features.core_available {
            Vec::new()
        } else {
            vec!["CRYPTO_BACKEND_DISABLED".to_string()]
        },
        vault_backend: "persistent_file".to_string(),
        readable_formats: if features.read_enabled {
            vec![2]
        } else {
            Vec::new()
        },
        writable_formats: if features.upload_enabled {
            vec![2]
        } else {
            Vec::new()
        },
        features: CryptoFeatureAvailability {
            upload: features.upload_enabled,
            read: features.read_enabled,
            per_file_passphrase: features.upload_enabled && features.read_enabled,
            recovery: features.core_available,
            share: features.share_enabled,
            migration: features.migration_enabled,
        },
        core_available: features.core_available,
        mode_alpha: features.mode_alpha,
        upload_enabled: features.upload_enabled,
        read_enabled: features.read_enabled,
        share_enabled: features.share_enabled,
        migration_enabled: features.migration_enabled,
        supported_suites: vec![1],
        envelope_version: 2,
    })
}

/// Read-only inventory of locally indexed encrypted objects. This command is
/// intentionally available while encryption is blocked so experimental
/// ciphertext can be identified and preserved.
#[tauri::command]
pub async fn cmd_get_crypto_inventory(
    db_pool: State<'_, DbConnection>,
    crypto_state: State<'_, CryptoState>,
) -> Result<CryptoInventory, String> {
    let (entries, total_files, total_ciphertext_bytes, experimental_format_quarantined) =
        crate::db::with_connection(db_pool.inner().clone(), |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT envelope_version, COUNT(*), COALESCE(SUM(ciphertext_size), 0) \
             FROM encrypted_files GROUP BY envelope_version ORDER BY envelope_version",
                )
                .map_err(|e| e.to_string())?;

            let mut entries = Vec::new();
            let mut total_files = 0i64;
            let mut total_ciphertext_bytes = 0i64;
            let mut experimental_format_quarantined = false;
            while let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
                let envelope_version = stmt.read::<i64, _>(0).map_err(|e| e.to_string())?;
                let file_count = stmt.read::<i64, _>(1).map_err(|e| e.to_string())?;
                let ciphertext_bytes = stmt.read::<i64, _>(2).map_err(|e| e.to_string())?;
                total_files = total_files.saturating_add(file_count);
                total_ciphertext_bytes = total_ciphertext_bytes.saturating_add(ciphertext_bytes);
                experimental_format_quarantined |= envelope_version == 1;
                entries.push(CryptoInventoryEntry {
                    envelope_version,
                    file_count,
                    ciphertext_bytes,
                });
            }

            Ok((
                entries,
                total_files,
                total_ciphertext_bytes,
                experimental_format_quarantined,
            ))
        })
        .await?;

    Ok(CryptoInventory {
        entries,
        total_files,
        total_ciphertext_bytes,
        vault_exists: crypto_state.vault_exists(),
        experimental_format_quarantined,
    })
}

/// Get non-secret encryption settings.
#[tauri::command]
pub async fn cmd_get_encryption_settings() -> Result<EncryptionSettings, String> {
    // In production, load from Tauri store
    Ok(EncryptionSettings::default())
}

/// Update non-secret encryption settings.
#[tauri::command]
pub async fn cmd_update_encryption_settings(
    settings: EncryptionSettings,
    crypto_state: State<'_, CryptoState>,
) -> Result<EncryptionSettings, String> {
    if !matches!(
        settings.default_mode.as_str(),
        "standard" | "vault" | "passphrase" | "vault_and_passphrase"
    ) {
        return Err("[POLICY_REJECTED] Invalid default encryption mode".to_string());
    }
    if !matches!(settings.temp_policy.as_str(), "balanced" | "strict") {
        return Err("[POLICY_REJECTED] Invalid temporary plaintext policy".to_string());
    }
    if settings.auto_lock_minutes > 24 * 60 {
        return Err("[POLICY_REJECTED] Auto-lock timeout exceeds 24 hours".to_string());
    }
    let timeout = if settings.auto_lock_minutes == 0 {
        None
    } else {
        Some(std::time::Duration::from_secs(
            u64::from(settings.auto_lock_minutes) * 60,
        ))
    };
    crypto_state.set_auto_lock_timeout(timeout);
    Ok(settings)
}

/// Create a new vault.
#[tauri::command]
pub async fn cmd_create_vault(
    mut passphrase: String,
    crypto_state: State<'_, CryptoState>,
    app_handle: tauri::AppHandle,
) -> Result<UnlockSessionId, String> {
    if !crypto_state.get_features().core_available {
        passphrase.zeroize();
        return Err("[ENCRYPTION_BLOCKED] Vault creation is disabled until the production vault and TDENC2 format are ready.".to_string());
    }
    let result = crypto_state
        .create_vault(passphrase.as_bytes())
        .map_err(|e| e.to_string());
    passphrase.zeroize();
    if result.is_ok() {
        let _ = app_handle.emit("vault-unlocked", ());
    }
    result
}

/// Unlock the vault and get a session handle.
#[tauri::command]
pub async fn cmd_unlock_vault(
    mut passphrase: String,
    crypto_state: State<'_, CryptoState>,
    app_handle: tauri::AppHandle,
) -> Result<UnlockSessionId, String> {
    let result = crypto_state
        .unlock(passphrase.as_bytes())
        .map_err(|e| e.to_string());
    passphrase.zeroize();
    if result.is_ok() {
        let _ = app_handle.emit("vault-unlocked", ());
    }
    result
}

#[tauri::command]
pub async fn cmd_change_vault_passphrase(
    mut new_passphrase: String,
    crypto_state: State<'_, CryptoState>,
) -> Result<(), String> {
    let result = crypto_state
        .change_vault_passphrase(new_passphrase.as_bytes())
        .map_err(|error| error.to_string());
    new_passphrase.zeroize();
    result
}

/// Lock the vault and invalidate all handles.
/// Also revokes all active plaintext leases and clears the encrypted cache.
#[tauri::command]
pub async fn cmd_lock_vault(
    crypto_state: State<'_, CryptoState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    crypto_state.lock();
    // Emit event so frontend refreshes encrypted file states
    let _ = app_handle.emit("vault-locked", ());
    log::info!("Vault locked — all handles revoked, encrypted routes disabled");
    Ok(())
}

/// Record throttled foreground input for the inactivity deadline. Activity
/// arriving after an elapsed deadline locks atomically rather than reviving an
/// expired vault after process or device suspension.
#[tauri::command]
pub async fn cmd_record_vault_activity(
    crypto_state: State<'_, CryptoState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if crypto_state.record_activity() {
        let _ = app_handle.emit("vault-locked", "auto_lock");
    }
    Ok(())
}

/// Stage a file passphrase behind a short-lived, opaque, single-use token.
/// The returned token is safe to keep in an in-memory queue; the passphrase is
/// consumed by the next upload/download command and is never persisted.
#[tauri::command]
pub async fn cmd_stage_file_passphrase(
    mut passphrase: String,
    crypto_state: State<'_, CryptoState>,
) -> Result<u64, String> {
    if !crypto_state.get_features().core_available {
        passphrase.zeroize();
        return Err("[ENCRYPTION_BLOCKED] Per-file passphrases are not available".to_string());
    }
    let result = crypto_state
        .stage_prompt_secret(passphrase.as_bytes())
        .map_err(|error| error.to_string());
    passphrase.zeroize();
    result
}

/// Get the current vault status.
#[tauri::command]
pub async fn cmd_get_vault_status(
    crypto_state: State<'_, CryptoState>,
) -> Result<VaultStatus, String> {
    let exists = crypto_state.vault_exists();
    let is_locked = crypto_state.is_locked();
    Ok(VaultStatus {
        exists,
        is_unlocked: exists && !is_locked,
        session_id: None,
        has_recovery: false,
        created_at: None,
    })
}

/// Export a recovery bundle.
#[tauri::command]
pub async fn cmd_export_vault_recovery(
    mut recovery_passphrase: String,
    crypto_state: State<'_, CryptoState>,
) -> Result<String, String> {
    if !crypto_state.get_features().core_available {
        recovery_passphrase.zeroize();
        return Err("[RECOVERY_UNAVAILABLE] Recovery export is disabled because the current implementation cannot produce a valid recovery bundle.".to_string());
    }
    let bundle_result = crypto_state
        .export_recovery(recovery_passphrase.as_bytes())
        .map_err(|e| e.to_string());
    recovery_passphrase.zeroize();
    let bundle = bundle_result?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &bundle,
    ))
}

/// Import a recovery bundle.
#[tauri::command]
pub async fn cmd_import_vault_recovery(
    mut bundle_base64: String,
    mut recovery_passphrase: String,
    replace_existing: Option<bool>,
    crypto_state: State<'_, CryptoState>,
) -> Result<(), String> {
    if !crypto_state.get_features().core_available {
        bundle_base64.zeroize();
        recovery_passphrase.zeroize();
        return Err("[RECOVERY_UNAVAILABLE] Recovery import is disabled until authenticated recovery bundles are implemented.".to_string());
    }
    if crypto_state.vault_exists() && replace_existing != Some(true) {
        bundle_base64.zeroize();
        recovery_passphrase.zeroize();
        return Err(
            "[RECOVERY_CONFIRMATION_REQUIRED] Import would replace the existing vault".to_string(),
        );
    }
    let mut bundle =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &bundle_base64)
            .map_err(|e| format!("Invalid base64: {}", e))?;

    let result = crypto_state
        .import_recovery(&bundle, recovery_passphrase.as_bytes())
        .map_err(|e| e.to_string());
    bundle.zeroize();
    bundle_base64.zeroize();
    recovery_passphrase.zeroize();
    result
}

/// Generate a recovery key (256-bit random, displayed to user).
#[tauri::command]
pub async fn cmd_generate_recovery_key() -> Result<String, String> {
    Err("[RECOVERY_UNAVAILABLE] A recovery key cannot be generated until it is cryptographically connected to the vault.".to_string())
}

/// Get file encryption info for a given message.
#[tauri::command]
pub async fn cmd_get_file_encryption_info(
    message_id: i32,
    folder_id: Option<i64>,
    db_pool: State<'_, DbConnection>,
    crypto_state: State<'_, CryptoState>,
) -> Result<FileEncryptionInfo, String> {
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    let row = crate::db::with_connection(db_pool.inner().clone(), move |conn| {
    let query = "SELECT envelope_version, key_profile_id, record_state, ciphertext_size, protection_mode, metadata_protected FROM encrypted_files WHERE folder_key = ? AND message_id = ?";
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    stmt.bind((1, folder_key.as_str()))
        .map_err(|e| e.to_string())?;
    stmt.bind((2, message_id as i64))
        .map_err(|e| e.to_string())?;

    if let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        let version: Option<i64> = stmt.read::<Option<i64>, _>(0).ok().flatten();
        let profile_id: Option<String> = stmt.read::<Option<String>, _>(1).ok().flatten();
        let state_str: String = stmt
            .read::<String, _>(2)
            .unwrap_or_else(|_| "active".to_string());
        let ct_size: Option<i64> = stmt.read::<Option<i64>, _>(3).ok().flatten();
        let protection_mode: Option<String> = stmt.read::<Option<String>, _>(4).ok().flatten();
        let metadata_protected = stmt
            .read::<Option<i64>, _>(5)
            .ok()
            .flatten()
            .map(|value| value != 0);

        Ok(Some((version, profile_id, state_str, ct_size, protection_mode, metadata_protected)))
    } else {
        Ok(None)
    }
    }).await?;

    if let Some((version, profile_id, state_str, ct_size, protection_mode, metadata_protected)) =
        row
    {
        let state = match state_str.as_str() {
            "active" if version == Some(1) => "encrypted_unsupported_version",
            "active"
                if !crypto_state.is_locked()
                    && matches!(
                        protection_mode.as_deref(),
                        Some("vault") | Some("vault_and_passphrase")
                    ) =>
            {
                "encrypted_unlocked"
            }
            "active" => "encrypted_locked",
            "verifying" => "encrypted_verifying",
            "corrupt" => "encrypted_corrupt",
            _ => "encrypted_locked",
        };

        Ok(FileEncryptionInfo {
            state: state.to_string(),
            envelope_version: version.map(|v| v as u16),
            profile_id,
            protection_mode,
            metadata_protected,
            ciphertext_size: ct_size.map(|s| s as u64),
        })
    } else {
        Ok(FileEncryptionInfo {
            state: "plain".to_string(),
            envelope_version: None,
            profile_id: None,
            protection_mode: None,
            metadata_protected: None,
            ciphertext_size: None,
        })
    }
}

/// Verify an encrypted file's integrity.
#[tauri::command]
pub async fn cmd_verify_encrypted_file(
    _message_id: i32,
    _folder_id: Option<i64>,
    crypto_state: State<'_, CryptoState>,
) -> Result<String, String> {
    if crypto_state.is_locked() {
        return Err(CryptoError::vault_locked().to_string());
    }
    Err("[VERIFICATION_REQUIRES_DOWNLOAD] Full verification requires streaming and authenticating the complete remote envelope".to_string())
}
