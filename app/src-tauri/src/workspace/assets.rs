use super::{
    store::{Store, WorkspaceFile},
    AccountGuard,
};
use crate::{
    bandwidth::{BandwidthManager, BandwidthReservation},
    commands::{
        utils::{media_size, resolve_peer},
        TelegramState,
    },
    vpn_optimizer::NetworkConfig,
};
use grammers_client::{
    types::{Downloadable, Media},
    Client,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, SystemTime},
};
use tauri::Manager;
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, RwLock, Semaphore},
};

static LOCKS: OnceLock<Mutex<HashMap<String, std::sync::Weak<Mutex<()>>>>> = OnceLock::new();
static READERS: OnceLock<Semaphore> = OnceLock::new();
static ASSET_READERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static CATEGORY_LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<RwLock<()>>>>> =
    OnceLock::new();
static CACHE_STATE: OnceLock<std::sync::Mutex<CacheState>> = OnceLock::new();
const THUMB_OUTPUT_LIMIT: u64 = 1024 * 1024;
const ORPHAN_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const PREVIEW_LIMIT: u64 = 512 * 1024 * 1024;
const THUMB_SOURCE_LIMIT: u64 = 16 * 1024 * 1024;
static PREVIEW_BUDGET: AtomicU64 = AtomicU64::new(PREVIEW_LIMIT);
static THUMB_BUDGET: AtomicU64 = AtomicU64::new(64 * 1024 * 1024);
static REQUESTS: OnceLock<std::sync::Mutex<HashMap<String, PendingRequest>>> = OnceLock::new();

