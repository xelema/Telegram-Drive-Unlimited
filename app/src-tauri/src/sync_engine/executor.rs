use crate::{
    bandwidth::BandwidthManager,
    commands::{self, fs::DownloadFileRequest, utils::flood_wait_seconds, TelegramState},
    crypto::state::CryptoState,
    db::DbConnection,
    sync_engine::{
        config::{log_sync, SyncPair, SyncSettings},
        planner::SyncOperation,
        SyncEngine,
    },
    vpn_optimizer::NetworkConfig,
};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionResult {
    pub relative_path: String,
    pub action: String,
    pub success: bool,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub message_id: Option<i32>,
    #[serde(default)]
    pub local_hash: Option<String>,
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

async fn with_flood_wait<F, Fut, T>(
    app: &tauri::AppHandle,
    account: &crate::workspace::AccountGuard,
    mut operation: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut attempt = 0u32;
    loop {
        account.validate()?;
        if *app.state::<SyncEngine>().subscribe_shutdown()?.borrow() {
            return Err("Folder sync shutdown requested".into());
        }
        match crate::workspace::with_operation_account(account, operation()).await {
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
                if *shutdown.borrow() {
                    return Err("Folder sync shutdown requested".into());
                }
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

/// The name shown for a sync transfer: the file's own name, not its path.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
fn display_name(relative_path: &str) -> String {
    relative_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("file")
        .to_string()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn transfer_queue(app: &tauri::AppHandle) -> Option<Arc<crate::transfer_engine::TransferEngine>> {
    app.try_state::<Arc<crate::transfer_engine::TransferEngine>>()
        .map(|engine| engine.inner().clone())
}

async fn upload(
    app: &tauri::AppHandle,
    pair: &SyncPair,
    path: &Path,
    relative_path: &str,
    settings: &SyncSettings,
    account: &crate::workspace::AccountGuard,
) -> Result<UploadedFile, String> {
    let protection_mode = upload_protection_mode(app, settings)?;
    let protected = protection_mode.is_some();
    let path = path.to_string_lossy().into_owned();
    // One id for every attempt, registered so shutdown can cancel the upload.
    let transfer_id = format!("sync-{}", uuid::Uuid::new_v4());
    let _active = app
        .state::<SyncEngine>()
        .track_transfer(transfer_id.clone(), None);

    // The transfer queue runs the upload: it shares the queue's limits and
    // retries, shows in Transfers, and continues a large file where an
    // earlier attempt stopped.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some(queue) = transfer_queue(app) {
        let total_bytes = tokio::fs::metadata(&path)
            .await
            .map(|metadata| metadata.len())
            .ok();
        let job = queue
            .run_supervised(
                crate::transfer_engine::TransferEnqueueRequest {
                    id: transfer_id,
                    owner_id: Some(account.owner.to_string()),
                    direction: crate::transfer_engine::TransferDirection::Upload,
                    kind: crate::transfer_engine::TransferKind::LocalUpload,
                    path: Some(path),
                    url: None,
                    folder_id: Some(pair.channel_id),
                    message_id: None,
                    filename: display_name(relative_path),
                    save_path: None,
                    collision_policy: Default::default(),
                    protection_mode,
                    prompt_token: None,
                    protect_metadata: Some(true),
                    video_upload_mode: Some("file".to_string()),
                    temp_zip_path: None,
                    total_bytes,
                    initial_status: None,
                    origin: Some(crate::transfer_engine::ORIGIN_SYNC.to_string()),
                    sync_path: Some(relative_path.to_string()),
                },
                app.state::<SyncEngine>().subscribe_shutdown()?,
            )
            .await?;
        account.validate()?;
        let message_id = job.message_id.ok_or_else(|| {
            "Upload succeeded but Telegram did not return its message id".to_string()
        })?;
        return Ok(UploadedFile {
            message_id,
            protected,
        });
    }

    let message_id = with_flood_wait(app, account, || {
        commands::fs::upload_local_file(
            path.clone(),
            Some(pair.channel_id),
            Some(transfer_id.clone()),
            protection_mode.clone(),
            None,
            Some(true),
            Some("file".to_string()),
            Some(relative_path.to_string()),
            app.clone(),
            app.state::<TelegramState>(),
            app.state::<Arc<BandwidthManager>>(),
            app.state::<Arc<NetworkConfig>>(),
            app.state::<CryptoState>(),
            app.state::<DbConnection>(),
            Some(account.owner.to_string()),
        )
    })
    .await?;
    let message_id = message_id
        .parse::<i32>()
        .map_err(|_| "Upload succeeded but Telegram did not return its message id".to_string())?;
    Ok(UploadedFile {
        message_id,
        protected,
    })
}

struct UploadedFile {
    message_id: i32,
    /// The file was uploaded as an encrypted envelope.
    protected: bool,
}

pub(crate) fn upload_protection_mode(
    app: &tauri::AppHandle,
    settings: &SyncSettings,
) -> Result<Option<String>, String> {
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
    if protection_mode.is_some() && !crypto.get_features().upload_enabled {
        return Err(
            "Encrypted uploads are unavailable in this build; this mapping is paused".into(),
        );
    }
    Ok(protection_mode)
}

fn inherited_protection_mode(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let settings_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("settings.json");
    let contents = match std::fs::read_to_string(settings_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Cannot read the inherited encryption preference: {error}"
            ))
        }
    };
    let value: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|error| format!("Cannot read the inherited encryption preference: {error}"))?;
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
    account: &crate::workspace::AccountGuard,
) -> Result<(), String> {
    with_flood_wait(app, account, || {
        commands::fs::cmd_delete_file(
            message_id,
            Some(channel_id),
            app.state::<TelegramState>(),
            app.state::<DbConnection>(),
            app.clone(),
            Some(account.owner.to_string()),
        )
    })
    .await
    .map(|_| ())
}

