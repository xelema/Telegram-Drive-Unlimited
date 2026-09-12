pub mod config;
pub mod executor;
pub mod planner;
pub mod policy;
pub mod preview;
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
use tokio::{
    sync::{Mutex as AsyncMutex, RwLock},
    task::JoinHandle,
};

pub struct SyncEngine {
    pub running: Arc<AtomicBool>,
    pub db: DbConnection,
    pub app_handle: tauri::AppHandle,
    pub status: Arc<RwLock<SyncStatus>>,
    shutdown_tx: Mutex<tokio::sync::watch::Sender<bool>>,
    task: Mutex<Option<JoinHandle<()>>>,
    pub(crate) operation_lock: AsyncMutex<()>,
    pub(crate) reconfigure_lock: AsyncMutex<()>,
    pub(crate) preview_receipts: Mutex<HashMap<String, preview::PreviewReceipt>>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub running: bool,
    pub active_pairs: usize,
    pub pending_ops: usize,
    pub conflicts: usize,
    pub last_error: Option<String>,
    pub pairs: Vec<SyncPairStatus>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPairStatus {
    pub pair_id: i64,
    pub phase: String,
    pub pending_ops: usize,
    pub conflicts: usize,
    pub last_error: Option<String>,
    pub last_checked_at: Option<i64>,
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
            operation_lock: AsyncMutex::new(()),
            reconfigure_lock: AsyncMutex::new(()),
            preview_receipts: Mutex::new(HashMap::new()),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let settings = load_settings(self.db.clone()).await?;
        let pairs = load_pairs(self.db.clone(), false).await?;
        if !settings.enabled {
            let status = self.status.clone();
            let app = self.app_handle.clone();
            {
                let snapshot = SyncStatus {
                    enabled: false,
                    active_pairs: pairs.iter().filter(|pair| pair.is_active).count(),
                    pairs: pairs
                        .iter()
                        .map(|pair| SyncPairStatus {
                            pair_id: pair.id,
                            phase: "paused".into(),
                            last_error: Some("Automatic sync is paused".into()),
                            ..SyncPairStatus::default()
                        })
                        .collect(),
                    ..SyncStatus::default()
                };
                *status.write().await = snapshot.clone();
                let _ = app.emit("sync-status-changed", snapshot);
            }
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
        let _reconfigure = self.reconfigure_lock.lock().await;
        self.shutdown_and_wait().await?;
        self.start().await
    }
}

pub async fn restart_sync_engine(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<SyncEngine>().restart().await
}

async fn emit_status(app: &tauri::AppHandle, status: &Arc<RwLock<SyncStatus>>) {
    let snapshot = status.read().await.clone();
    let _ = app.emit("sync-status-changed", snapshot);
}

pub(crate) fn pair_account(
    app: &tauri::AppHandle,
    pair: &SyncPair,
) -> Result<crate::workspace::AccountGuard, String> {
    let expected = pair
        .account_owner
        .as_deref()
        .ok_or("Review this mapping before activating it for your current Telegram account")?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    crate::workspace::AccountGuard::open(&root, Some(expected))
}

async fn set_pair_status(
    app: &tauri::AppHandle,
    status: &Arc<RwLock<SyncStatus>>,
    pair_status: SyncPairStatus,
) {
    let mut current = status.write().await;
    if let Some(existing) = current
        .pairs
        .iter_mut()
        .find(|entry| entry.pair_id == pair_status.pair_id)
    {
        *existing = pair_status;
    } else {
        current.pairs.push(pair_status);
    }
    drop(current);
    emit_status(app, status).await;
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
        current.active_pairs = pairs.iter().filter(|pair| pair.is_active).count();
        current.last_error = None;
        current.pairs = pairs
            .iter()
            .map(|pair| SyncPairStatus {
                pair_id: pair.id,
                phase: if pair.is_active { "waiting" } else { "paused" }.into(),
                ..SyncPairStatus::default()
            })
            .collect();
    }
    emit_status(&app, &status).await;

