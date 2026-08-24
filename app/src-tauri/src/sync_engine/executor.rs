use crate::{
    bandwidth::BandwidthManager,
    commands::{self, fs::DownloadFileRequest, TelegramState},
    crypto::state::CryptoState,
    db::DbConnection,
    sync_engine::{
        config::{log_sync, SyncPair, SyncSettings},
        planner::SyncOperation,
        SyncEngine,
    },
    vpn_optimizer::NetworkConfig,
};
use serde::Serialize;
use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{Emitter, Manager};

pub const TELEGRAM_MAX_FILE_BYTES: u64 = 2_000_000_000;

fn validate_upload_size(file_size: u64) -> Result<(), String> {
    if file_size > TELEGRAM_MAX_FILE_BYTES {
        Err(format!(
            "Skipped: file is {file_size} bytes; Telegram sync limit is {TELEGRAM_MAX_FILE_BYTES} bytes"
        ))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionResult {
    pub relative_path: String,
    pub action: String,
    pub success: bool,
    pub detail: Option<String>,
    pub message_id: Option<i32>,
}

fn safe_local_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("Unsafe sync path: {relative_path}"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Sync root is unavailable: {error}"))?;
    let candidate = canonical_root.join(relative);
    let mut existing_ancestor = candidate.as_path();
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| format!("Unsafe sync path: {relative_path}"))?;
    }
    let canonical_ancestor = existing_ancestor
        .canonicalize()
        .map_err(|error| format!("Could not validate sync destination: {error}"))?;
    if !canonical_ancestor.starts_with(&canonical_root) {
        return Err(format!(
            "Sync path escapes the mapped folder through a symbolic link: {relative_path}"
        ));
    }
    Ok(candidate)
}

fn validate_portable_relative_path(relative_path: &str) -> Result<(), String> {
    for component in Path::new(relative_path).components() {
        let Component::Normal(name) = component else {
            return Err(format!("Unsafe sync path: {relative_path}"));
        };
        let name = name
            .to_str()
            .ok_or_else(|| format!("Sync filename is not valid UTF-8: {relative_path}"))?;
        let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
        let windows_reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"))
                .and_then(|number| number.parse::<u8>().ok())
                .is_some_and(|number| (1..=9).contains(&number));
        let invalid = name.is_empty()
            || name.ends_with(['.', ' '])
            || windows_reserved
            || name.chars().any(|character| {
                character.is_control()
                    || matches!(
                        character,
                        '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                    )
            });
        if invalid {
            return Err(format!(
                "Telegram path cannot be represented portably on Windows, macOS, and Linux: {relative_path}"
            ));
        }
    }
    Ok(())
}

fn safe_download_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    validate_portable_relative_path(relative_path)?;
    safe_local_path(root, relative_path)
}

fn conflict_path(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    let suffix = &uuid::Uuid::new_v4().to_string()[..8];
    let name = match extension {
        Some(extension) => format!("{stem}.remote-conflict-{suffix}.{extension}"),
        None => format!("{stem}.remote-conflict-{suffix}"),
    };
    path.with_file_name(name)
}

fn temporary_download_path(destination: &Path) -> Result<PathBuf, String> {
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid destination filename")?;
    Ok(destination.with_file_name(format!("{file_name}.td-sync-tmp")))
}

async fn reserve_temporary_download(path: &Path) -> Result<(), String> {
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map(|_| ())
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!(
                    "Temporary download already exists and was preserved: {}",
                    path.display()
                )
            } else {
                format!("Could not reserve temporary download: {error}")
            }
        })
}

fn flood_wait_seconds(error: &str) -> Option<u64> {
    let marker = "FLOOD_WAIT_";
    let start = error.find(marker)? + marker.len();
    let digits: String = error[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

async fn with_flood_wait<F, Fut, T>(app: &tauri::AppHandle, mut operation: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut attempt = 0u32;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if attempt >= 5 {
                    return Err(error);
                }
                let Some(server_wait) = flood_wait_seconds(&error) else {
                    return Err(error);
                };
                let exponential = 1u64 << attempt.min(8);
                let wait = server_wait.max(exponential);
                log::warn!("Folder sync hit FLOOD_WAIT; retrying in {wait}s");
                let mut shutdown = app.state::<SyncEngine>().subscribe_shutdown()?;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(wait)) => {}
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            return Err("Folder sync shutdown requested".to_string());
                        }
                    }
                }
                attempt += 1;
            }
        }
    }
}

