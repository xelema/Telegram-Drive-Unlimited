pub mod config;
pub mod executor;
pub mod planner;
pub mod watcher;

use crate::{
    commands::{
        utils::{media_size, resolve_peer},
        TelegramState,
    },
    db::DbConnection,
};
use config::{load_pairs, load_settings, log_sync, SyncPair};
use planner::{FileTree, SyncOperation, SyncedEntry, SyncedTree, TreeEntry};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlite::State;
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Listener, Manager};
use tokio::{sync::RwLock, task::JoinHandle};

pub struct SyncEngine {
    pub running: Arc<AtomicBool>,
    pub db: DbConnection,
    pub app_handle: tauri::AppHandle,
    pub status: Arc<RwLock<SyncStatus>>,
    shutdown_tx: Mutex<tokio::sync::watch::Sender<bool>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub running: bool,
    pub active_pairs: usize,
    pub pending_ops: usize,
    pub conflicts: usize,
    pub last_error: Option<String>,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            running: false,
            active_pairs: 0,
            pending_ops: 0,
            conflicts: 0,
            last_error: None,
        }
    }
}

impl SyncEngine {
    pub fn new(db: DbConnection, app_handle: tauri::AppHandle) -> Self {
        let (shutdown_tx, _) = tokio::sync::watch::channel(false);
        Self {
            running: Arc::new(AtomicBool::new(false)),
            db,
            app_handle,
            status: Arc::new(RwLock::new(SyncStatus::default())),
            shutdown_tx: Mutex::new(shutdown_tx),
            task: Mutex::new(None),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let settings = load_settings(&self.db)?;
        let pairs = load_pairs(&self.db, true)?;
        if !settings.enabled {
            let status = self.status.clone();
            let app = self.app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let snapshot = SyncStatus {
                    enabled: false,
                    active_pairs: pairs.len(),
                    ..SyncStatus::default()
                };
                *status.write().await = snapshot.clone();
                let _ = app.emit("sync-status-changed", snapshot);
            });
            return Ok(());
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        *self
            .shutdown_tx
            .lock()
            .map_err(|_| "Sync shutdown lock poisoned")? = shutdown_tx;
        let app = self.app_handle.clone();
        let db = self.db.clone();
        let status = self.status.clone();
        let running = self.running.clone();
        let task = tokio::spawn(async move {
            engine_loop(app, db, status, running, settings, pairs, shutdown_rx).await;
        });
        *self.task.lock().map_err(|_| "Sync task lock poisoned")? = Some(task);
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(sender) = self.shutdown_tx.lock() {
            let _ = sender.send(true);
        }
    }

    pub(crate) fn subscribe_shutdown(&self) -> Result<tokio::sync::watch::Receiver<bool>, String> {
        self.shutdown_tx
            .lock()
            .map(|sender| sender.subscribe())
            .map_err(|_| "Sync shutdown lock poisoned".to_string())
    }

