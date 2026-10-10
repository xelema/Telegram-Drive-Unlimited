use crate::bandwidth::BandwidthManager;
use crate::db::DbConnection;
use crate::vpn_optimizer::NetworkConfig;
use crate::workspace::AccountGuard;
use crate::TelegramState;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;
use tauri::{Manager, State};

/// Supported image file extensions for thumbnails.
/// Shared between Tauri commands and the REST API cache cleanup.
pub const THUMBNAIL_EXTS: &[&str] = &["thumb.jpg", "jpg", "jpeg", "png", "gif", "webp", "bmp"];

#[derive(Default)]
pub struct LegacyPreviewState {
    active: HashMap<PathBuf, usize>,
}
impl LegacyPreviewState {
    pub fn is_active(&self, path: &Path) -> bool {
        self.active.contains_key(path)
    }
}
pub fn active_legacy_paths() -> std::collections::HashSet<PathBuf> {
    legacy_preview_mutation().active.keys().cloned().collect()
}
static LEGACY_PREVIEW_STATE: LazyLock<Mutex<LegacyPreviewState>> =
    LazyLock::new(|| Mutex::new(LegacyPreviewState::default()));

/// Serializes pin decisions and cache removals; also tracks live legacy writers.
pub fn legacy_preview_mutation() -> std::sync::MutexGuard<'static, LegacyPreviewState> {
    LEGACY_PREVIEW_STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
pub(crate) struct LegacyPreviewUse(PathBuf);
impl LegacyPreviewUse {
    pub(crate) fn new(path: &Path) -> Self {
        *legacy_preview_mutation()
            .active
            .entry(path.into())
            .or_default() += 1;
        Self(path.into())
    }
}
impl Drop for LegacyPreviewUse {
    fn drop(&mut self) {
        let mut state = legacy_preview_mutation();
        if let Some(count) = state.active.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                state.active.remove(&self.0);
            }
        }
    }
}
fn preview_account(app: &tauri::AppHandle) -> Result<AccountGuard, String> {
    AccountGuard::open(&app.path().app_data_dir().map_err(|e| e.to_string())?, None)
}
pub fn configure_limits(previews: u64, thumbnails: u64) {
    crate::workspace::assets::configure_limits(previews, thumbnails);
}