    // A trigger means "the trees may have changed", not "perform exactly one
    // reconciliation". A capacity of one coalesces filesystem bursts and
    // prevents a large copy from queueing hundreds of full remote scans.
    let (trigger_tx, mut trigger_rx) = tokio::sync::mpsc::channel(1);
    let watcher = watcher::LocalWatcher::spawn(
        pairs
            .iter()
            .filter(|pair| pair.is_active)
            .map(|pair| (PathBuf::from(&pair.local_path), pair.preferences.clone()))
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
            if !pair.is_active {
                set_pair_status(
                    &app,
                    &status,
                    SyncPairStatus {
                        pair_id: pair.id,
                        phase: "paused".into(),
                        last_error: Some("Paused by you".into()),
                        ..SyncPairStatus::default()
                    },
                )
                .await;
                continue;
            }
            set_pair_status(
                &app,
                &status,
                SyncPairStatus {
                    pair_id: pair.id,
                    phase: "scanning".into(),
                    ..SyncPairStatus::default()
                },
            )
            .await;
            let engine = app.state::<SyncEngine>();
            let _operation = engine.operation_lock.lock().await;
            match reconcile_pair(&app, &db, pair, &settings, shutdown.clone()).await {
                Ok((pair_pending, pair_conflicts, pair_error)) => {
                    set_pair_status(
                        &app,
                        &status,
                        SyncPairStatus {
                            pair_id: pair.id,
                            phase: if pair_error.is_some() || pair_conflicts > 0 {
                                "paused"
                            } else {
                                "ready"
                            }
                            .into(),
                            pending_ops: pair_pending,
                            conflicts: pair_conflicts,
                            last_error: pair_error.clone(),
                            last_checked_at: Some(chrono::Utc::now().timestamp()),
                        },
                    )
                    .await;
                    pending += pair_pending;
                    conflicts += pair_conflicts;
                    if pair_error.is_some() {
                        last_error = pair_error;
                    }
                }
                Err(error) => {
                    set_pair_status(
                        &app,
                        &status,
                        SyncPairStatus {
                            pair_id: pair.id,
                            phase: "paused".into(),
                            last_error: Some(error.clone()),
                            last_checked_at: Some(chrono::Utc::now().timestamp()),
                            ..SyncPairStatus::default()
                        },
                    )
                    .await;
                    log::error!("Folder sync pair {} paused: {error}", pair.id);
                    log_sync(
                        db.clone(),
                        Some(pair.id),
                        "error".to_string(),
                        None,
                        Some(error.clone()),
                    )
                    .await;
                    last_error = Some(error);
                }
            }
        }
        conflicts = conflicts.max(count_conflicts(&db).await.unwrap_or(conflicts));
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

async fn count_conflicts(db: &DbConnection) -> Result<usize, String> {
    crate::db::with_connection(db.clone(), |connection| {
        let mut statement = connection
            .prepare("SELECT COUNT(*) FROM sync_state WHERE sync_status = 'conflict'")
            .map_err(|error| error.to_string())?;
        if statement.next().map_err(|error| error.to_string())? == State::Row {
            return Ok(statement.read::<i64, _>(0).unwrap_or(0).max(0) as usize);
        }
        Ok(0)
    })
    .await
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

async fn scan_local(root: &str, preferences: &policy::SyncPreferences) -> Result<FileTree, String> {
    let root = PathBuf::from(root);
    let preferences = preferences.clone();
    tokio::task::spawn_blocking(move || {
        let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
        let mut tree = FileTree::new();
        let entries = walkdir::WalkDir::new(&canonical_root).follow_links(false).into_iter().filter_entry(|entry| {
            if entry.depth() == 0 { return true; }
            let relative = entry.path().strip_prefix(&canonical_root).unwrap_or(entry.path()).components().map(|component| component.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            !(preferences.ignores(&relative) || (entry.file_type().is_dir() && preferences.ignores(&format!("{relative}/"))))
        });
        for entry in entries {
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
    account: &crate::workspace::AccountGuard,
) -> Result<FileTree, String> {
    let mut attempt = 0u32;
    loop {
        account.validate()?;
        match scan_remote_once(app, pair, synced, account).await {
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
    account: &crate::workspace::AccountGuard,
) -> Result<FileTree, String> {
    let telegram = app.state::<TelegramState>();
    let client = telegram.client.lock().await.clone().ok_or(
        "Telegram is offline; remote tree unavailable, so no reconciliation was attempted",
    )?;
    account.validate_client(&client).await?;
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
        account.validate()?;
        let Some(media) = message.media() else {
            continue;
        };
        let (document_name, media_id) = match &media {
            grammers_client::types::Media::Document(document) => {
                (document.name().to_string(), document.id())
            }
            grammers_client::types::Media::Photo(photo) => ("Photo.jpg".to_string(), photo.id()),
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
        let remote_date = message
            .edit_date()
            .unwrap_or_else(|| message.date())
            .timestamp();
        let fingerprint = remote_fingerprint(
            file_size,
            message.date().timestamp(),
            message.edit_date().map(|date| date.timestamp()),
            message.id(),
            media_id,
        );
        if let Some(existing) = tree.get(&relative_path) {
            if pair.preferences.ignores(&relative_path) {
                continue;
            }
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
    account.validate()?;
    Ok(tree)
}

fn remote_fingerprint(
    file_size: u64,
    created_at: i64,
    edited_at: Option<i64>,
    message_id: i32,
    media_id: i64,
) -> String {
    format!(
        "v2:{:x}",
        Sha256::digest(
            format!("{file_size}:{created_at}:{edited_at:?}:{message_id}:{media_id}").as_bytes()
        )
    )
}

fn message_fingerprint(message: &grammers_client::types::Message) -> Result<String, String> {
    let media = message
        .media()
        .ok_or("The remote file has no downloadable media")?;
    let media_id = match &media {
        grammers_client::types::Media::Document(document) => document.id(),
        grammers_client::types::Media::Photo(photo) => photo.id(),
        _ => return Err("The remote media type cannot be compared safely".into()),
    };
    Ok(remote_fingerprint(
        media_size(&media),
        message.date().timestamp(),
        message.edit_date().map(|date| date.timestamp()),
        message.id(),
        media_id,
    ))
}

fn retain_tree_paths(
    local: &mut FileTree,
    remote: &mut FileTree,
    synced: &mut SyncedTree,
    preferences: &policy::SyncPreferences,
) -> usize {
    let ignored: std::collections::BTreeSet<_> = local
        .keys()
        .chain(remote.keys())
        .chain(synced.keys())
        .filter(|path| preferences.ignores(path))
        .cloned()
        .collect();
    for path in &ignored {
        local.remove(path);
        remote.remove(path);
        synced.remove(path);
    }
    ignored.len()
}

#[derive(Debug, PartialEq, Eq)]
enum CleanupAction {
    DeleteOld,
    AlreadyGone,
    PreserveOld,
}

fn cleanup_action(old_exists: bool, new_exists: bool, old_unchanged: bool) -> CleanupAction {
    match (old_exists, new_exists, old_unchanged) {
        (false, _, _) => CleanupAction::AlreadyGone,
        (true, true, true) => CleanupAction::DeleteOld,
        (true, _, _) => CleanupAction::PreserveOld,
    }
}

/// Retry publication cleanup before scanning a channel, so a temporary error
/// cannot turn the application's own superseded versions into a permanent
/// duplicate-path failure. The journal is persisted before deleting anything.
async fn retry_pending_cleanup(
    app: &tauri::AppHandle,
    db: &DbConnection,
    pair: &SyncPair,
    account: &crate::workspace::AccountGuard,
) -> Result<(), String> {
    replay_pending_cleanup(db, pair.id, |item| async move {
        account.validate()?;
        let telegram = app.state::<TelegramState>();
        let client = telegram
            .client
            .lock()
            .await
            .clone()
            .ok_or("Telegram is offline; replacement cleanup will retry when connected")?;
        let peer = resolve_peer(&client, Some(pair.channel_id), &telegram.peer_cache).await?;
        let messages = client
            .get_messages_by_id(&peer, &[item.old_message_id, item.new_message_id])
            .await
            .map_err(|error| {
                format!("Uploaded replacement is preserved; cleanup will retry: {error}")
            })?;
        let old_exists = messages
            .iter()
            .flatten()
            .any(|message| message.id() == item.old_message_id);
        let new_exists = messages
            .iter()
            .flatten()
            .any(|message| message.id() == item.new_message_id && message.media().is_some());
        let old_unchanged = messages.iter().flatten().find(|message| message.id() == item.old_message_id)
            .and_then(|message| message_fingerprint(message).ok()).zip(item.old_remote_hash.as_ref())
            .is_some_and(|(actual, expected)| actual == *expected);
        let action = cleanup_action(old_exists, new_exists, old_unchanged);
        let preserve_old = action == CleanupAction::PreserveOld;
        match action {
            CleanupAction::DeleteOld => {
                account.validate()?;
                executor::delete_remote(app, pair.channel_id, item.old_message_id, account)
                    .await
                    .map_err(|error| {
                        format!("Uploaded replacement is preserved; cleanup will retry: {error}")
                    })?;
            }
            CleanupAction::PreserveOld => {
                set_state_status(db, pair.id, &item.relative_path, "conflict").await?;
                log_sync(db.clone(), Some(pair.id), "conflict".into(), Some(item.relative_path.clone()), Some("The previous remote file changed or its replacement disappeared before cleanup; the previous copy was preserved".into())).await;
            }
            CleanupAction::AlreadyGone => {}
        }
        account.validate()?;
        Ok(preserve_old)
    }).await
}

async fn replay_pending_cleanup<F, Fut>(
    db: &DbConnection,
    pair_id: i64,
    mut perform: F,
) -> Result<(), String>
where
    F: FnMut(config::PendingCleanup) -> Fut,
    Fut: std::future::Future<Output = Result<bool, String>>,
{
    let mut pending = config::load_pending_cleanup(db.clone(), pair_id).await?;
    while let Some(item) = pending.first().cloned() {
        let preserve_old = perform(item).await?;
        pending.remove(0);
        config::save_pending_cleanup(db.clone(), pair_id, &pending).await?;
        if preserve_old {
            return Err("A previous remote file changed or its replacement disappeared before cleanup. Both available copies were preserved; review the conflict".into());
        }
    }
    Ok(())
}

async fn load_synced_tree(db: &DbConnection, pair_id: i64) -> Result<SyncedTree, String> {
    crate::db::with_connection(db.clone(), move |connection| {
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
    }).await
}

async fn upsert_state(
    db: &DbConnection,
    pair_id: i64,
    path: &str,
    local: Option<&TreeEntry>,
    remote: Option<&TreeEntry>,
    status: &str,
) -> Result<(), String> {
    let path = path.to_string();
    let local = local.cloned();
    let remote = remote.cloned();
    let status = status.to_string();
    crate::db::with_connection(db.clone(), move |connection| {
    let mut statement = connection.prepare(
        "INSERT INTO sync_state (pair_id, relative_path, local_hash, remote_hash, file_size, local_mtime, remote_date, message_id, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pair_id, relative_path) DO UPDATE SET local_hash=excluded.local_hash, remote_hash=excluded.remote_hash, file_size=excluded.file_size, local_mtime=excluded.local_mtime, remote_date=excluded.remote_date, message_id=excluded.message_id, sync_status=excluded.sync_status",
    ).map_err(|error| error.to_string())?;
    statement
        .bind((1, pair_id))
        .map_err(|error| error.to_string())?;
    statement
        .bind((2, path.as_str()))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<&str>)>((3, local.as_ref().map(|entry| entry.hash.as_str())))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<&str>)>((4, remote.as_ref().map(|entry| entry.hash.as_str())))
        .map_err(|error| error.to_string())?;
    statement
        .bind((
            5,
            local
                .as_ref()
                .or(remote.as_ref())
                .map(|entry| entry.file_size as i64)
                .unwrap_or(0),
        ))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<i64>)>((6, local.as_ref().and_then(|entry| entry.modified_at)))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<i64>)>((7, remote.as_ref().and_then(|entry| entry.modified_at)))
        .map_err(|error| error.to_string())?;
    statement
        .bind::<(usize, Option<i64>)>((8, remote.as_ref().and_then(|entry| entry.message_id).map(i64::from)))
        .map_err(|error| error.to_string())?;
    statement
        .bind((9, status.as_str()))
        .map_err(|error| error.to_string())?;
    statement.next().map_err(|error| error.to_string())?;
    Ok(())
    }).await
}

async fn delete_state(db: &DbConnection, pair_id: i64, path: &str) -> Result<(), String> {
    let path = path.to_string();
    crate::db::with_connection(db.clone(), move |connection| {
        let mut statement = connection
            .prepare("DELETE FROM sync_state WHERE pair_id = ? AND relative_path = ?")
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, pair_id))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, path.as_str()))
            .map_err(|error| error.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
}

async fn set_state_status(
    db: &DbConnection,
    pair_id: i64,
    path: &str,
    status: &str,
) -> Result<(), String> {
    let path = path.to_string();
    let status = status.to_string();
    crate::db::with_connection(db.clone(), move |connection| {
        let mut statement = connection
            .prepare(
                "UPDATE sync_state SET sync_status = ? WHERE pair_id = ? AND relative_path = ?",
            )
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, status.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, pair_id))
            .map_err(|error| error.to_string())?;
        statement
            .bind((3, path.as_str()))
            .map_err(|error| error.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
}

async fn reconcile_pair(
    app: &tauri::AppHandle,
    db: &DbConnection,
    pair: &SyncPair,
    settings: &config::SyncSettings,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(usize, usize, Option<String>), String> {
    let account = pair_account(app, pair)?;
    retry_pending_cleanup(app, db, pair, &account).await?;
    let mut local = scan_local(&pair.local_path, &pair.preferences).await?;
    let mut synced = load_synced_tree(db, pair.id).await?;
    let mut remote = scan_remote(app, pair, &synced, shutdown.clone(), &account).await?;
    account.validate()?;
    retain_tree_paths(&mut local, &mut remote, &mut synced, &pair.preferences);
    for vanished_path in synced
        .keys()
        .filter(|path| !local.contains_key(*path) && !remote.contains_key(*path))
    {
        delete_state(db, pair.id, vanished_path).await?;
    }
    let mut operations = planner::plan_for_policy(
        &local,
        &remote,
        &synced,
        &pair.sync_direction,
        pair.preferences.propagate_deletions,
    )
    .map_err(|error| {
        let message = error.to_string();
        let _ = app.emit("sync-mass-deletion-blocked", &message);
        message
    })?;
    let conflicts = operations
        .iter()
        .filter(|operation| matches!(operation, SyncOperation::Conflict { .. }))
        .count();
    for operation in operations
        .iter()
        .filter(|operation| matches!(operation, SyncOperation::Conflict { .. }))
    {
        if synced.contains_key(operation.path()) {
            set_state_status(db, pair.id, operation.path(), "conflict").await?;
        } else {
            upsert_state(
                db,
                pair.id,
                operation.path(),
                local.get(operation.path()),
                remote.get(operation.path()),
                "conflict",
            )
            .await?;
        }
    }
    if pair.preferences.pause_on_conflicts && conflicts > 0 {
        return Ok((
            operations
                .iter()
                .filter(|operation| {
                    !matches!(
                        operation,
                        SyncOperation::Skip { .. } | SyncOperation::Conflict { .. }
                    )
                })
                .count(),
            conflicts,
            Some("Paused because this mapping has conflicts; review them before continuing".into()),
        ));
    }
    if operations
        .iter()
        .any(|operation| matches!(operation, SyncOperation::Upload { .. }))
    {
        if let Err(reason) = executor::upload_protection_mode(app, settings) {
            return Ok((
                operations
                    .iter()
                    .filter(|operation| {
                        !matches!(
                            operation,
                            SyncOperation::Skip { .. } | SyncOperation::Conflict { .. }
                        )
                    })
                    .count(),
                conflicts,
                Some(reason),
            ));
        }
    }
    // Existing unchanged entries need no transfer or database write. Keeping
    // them out of the executor avoids one log row per file every poll cycle.
    operations.retain(|operation| {
        !matches!(operation, SyncOperation::Skip { .. })
            || !synced.contains_key(operation.path())
            || (local
                .get(operation.path())
                .zip(remote.get(operation.path()))
                .zip(synced.get(operation.path()))
                .is_some_and(|((local, remote), previous)| {
                    previous.local_hash.as_deref() != Some(local.hash.as_str())
                        || previous.remote_hash.as_deref() != Some(remote.hash.as_str())
                }))
    });
    let operation_count = operations
        .iter()
        .filter(|operation| {
            !matches!(
                operation,
                SyncOperation::Skip { .. } | SyncOperation::Conflict { .. }
            )
        })
        .count();
    if operation_count > 0 {
        let engine = app.state::<SyncEngine>();
        set_pair_status(
            app,
            &engine.status,
            SyncPairStatus {
                pair_id: pair.id,
                phase: "syncing".into(),
                pending_ops: operation_count,
                conflicts,
                ..SyncPairStatus::default()
            },
        )
        .await;
    }
    let results = executor::execute(app, db, pair, settings, operations, &account).await;
    account.validate()?;
    let pending = results
        .iter()
        .filter(|result| !result.success && result.action != "conflict")
        .count();
    let execution_error = results
        .iter()
        .find(|result| !result.success && result.action != "conflict")
        .and_then(|result| result.detail.clone());

    // Our uploads publish replacements as new messages. Journal superseded
    // messages before cleanup so a transient error or restart can retry them.
    for result in results
        .iter()
        .filter(|result| result.success && result.action == "upload")
    {
        let old_message_id = remote
            .get(&result.relative_path)
            .and_then(|entry| entry.message_id);
        if let (Some(old_message_id), Some(new_message_id)) = (old_message_id, result.message_id) {
            if old_message_id != new_message_id {
                let mut pending = config::load_pending_cleanup(db.clone(), pair.id).await?;
                let cleanup = config::PendingCleanup {
                    relative_path: result.relative_path.clone(),
                    old_message_id,
                    new_message_id,
                    old_remote_hash: remote
                        .get(&result.relative_path)
                        .map(|entry| entry.hash.clone()),
                };
                if !pending.contains(&cleanup) {
                    pending.push(cleanup);
                }
                config::save_pending_cleanup(db.clone(), pair.id, &pending).await?;
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
            )
            .await?;
        }
    }
    account.validate()?;
    retry_pending_cleanup(app, db, pair, &account).await?;
    let local_after = scan_local(&pair.local_path, &pair.preferences).await?;
    let mapped = load_synced_tree(db, pair.id).await?;
    let remote_after = scan_remote(app, pair, &mapped, shutdown, &account).await?;
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
                set_state_status(db, pair.id, &result.relative_path, status).await?;
            } else {
                upsert_state(
                    db,
                    pair.id,
                    &result.relative_path,
                    local_after.get(&result.relative_path),
                    remote_after.get(&result.relative_path),
                    status,
                )
                .await?;
            }
            continue;
        }
        // For uploads, baseline the exact hash that was planned and verified.
        // If the source changes again before the post-scan, retaining that
        // earlier hash guarantees the next cycle sees another local change.
        let verified_download = result.local_hash.as_ref().and_then(|hash| {
            remote.get(&result.relative_path).cloned().map(|mut entry| {
                entry.hash = hash.clone();
                entry.message_id = None;
                entry
            })
        });
        let local_entry = if matches!(result.action.as_str(), "upload" | "skip" | "keep_both") {
            local.get(&result.relative_path)
        } else if result.action == "download" {
            verified_download.as_ref()
        } else {
            local_after.get(&result.relative_path)
        };
        let remote_entry = if matches!(result.action.as_str(), "download" | "keep_both" | "skip") {
            remote.get(&result.relative_path)
        } else {
            remote_after.get(&result.relative_path)
        };
        if local_entry.is_none() && remote_entry.is_none() {
            delete_state(db, pair.id, &result.relative_path).await?;
        } else {
            upsert_state(
                db,
                pair.id,
                &result.relative_path,
                local_entry,
                remote_entry,
                "synced",
            )
            .await?;
        }
    }
    Ok((pending, conflicts, execution_error))
}

#[cfg(test)]
mod safety_tests {
    use super::*;

    #[test]
    fn remote_identity_detects_equal_size_media_replacements_and_edits() {
        let original = remote_fingerprint(100, 123, None, 1, 10);
        assert!(original.starts_with("v2:"));
        assert_ne!(original, remote_fingerprint(100, 123, None, 1, 11));
        assert_ne!(original, remote_fingerprint(100, 123, Some(124), 1, 10));
        assert_eq!(original, remote_fingerprint(100, 123, None, 1, 10));
    }

    #[test]
    fn replacement_cleanup_never_deletes_the_only_remaining_copy() {
        assert_eq!(cleanup_action(true, true, true), CleanupAction::DeleteOld);
        assert_eq!(
            cleanup_action(true, true, false),
            CleanupAction::PreserveOld
        );
        assert_eq!(
            cleanup_action(true, false, true),
            CleanupAction::PreserveOld
        );
        assert_eq!(
            cleanup_action(false, true, false),
            CleanupAction::AlreadyGone
        );
        assert_eq!(
            cleanup_action(false, false, false),
            CleanupAction::AlreadyGone
        );
    }

    #[tokio::test]
    async fn failed_cleanup_is_durable_and_retried_before_later_items() {
        let path =
            std::env::temp_dir().join(format!("telegram-sync-cleanup-{}.db", uuid::Uuid::new_v4()));
        let pending = vec![
            config::PendingCleanup {
                relative_path: "a.txt".into(),
                old_message_id: 1,
                new_message_id: 11,
                old_remote_hash: Some("old-a".into()),
            },
            config::PendingCleanup {
                relative_path: "b.txt".into(),
                old_message_id: 2,
                new_message_id: 12,
                old_remote_hash: Some("old-b".into()),
            },
        ];
        {
            let connection = sqlite::open(&path).unwrap();
            connection
                .execute("CREATE TABLE sync_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                .unwrap();
            let db = Arc::new(Mutex::new(connection));
            config::save_pending_cleanup(db.clone(), 7, &pending)
                .await
                .unwrap();
            assert!(replay_pending_cleanup(&db, 7, |_| async {
                Err("temporary network failure".into())
            })
            .await
            .is_err());
        }
        {
            let db = Arc::new(Mutex::new(sqlite::open(&path).unwrap()));
            assert_eq!(
                config::load_pending_cleanup(db.clone(), 7).await.unwrap(),
                pending
            );
            let seen = Arc::new(Mutex::new(Vec::new()));
            let seen_for_operation = seen.clone();
            replay_pending_cleanup(&db, 7, move |item| {
                seen_for_operation.lock().unwrap().push(item.old_message_id);
                async { Ok(false) }
            })
            .await
            .unwrap();
            assert_eq!(*seen.lock().unwrap(), vec![1, 2]);
            assert!(config::load_pending_cleanup(db, 7)
                .await
                .unwrap()
                .is_empty());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn local_scan_skips_ignored_folders_and_preserves_visible_files() {
        let root =
            std::env::temp_dir().join(format!("telegram-sync-ignore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested/.git")).unwrap();
        std::fs::write(root.join("nested/.git/config"), "ignored").unwrap();
        std::fs::write(root.join("report.txt"), "visible").unwrap();
        std::fs::write(root.join("report.txt.td-sync-tmp"), "partial").unwrap();
        let tree = scan_local(root.to_str().unwrap(), &policy::SyncPreferences::default())
            .await
            .unwrap();
        assert_eq!(tree.keys().cloned().collect::<Vec<_>>(), vec!["report.txt"]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