async fn verify_remote_precondition(
    app: &tauri::AppHandle,
    pair: &SyncPair,
    message_id: i32,
    expected_hash: &str,
    account: &crate::workspace::AccountGuard,
) -> Result<(), String> {
    account.validate()?;
    let telegram = app.state::<TelegramState>();
    let client = telegram
        .client
        .lock()
        .await
        .clone()
        .ok_or("Telegram is offline; remote deletion was cancelled")?;
    account.validate_client(&client).await?;
    let peer =
        commands::utils::resolve_peer(&client, Some(pair.channel_id), &telegram.peer_cache).await?;
    let message = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .flatten()
        .next()
        .ok_or("The remote file disappeared after planning; deletion was cancelled")?;
    let actual = super::message_fingerprint(&message)?;
    if actual != expected_hash {
        return Err("The remote file changed after planning; deletion was cancelled".into());
    }
    account.validate()
}

#[allow(clippy::too_many_arguments)] // One value per independent input of a download.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(unused_variables))]
async fn download(
    app: &tauri::AppHandle,
    pair: &SyncPair,
    message_id: i32,
    relative_path: &str,
    total_bytes: u64,
    destination: &Path,
    expected_local_hash: Option<&str>,
    account: &crate::workspace::AccountGuard,
) -> Result<String, String> {
    account.validate()?;
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let temporary = temporary_download_path(destination)?;
    reserve_temporary_download(&temporary).await?;
    let transfer_id = format!("sync-{}", uuid::Uuid::new_v4());
    // Registered so shutdown can cancel the download and, if it has to be
    // abandoned, remove this reserved staging file.
    let _active = app
        .state::<SyncEngine>()
        .track_transfer(transfer_id.clone(), Some(temporary.clone()));
    // The transfer queue runs the download, into our staging file.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let queue = transfer_queue(app);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let queue: Option<()> = None;
    let result = match queue {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        Some(queue) => match app.state::<SyncEngine>().subscribe_shutdown() {
            Ok(stop) => queue
                .run_supervised(
                    crate::transfer_engine::TransferEnqueueRequest {
                        id: transfer_id,
                        owner_id: Some(account.owner.to_string()),
                        direction: crate::transfer_engine::TransferDirection::Download,
                        kind: crate::transfer_engine::TransferKind::Download,
                        path: None,
                        url: None,
                        folder_id: Some(pair.channel_id),
                        message_id: Some(message_id),
                        filename: display_name(relative_path),
                        // This is our exclusively reserved internal staging
                        // file, never the user destination.
                        save_path: Some(temporary.to_string_lossy().into_owned()),
                        collision_policy:
                            commands::download_destination::DownloadCollisionPolicy::Replace,
                        protection_mode: None,
                        prompt_token: None,
                        protect_metadata: None,
                        video_upload_mode: None,
                        temp_zip_path: None,
                        total_bytes: Some(total_bytes),
                        initial_status: None,
                        origin: Some(crate::transfer_engine::ORIGIN_SYNC.to_string()),
                        sync_path: None,
                    },
                    stop,
                )
                .await
                .map(|_| ()),
            Err(error) => Err(error),
        },
        _ => {
            let request = DownloadFileRequest {
                owner_id: Some(account.owner.to_string()),
                // This is our exclusively reserved internal staging file, never the user destination.
                collision_policy: commands::download_destination::DownloadCollisionPolicy::Replace,
                message_id,
                save_path: temporary.to_string_lossy().into_owned(),
                folder_id: Some(pair.channel_id),
                transfer_id: Some(transfer_id),
                prompt_token: None,
            };
            with_flood_wait(app, account, || {
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
            .await
            .map(|_| ())
        }
    };
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    if let Err(error) = account.validate() {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    let temporary_for_hash = temporary.clone();
    let published_hash = tokio::task::spawn_blocking(move || super::hash_file(&temporary_for_hash))
        .await
        .map_err(|error| error.to_string())??;
    if let Err(error) = verify_local_precondition(destination, expected_local_hash).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    if let Err(error) = account.validate() {
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
        })?;
    Ok(published_hash)
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
    account: &crate::workspace::AccountGuard,
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
        let mut downloaded_hash = None;
        let precondition = account.validate().and_then(|_| {
            if *app.state::<SyncEngine>().subscribe_shutdown()?.borrow() {
                Err("Folder sync paused after the current operation".to_string())
            } else {
                Ok(())
            }
        });
        let outcome = match precondition {
            Err(error) => Err(error),
            Ok(()) => match operation {
                SyncOperation::Upload { local, .. } => {
                    match validate_upload_size(local.file_size) {
                        Err(error) => Err(error),
                        Ok(()) => match safe_local_path(root, &path) {
                            Ok(local_path) if local_path.is_file() => {
                                match tokio::fs::metadata(&local_path).await {
                                    Err(error) => Err(error.to_string()),
                                    Ok(metadata) => match validate_upload_size(metadata.len()) {
                                        Err(error) => Err(error),
                                        Ok(()) => {
                                            match upload(
                                                app,
                                                pair,
                                                &local_path,
                                                &path,
                                                settings,
                                                account,
                                            )
                                            .await
                                            {
                                                Ok(UploadedFile {
                                                    message_id,
                                                    protected,
                                                }) => {
                                                    let verify_path = local_path.clone();
                                                    let current_hash =
                                                        tokio::task::spawn_blocking(move || {
                                                            super::hash_file(&verify_path)
                                                        })
                                                        .await
                                                        .map_err(|error| error.to_string())
                                                        .and_then(|result| result);
                                                    match current_hash {
                                                        Err(error) => Err(error),
                                                        Ok(current_hash)
                                                            if current_hash != local.hash =>
                                                        {
                                                            let _ = delete_remote(
                                                                app,
                                                                pair.channel_id,
                                                                message_id,
                                                                account,
                                                            )
                                                            .await;
                                                            Err("Local file changed during upload; uploaded attempt was discarded and will be retried".to_string())
                                                        }
                                                        Ok(_) => match account.validate() {
                                                            Err(error) => Err(error),
                                                            Ok(()) => {
                                                                uploaded_message_id =
                                                                    Some(message_id);
                                                                // Recorded now, not after
                                                                // the whole batch: if the
                                                                // engine stops before then,
                                                                // the next cycle still
                                                                // knows this message is
                                                                // this file.
                                                                if let Err(error) =
                                                                    super::journal_upload(
                                                                        db, pair.id, &path, &local,
                                                                        message_id,
                                                                    )
                                                                    .await
                                                                {
                                                                    log::warn!("Folder sync could not journal an upload yet: {error}");
                                                                }
                                                                // A protected file keeps its
                                                                // envelope marker as caption:
                                                                // writing the path there would
                                                                // expose it and is refused for
                                                                // envelopes. Its path is mapped
                                                                // by the journaled message id.
                                                                if !protected {
                                                                    crate::workspace::with_operation_account(account, commands::fs::cmd_rename_file(
                                                        message_id,
                                                        Some(pair.channel_id),
                                                        path.clone(),
                                                        app.state::<TelegramState>(),
                                                        app.state::<DbConnection>(),
                                                        app.clone(),
                                                        Some(account.owner.to_string()),
                                                    )).await.map(|_| ())
                                                                } else {
                                                                    Ok(())
                                                                }
                                                            }
                                                        },
                                                    }
                                                }
                                                Err(error) => Err(error),
                                            }
                                        }
                                    },
                                }
                            }
                            Ok(_) => Err("Local file disappeared before upload".to_string()),
                            Err(error) => Err(error),
                        },
                    }
                }
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
                            download(
                                app,
                                pair,
                                message_id,
                                &path,
                                remote.file_size,
                                &destination,
                                expected_hash,
                                account,
                            )
                            .await
                            .map(|hash| {
                                if !keep_both {
                                    downloaded_hash = Some(hash);
                                }
                            })
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
                            Ok(()) => match account.validate() {
                                Ok(()) => tokio::fs::remove_file(local)
                                    .await
                                    .map_err(|error| error.to_string()),
                                Err(error) => Err(error),
                            },
                            Err(error) => Err(error),
                        }
                    }
                    Err(error) => Err(error),
                },
                SyncOperation::DeleteRemote {
                    message_id,
                    expected_remote_hash,
                    ..
                } => {
                    match verify_remote_precondition(
                        app,
                        pair,
                        message_id,
                        &expected_remote_hash,
                        account,
                    )
                    .await
                    {
                        Ok(()) => delete_remote(app, pair.channel_id, message_id, account).await,
                        Err(error) => Err(error),
                    }
                }
                SyncOperation::Conflict { .. } => {
                    Err("Conflict requires user resolution".to_string())
                }
                SyncOperation::Skip { .. } => Ok(()),
            },
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
            local_hash: downloaded_hash,
        };
        let _ = app.emit("sync-operation", &result);
        results.push(result);
    }
    results
}