async fn can_use_plain_preview(
    account: &AccountGuard,
    folder: Option<i64>,
    message: i32,
) -> Result<bool, String> {
    let account = account.clone();
    tokio::task::spawn_blocking(move || {
        account.validate()?;
        let file = crate::workspace::store::Store::open(&account.root, account.owner)?
            .file(&crate::workspace::store::file_key(folder, message.into()))?;
        account.validate()?;
        // A cache path already includes its owner. A known protected record may
        // never reuse an ordinary preview, even while its vault is unlocked.
        Ok(file.is_none_or(|file| file.file.encryption_state == "plain"))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cache_stem(owner: i64, folder_id: Option<i64>, message_id: i32) -> String {
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    format!("{}_{}_{}", owner, folder_key, message_id)
}

async fn find_cached_file(cache_dir: &Path, stem: &str) -> Option<PathBuf> {
    let prefix = format!("{}.", stem);
    let mut entries = tokio::fs::read_dir(cache_dir).await.ok()?;
    let mut newest: Option<(PathBuf, SystemTime)> = None;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name,
            None => continue,
        };
        if !name.starts_with(&prefix) || name.ends_with(".part") || name.ends_with(".pin") {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(meta) if meta.is_file() && meta.len() > 0 => meta,
            _ => continue,
        };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if newest
            .as_ref()
            .is_none_or(|(_, current)| modified > *current)
        {
            newest = Some((path, modified));
        }
    }

    newest.map(|(path, _)| path)
}

#[derive(Debug, Clone, Serialize)]
pub struct OfflineFile {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub name: String,
    pub size: u64,
    pub mime_type: Option<String>,
    pub file_ext: Option<String>,
    pub created_at: String,
    pub icon_type: String,
    pub encryption_state: String,
    pub is_favorite: bool,
    pub is_pinned: bool,
    pub last_opened_at: i64,
    pub offline_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OfflineCacheStatus {
    pub file_count: usize,
    pub total_bytes: u64,
    pub max_files: usize,
    pub max_bytes: u64,
}

pub(crate) async fn preview_cache_status(cache_dir: &Path) -> Result<OfflineCacheStatus, String> {
    let cache = cache_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let _state = crate::workspace::cache_core::state();
        let mut result = OfflineCacheStatus {
            file_count: 0,
            total_bytes: 0,
            max_files: 0,
            max_bytes: crate::workspace::assets::limits().0,
        };
        for (path, meta) in crate::workspace::cache_core::entries(&cache)? {
            if path.components().any(|c| c.as_os_str() == "thumbnails")
                || path
                    .extension()
                    .is_some_and(|e| e == "part" || e == "pin" || e == "source")
            {
                continue;
            }
            result.file_count += 1;
            result.total_bytes = result.total_bytes.saturating_add(meta.len());
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn cmd_set_preview_cache_limit(max_gb: f64) -> Result<(), String> {
    if !max_gb.is_finite() {
        return Err("Offline media cache limit must be finite".into());
    }
    let bytes = (max_gb.clamp(0.25, 50.0) * 1024.0 * 1024.0 * 1024.0) as u64;
    configure_limits(bytes, crate::workspace::assets::limits().1);
    Ok(())
}

#[cfg(feature = "native-e2e")]
static PIN_GATE: LazyLock<Mutex<Option<(PathBuf, PathBuf)>>> = LazyLock::new(|| Mutex::new(None));
#[cfg(feature = "native-e2e")]
pub(crate) fn install_pin_gate(started: PathBuf, release: PathBuf) {
    *PIN_GATE.lock().unwrap_or_else(|e| e.into_inner()) = Some((started, release));
}
#[cfg(feature = "native-e2e")]
fn wait_pin_gate() -> Result<(), String> {
    let gate = PIN_GATE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some((started, release)) = gate {
        std::fs::write(started, b"ready").map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !release.is_file() {
            if std::time::Instant::now() >= deadline {
                return Err("Fixture pin gate expired".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    Ok(())
}
pub(crate) fn set_preview_pinned(cache_dir: &Path, stem: &str, pinned: bool) -> Result<(), String> {
    let _mutation = legacy_preview_mutation();
    // All legacy mutations take the legacy registry before the shared core.
    let _shared = crate::workspace::cache_core::state();
    std::fs::create_dir_all(cache_dir)
        .map_err(|error| format!("Unable to prepare the offline media cache: {error}"))?;
    let marker = cache_dir.join(format!("{stem}.pin"));
    if pinned {
        let prefix = format!("{stem}.");
        let found = std::fs::read_dir(cache_dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .any(|entry| {
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(&prefix)
                    && !name.ends_with(".part")
                    && !name.ends_with(".pin")
                    && std::fs::symlink_metadata(path)
                        .is_ok_and(|meta| meta.file_type().is_file() && meta.len() > 0)
            });
        if !found {
            return Err("Download this file before marking it for offline use".into());
        }
        #[cfg(feature = "native-e2e")]
        wait_pin_gate()?;
        std::fs::write(marker, b"pinned")
            .map_err(|error| format!("Unable to preserve this offline file: {error}"))?;
    } else if let Err(error) = std::fs::remove_file(marker) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("Unable to unpin this offline file: {error}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_set_preview_pinned(
    message_id: i32,
    folder_id: Option<i64>,
    pinned: bool,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let account = preview_account(&app_handle)?;
    let cache = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let shared = crate::workspace::assets::set_pinned_at(
        cache,
        account.clone(),
        crate::workspace::store::file_key(folder_id, i64::from(message_id)),
        pinned,
    )
    .await?;
    if shared && pinned {
        return Ok(());
    }
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("previews");
    tokio::task::spawn_blocking(move || {
        account.validate()?;
        set_preview_pinned(
            &cache_dir,
            &cache_stem(account.owner, folder_id, message_id),
            pinned,
        )?;
        account.validate()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_get_offline_cache_status(
    app_handle: tauri::AppHandle,
) -> Result<OfflineCacheStatus, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error: tauri::Error| error.to_string())?
        .join("previews");
    preview_cache_status(&cache_dir).await
}

#[tauri::command]
pub async fn cmd_get_offline_files(
    app_handle: tauri::AppHandle,
    owner_id: Option<String>,
    _db_pool: State<'_, DbConnection>,
    limit: Option<i64>,
) -> Result<Vec<OfflineFile>, String> {
    let account = preview_account(&app_handle)?;
    if owner_id
        .as_ref()
        .is_some_and(|owner| owner != &account.owner.to_string())
    {
        return Err("ACCOUNT_CHANGED: Reopen the current account's offline files".into());
    }
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error: tauri::Error| error.to_string())?
        .join("previews");
    read_offline_files(&account, &cache_dir, limit).await
}

pub(crate) async fn read_offline_files(
    account: &AccountGuard,
    cache_dir: &Path,
    limit: Option<i64>,
) -> Result<Vec<OfflineFile>, String> {
    let read_account = account.clone();
    let rows = tokio::task::spawn_blocking(move || {
        read_account.validate()?;
        let store = crate::workspace::store::Store::open(&read_account.root, read_account.owner)?;
        let rows = super::file_activity::read_activity(&store, "recents", limit)?;
        read_account.validate()?;
        Ok::<_, String>(rows)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut files = Vec::new();
    for row in rows {
        account.validate()?;
        let owned = row.file;
        if owned.encryption_state != "plain" {
            continue;
        }
        let Ok(message_id) = i32::try_from(owned.id) else {
            continue;
        };
        let stem = cache_stem(account.owner, owned.folder_id, message_id);
        let scope = account.clone();
        let base = cache_dir
            .parent()
            .ok_or("Invalid cache root")?
            .to_path_buf();
        let key = crate::workspace::store::file_key(owned.folder_id, owned.id);
        let shared = tokio::task::spawn_blocking(move || {
            crate::workspace::assets::cached_preview_at(&base, &scope, &key)
        })
        .await
        .map_err(|e| e.to_string())??;
        let path = match shared {
            Some(path) => path,
            None => match find_cached_file(cache_dir, &stem).await {
                Some(path) => path,
                None => continue,
            },
        };
        let cached_size = tokio::fs::metadata(path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if cached_size != owned.size {
            continue;
        }
        files.push(OfflineFile {
            id: owned.id,
            folder_id: owned.folder_id,
            name: owned.name,
            size: owned.size,
            mime_type: owned.mime_type,
            file_ext: owned.file_ext,
            created_at: owned.created_at,
            icon_type: "file".into(),
            encryption_state: owned.encryption_state,
            is_favorite: owned.is_favorite,
            is_pinned: owned.is_pinned,
            last_opened_at: row.last_opened_at,
            offline_available: true,
        });
    }
    account.validate()?;
    Ok(files)
}

#[cfg(feature = "native-e2e")]
pub(crate) async fn create_resized_thumbnail(
    source_path: PathBuf,
    destination_path: PathBuf,
    account: Option<AccountGuard>,
) -> Result<PathBuf, String> {
    let holds = (
        LegacyPreviewUse::new(&source_path),
        LegacyPreviewUse::new(&destination_path),
    );
    crate::workspace::assets::render_thumbnail(
        source_path,
        destination_path,
        account,
        crate::workspace::assets::ThumbnailInput::Image,
        Arc::new(|| false),
        holds,
        None,
    )
    .await
}

async fn compat_asset(
    app: tauri::AppHandle,
    folder: Option<i64>,
    message: i32,
    thumbnail: bool,
) -> Result<String, String> {
    if !thumbnail {
        let account = preview_account(&app)?;
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("previews");
        let stem = cache_stem(account.owner, folder, message);
        if cache.join(format!("{stem}.pin")).is_file()
            && can_use_plain_preview(&account, folder, message).await?
        {
            if let Some(path) = find_cached_file(&cache, &stem).await {
                account.validate()?;
                if crate::external_files::reuse_cached(account.clone(), path.clone()).await? {
                    return Ok(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    match crate::workspace::assets::legacy_asset(app, folder, message, thumbnail).await {
        Err(error) if thumbnail && error.starts_with("THUMBNAIL_UNAVAILABLE") => Ok(String::new()),
        result => result,
    }
}

#[tauri::command]
pub async fn cmd_get_preview(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    _state: State<'_, TelegramState>,
    _bw_state: State<'_, Arc<BandwidthManager>>,
    _net_config: State<'_, Arc<NetworkConfig>>,
    _db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    compat_asset(app_handle, folder_id, message_id, false).await
}

#[tauri::command]
pub async fn cmd_get_display_preview(
    message_id: i32,
    folder_id: Option<i64>,
    local_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let original = match local_path {
        Some(path) => path,
        None => compat_asset(app_handle.clone(), folder_id, message_id, false).await?,
    };
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::heic::is_name(&original) {
        let root = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
        let account = crate::workspace::AccountGuard::open(&root, None)?;
        let cache = app_handle
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?;
        let tools = crate::heic::Tools::platform(app_handle.path().resource_dir().ok().as_deref());
        return crate::workspace::assets::display_rendition_at(
            cache,
            account,
            crate::workspace::store::file_key(folder_id, i64::from(message_id)),
            original.into(),
            tools,
            None,
        )
        .await;
    }
    Ok(original)
}

#[tauri::command]
pub async fn cmd_clean_preview_cache(app_handle: tauri::AppHandle) -> Result<(), String> {
    let cache = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    if let Ok(owner) = crate::workspace::current_owner(&data) {
        crate::workspace::assets::clear_owner(&app_handle, owner, "previews").await?;
    }
    tokio::task::spawn_blocking(move || {
        crate::workspace::storage::clear_legacy_previews(&cache)?;
        crate::workspace::device_cache::clear(&data, &cache)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_clean_cache(app_handle: tauri::AppHandle) -> Result<(), String> {
    cmd_clean_preview_cache(app_handle.clone()).await?;
    let data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    if let Ok(owner) = crate::workspace::current_owner(&data) {
        crate::workspace::storage::cmd_storage_clear(
            app_handle,
            owner.to_string(),
            "thumbnails".into(),
        )
        .await?;
    }
    Ok(())
}

/// Get a small thumbnail for inline display in file cards.
/// Returns a local asset path for images, empty string for non-image files.
#[tauri::command]
pub async fn cmd_get_thumbnail(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    _state: State<'_, TelegramState>,
    _bw_state: State<'_, Arc<BandwidthManager>>,
    _net_config: State<'_, Arc<NetworkConfig>>,
    _db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    compat_asset(app_handle, folder_id, message_id, true).await
}

#[tauri::command]
pub async fn cmd_delete_preview_for_message(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let account = preview_account(&app_handle)?;
    crate::workspace::assets::delete_cached_at(
        app_handle
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?,
        account.clone(),
        crate::workspace::store::file_key(folder_id, i64::from(message_id)),
        false,
    )
    .await?;
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");

    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());

    let prefix = format!("{}_{}_{}.", account.owner, folder_key, message_id);

    let _ = tokio::task::spawn_blocking(move || {
        if account.validate().is_err() {
            return;
        }
        let active = legacy_preview_mutation();
        let _shared = crate::workspace::cache_core::state();
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file()
                    || active.active.contains_key(&path)
                    || path.with_extension("pin").is_file()
                    || path.extension().is_some_and(|ext| ext == "pin")
                {
                    continue;
                }
                let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if fname.starts_with(&prefix) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    })
    .await;
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_image_thumbnail(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let account = preview_account(&app_handle)?;
    crate::workspace::assets::delete_cached_at(
        app_handle
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?,
        account.clone(),
        crate::workspace::store::file_key(folder_id, i64::from(message_id)),
        true,
    )
    .await?;
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");

    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    let prefix = format!("{}_{}_{}.", account.owner, folder_key, message_id);

    let _ = tokio::task::spawn_blocking(move || {
        if account.validate().is_err() {
            return;
        }
        let active = legacy_preview_mutation();
        let _shared = crate::workspace::cache_core::state();
        if let Ok(entries) = std::fs::read_dir(cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if path.is_file() && name.starts_with(&prefix) && !active.active.contains_key(&path)
                {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    })
    .await;
    Ok(())
}