#[derive(Default)]
struct CacheState {
    paths: HashMap<PathBuf, String>,
    reservations: HashMap<String, (PathBuf, u64)>,
    clearing: HashMap<PathBuf, usize>,
}
struct Clearing(PathBuf);
impl Clearing {
    fn new(directory: &Path) -> Self {
        *cache_state().clearing.entry(directory.into()).or_default() += 1;
        Self(directory.into())
    }
}
impl Drop for Clearing {
    fn drop(&mut self) {
        let mut state = cache_state();
        if let Some(count) = state.clearing.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                state.clearing.remove(&self.0);
            }
        }
    }
}
struct PendingRequest {
    cancelled: Arc<AtomicBool>,
    directory: PathBuf,
}
fn cache_state() -> std::sync::MutexGuard<'static, CacheState> {
    CACHE_STATE
        .get_or_init(|| std::sync::Mutex::new(CacheState::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
pub fn active_paths() -> HashSet<PathBuf> {
    cache_state().paths.keys().cloned().collect()
}
fn category_lock(directory: &Path) -> Arc<RwLock<()>> {
    CATEGORY_LOCKS
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(directory.into())
        .or_insert_with(|| Arc::new(RwLock::new(())))
        .clone()
}

struct ActivePath {
    path: PathBuf,
    token: String,
    disposable: bool,
}
impl ActivePath {
    fn new(path: PathBuf, token: String, disposable: bool) -> Self {
        cache_state().paths.insert(path.clone(), token.clone());
        Self {
            path,
            token,
            disposable,
        }
    }
}
impl Drop for ActivePath {
    fn drop(&mut self) {
        let mut state = cache_state();
        if state.paths.get(&self.path) == Some(&self.token) {
            state.paths.remove(&self.path);
        }
        drop(state);
        if self.disposable {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct CacheReservation {
    token: String,
    directory: PathBuf,
    thumbnail: bool,
}
impl CacheReservation {
    fn reserve(directory: &Path, token: &str, bytes: u64, thumbnail: bool) -> Result<Self, String> {
        let cap = if thumbnail { limits().1 } else { limits().0 };
        if bytes > cap {
            return Err(
                "PREVIEW_TOO_LARGE: Increase the device cache limit or keep the file offline"
                    .into(),
            );
        }
        let mut state = cache_state();
        let reserved = state
            .reservations
            .values()
            .filter(|(root, _)| root == directory)
            .map(|(_, size)| *size)
            .sum::<u64>();
        let mut entries = cache_entries(directory)?;
        let mut used = reserved.saturating_add(
            entries
                .iter()
                .filter(|(path, _)| {
                    !state
                        .paths
                        .get(path)
                        .is_some_and(|token| state.reservations.contains_key(token))
                })
                .map(|(_, meta)| meta.len())
                .sum::<u64>(),
        );
        entries.sort_by_key(|(_, meta)| meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));
        for (path, meta) in entries {
            if used.saturating_add(bytes) <= cap {
                break;
            }
            if state.paths.contains_key(&path) || (temporary(&path) && !orphan_age(&meta)) {
                continue;
            }
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            used = used.saturating_sub(meta.len());
        }
        if used.saturating_add(bytes) > cap {
            return Err(
                "CACHE_BUSY: Wait for current previews or clear disposable cache files".into(),
            );
        }
        state
            .reservations
            .insert(token.into(), (directory.into(), bytes));
        Ok(Self {
            token: token.into(),
            directory: directory.into(),
            thumbnail,
        })
    }
    fn cancelled(&self) -> bool {
        let cap = if self.thumbnail {
            limits().1
        } else {
            limits().0
        };
        cache_state()
            .reservations
            .values()
            .filter(|(directory, _)| directory == &self.directory)
            .map(|(_, bytes)| *bytes)
            .sum::<u64>()
            > cap
    }
}
impl Drop for CacheReservation {
    fn drop(&mut self) {
        cache_state().reservations.remove(&self.token);
    }
}
fn temporary(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext == "part" || ext == "source")
}
fn orphan_age(meta: &std::fs::Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= ORPHAN_AGE)
}

fn private_directory(base: &Path, components: &[&str], create: bool) -> Result<PathBuf, String> {
    if create {
        std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    }
    let mut path = base.to_path_buf();
    for component in components {
        path.push(component);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_dir() => {}
            Ok(_) => return Err("STORAGE_UNAVAILABLE: Unexpected cache directory".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if create {
                    std::fs::create_dir(&path).map_err(|e| e.to_string())?;
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(path)
}
fn cache_entries(directory: &Path) -> Result<Vec<(PathBuf, std::fs::Metadata)>, String> {
    match std::fs::symlink_metadata(directory) {
        Ok(meta) if meta.file_type().is_dir() => {}
        Ok(_) => return Err("STORAGE_UNAVAILABLE: Unexpected cache directory".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    }
    let mut result = Vec::new();
    for entry in walkdir::WalkDir::new(directory).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file() {
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            result.push((entry.into_path(), meta));
        }
    }
    Ok(result)
}

pub fn configure_limits(previews: u64, thumbnails: u64) {
    PREVIEW_BUDGET.store(previews.max(1), Ordering::Relaxed);
    THUMB_BUDGET.store(thumbnails.max(1), Ordering::Relaxed);
}
pub fn limits() -> (u64, u64) {
    (
        PREVIEW_BUDGET.load(Ordering::Relaxed),
        THUMB_BUDGET.load(Ordering::Relaxed),
    )
}
fn requests() -> std::sync::MutexGuard<'static, HashMap<String, PendingRequest>> {
    REQUESTS
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
struct Request {
    key: String,
    token: String,
    cancelled: Arc<AtomicBool>,
}
impl Request {
    fn new(owner: &str, id: Option<String>, directory: PathBuf) -> Result<Self, String> {
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if id.is_empty() || id.len() > 128 {
            return Err("Invalid preview request".into());
        }
        let key = format!("{owner}:{id}");
        let state = cache_state();
        let cancelled = Arc::new(AtomicBool::new(state.clearing.contains_key(&directory)));
        if let Some(old) = requests().insert(
            key.clone(),
            PendingRequest {
                cancelled: cancelled.clone(),
                directory,
            },
        ) {
            old.cancelled.store(true, Ordering::SeqCst);
        }
        drop(state);
        Ok(Self {
            key,
            token: uuid::Uuid::new_v4().to_string(),
            cancelled,
        })
    }
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let mut active = requests();
        if active
            .get(&self.key)
            .is_some_and(|value| Arc::ptr_eq(&value.cancelled, &self.cancelled))
        {
            active.remove(&self.key);
        }
    }
}
pub fn cancel_owner(owner: i64) {
    let prefix = format!("{owner}:");
    for (key, request) in requests().iter() {
        if key.starts_with(&prefix) {
            request.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub async fn cmd_workspace_cancel_asset(
    app: tauri::AppHandle,
    owner_id: String,
    request_id: String,
) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    AccountGuard::open(&root, Some(&owner_id))?;
    if let Some(request) = requests().get(&format!("{owner_id}:{request_id}")) {
        request.cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

pub async fn clear_owner(app: &tauri::AppHandle, owner: i64, category: &str) -> Result<(), String> {
    if !["previews", "thumbnails", "staging"].contains(&category) {
        return Err("Unknown cache category".into());
    }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let categories = if category == "staging" {
        vec!["previews", "thumbnails"]
    } else {
        vec![category]
    };
    for category_name in categories {
        let directory = private_directory(
            &cache,
            &["previews", "workspace", &owner.to_string(), category_name],
            false,
        )?;
        clear_directory(&directory, category == "staging").await?;
    }
    Ok(())
}

async fn clear_directory(directory: &Path, staging_only: bool) -> Result<(), String> {
    if staging_only {
        let active = cache_state();
        for (path, meta) in cache_entries(directory)? {
            if temporary(&path) && orphan_age(&meta) && !active.paths.contains_key(&path) {
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        return Ok(());
    }
    // Mark first so a new request cannot begin an uncancellable download while
    // this clear is waiting for an older blocking decoder to release its reader.
    let _clearing = Clearing::new(directory);
    for request in requests().values() {
        if request.directory == directory {
            request.cancelled.store(true, Ordering::SeqCst);
        }
    }
    let _exclusive = category_lock(directory).write_owned().await;
    if directory.exists() {
        std::fs::remove_dir_all(directory).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn file_lock(key: String) -> Arc<Mutex<()>> {
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .await;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(|lock| lock.upgrade()) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

pub fn file_name(file: &WorkspaceFile) -> String {
    let ext = file
        .file
        .file_ext
        .as_deref()
        .unwrap_or("bin")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>();
    format!(
        "{:x}.{}",
        Sha256::digest(file.key.as_bytes()),
        if ext.is_empty() { "bin" } else { &ext }
    )
}

pub fn cache_root(app: &tauri::AppHandle, owner: i64) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("previews")
        .join("workspace")
        .join(owner.to_string()))
}

pub fn stored_file(account: &AccountGuard, key: &str) -> Result<WorkspaceFile, String> {
    account.validate()?;
    Store::open(&account.root, account.owner)?
        .file(key)?
        .ok_or_else(|| "FILE_NOT_INDEXED: Scan this folder to add it to your library".into())
}

pub async fn remote_media(
    app: &tauri::AppHandle,
    account: &AccountGuard,
    file: &WorkspaceFile,
) -> Result<(Client, Media), String> {
    account.validate()?;
    if file.file.encryption_state != "plain" {
        return Err(
            "ENCRYPTED_PREVIEW_UNAVAILABLE: Open protected files through the unlocked vault".into(),
        );
    }
    let state = app.state::<TelegramState>();
    let client = state
        .client
        .lock()
        .await
        .clone()
        .ok_or("NETWORK_UNAVAILABLE: Reconnect to Telegram")?;
    let peer = resolve_peer(&client, file.file.folder_id, &state.peer_cache).await?;
    let id = i32::try_from(file.file.id).map_err(|_| "Invalid message identifier")?;
    let message = client
        .get_messages_by_id(&peer, &[id])
        .await
        .map_err(|_| "NETWORK_UNAVAILABLE: Could not read this Telegram file")?
        .into_iter()
        .flatten()
        .next()
        .ok_or("FILE_NOT_FOUND: This file is no longer available in Telegram")?;
    let media = message
        .media()
        .ok_or("FILE_NOT_FOUND: This message has no file")?;
    if message.text() == "TDENC2"
        || matches!(&media,Media::Document(d) if d.name().to_ascii_lowercase().ends_with(".tdenc"))
    {
        return Err(
            "ENCRYPTED_PREVIEW_UNAVAILABLE: Open protected files through the unlocked vault".into(),
        );
    }
    if media_size(&media) != file.file.size {
        return Err("FILE_CHANGED: Refresh the folder before saving this file".into());
    }
    account.validate()?;
    Ok((client, media))
}

pub struct DownloadSource<'a> {
    pub app: &'a tauri::AppHandle,
    pub account: &'a AccountGuard,
    pub client: &'a Client,
}

/// Private temporary file, bounded streaming and exact-length publication.
/// Used by both disposable previews and durable offline-pack downloads.
pub async fn download<D: Downloadable>(
    source: DownloadSource<'_>,
    media: &D,
    expected: u64,
    target: &Path,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    download_inner(
        source,
        media,
        expected,
        target,
        cancelled,
        &mut progress,
        None,
    )
    .await
}

async fn download_inner<D: Downloadable>(
    source: DownloadSource<'_>,
    media: &D,
    expected: u64,
    target: &Path,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(u64),
    request: Option<&Request>,
) -> Result<(), String> {
    let DownloadSource {
        app,
        account,
        client,
    } = source;
    let _permit = READERS
        .get_or_init(|| Semaphore::new(3))
        .acquire()
        .await
        .map_err(|_| "Download service stopped")?;
    if cancelled() {
        return Err("CANCELLED".into());
    }
    account.validate()?;
    let parent = target.parent().ok_or("Invalid media destination")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let temporary = target.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    let _temporary = ActivePath::new(
        temporary.clone(),
        request
            .map(|request| request.token.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        true,
    );
    crate::workspace::device_cache::ensure_free_space(parent, expected)
        .map_err(|e| format!("STORAGE_UNAVAILABLE: {e}"))?;
    let mut reservation = BandwidthReservation::download(
        app.state::<Arc<BandwidthManager>>().inner().clone(),
        expected,
    )?;
    let config = app.state::<Arc<NetworkConfig>>();
    let limit = config.download_limit_bytes_per_sec();
    let result = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut output = options
            .open(&temporary)
            .await
            .map_err(|e| format!("STORAGE_UNAVAILABLE: {e}"))?;
        let chunk_size = (config.chunk_size_bytes().clamp(4096, 512 * 1024) / 4096 * 4096) as i32;
        let mut stream = client.iter_download(media).chunk_size(chunk_size);
        let mut count = 0u64;
        let start = std::time::Instant::now();
        while let Some(chunk) = stream
            .next()
            .await
            .map_err(|_| "NETWORK_UNAVAILABLE: Download interrupted; retry to continue")?
        {
            if cancelled() {
                return Err("CANCELLED: Download paused".into());
            }
            account.validate()?;
            count = count
                .checked_add(chunk.len() as u64)
                .ok_or("FILE_CHANGED: Download exceeded expected size")?;
            verify_length(count, expected, false)?;
            crate::workspace::device_cache::ensure_free_space(parent, chunk.len() as u64)
                .map_err(|e| format!("STORAGE_UNAVAILABLE: {e}"))?;
            output
                .write_all(&chunk)
                .await
                .map_err(|e| format!("STORAGE_UNAVAILABLE: {e}"))?;
            progress(count);
            if limit > 0 {
                let desired = std::time::Duration::from_secs_f64(count as f64 / limit as f64);
                while desired > start.elapsed() {
                    if cancelled() {
                        return Err("CANCELLED: Download paused".into());
                    }
                    account.validate()?;
                    tokio::time::sleep(
                        (desired - start.elapsed()).min(std::time::Duration::from_millis(250)),
                    )
                    .await;
                }
            }
        }
        verify_length(count, expected, true)?;
        output
            .sync_all()
            .await
            .map_err(|e| format!("STORAGE_UNAVAILABLE: {e}"))?;
        drop(output);
        if cancelled() {
            return Err("CANCELLED: Download paused".into());
        }
        account.validate()?;
        tokio::fs::rename(&temporary, target)
            .await
            .map_err(|e| e.to_string())?;
        reservation.commit();
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

pub fn verify_length(actual: u64, expected: u64, complete: bool) -> Result<(), String> {
    if actual > expected || (complete && actual != expected) {
        Err("INCOMPLETE_DOWNLOAD: File length could not be verified".into())
    } else {
        Ok(())
    }
}

pub fn tree_size(root: &Path) -> u64 {
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

pub fn prune_directory(root: &Path, limit: u64, preserve: Option<&Path>) -> Result<u64, String> {
    let active = cache_state();
    let mut entries = cache_entries(root)?;
    let mut bytes = entries.iter().map(|(_, m)| m.len()).sum::<u64>();
    entries.sort_by_key(|(_, m)| m.modified().unwrap_or(std::time::UNIX_EPOCH));
    for (path, metadata) in entries {
        if bytes <= limit {
            break;
        }
        // Writers own their private partials; explicit orphan cleanup handles
        // those only after a conservative age threshold.
        if Some(path.as_path()) == preserve
            || active.paths.contains_key(&path)
            || (temporary(&path) && !orphan_age(&metadata))
        {
            continue;
        }
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
        bytes = bytes.saturating_sub(metadata.len());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn cmd_workspace_asset(
    app: tauri::AppHandle,
    owner_id: String,
    key: String,
    thumbnail: bool,
    request_id: Option<String>,
) -> Result<String, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, Some(&owner_id))?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let category = if thumbnail { "thumbnails" } else { "previews" };
    let directory = private_directory(
        &cache,
        &["previews", "workspace", &owner_id, category],
        false,
    )?;
    let request = Request::new(&owner_id, request_id, directory.clone())?;
    // The complete request, including image decoding, owns a bounded permit.
    let capacity = Arc::new(
        ASSET_READERS
            .get_or_init(|| Arc::new(Semaphore::new(3)))
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Preview service stopped")?,
    );
    let file_guard = Arc::new(
        file_lock(format!("{owner_id}:{key}:{thumbnail}"))
            .await
            .lock_owned()
            .await,
    );
    let category_guard = Arc::new(category_lock(&directory).read_owned().await);
    if request.cancelled() || cache_state().clearing.contains_key(&directory) {
        return Err("CANCELLED".into());
    }
    account.validate()?;
    private_directory(
        &cache,
        &["previews", "workspace", &owner_id, category],
        true,
    )?;
    let file = stored_file(&account, &key)?;
    if file.file.encryption_state != "plain" {
        return Err("ENCRYPTED_PREVIEW_UNAVAILABLE".into());
    }
    let target = directory.join(if thumbnail {
        format!("{:x}.jpg", Sha256::digest(key.as_bytes()))
    } else {
        file_name(&file)
    });
    let target_guard = Arc::new(ActivePath::new(
        target.clone(),
        request.token.clone(),
        false,
    ));
    let cap = if thumbnail { limits().1 } else { limits().0 };
    match std::fs::symlink_metadata(&target) {
        Ok(metadata)
            if metadata.file_type().is_file()
                && metadata.len() <= cap
                && (if thumbnail {
                    metadata.len() > 0
                } else {
                    metadata.len() == file.file.size
                }) =>
        {
            let handle = std::fs::OpenOptions::new()
                .write(true)
                .open(&target)
                .map_err(|e| e.to_string())?;
            handle
                .set_times(std::fs::FileTimes::new().set_modified(SystemTime::now()))
                .map_err(|e| e.to_string())?;
            account.validate()?;
            return Ok(target.to_string_lossy().to_string());
        }
        Ok(metadata) if metadata.file_type().is_file() => {
            std::fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
        Ok(_) => return Err("STORAGE_UNAVAILABLE: Invalid preview file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    if !thumbnail && file.file.size > cap {
        return Err("PREVIEW_TOO_LARGE: Keep this file offline or increase the cache limit".into());
    }
    let operation = async {
        let (client, media) = remote_media(&app, &account, &file).await?;
        if thumbnail {
            let thumbs = match &media {
                Media::Photo(photo) => photo.thumbs(),
                Media::Document(document) => document.thumbs(),
                _ => Vec::new(),
            };
            let source = target.with_extension(format!("{}.source", uuid::Uuid::new_v4()));
            let source_guard =
                Arc::new(ActivePath::new(source.clone(), request.token.clone(), true));
            let reservation: Arc<CacheReservation>;
            if let Some(thumb) = thumbs
                .iter()
                .filter(|t| t.size() > 0 && (t.size() as u64) <= THUMB_SOURCE_LIMIT)
                .min_by_key(|t| t.size().abs_diff(60_000))
            {
                reservation = Arc::new(CacheReservation::reserve(
                    &directory,
                    &request.token,
                    thumb.size() as u64 + THUMB_OUTPUT_LIMIT,
                    true,
                )?);
                download_inner(
                    DownloadSource {
                        app: &app,
                        account: &account,
                        client: &client,
                    },
                    thumb,
                    thumb.size() as u64,
                    &source,
                    || request.cancelled() || reservation.cancelled(),
                    |_| {},
                    Some(&request),
                )
                .await?;
            } else if file.file.size <= THUMB_SOURCE_LIMIT
                && file
                    .file
                    .mime_type
                    .as_deref()
                    .is_some_and(|m| m.starts_with("image/"))
            {
                reservation = Arc::new(CacheReservation::reserve(
                    &directory,
                    &request.token,
                    file.file.size + THUMB_OUTPUT_LIMIT,
                    true,
                )?);
                download_inner(
                    DownloadSource {
                        app: &app,
                        account: &account,
                        client: &client,
                    },
                    &media,
                    file.file.size,
                    &source,
                    || request.cancelled() || reservation.cancelled(),
                    |_| {},
                    Some(&request),
                )
                .await?;
            } else {
                return Err("THUMBNAIL_UNAVAILABLE".into());
            }
            let input = source.clone();
            let destination = target.clone();
            let cancelled = request.cancelled.clone();
            let token = request.token.clone();
            let account = account.clone();
            // A cancelled async caller cannot release the clear/publication or
            // same-file barriers while its blocking decoder is still alive.
            let holds = (
                capacity.clone(),
                file_guard.clone(),
                category_guard.clone(),
                source_guard.clone(),
                target_guard.clone(),
                reservation.clone(),
            );
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let _holds = holds;
                if cancelled.load(Ordering::SeqCst) || reservation.cancelled() {
                    return Err("CANCELLED".into());
                }
                account.validate()?;
                let mut reader = image::ImageReader::open(&input)
                    .map_err(|e| e.to_string())?
                    .with_guessed_format()
                    .map_err(|e| e.to_string())?;
                let mut limits = image::Limits::default();
                limits.max_alloc = Some(64 * 1024 * 1024);
                reader.limits(limits);
                let image = reader
                    .decode()
                    .map_err(|_| "THUMBNAIL_UNAVAILABLE")?
                    .thumbnail(480, 360)
                    .to_rgb8();
                let temporary =
                    destination.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
                let _temporary = ActivePath::new(temporary.clone(), token, true);
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut output = options.open(&temporary).map_err(|e| e.to_string())?;
                image
                    .write_to(&mut output, image::ImageFormat::Jpeg)
                    .map_err(|e| e.to_string())?;
                output.sync_all().map_err(|e| e.to_string())?;
                if output.metadata().map_err(|e| e.to_string())?.len() > THUMB_OUTPUT_LIMIT {
                    return Err("THUMBNAIL_UNAVAILABLE".into());
                }
                drop(output);
                if cancelled.load(Ordering::SeqCst) || reservation.cancelled() {
                    return Err("CANCELLED".into());
                }
                account.validate()?;
                std::fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
                if cancelled.load(Ordering::SeqCst) || account.validate().is_err() {
                    let _ = std::fs::remove_file(&destination);
                    return Err("CANCELLED".into());
                }
                Ok(())
            })
            .await
            .map_err(|e| e.to_string())??;
        } else {
            let reservation =
                CacheReservation::reserve(&directory, &request.token, file.file.size, false)?;
            download_inner(
                DownloadSource {
                    app: &app,
                    account: &account,
                    client: &client,
                },
                &media,
                file.file.size,
                &target,
                || request.cancelled() || reservation.cancelled(),
                |_| {},
                Some(&request),
            )
            .await?;
        }
        account.validate()?;
        if request.cancelled() {
            let _ = tokio::fs::remove_file(&target).await;
            return Err("CANCELLED".into());
        }
        let current_cap = if thumbnail { limits().1 } else { limits().0 };
        if std::fs::metadata(&target).map_err(|e| e.to_string())?.len() > current_cap {
            std::fs::remove_file(&target).map_err(|e| e.to_string())?;
            return Err("PREVIEW_TOO_LARGE: The device cache limit changed".into());
        }
        prune_directory(&directory, current_cap, Some(&target))?;
        Ok(target.to_string_lossy().to_string())
    };
    tokio::select! {
        result=operation=>result,
        _=async {while !request.cancelled(){tokio::time::sleep(Duration::from_millis(100)).await;}}=>Err("CANCELLED".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        let root = std::env::temp_dir().join(format!("asset-safety-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    #[tokio::test]
    async fn clear_cancels_requests_and_waits_for_blocking_decoder_barrier() {
        let root = temp();
        let cache = root.join("previews");
        std::fs::create_dir(&cache).unwrap();
        std::fs::write(root.join("offline-copy"), [9; 4]).unwrap();
        let request = Request::new("tests", None, cache.clone()).unwrap();
        let decoder = category_lock(&cache).read_owned().await;
        let directory = cache.clone();
        let clear = tokio::spawn(async move { clear_directory(&directory, false).await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !request.cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!clear.is_finished());
        let raced = Request::new("tests", None, cache.clone()).unwrap();
        assert!(raced.cancelled());
        // A decoder already inside its critical section may finish writing;
        // clear must remove that output before it reports completion.
        std::fs::write(cache.join("late.jpg"), [8; 4]).unwrap();
        drop(decoder);
        clear.await.unwrap().unwrap();
        assert!(!cache.exists());
        assert!(root.join("offline-copy").exists());
        assert!(!Request::new("tests", None, cache).unwrap().cancelled());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn dropping_request_cancels_a_detached_decoder_without_canceling_its_replacement() {
        let root = temp();
        let id = uuid::Uuid::new_v4().to_string();
        let request = Request::new("tests", Some(id.clone()), root.clone()).unwrap();
        let decoder_cancelled = request.cancelled.clone();
        let replacement = Request::new("tests", Some(id), root.clone()).unwrap();
        drop(request);
        assert!(decoder_cancelled.load(Ordering::SeqCst));
        assert!(!replacement.cancelled());
        assert!(requests().contains_key(&replacement.key));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn staging_cleanup_preserves_active_old_partials_and_recent_or_retained_files() {
        let root = temp();
        for name in ["active.part", "orphan.part", "recent.part", "retained.bin"] {
            std::fs::write(root.join(name), [0; 4]).unwrap();
        }
        for name in ["active.part", "orphan.part"] {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .open(root.join(name))
                .unwrap();
            file.set_times(
                std::fs::FileTimes::new()
                    .set_modified(SystemTime::now() - ORPHAN_AGE - Duration::from_secs(1)),
            )
            .unwrap();
        }
        let active = ActivePath::new(
            root.join("active.part"),
            uuid::Uuid::new_v4().to_string(),
            false,
        );
        clear_directory(&root, true).await.unwrap();
        assert!(root.join("active.part").exists());
        assert!(!root.join("orphan.part").exists());
        assert!(root.join("recent.part").exists());
        assert!(root.join("retained.bin").exists());
        drop(active);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_reservations_include_inflight_bytes_without_double_counting_partials() {
        let root = temp();
        let cap = limits().0;
        let first_id = uuid::Uuid::new_v4().to_string();
        let second_id = uuid::Uuid::new_v4().to_string();
        let first = CacheReservation::reserve(&root, &first_id, cap - 1, false).unwrap();
        let part = root.join("active.part");
        let active = ActivePath::new(part.clone(), first_id, true);
        std::fs::write(&part, [0; 16]).unwrap();
        assert!(CacheReservation::reserve(&root, &second_id, 2, false).is_err());
        let second = CacheReservation::reserve(&root, &second_id, 1, false).unwrap();
        assert!(part.exists());
        drop(second);
        drop(first);
        drop(active);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exact_length_is_required_before_publication() {
        assert!(verify_length(5, 10, false).is_ok());
        assert!(verify_length(5, 10, true).is_err());
        assert!(verify_length(11, 10, false).is_err());
        assert!(verify_length(10, 10, true).is_ok());
    }
    #[test]
    fn preview_pruning_preserves_current_file_and_never_traverses_siblings() {
        let root = std::env::temp_dir().join(format!("workspace-prune-{}", uuid::Uuid::new_v4()));
        let cache = root.join("previews");
        let kept = root.join("offline");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::write(cache.join("old"), [0; 8]).unwrap();
        std::fs::write(cache.join("active"), [0; 8]).unwrap();
        std::fs::write(kept.join("retained"), [0; 8]).unwrap();
        assert_eq!(
            prune_directory(&cache, 8, Some(&cache.join("active"))).unwrap(),
            8
        );
        assert!(cache.join("active").exists());
        assert!(kept.join("retained").exists());
        assert!(!cache.join("old").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