async fn upload(
    app: &tauri::AppHandle,
    pair: &SyncPair,
    path: &Path,
    settings: &SyncSettings,
) -> Result<i32, String> {
    let crypto = app.state::<CryptoState>();
    let protection_mode = match settings.encryption.as_str() {
        "always_vault" => Some("vault".to_string()),
        "inherit" => inherited_protection_mode(app)?,
        "standard" => None,
        mode => return Err(format!("Unsupported folder sync encryption mode: {mode}")),
    };
    if protection_mode
        .as_deref()
        .is_some_and(|mode| matches!(mode, "vault" | "vault_and_passphrase"))
        && crypto.is_locked()
    {
        return Err("[VAULT_LOCKED] Sync upload paused until the vault is unlocked".to_string());
    }
    if protection_mode
        .as_deref()
        .is_some_and(|mode| matches!(mode, "passphrase" | "vault_and_passphrase"))
    {
        return Err("[KEY_REQUIRED] Background sync cannot prompt for a per-file passphrase; choose standard or vault encryption".to_string());
    }
    let path = path.to_string_lossy().into_owned();
    let message_id = with_flood_wait(app, || {
        commands::fs::cmd_upload_file(
            path.clone(),
            Some(pair.channel_id),
            Some(format!("sync-{}", uuid::Uuid::new_v4())),
            protection_mode.clone(),
            None,
            Some(true),
            app.clone(),
            app.state::<TelegramState>(),
            app.state::<Arc<BandwidthManager>>(),
            app.state::<Arc<NetworkConfig>>(),
            app.state::<CryptoState>(),
            app.state::<DbConnection>(),
        )
    })
    .await?;
    message_id
        .parse::<i32>()
        .map_err(|_| "Upload succeeded but Telegram did not return its message id".to_string())
}