    pub async fn shutdown_and_wait(&self) -> Result<(), String> {
        self.shutdown();
        let task = self
            .task
            .lock()
            .map_err(|_| "Sync task lock poisoned")?
            .take();
        if let Some(task) = task {
            task.await
                .map_err(|error| format!("Sync engine stopped unexpectedly: {error}"))?;
        }
        self.running.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub async fn restart(&self) -> Result<(), String> {
        self.shutdown_and_wait().await?;
        self.start()
    }
}

pub async fn restart_sync_engine(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<SyncEngine>().restart().await
}

async fn emit_status(app: &tauri::AppHandle, status: &Arc<RwLock<SyncStatus>>) {
    let snapshot = status.read().await.clone();
    let _ = app.emit("sync-status-changed", snapshot);
}

async fn engine_loop(
    app: tauri::AppHandle,
    db: DbConnection,
    status: Arc<RwLock<SyncStatus>>,
    running: Arc<AtomicBool>,
    settings: config::SyncSettings,
    pairs: Vec<SyncPair>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    {
        let mut current = status.write().await;
        current.enabled = true;
        current.active_pairs = pairs.len();
        current.last_error = None;
    }
    emit_status(&app, &status).await;

    // A trigger means "the trees may have changed", not "perform exactly one
    // reconciliation". A capacity of one coalesces filesystem bursts and
    // prevents a large copy from queueing hundreds of full remote scans.
    let (trigger_tx, mut trigger_rx) = tokio::sync::mpsc::channel(1);
    let watcher = watcher::LocalWatcher::spawn(
        pairs
            .iter()
            .map(|pair| PathBuf::from(&pair.local_path))
            .collect(),
        Duration::from_millis(settings.debounce_ms),
        app.clone(),
        shutdown.clone(),
        trigger_tx.clone(),
    );
    let vault_trigger = trigger_tx.clone();
    let listener_id = app.listen("vault-unlocked", move |_| {
        let _ = vault_trigger.try_send(());
    });
    let _ = trigger_tx.try_send(());
    let mut interval = tokio::time::interval(Duration::from_secs(30));

    loop {
        tokio::select! {
            changed = shutdown.changed() => if changed.is_err() || *shutdown.borrow() { break },
            _ = interval.tick() => {},
            event = trigger_rx.recv() => if event.is_none() { break },
        }
        if *shutdown.borrow() {
            break;
        }
        while trigger_rx.try_recv().is_ok() {}
        {
            let mut current = status.write().await;
            current.running = true;
            current.last_error = None;
        }
        emit_status(&app, &status).await;

        let mut pending = 0usize;
        let mut conflicts = 0usize;
        let mut last_error = None;
        for pair in &pairs {
            if *shutdown.borrow() {
                break;
            }
            match reconcile_pair(&app, &db, pair, &settings, shutdown.clone()).await {
                Ok((pair_pending, pair_conflicts, pair_error)) => {
                    pending += pair_pending;
                    conflicts += pair_conflicts;
                    if pair_error.is_some() {
                        last_error = pair_error;
                    }
                }
                Err(error) => {
                    log::error!("Folder sync pair {} paused: {error}", pair.id);
                    log_sync(&db, Some(pair.id), "error", None, Some(&error));
                    last_error = Some(error);
                }
            }
        }
        conflicts = conflicts.max(count_conflicts(&db).unwrap_or(conflicts));
        {
            let mut current = status.write().await;
            current.running = false;
            current.pending_ops = pending;
            current.conflicts = conflicts;
            current.last_error = last_error;
        }
        emit_status(&app, &status).await;
    }

    app.unlisten(listener_id);
    watcher.abort();
    running.store(false, Ordering::SeqCst);
    {
        let mut current = status.write().await;
        current.running = false;
    }
    emit_status(&app, &status).await;
}

fn count_conflicts(db: &DbConnection) -> Result<usize, String> {
    let connection = db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare("SELECT COUNT(*) FROM sync_state WHERE sync_status = 'conflict'")
        .map_err(|error| error.to_string())?;
    if statement.next().map_err(|error| error.to_string())? == State::Row {
        return Ok(statement.read::<i64, _>(0).unwrap_or(0).max(0) as usize);
    }
    Ok(0)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

async fn scan_local(root: &str) -> Result<FileTree, String> {
    let root = PathBuf::from(root);
    tokio::task::spawn_blocking(move || {
        let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
        let mut tree = FileTree::new();
        for entry in walkdir::WalkDir::new(&canonical_root).follow_links(false) {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            if entry
                .file_name()
                .to_string_lossy()
                .ends_with(".td-sync-tmp")
            {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&canonical_root)
                .map_err(|error| error.to_string())?;
            let relative_path = relative
                .components()
                .map(|part| {
                    part.as_os_str().to_str().ok_or_else(|| {
                        format!(
                            "Folder contains a non-UTF-8 filename that cannot be represented safely: {}",
                            entry.path().display()
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_secs() as i64);
            tree.insert(
                relative_path.clone(),
                TreeEntry {
                    relative_path,
                    hash: hash_file(entry.path())?,
                    file_size: metadata.len(),
                    modified_at,
                    message_id: None,
                },
            );
        }
        Ok(tree)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn is_safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', '\0'])
        && path
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

async fn scan_remote(
    app: &tauri::AppHandle,
    pair: &SyncPair,
    synced: &SyncedTree,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<FileTree, String> {
    let mut attempt = 0u32;
    loop {
        match scan_remote_once(app, pair, synced).await {
            Ok(tree) => return Ok(tree),
            Err(error) => {
                let wait = error.find("FLOOD_WAIT_").and_then(|start| {
                    error[start + "FLOOD_WAIT_".len()..]
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                        .parse::<u64>()
                        .ok()
                });
                let Some(server_wait) = wait else {
                    return Err(error);
                };
                if attempt >= 5 {
                    return Err(error);
                }
                let wait = server_wait.max(1u64 << attempt.min(8));
                log::warn!("Remote sync scan hit FLOOD_WAIT; retrying in {wait}s");
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

async fn scan_remote_once(
    app: &tauri::AppHandle,
    pair: &SyncPair,
    synced: &SyncedTree,
) -> Result<FileTree, String> {
    let telegram = app.state::<TelegramState>();
    let client = telegram.client.lock().await.clone().ok_or(
        "Telegram is offline; remote tree unavailable, so no reconciliation was attempted",
    )?;
    let peer = resolve_peer(&client, Some(pair.channel_id), &telegram.peer_cache).await?;
    let known_paths: HashMap<i32, String> = synced
        .values()
        .filter_map(|entry| entry.message_id.map(|id| (id, entry.relative_path.clone())))
        .collect();
    let mut messages = client.iter_messages(&peer);
    let mut tree = FileTree::new();
    const MAX_REMOTE_FILES: usize = 50_000;
    let mut scanned_files = 0usize;
    while let Some(message) = messages.next().await.map_err(|error| error.to_string())? {
        let Some(media) = message.media() else {
            continue;
        };
        let document_name = match &media {
            grammers_client::types::Media::Document(document) => document.name().to_string(),
            grammers_client::types::Media::Photo(_) => "Photo.jpg".to_string(),
            _ => continue,
        };
        scanned_files += 1;
        if scanned_files > MAX_REMOTE_FILES {
            return Err(format!(
                "Telegram channel contains more than {MAX_REMOTE_FILES} file messages; sync paused rather than building an unsafe remote tree"
            ));
        }
        let caption = message.text();
        let relative_path = known_paths.get(&message.id()).cloned().or_else(|| {
            if is_safe_relative(caption) {
                Some(caption.to_string())
            } else if is_safe_relative(&document_name) {
                Some(document_name)
            } else {
                None
            }
        });
        let Some(relative_path) = relative_path else {
            continue;
        };
        let file_size = media_size(&media);
        let remote_date = message.date().timestamp();
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(format!("{file_size}:{remote_date}:{}", message.id()).as_bytes())
        );
        if let Some(existing) = tree.get(&relative_path) {
            return Err(format!(
                "Multiple Telegram messages map to the same sync path '{relative_path}' (message {} and {}); rename or remove the duplicate before syncing",
                existing.message_id.unwrap_or_default(),
                message.id()
            ));
        }
        tree.insert(
            relative_path.clone(),
            TreeEntry {
                relative_path,
                hash: fingerprint,
                file_size,
                modified_at: Some(remote_date),
                message_id: Some(message.id()),
            },
        );
    }
    Ok(tree)
}

fn load_synced_tree(db: &DbConnection, pair_id: i64) -> Result<SyncedTree, String> {
    let connection = db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection.prepare(
        "SELECT relative_path, local_hash, remote_hash, file_size, local_mtime, remote_date, message_id, sync_status FROM sync_state WHERE pair_id = ?",
    ).map_err(|error| error.to_string())?;
    statement
        .bind((1, pair_id))
        .map_err(|error| error.to_string())?;
    let mut tree = SyncedTree::new();
    while statement.next().map_err(|error| error.to_string())? == State::Row {
        let relative_path: String = statement.read(0).map_err(|error| error.to_string())?;
        tree.insert(
            relative_path.clone(),
            SyncedEntry {
                relative_path,
                local_hash: statement.read::<Option<String>, _>(1).ok().flatten(),
                remote_hash: statement.read::<Option<String>, _>(2).ok().flatten(),
                file_size: statement.read::<i64, _>(3).unwrap_or(0).max(0) as u64,
                local_mtime: statement.read::<Option<i64>, _>(4).ok().flatten(),
                remote_date: statement.read::<Option<i64>, _>(5).ok().flatten(),
                message_id: statement
                    .read::<Option<i64>, _>(6)
                    .ok()
                    .flatten()
                    .and_then(|id| i32::try_from(id).ok()),
                sync_status: statement.read(7).unwrap_or_else(|_| "synced".to_string()),
            },
        );
    }
    Ok(tree)
}

fn upsert_state(
    db: &DbConnection,
    pair_id: i64,
    path: &str,
    local: Option<&TreeEntry>,
    remote: Option<&TreeEntry>,
    status: &str,
) -> Result<(), String> {
    let connection = db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection.prepare(
        "INSERT INTO sync_state (pair_id, relative_path, local_hash, remote_hash, file_size, local_mtime, remote_date, message_id, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pair_id, relative_path) DO UPDATE SET local_hash=excluded.local_hash, remote_hash=excluded.remote_hash, file_size=excluded.file_size, local_mtime=excluded.local_mtime, remote_date=excluded.remote_date, message_id=excluded.message_id, sync_status=excluded.sync_status",
    ).map_err(|error| error.to_string())?;
    statement
        .bind((1, pair_id))
        .map_err(|error| error.to_string())?;
    statement
        .bind((2, path))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<&str>)>((3, local.map(|entry| entry.hash.as_str())))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<&str>)>((4, remote.map(|entry| entry.hash.as_str())))
        .map_err(|error| error.to_string())?;
    statement
        .bind((
            5,
            local
                .or(remote)
                .map(|entry| entry.file_size as i64)
                .unwrap_or(0),
        ))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<i64>)>((6, local.and_then(|entry| entry.modified_at)))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<i64>)>((7, remote.and_then(|entry| entry.modified_at)))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<i64>)>((8, remote.and_then(|entry| entry.message_id).map(i64::from)))
        .map_err(|error| error.to_string())?;
    statement
        .bind((9, status))
        .map_err(|error| error.to_string())?;
    statement.next().map_err(|error| error.to_string())?;
    Ok(())
}

fn delete_state(db: &DbConnection, pair_id: i64, path: &str) -> Result<(), String> {
    let connection = db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare("DELETE FROM sync_state WHERE pair_id = ? AND relative_path = ?")
        .map_err(|error| error.to_string())?;
    statement
        .bind((1, pair_id))
        .map_err(|error| error.to_string())?;
    statement
        .bind((2, path))
        .map_err(|error| error.to_string())?;
    statement.next().map_err(|error| error.to_string())?;
    Ok(())
}

fn set_state_status(
    db: &DbConnection,
    pair_id: i64,
    path: &str,
    status: &str,
) -> Result<(), String> {
    let connection = db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare("UPDATE sync_state SET sync_status = ? WHERE pair_id = ? AND relative_path = ?")
        .map_err(|error| error.to_string())?;
    statement
        .bind((1, status))
        .map_err(|error| error.to_string())?;
    statement
        .bind((2, pair_id))
        .map_err(|error| error.to_string())?;
    statement
        .bind((3, path))
        .map_err(|error| error.to_string())?;
    statement.next().map_err(|error| error.to_string())?;
    Ok(())
}

async fn reconcile_pair(
    app: &tauri::AppHandle,
    db: &DbConnection,
    pair: &SyncPair,
    settings: &config::SyncSettings,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(usize, usize, Option<String>), String> {
    let local = scan_local(&pair.local_path).await?;
    let synced = load_synced_tree(db, pair.id)?;
    let remote = scan_remote(app, pair, &synced, shutdown.clone()).await?;
    for vanished_path in synced
        .keys()
        .filter(|path| !local.contains_key(*path) && !remote.contains_key(*path))
    {
        delete_state(db, pair.id, vanished_path)?;
    }
    let mut operations =
        planner::plan_for_direction(&local, &remote, &synced, &pair.sync_direction).map_err(
            |error| {
                let message = error.to_string();
                let _ = app.emit("sync-mass-deletion-blocked", &message);
                message
            },
        )?;
    let conflicts = operations
        .iter()
        .filter(|operation| matches!(operation, SyncOperation::Conflict { .. }))
        .count();
    for operation in operations
        .iter()
        .filter(|operation| matches!(operation, SyncOperation::Conflict { .. }))
    {
        if synced.contains_key(operation.path()) {
            set_state_status(db, pair.id, operation.path(), "conflict")?;
        } else {
            upsert_state(
                db,
                pair.id,
                operation.path(),
                local.get(operation.path()),
                remote.get(operation.path()),
                "conflict",
            )?;
        }
    }
    // Existing unchanged entries need no transfer or database write. Keeping
    // them out of the executor avoids one log row per file every poll cycle.
    operations.retain(|operation| {
        !matches!(operation, SyncOperation::Skip { .. }) || !synced.contains_key(operation.path())
    });
    let results = executor::execute(app, db, pair, settings, operations).await;
    let pending = results
        .iter()
        .filter(|result| !result.success && result.action != "conflict")
        .count();
    let execution_error = results
        .iter()
        .find(|result| !result.success && result.action != "conflict")
        .and_then(|result| result.detail.clone());

    // Telegram documents are immutable. Uploading a replacement creates a new
    // message, so remove the superseded message to prevent an old version from
    // resurfacing after a later delete.
    for result in results
        .iter()
        .filter(|result| result.success && result.action == "upload")
    {
        let old_message_id = remote
            .get(&result.relative_path)
            .and_then(|entry| entry.message_id);
        if let (Some(old_message_id), Some(new_message_id)) = (old_message_id, result.message_id) {
            if old_message_id != new_message_id {
                if let Err(error) =
                    executor::delete_remote(app, pair.channel_id, old_message_id).await
                {
                    log::warn!("Uploaded replacement but could not remove superseded Telegram message {old_message_id}: {error}");
                    log_sync(
                        db,
                        Some(pair.id),
                        "cleanup_remote_version",
                        Some(&result.relative_path),
                        Some(&error),
                    );
                }
            }
        }
    }

    // Persist uploaded message ids before the second remote scan so encrypted
    // Telegram filenames can still be mapped back to their relative paths.
    for result in results
        .iter()
        .filter(|result| result.success && result.action == "upload")
    {
        if let Some(message_id) = result.message_id {
            let mut remote_stub = local.get(&result.relative_path).cloned().unwrap();
            remote_stub.message_id = Some(message_id);
            remote_stub.hash.clear();
            upsert_state(
                db,
                pair.id,
                &result.relative_path,
                local.get(&result.relative_path),
                Some(&remote_stub),
                "syncing",
            )?;
        }
    }
    let local_after = scan_local(&pair.local_path).await?;
    let mapped = load_synced_tree(db, pair.id)?;
    let remote_after = scan_remote(app, pair, &mapped, shutdown).await?;
    for result in results {
        if !result.success {
            let status = if result.action == "conflict" {
                "conflict"
            } else if result
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("VAULT_LOCKED"))
            {
                "paused_vault"
            } else if result.action == "upload"
                && result.detail.as_deref().is_some_and(|detail| {
                    detail.contains("Telegram sync limit") || detail.contains("Telegram size limit")
                })
            {
                "skipped"
            } else {
                "error"
            };
            if synced.contains_key(&result.relative_path) {
                set_state_status(db, pair.id, &result.relative_path, status)?;
            } else {
                upsert_state(
                    db,
                    pair.id,
                    &result.relative_path,
                    local_after.get(&result.relative_path),
                    remote_after.get(&result.relative_path),
                    status,
                )?;
            }
            continue;
        }
        // For uploads, baseline the exact hash that was planned and verified.
        // If the source changes again before the post-scan, retaining that
        // earlier hash guarantees the next cycle sees another local change.
        let local_entry = if result.action == "upload" {
            local.get(&result.relative_path)
        } else {
            local_after.get(&result.relative_path)
        };
        let remote_entry = remote_after.get(&result.relative_path);
        if local_entry.is_none() && remote_entry.is_none() {
            delete_state(db, pair.id, &result.relative_path)?;
        } else {
            upsert_state(
                db,
                pair.id,
                &result.relative_path,
                local_entry,
                remote_entry,
                "synced",
            )?;
        }
    }
    Ok((pending, conflicts, execution_error))
}