fn inherited_protection_mode(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let settings_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("settings.json");
    let Ok(contents) = std::fs::read_to_string(settings_path) else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(&contents).unwrap_or_default();
    let mode = value
        .pointer("/settings/encryptionDefaultMode")
        .or_else(|| value.get("encryptionDefaultMode"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("standard");
    match mode {
        "standard" => Ok(None),
        "vault" | "passphrase" | "vault_and_passphrase" => Ok(Some(mode.to_string())),
        _ => Err("Stored default encryption mode is invalid".to_string()),
    }
}

pub(crate) async fn delete_remote(
    app: &tauri::AppHandle,
    channel_id: i64,
    message_id: i32,
) -> Result<(), String> {
    with_flood_wait(app, || {
        commands::fs::cmd_delete_file(
            message_id,
            Some(channel_id),
            app.state::<TelegramState>(),
            app.state::<DbConnection>(),
        )
    })
    .await
    .map(|_| ())
}

async fn download(
    app: &tauri::AppHandle,
    pair: &SyncPair,
    message_id: i32,
    destination: &Path,
    expected_local_hash: Option<&str>,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let temporary = temporary_download_path(destination)?;
    reserve_temporary_download(&temporary).await?;
    let request = DownloadFileRequest {
        message_id,
        save_path: temporary.to_string_lossy().into_owned(),
        folder_id: Some(pair.channel_id),
        transfer_id: Some(format!("sync-{}", uuid::Uuid::new_v4())),
        prompt_token: None,
    };
    let result = with_flood_wait(app, || {
        commands::fs::cmd_download_file(
            DownloadFileRequest { ..request.clone() },
            app.clone(),
            app.state::<TelegramState>(),
            app.state::<Arc<BandwidthManager>>(),
            app.state::<Arc<NetworkConfig>>(),
            app.state::<CryptoState>(),
            app.state::<DbConnection>(),
        )
    })
    .await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    if let Err(error) = verify_local_precondition(destination, expected_local_hash).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    atomic_replace(&temporary, destination)
        .await
        .map_err(|error| {
            format!(
                "Downloaded safely to {} but atomic rename failed: {error}",
                temporary.display()
            )
        })
}

async fn verify_local_precondition(path: &Path, expected_hash: Option<&str>) -> Result<(), String> {
    match expected_hash {
        Some(expected_hash) => {
            let path = path.to_owned();
            let actual_hash = tokio::task::spawn_blocking(move || super::hash_file(&path))
                .await
                .map_err(|error| error.to_string())??;
            if actual_hash != expected_hash {
                return Err(
                    "Local file changed after sync planning; destructive operation was cancelled"
                        .to_string(),
                );
            }
        }
        None => {
            if tokio::fs::try_exists(path)
                .await
                .map_err(|error| error.to_string())?
            {
                return Err(
                    "A local file appeared after sync planning; overwrite was cancelled"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
async fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    tokio::fs::rename(source, destination).await
}

#[cfg(target_os = "windows")]
async fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source = windows_extended_path(source);
    let destination = windows_extended_path(destination);
    tokio::task::spawn_blocking(move || {
        let result = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                    | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(target_os = "windows")]
fn windows_extended_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().collect();
    const SLASH: u16 = b'\\' as u16;
    const QUESTION: u16 = b'?' as u16;
    let mut extended = if path.starts_with(&[SLASH, SLASH, QUESTION, SLASH]) {
        path
    } else if path.starts_with(&[SLASH, SLASH]) {
        "\\\\?\\UNC\\"
            .encode_utf16()
            .chain(path.into_iter().skip(2))
            .collect()
    } else {
        "\\\\?\\".encode_utf16().chain(path).collect()
    };
    extended.push(0);
    extended
}

pub async fn execute(
    app: &tauri::AppHandle,
    db: &DbConnection,
    pair: &SyncPair,
    settings: &SyncSettings,
    operations: Vec<SyncOperation>,
) -> Vec<ExecutionResult> {
    let root = Path::new(&pair.local_path);
    let mut results = Vec::with_capacity(operations.len());
    for operation in operations {
        let path = operation.path().to_string();
        let action = match &operation {
            SyncOperation::Upload { .. } => "upload",
            SyncOperation::Download {
                keep_both: true, ..
            } => "keep_both",
            SyncOperation::Download { .. } => "download",
            SyncOperation::DeleteLocal { .. } => "delete_local",
            SyncOperation::DeleteRemote { .. } => "delete_remote",
            SyncOperation::Conflict { .. } => "conflict",
            SyncOperation::Skip { .. } => "skip",
        }
        .to_string();
        let mut uploaded_message_id = None;
        let outcome = match operation {
            SyncOperation::Upload { local, .. } => match validate_upload_size(local.file_size) {
                Err(error) => Err(error),
                Ok(()) => match safe_local_path(root, &path) {
                    Ok(local_path) if local_path.is_file() => {
                        match tokio::fs::metadata(&local_path).await {
                            Err(error) => Err(error.to_string()),
                            Ok(metadata) => match validate_upload_size(metadata.len()) {
                                Err(error) => Err(error),
                                Ok(()) => match upload(app, pair, &local_path, settings).await {
                                    Ok(message_id) => {
                                        let verify_path = local_path.clone();
                                        let current_hash = tokio::task::spawn_blocking(move || {
                                            super::hash_file(&verify_path)
                                        })
                                        .await
                                        .map_err(|error| error.to_string())
                                        .and_then(|result| result);
                                        match current_hash {
                                            Err(error) => Err(error),
                                            Ok(current_hash) if current_hash != local.hash => {
                                                let _ =
                                                    delete_remote(app, pair.channel_id, message_id)
                                                        .await;
                                                Err("Local file changed during upload; uploaded attempt was discarded and will be retried".to_string())
                                            }
                                            Ok(_) => {
                                                uploaded_message_id = Some(message_id);
                                                if settings.encryption != "always_vault" {
                                                    let _ = commands::fs::cmd_rename_file(
                                                        message_id,
                                                        Some(pair.channel_id),
                                                        path.clone(),
                                                        app.state::<TelegramState>(),
                                                        app.state::<DbConnection>(),
                                                    )
                                                    .await;
                                                }
                                                Ok(())
                                            }
                                        }
                                    }
                                    Err(error) => Err(error),
                                },
                            },
                        }
                    }
                    Ok(_) => Err("Local file disappeared before upload".to_string()),
                    Err(error) => Err(error),
                },
            },
            SyncOperation::Download {
                remote,
                keep_both,
                expected_local_hash,
                ..
            } => match remote.message_id {
                None => Err("Remote file has no Telegram message id".to_string()),
                Some(message_id) => match safe_download_path(root, &path) {
                    Ok(destination) => {
                        let destination = if keep_both {
                            conflict_path(&destination)
                        } else {
                            destination
                        };
                        let expected_hash = if keep_both {
                            None
                        } else {
                            expected_local_hash.as_deref()
                        };
                        download(app, pair, message_id, &destination, expected_hash).await
                    }
                    Err(error) => Err(error),
                },
            },
            SyncOperation::DeleteLocal {
                expected_local_hash,
                ..
            } => match safe_local_path(root, &path) {
                Ok(local) => {
                    match verify_local_precondition(&local, Some(&expected_local_hash)).await {
                        Ok(()) => tokio::fs::remove_file(local)
                            .await
                            .map_err(|error| error.to_string()),
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            },
            SyncOperation::DeleteRemote { message_id, .. } => {
                delete_remote(app, pair.channel_id, message_id).await
            }
            SyncOperation::Conflict { .. } => Err("Conflict requires user resolution".to_string()),
            SyncOperation::Skip { .. } => Ok(()),
        };
        let (success, detail) = match outcome {
            Ok(()) => (true, None),
            Err(error) => (false, Some(error)),
        };
        log_sync(
            db.clone(),
            Some(pair.id),
            action.clone(),
            Some(path.clone()),
            detail.clone(),
        )
        .await;
        let result = ExecutionResult {
            relative_path: path,
            action,
            success,
            detail,
            message_id: uploaded_message_id,
        };
        let _ = app.emit("sync-operation", &result);
        results.push(result);
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "telegram-drive-sync-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn telegram_limit_accepts_exact_boundary_and_rejects_one_byte_over() {
        assert!(validate_upload_size(TELEGRAM_MAX_FILE_BYTES).is_ok());
        assert!(validate_upload_size(TELEGRAM_MAX_FILE_BYTES + 1)
            .unwrap_err()
            .contains("Skipped"));
    }

    #[test]
    fn downloads_use_the_required_temporary_suffix() {
        let destination = Path::new("/safe/folder/report.pdf");
        assert_eq!(
            temporary_download_path(destination).unwrap(),
            PathBuf::from("/safe/folder/report.pdf.td-sync-tmp")
        );
    }

    #[test]
    fn download_names_are_portable_across_desktop_platforms() {
        assert!(validate_portable_relative_path("reports/quarter-1.pdf").is_ok());
        for invalid in [
            "CON.txt",
            "aux",
            "nested/LPT9.log",
            "report?.pdf",
            "trailing-dot.",
            "trailing-space ",
        ] {
            assert!(
                validate_portable_relative_path(invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    #[tokio::test]
    async fn atomic_replace_overwrites_only_at_the_commit_step() {
        let directory = test_directory("atomic-replace");
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("report.txt.td-sync-tmp");
        let destination = directory.join("report.txt");
        std::fs::write(&source, b"new").unwrap();
        std::fs::write(&destination, b"old").unwrap();

        atomic_replace(&source, &destination).await.unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"new");
        assert!(!source.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn destructive_local_actions_reject_changed_or_unexpected_files() {
        let directory = test_directory("precondition");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("report.txt");
        std::fs::write(&path, b"current").unwrap();
        let current_hash = super::super::hash_file(&path).unwrap();

        assert!(verify_local_precondition(&path, Some(&current_hash))
            .await
            .is_ok());
        assert!(verify_local_precondition(&path, Some("stale-hash"))
            .await
            .is_err());
        assert!(verify_local_precondition(&path, None).await.is_err());

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn existing_temporary_download_is_never_overwritten() {
        let directory = test_directory("temp-reservation");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("report.txt.td-sync-tmp");
        std::fs::write(&path, b"preserve me").unwrap();

        assert!(reserve_temporary_download(&path).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"preserve me");

        std::fs::remove_dir_all(directory).unwrap();
    }
}
