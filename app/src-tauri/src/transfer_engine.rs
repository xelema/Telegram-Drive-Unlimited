//! Durable, backend-owned desktop transfer scheduling.
//!
//! Transfer metadata is stored in a dedicated SQLite database. Credential
//! handles are intentionally memory-only and are never serialized or emitted.

use crate::bandwidth::BandwidthManager;
use crate::commands::download_destination::{
    destination_key, reserve_destination, DownloadCollisionPolicy, DownloadOutcome,
    DownloadPublication,
};
use crate::commands::{self, fs::DownloadFileRequest, TelegramState};
use crate::crypto::state::CryptoState;
use crate::db::DbConnection;
use crate::vpn_optimizer::NetworkConfig;
pub(crate) use crate::workspace::operation_account;
use crate::workspace::AccountGuard;
use serde::{Deserialize, Serialize};
use sqlite::State as SqliteState;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, Notify, RwLock};

const DATABASE_SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS transfer_schema (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO transfer_schema (version, applied_at)
VALUES (1, CAST(strftime('%s', 'now') AS INTEGER));
CREATE TABLE IF NOT EXISTS transfer_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('upload', 'download')),
    status TEXT NOT NULL,
    queue_position INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transfer_tombstones (id TEXT PRIMARY KEY NOT NULL);
CREATE INDEX IF NOT EXISTS idx_transfer_jobs_schedule
ON transfer_jobs(direction, status, queue_position);
"#;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferKind {
    LocalUpload,
    UrlUpload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Pending,
    Paused,
    WaitingForNetwork,
    Cooldown,
    Downloading,
    Uploading,
    Encrypting,
    Decrypting,
    Verifying,
    WaitingForUnlock,
    Completed,
    Failed,
    Cancelled,
}

impl TransferStatus {
    fn is_active(self) -> bool {
        matches!(
            self,
            Self::Downloading
                | Self::Uploading
                | Self::Encrypting
                | Self::Decrypting
                | Self::Verifying
        )
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    pub fn is_tray_active(self) -> bool {
        self.is_active() || self == Self::Pending
    }

    pub fn is_tray_waiting(self) -> bool {
        matches!(
            self,
            Self::WaitingForNetwork | Self::WaitingForUnlock | Self::Cooldown
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferErrorCategory {
    Network,
    RateLimit,
    Unlock,
    SourceMissing,
    Storage,
    Integrity,
    Account,
    Interrupted,
    Persistence,
    Cancelled,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
    pub id: String,
    #[serde(default)]
    pub owner_id: Option<String>,
    pub direction: TransferDirection,
    pub kind: TransferKind,
    pub status: TransferStatus,
    #[serde(default)]
    pub download_outcome: Option<DownloadOutcome>,
    pub path: Option<String>,
    pub url: Option<String>,
    pub folder_id: Option<i64>,
    pub message_id: Option<i32>,
    pub filename: String,
    pub save_path: Option<String>,
    #[serde(default)]
    pub collision_policy: DownloadCollisionPolicy,
    pub protection_mode: Option<String>,
    pub protect_metadata: Option<bool>,
    pub video_upload_mode: Option<String>,
    pub temp_zip_path: Option<String>,
    pub progress: u8,
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub error: Option<String>,
    #[serde(default)]
    pub error_category: Option<TransferErrorCategory>,
    #[serde(default)]
    pub persistence_pending: bool,
    pub retry_at: Option<i64>,
    pub queue_position: i64,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEnqueueRequest {
    pub id: String,
    #[serde(default)]
    pub owner_id: Option<String>,
    pub direction: TransferDirection,
    pub kind: TransferKind,
    pub path: Option<String>,
    pub url: Option<String>,
    pub folder_id: Option<i64>,
    pub message_id: Option<i32>,
    pub filename: String,
    pub save_path: Option<String>,
    #[serde(default)]
    pub collision_policy: DownloadCollisionPolicy,
    pub protection_mode: Option<String>,
    pub prompt_token: Option<u64>,
    pub protect_metadata: Option<bool>,
    pub video_upload_mode: Option<String>,
    pub temp_zip_path: Option<String>,
    pub total_bytes: Option<u64>,
    pub initial_status: Option<TransferStatus>,
}

impl TransferEnqueueRequest {
    fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() || self.id.len() > 128 {
            return Err("Transfer ID is missing or invalid".to_string());
        }
        if self.filename.trim().is_empty() {
            return Err("Transfer filename is required".to_string());
        }
        match self.kind {
            TransferKind::LocalUpload if self.path.as_deref().unwrap_or("").is_empty() => {
                Err("A local upload requires a source path".to_string())
            }
            TransferKind::UrlUpload if self.url.as_deref().unwrap_or("").is_empty() => {
                Err("A URL upload requires a URL".to_string())
            }
            TransferKind::Download
                if self.message_id.is_none()
                    || self.save_path.as_deref().unwrap_or("").is_empty() =>
            {
                Err("A download requires a message and destination path".to_string())
            }
            TransferKind::Download if self.direction != TransferDirection::Download => {
                Err("Download jobs must use the download direction".to_string())
            }
            TransferKind::LocalUpload | TransferKind::UrlUpload
                if self.direction != TransferDirection::Upload =>
            {
                Err("Upload jobs must use the upload direction".to_string())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone)]
struct TransferStore {
    connection: Arc<Mutex<sqlite::Connection>>,
}

impl TransferStore {
    fn open(path: &Path) -> Result<(Self, Vec<TransferJob>), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = sqlite::open(path).map_err(|error| error.to_string())?;
        connection
            .execute(DATABASE_SCHEMA)
            .map_err(|error| format!("Could not initialize transfer database: {error}"))?;
        let mut jobs = Self::load_all_from(&connection)?;
        for job in &mut jobs {
            if recover_after_restart(job) {
                Self::upsert_on(&connection, job)?;
            }
        }
        Ok((
            Self {
                connection: Arc::new(Mutex::new(connection)),
            },
            jobs,
        ))
    }

    fn load_all_from(connection: &sqlite::Connection) -> Result<Vec<TransferJob>, String> {
        let mut statement = connection
            .prepare("SELECT payload_json FROM transfer_jobs ORDER BY queue_position, created_at")
            .map_err(|error| error.to_string())?;
        let mut jobs = Vec::new();
        while statement.next().map_err(|error| error.to_string())? == SqliteState::Row {
            let payload = statement
                .read::<String, _>(0)
                .map_err(|error| error.to_string())?;
            jobs.push(
                serde_json::from_str(&payload)
                    .map_err(|error| format!("Invalid durable transfer record: {error}"))?,
            );
        }
        Ok(jobs)
    }

    async fn upsert(&self, job: &TransferJob) -> Result<(), String> {
        let connection = self.connection.clone();
        let job = job.clone();
        crate::db::with_connection(connection, move |connection| {
            Self::upsert_on(connection, &job)
        })
        .await
    }

    fn upsert_on(connection: &sqlite::Connection, job: &TransferJob) -> Result<(), String> {
        let mut tombstone = connection
            .prepare("SELECT id FROM transfer_tombstones WHERE id = ?")
            .map_err(|e| e.to_string())?;
        tombstone
            .bind((1, job.id.as_str()))
            .map_err(|e| e.to_string())?;
        if tombstone.next().map_err(|e| e.to_string())? == SqliteState::Row {
            return Err("Transfer was removed; stale updates are rejected".into());
        }
        let payload = serde_json::to_string(job).map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "INSERT INTO transfer_jobs
                 (id, direction, status, queue_position, revision, payload_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   direction = excluded.direction,
                   status = excluded.status,
                   queue_position = excluded.queue_position,
                   revision = excluded.revision,
                   payload_json = excluded.payload_json,
                   updated_at = excluded.updated_at
                 WHERE excluded.revision >= transfer_jobs.revision",
            )
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, job.id.as_str()))
            .map_err(|e| e.to_string())?;
        statement
            .bind((2, enum_json(&job.direction)?.as_str()))
            .map_err(|e| e.to_string())?;
        statement
            .bind((3, enum_json(&job.status)?.as_str()))
            .map_err(|e| e.to_string())?;
        statement
            .bind((4, job.queue_position))
            .map_err(|e| e.to_string())?;
        statement
            .bind((5, u64_to_i64(job.revision)?))
            .map_err(|e| e.to_string())?;
        statement
            .bind((6, payload.as_str()))
            .map_err(|e| e.to_string())?;
        statement
            .bind((7, job.created_at))
            .map_err(|e| e.to_string())?;
        statement
            .bind((8, job.updated_at))
            .map_err(|e| e.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        Ok(())
    }

    async fn upsert_many(&self, jobs: &[TransferJob]) -> Result<(), String> {
        let connection = self.connection.clone();
        let jobs = jobs.to_vec();
        crate::db::with_connection(connection, move |connection| {
            connection
                .execute("BEGIN IMMEDIATE")
                .map_err(|e| e.to_string())?;
            let result = jobs
                .iter()
                .try_for_each(|job| Self::upsert_on(connection, job));
            match result {
                Ok(()) => match connection.execute("COMMIT") {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        let _ = connection.execute("ROLLBACK");
                        Err(error.to_string())
                    }
                },
                Err(error) => {
                    let _ = connection.execute("ROLLBACK");
                    Err(error)
                }
            }
        })
        .await
    }

    async fn delete_many(&self, ids: &[String]) -> Result<(), String> {
        let connection = self.connection.clone();
        let ids = ids.to_vec();
        crate::db::with_connection(connection, move |connection| {
            connection
                .execute("BEGIN IMMEDIATE")
                .map_err(|e| e.to_string())?;
            let result = (|| {
                for id in &ids {
                    for sql in [
                        "INSERT OR IGNORE INTO transfer_tombstones(id) VALUES (?)",
                        "DELETE FROM transfer_jobs WHERE id = ?",
                    ] {
                        let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
                        statement
                            .bind((1, id.as_str()))
                            .map_err(|e| e.to_string())?;
                        statement.next().map_err(|e| e.to_string())?;
                    }
                }
                Ok::<(), String>(())
            })();
            match result {
                Ok(()) => match connection.execute("COMMIT") {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        let _ = connection.execute("ROLLBACK");
                        Err(error.to_string())
                    }
                },
                Err(error) => {
                    let _ = connection.execute("ROLLBACK");
                    Err(error)
                }
            }
        })
        .await
    }

    #[cfg(test)]
    async fn delete(&self, id: &str) -> Result<(), String> {
        self.delete_many(&[id.to_string()]).await
    }
}

fn enum_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value)
        .map(|value| value.trim_matches('"').to_string())
        .map_err(|error| error.to_string())
}

fn u64_to_i64(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "Transfer revision overflow".to_string())
}

fn recover_after_restart(job: &mut TransferJob) -> bool {
    if job.status.is_active()
        || (job.owner_id.is_none()
            && !job.status.is_terminal()
            && job.status != TransferStatus::Paused)
    {
        job.status = TransferStatus::Paused;
        job.error = Some("Interrupted transfer. Inspect the destination before resuming; publication may already have completed.".into());
        job.error_category = Some(if job.owner_id.is_none() {
            TransferErrorCategory::Account
        } else {
            TransferErrorCategory::Interrupted
        });
        job.retry_at = None;
        job.speed_bytes_per_sec = 0;
    } else {
        return false;
    }
    job.persistence_pending = false;
    job.revision = job.revision.saturating_add(1);
    job.updated_at = now_millis();
    true
}

/// Essential state becomes visible only after its complete SQLite transaction succeeds.
async fn commit_jobs(
    store: &TransferStore,
    jobs: &mut HashMap<String, TransferJob>,
    updated: &[TransferJob],
) -> Result<(), String> {
    store
        .upsert_many(updated)
        .await
        .map_err(|error| format!("PERSISTENCE_ERROR: Transfer changes were not saved: {error}"))?;
    for job in updated {
        jobs.insert(job.id.clone(), job.clone());
    }
    Ok(())
}

async fn commit_result(
    store: &TransferStore,
    jobs: &mut HashMap<String, TransferJob>,
    pending: &mut HashMap<String, TransferJob>,
    mut result: TransferJob,
) -> TransferJob {
    result.persistence_pending = false;
    if let Err(error) = commit_jobs(store, jobs, &[result.clone()]).await {
        pending.insert(result.id.clone(), result.clone());
        result.persistence_pending = true;
        result.error = Some(format!("{error}. The transfer result will be saved again; its data will not be transferred again."));
        result.error_category = Some(TransferErrorCategory::Persistence);
        jobs.insert(result.id.clone(), result.clone());
    } else {
        pending.remove(&result.id);
    }
    result
}

#[derive(Debug, Deserialize)]
struct ProgressPayload {
    id: String,
    percent: u8,
    uploaded_bytes: u64,
    total_bytes: u64,
    speed_bytes_per_sec: u64,
}

#[derive(Debug, Deserialize)]
struct RemoteProgressPayload {
    id: String,
    phase: TransferStatus,
    percent: u8,
    speed: u64,
    uploaded_bytes: u64,
    total_bytes: u64,
}

pub struct TransferEngine {
    app: AppHandle,
    store: TransferStore,
    jobs: RwLock<HashMap<String, TransferJob>>,
    startup_jobs: Mutex<Option<Vec<TransferJob>>>,
    active: AsyncMutex<HashMap<String, TransferDirection>>,
    mutation_lock: AsyncMutex<()>,
    pending_commits: AsyncMutex<HashMap<String, TransferJob>>,
    prompt_tokens: AsyncMutex<HashMap<String, u64>>,
    notify: Notify,
    max_uploads: AtomicUsize,
    max_downloads: AtomicUsize,
    shutting_down: AtomicBool,
}

impl TransferEngine {
    pub fn initialize(app: AppHandle) -> Result<Arc<Self>, String> {
        let database_path = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("transfers.db");
        let (store, loaded_jobs) = TransferStore::open(&database_path)?;
        let startup_jobs = loaded_jobs.clone();
        let mut jobs = HashMap::new();
        for job in loaded_jobs {
            jobs.insert(job.id.clone(), job);
        }

        Ok(Arc::new(Self {
            app,
            store,
            jobs: RwLock::new(jobs),
            startup_jobs: Mutex::new(Some(startup_jobs)),
            active: AsyncMutex::new(HashMap::new()),
            mutation_lock: AsyncMutex::new(()),
            pending_commits: AsyncMutex::new(HashMap::new()),
            prompt_tokens: AsyncMutex::new(HashMap::new()),
            notify: Notify::new(),
            max_uploads: AtomicUsize::new(6),
            max_downloads: AtomicUsize::new(6),
            shutting_down: AtomicBool::new(false),
        }))
    }

    pub fn start(self: &Arc<Self>) {
        self.install_progress_listeners();
        let engine = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if engine.shutting_down.load(Ordering::Acquire) {
                    break;
                }
                engine.schedule_once().await;
                tokio::select! {
                    _ = engine.notify.notified() => {},
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                }
            }
        });
        self.notify.notify_one();
    }

    pub fn startup_snapshot(&self) -> Vec<TransferJob> {
        self.startup_jobs
            .lock()
            .ok()
            .and_then(|mut jobs| jobs.take())
            .unwrap_or_default()
            .into_iter()
            .filter(|job| self.is_current_owner(job))
            .collect()
    }

    fn install_progress_listeners(self: &Arc<Self>) {
        let engine = self.clone();
        self.app.listen("upload-progress", move |event| {
            if let Ok(payload) = serde_json::from_str::<ProgressPayload>(event.payload()) {
                let engine = engine.clone();
                tauri::async_runtime::spawn(async move {
                    engine
                        .record_progress(
                            payload.id,
                            Some(TransferStatus::Uploading),
                            payload.percent,
                            payload.uploaded_bytes,
                            payload.total_bytes,
                            payload.speed_bytes_per_sec,
                        )
                        .await;
                });
            }
        });

        let engine = self.clone();
        self.app.listen("download-progress", move |event| {
            if let Ok(payload) = serde_json::from_str::<ProgressPayload>(event.payload()) {
                let engine = engine.clone();
                tauri::async_runtime::spawn(async move {
                    engine
                        .record_progress(
                            payload.id,
                            Some(TransferStatus::Downloading),
                            payload.percent,
                            payload.uploaded_bytes,
                            payload.total_bytes,
                            payload.speed_bytes_per_sec,
                        )
                        .await;
                });
            }
        });

        let engine = self.clone();
        self.app.listen("remote-upload-progress", move |event| {
            if let Ok(payload) = serde_json::from_str::<RemoteProgressPayload>(event.payload()) {
                let engine = engine.clone();
                tauri::async_runtime::spawn(async move {
                    engine
                        .record_progress(
                            payload.id,
                            Some(payload.phase),
                            payload.percent,
                            payload.uploaded_bytes,
                            payload.total_bytes,
                            payload.speed,
                        )
                        .await;
                });
            }
        });
    }

    async fn record_progress(
        &self,
        id: String,
        phase: Option<TransferStatus>,
        progress: u8,
        transferred_bytes: u64,
        total_bytes: u64,
        speed_bytes_per_sec: u64,
    ) {
        let _mutation = self.mutation_lock.lock().await;
        if !self.active.lock().await.contains_key(&id) {
            return;
        }
        let updated = {
            let mut jobs = self.jobs.write().await;
            let Some(job) = jobs.get_mut(&id) else {
                return;
            };
            if !job.status.is_active() {
                return;
            }
            if let Some(phase) = phase {
                job.status = phase;
            }
            job.progress = progress;
            job.transferred_bytes = transferred_bytes;
            job.total_bytes = total_bytes;
            job.speed_bytes_per_sec = speed_bytes_per_sec;
            job.revision = job.revision.saturating_add(1);
            job.updated_at = now_millis();
            job.clone()
        };
        self.persist_and_emit(updated).await;
    }

    fn account(&self, expected: Option<&str>) -> Result<AccountGuard, String> {
        AccountGuard::open(
            &self.app.path().app_data_dir().map_err(|e| e.to_string())?,
            expected,
        )
    }

    fn is_current_owner(&self, job: &TransferJob) -> bool {
        job.owner_id
            .as_deref()
            .is_some_and(|owner| self.account(Some(owner)).is_ok())
    }

    fn emit_job(&self, job: &TransferJob) {
        if self.is_current_owner(job) {
            let _ = self.app.emit("transfer-upserted", job);
        }
    }

    async fn schedule_once(self: &Arc<Self>) {
        if self.shutting_down.load(Ordering::Acquire) {
            return;
        }
        let _mutation = self.mutation_lock.lock().await;
        // Failed final checkpoints retry metadata only, never the external operation.
        let retries: Vec<_> = self
            .pending_commits
            .lock()
            .await
            .values()
            .cloned()
            .collect();
        for mut job in retries {
            job.revision = job.revision.saturating_add(1);
            job.persistence_pending = false;
            let mut jobs = self.jobs.write().await;
            if commit_jobs(&self.store, &mut jobs, &[job.clone()])
                .await
                .is_ok()
            {
                self.pending_commits.lock().await.remove(&job.id);
                drop(jobs);
                self.emit_job(&job);
                if job.status == TransferStatus::Completed {
                    self.cleanup_temporary_source(&job).await;
                }
            }
        }
        let Ok(account) = self.account(None) else {
            return;
        };
        let owner = account.owner.to_string();
        if self
            .app
            .state::<TelegramState>()
            .client
            .lock()
            .await
            .is_none()
        {
            return;
        }
        let mut active = self.active.lock().await;
        let upload_slots = self.max_uploads.load(Ordering::Relaxed).saturating_sub(
            active
                .values()
                .filter(|d| **d == TransferDirection::Upload)
                .count(),
        );
        let download_slots = self.max_downloads.load(Ordering::Relaxed).saturating_sub(
            active
                .values()
                .filter(|d| **d == TransferDirection::Download)
                .count(),
        );
        if upload_slots == 0 && download_slots == 0 {
            return;
        }
        let now = now_millis();
        let mut jobs = self.jobs.write().await;
        let eligible: HashMap<_, _> = jobs
            .values()
            .filter(|job| {
                job.owner_id.as_deref() == Some(owner.as_str())
                    && !job.persistence_pending
                    && (job.status == TransferStatus::Pending
                        || job.status == TransferStatus::WaitingForNetwork
                        || (job.status == TransferStatus::Cooldown
                            && job.retry_at.is_some_and(|at| at <= now)))
            })
            .map(|job| {
                let mut next = job.clone();
                next.status = TransferStatus::Pending;
                (next.id.clone(), next)
            })
            .collect();
        let selected: Vec<_> =
            select_pending_job_ids(&eligible, &active, upload_slots, download_slots)
                .into_iter()
                .filter_map(|id| eligible.get(&id).cloned())
                .map(|mut job| {
                    job.status = if job.kind == TransferKind::LocalUpload {
                        TransferStatus::Uploading
                    } else {
                        TransferStatus::Downloading
                    };
                    job.error = None;
                    job.error_category = None;
                    job.retry_at = None;
                    job.speed_bytes_per_sec = 0;
                    job.revision = job.revision.saturating_add(1);
                    job.updated_at = now;
                    job
                })
                .collect();
        if selected.is_empty() || account.validate().is_err() {
            return;
        }
        if let Err(error) = commit_jobs(&self.store, &mut jobs, &selected).await {
            // No work starts without its durable intent. Expose a reviewable storage error.
            for selected_job in &selected {
                if let Some(job) = jobs.get_mut(&selected_job.id) {
                    job.status = TransferStatus::Paused;
                    job.error = Some(error.clone());
                    job.error_category = Some(TransferErrorCategory::Persistence);
                    job.revision = job.revision.saturating_add(1);
                    self.emit_job(job);
                }
            }
            return;
        }
        drop(jobs);
        for job in &selected {
            active.insert(job.id.clone(), job.direction);
        }
        drop(active);
        for job in selected {
            self.emit_job(&job);
            let engine = self.clone();
            tauri::async_runtime::spawn(async move {
                engine.execute(job).await;
            });
        }
    }

    async fn execute(self: Arc<Self>, job: TransferJob) {
        let prompt_token = self.prompt_tokens.lock().await.remove(&job.id);
        let account = job
            .owner_id
            .as_deref()
            .ok_or_else(|| "ACCOUNT_REQUIRED: Review this legacy transfer first".to_string())
            .and_then(|owner| self.account(Some(owner)));
        let result = match account {
            Err(error) => Err(error),
            Ok(_) => match job.kind {
                TransferKind::LocalUpload => {
                    commands::cmd_upload_file(
                        job.path.clone().unwrap_or_default(),
                        job.folder_id,
                        Some(job.id.clone()),
                        job.protection_mode.clone(),
                        prompt_token,
                        job.protect_metadata,
                        job.video_upload_mode.clone(),
                        self.app.clone(),
                        self.app.state::<TelegramState>(),
                        self.app.state::<Arc<BandwidthManager>>(),
                        self.app.state::<Arc<NetworkConfig>>(),
                        self.app.state::<CryptoState>(),
                        self.app.state::<DbConnection>(),
                        job.owner_id.clone(),
                    )
                    .await
                }
                TransferKind::UrlUpload => {
                    commands::cmd_upload_from_url(
                        job.url.clone().unwrap_or_default(),
                        job.folder_id,
                        job.id.clone(),
                        job.protection_mode.clone(),
                        prompt_token,
                        job.protect_metadata,
                        job.video_upload_mode.clone(),
                        self.app.clone(),
                        self.app.state::<TelegramState>(),
                        self.app.state::<Arc<BandwidthManager>>(),
                        self.app.state::<Arc<NetworkConfig>>(),
                        self.app.state::<CryptoState>(),
                        self.app.state::<DbConnection>(),
                        job.owner_id.clone(),
                    )
                    .await
                }
                TransferKind::Download => {
                    commands::cmd_download_file(
                        DownloadFileRequest {
                            owner_id: job.owner_id.clone(),
                            message_id: job.message_id.unwrap_or_default(),
                            save_path: job.save_path.clone().unwrap_or_default(),
                            folder_id: job.folder_id,
                            transfer_id: Some(job.id.clone()),
                            prompt_token,
                            collision_policy: job.collision_policy,
                        },
                        self.app.clone(),
                        self.app.state::<TelegramState>(),
                        self.app.state::<Arc<BandwidthManager>>(),
                        self.app.state::<Arc<NetworkConfig>>(),
                        self.app.state::<CryptoState>(),
                        self.app.state::<DbConnection>(),
                    )
                    .await
                }
            },
        };

        let _mutation = self.mutation_lock.lock().await;
        self.active.lock().await.remove(&job.id);
        let updated = {
            let mut jobs = self.jobs.write().await;
            let Some(mut current) = jobs.get(&job.id).cloned() else {
                self.notify.notify_one();
                return;
            };
            match result {
                Ok(response) => {
                    // Successful publication wins over a late pause/cancel race.
                    current.status = TransferStatus::Completed;
                    current.progress = 100;
                    current.transferred_bytes = current.total_bytes.max(current.transferred_bytes);
                    current.speed_bytes_per_sec = 0;
                    current.error = None;
                    current.retry_at = None;
                    current.error_category = None;
                    record_success_response(&mut current, &response);
                }
                Err(_error)
                    if matches!(
                        current.status,
                        TransferStatus::Pending
                            | TransferStatus::Paused
                            | TransferStatus::Cancelled
                    ) =>
                {
                    current.speed_bytes_per_sec = 0;
                    if matches!(
                        current.status,
                        TransferStatus::Pending | TransferStatus::Paused
                    ) {
                        current.error = None;
                    }
                }
                Err(error) => apply_failure(&mut current, error, now_millis()),
            }
            current.revision = current.revision.saturating_add(1);
            current.updated_at = now_millis();
            let mut pending = self.pending_commits.lock().await;
            commit_result(&self.store, &mut jobs, &mut pending, current).await
        };
        self.emit_job(&updated);
        if !updated.persistence_pending && updated.status == TransferStatus::Completed {
            self.cleanup_temporary_source(&updated).await;
        }
        self.notify.notify_one();
    }

    async fn persist_and_emit(&self, job: TransferJob) {
        match self.store.upsert(&job).await {
            Ok(()) => {
                self.emit_job(&job);
            }
            Err(error) => log::error!("Could not persist transfer {}: {}", job.id, error),
        }
    }

    async fn enqueue_many(
        &self,
        requests: Vec<TransferEnqueueRequest>,
    ) -> Result<Vec<TransferJob>, String> {
        let _mutation = self.mutation_lock.lock().await;
        let account = self.account(None)?;
        for request in &requests {
            request.validate()?;
            if request
                .owner_id
                .as_deref()
                .is_some_and(|owner| owner != account.owner.to_string())
            {
                return Err("ACCOUNT_CHANGED: Transfer belongs to another account".into());
            }
        }
        let mut jobs = self.jobs.write().await;
        let mut position = jobs
            .values()
            .map(|job| job.queue_position)
            .max()
            .unwrap_or(0);
        let now = now_millis();
        let mut changed = Vec::with_capacity(requests.len());
        let mut tokens = Vec::new();
        let mut created_ids = std::collections::HashSet::new();
        for request in requests {
            if changed.iter().any(|job: &TransferJob| job.id == request.id) {
                return Err("Duplicate transfer ID in batch".into());
            }
            if let Some(existing) = jobs.get(&request.id) {
                if existing.owner_id != request.owner_id {
                    return Err("Transfer ID belongs to a different owner".into());
                }
                changed.push(existing.clone());
                continue;
            }
            created_ids.insert(request.id.clone());
            position = position.saturating_add(1);
            let requested = request.initial_status.unwrap_or(TransferStatus::Pending);
            let status = if request.owner_id.is_none() && !requested.is_terminal() {
                TransferStatus::Paused
            } else if requested.is_active() {
                TransferStatus::Pending
            } else {
                requested
            };
            if let Some(token) = request.prompt_token {
                if request.owner_id.is_some() {
                    tokens.push((request.id.clone(), token));
                }
            }
            changed.push(TransferJob {
                id: request.id,
                owner_id: request.owner_id,
                direction: request.direction,
                kind: request.kind,
                status,
                download_outcome: None,
                path: request.path,
                url: request.url,
                folder_id: request.folder_id,
                message_id: request.message_id,
                filename: request.filename,
                save_path: request.save_path,
                collision_policy: request.collision_policy,
                protection_mode: request.protection_mode,
                protect_metadata: request.protect_metadata,
                video_upload_mode: request.video_upload_mode,
                temp_zip_path: request.temp_zip_path,
                progress: 0,
                transferred_bytes: 0,
                total_bytes: request.total_bytes.unwrap_or(0),
                speed_bytes_per_sec: 0,
                error: None,
                error_category: None,
                persistence_pending: false,
                retry_at: None,
                queue_position: position,
                revision: 1,
                created_at: now,
                updated_at: now,
            });
        }
        let reserved_paths: Vec<PathBuf> = jobs
            .values()
            .filter(|job| {
                job.direction == TransferDirection::Download
                    && job.status != TransferStatus::Completed
            })
            .filter_map(|job| job.save_path.as_ref().map(PathBuf::from))
            .collect();
        let changed = tokio::task::spawn_blocking(move || {
            reserve_new_downloads(changed, &created_ids, &reserved_paths)
        })
        .await
        .map_err(|error| format!("Download reservation task failed: {error}"))??;
        account.validate()?;
        commit_jobs(&self.store, &mut jobs, &changed).await?;
        drop(jobs);
        self.prompt_tokens.lock().await.extend(tokens);
        for job in &changed {
            self.emit_job(job);
        }
        self.notify.notify_one();
        Ok(changed)
    }

    async fn enqueue(&self, request: TransferEnqueueRequest) -> Result<TransferJob, String> {
        self.enqueue_many(vec![request])
            .await?
            .pop()
            .ok_or_else(|| "No transfer enqueued".into())
    }

    async fn transition(
        &self,
        id: &str,
        action: TransferAction,
        expected: Option<&str>,
    ) -> Result<TransferJob, String> {
        let _mutation = self.mutation_lock.lock().await;
        let account = self.account(expected)?;
        let active = self.active.lock().await.contains_key(id);
        let mut jobs = self.jobs.write().await;
        let mut job = jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "Transfer was not found".to_string())?;
        if job.owner_id.as_deref() != Some(account.owner.to_string().as_str()) {
            return Err("ACCOUNT_CHANGED: Transfer is not owned by this account".into());
        }
        let pending_result = self.pending_commits.lock().await.get(id).cloned();
        if let Some(mut pending) = pending_result {
            pending.revision = job.revision.saturating_add(1);
            pending.persistence_pending = false;
            account.validate()?;
            commit_jobs(&self.store, &mut jobs, &[pending.clone()]).await?;
            self.pending_commits.lock().await.remove(id);
            self.emit_job(&pending);
            return Ok(pending);
        }
        let should_cancel =
            active && matches!(action, TransferAction::Pause | TransferAction::Cancel);
        match action {
            TransferAction::Pause if !job.status.is_terminal() => {
                job.status = TransferStatus::Paused
            }
            TransferAction::Cancel if !job.status.is_terminal() => {
                job.status = TransferStatus::Cancelled
            }
            TransferAction::Resume if job.status == TransferStatus::Paused => {
                job.status = TransferStatus::Pending
            }
            TransferAction::Retry
                if matches!(
                    job.status,
                    TransferStatus::Failed
                        | TransferStatus::Cancelled
                        | TransferStatus::WaitingForUnlock
                        | TransferStatus::WaitingForNetwork
                        | TransferStatus::Cooldown
                ) =>
            {
                job.status = TransferStatus::Pending;
                job.progress = 0;
                job.transferred_bytes = 0;
            }
            _ => return Ok(job),
        }
        job.error = None;
        job.error_category = None;
        job.retry_at = None;
        job.speed_bytes_per_sec = 0;
        job.revision = job.revision.saturating_add(1);
        job.updated_at = now_millis();
        account.validate()?;
        commit_jobs(&self.store, &mut jobs, &[job.clone()]).await?;
        drop(jobs);
        self.emit_job(&job);
        if should_cancel {
            let _ =
                commands::cmd_cancel_transfer(id.to_string(), self.app.state::<TelegramState>())
                    .await;
        }
        self.notify.notify_one();
        Ok(job)
    }

    async fn transition_all(
        &self,
        direction: TransferDirection,
        action: TransferAction,
        expected: Option<&str>,
    ) -> Result<Vec<TransferJob>, String> {
        let account = self.account(expected)?;
        let owner = account.owner.to_string();
        let ids: Vec<_> = self
            .jobs
            .read()
            .await
            .values()
            .filter(|job| {
                job.owner_id.as_deref() == Some(owner.as_str())
                    && job.direction == direction
                    && !job.status.is_terminal()
            })
            .map(|job| job.id.clone())
            .collect();
        let mut changed = Vec::new();
        for id in ids {
            changed.push(self.transition(&id, action, Some(&owner)).await?);
        }
        Ok(changed)
    }

    async fn clear_terminal(
        &self,
        direction: TransferDirection,
        include_failed_and_cancelled: bool,
        expected: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let _mutation = self.mutation_lock.lock().await;
        let account = self.account(expected)?;
        let owner = account.owner.to_string();
        let mut jobs = self.jobs.write().await;
        let ids: Vec<_> = jobs
            .values()
            .filter(|job| {
                job.owner_id.as_deref() == Some(owner.as_str())
                    && !job.persistence_pending
                    && job.direction == direction
                    && (job.status == TransferStatus::Completed
                        || (include_failed_and_cancelled
                            && matches!(
                                job.status,
                                TransferStatus::Failed | TransferStatus::Cancelled
                            )))
            })
            .map(|job| job.id.clone())
            .collect();
        account.validate()?;
        self.store.delete_many(&ids).await?;
        for id in &ids {
            jobs.remove(id);
            self.prompt_tokens.lock().await.remove(id);
            let _ = self.app.emit("transfer-removed", id);
        }
        Ok(ids)
    }

    pub async fn active_paths(&self) -> Vec<PathBuf> {
        let jobs = self.jobs.read().await;
        let mut paths = Vec::new();
        for job in jobs
            .values()
            .filter(|job| job.status != TransferStatus::Completed || job.persistence_pending)
        {
            paths.extend(
                [
                    job.path.as_ref(),
                    job.temp_zip_path.as_ref(),
                    job.save_path.as_ref(),
                ]
                .into_iter()
                .flatten()
                .map(PathBuf::from),
            );
            if job.kind == TransferKind::UrlUpload {
                paths.push(std::env::temp_dir().join(format!("tg_drive_{}.tmp", job.id)));
                paths.push(std::env::temp_dir().join(format!("tg_drive_encrypted_{}", job.id)));
            }
        }
        paths
    }

    pub async fn completed_downloads(&self, owner_id: &str) -> Result<Vec<TransferJob>, String> {
        let account = self.account(Some(owner_id))?;
        let jobs = self
            .jobs
            .read()
            .await
            .values()
            .filter(|job| {
                job.owner_id.as_deref() == Some(owner_id)
                    && job.direction == TransferDirection::Download
                    && job.status == TransferStatus::Completed
                    && job.download_outcome != Some(DownloadOutcome::Skipped)
                    && !job.persistence_pending
            })
            .cloned()
            .collect();
        account.validate()?;
        Ok(jobs)
    }

    async fn cleanup_temporary_source(&self, job: &TransferJob) {
        if let Some(path) = job.temp_zip_path.as_ref() {
            if let Err(error) = commands::cmd_delete_temp_zip(path.clone(), self.app.clone()).await
            {
                log::warn!(
                    "Could not clean transfer temporary source {}: {}",
                    job.id,
                    error
                );
            }
        }
    }

    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub async fn snapshot(&self) -> Vec<TransferJob> {
        let owner = self
            .account(None)
            .ok()
            .map(|account| account.owner.to_string());
        let mut jobs: Vec<_> = self
            .jobs
            .read()
            .await
            .values()
            .filter(|job| owner.is_some() && job.owner_id == owner)
            .cloned()
            .collect();
        jobs.sort_by_key(|job| (job.queue_position, job.created_at));
        jobs
    }

    pub async fn pause_all_directions(&self) -> Result<usize, String> {
        let mut changed = 0;
        for direction in [TransferDirection::Upload, TransferDirection::Download] {
            changed += self
                .transition_all(direction, TransferAction::Pause, None)
                .await?
                .into_iter()
                .filter(|job| job.status == TransferStatus::Paused)
                .count();
        }
        Ok(changed)
    }

    pub async fn resume_all_directions(&self) -> Result<usize, String> {
        let mut changed = 0;
        for direction in [TransferDirection::Upload, TransferDirection::Download] {
            changed += self
                .transition_all(direction, TransferAction::Resume, None)
                .await?
                .into_iter()
                .filter(|job| job.status == TransferStatus::Pending)
                .count();
        }
        Ok(changed)
    }
}

fn select_pending_job_ids(
    jobs: &HashMap<String, TransferJob>,
    active: &HashMap<String, TransferDirection>,
    upload_slots: usize,
    download_slots: usize,
) -> Vec<String> {
    let mut candidates: Vec<_> = jobs
        .values()
        .filter(|job| job.status == TransferStatus::Pending && !active.contains_key(&job.id))
        .map(|job| (job.queue_position, job.id.clone(), job.direction))
        .collect();
    candidates.sort_by_key(|candidate| candidate.0);
    let mut uploads = 0usize;
    let mut downloads = 0usize;
    candidates
        .into_iter()
        .filter_map(|(_, id, direction)| match direction {
            TransferDirection::Upload if uploads < upload_slots => {
                uploads += 1;
                Some(id)
            }
            TransferDirection::Download if downloads < download_slots => {
                downloads += 1;
                Some(id)
            }
            _ => None,
        })
        .collect()
}

#[derive(Clone, Copy)]
enum TransferAction {
    Pause,
    Cancel,
    Resume,
    Retry,
}

fn apply_failure(job: &mut TransferJob, error: String, now: i64) {
    job.speed_bytes_per_sec = 0;
    job.retry_at = None;
    job.error_category = Some(classify_failure(&error));
    if error.contains("VAULT_LOCKED") || error.contains("KEY_REQUIRED") {
        job.status = TransferStatus::WaitingForUnlock;
        job.error = Some(error);
        return;
    }
    if let Some(seconds) = flood_wait_seconds(&error) {
        job.status = TransferStatus::Cooldown;
        job.retry_at = Some(now.saturating_add(i64::from(seconds) * 1_000));
        job.error = Some(format!("Telegram cooling down ({seconds}s)"));
        return;
    }
    if error.contains("ACCOUNT_") {
        job.status = TransferStatus::Paused;
    } else if error.contains("Client not connected") {
        job.status = TransferStatus::WaitingForNetwork;
    } else if error.contains("Transfer cancelled") {
        job.status = TransferStatus::Cancelled;
    } else {
        job.status = TransferStatus::Failed;
    }
    job.error = Some(error);
}

fn classify_failure(error: &str) -> TransferErrorCategory {
    let lower = error.to_lowercase();
    if error.contains("ACCOUNT_") {
        TransferErrorCategory::Account
    } else if error.contains("VAULT_LOCKED") || error.contains("KEY_REQUIRED") {
        TransferErrorCategory::Unlock
    } else if flood_wait_seconds(error).is_some() {
        TransferErrorCategory::RateLimit
    } else if lower.contains("cancelled") {
        TransferErrorCategory::Cancelled
    } else if lower.contains("no such file") || lower.contains("not found") {
        TransferErrorCategory::SourceMissing
    } else if lower.contains("no space")
        || lower.contains("disk full")
        || lower.contains("permission denied")
    {
        TransferErrorCategory::Storage
    } else if lower.contains("integrity")
        || lower.contains("authentication failed")
        || lower.contains("verification")
    {
        TransferErrorCategory::Integrity
    } else if lower.contains("network")
        || lower.contains("connection")
        || lower.contains("timed out")
        || lower.contains("client not connected")
    {
        TransferErrorCategory::Network
    } else {
        TransferErrorCategory::Other
    }
}

pub(crate) async fn validate_client_account(
    account: &AccountGuard,
    client: &grammers_client::Client,
) -> Result<(), String> {
    account.validate_client(client).await
}

/// Capture the original scoped operation or durable queue owner. Its epoch is
/// checked again against the actual connected client and before publication.
pub async fn capture_job_account(app: &AppHandle, id: &str) -> Result<AccountGuard, String> {
    if let Some(account) = operation_account()? {
        return Ok(account);
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let expected = if let Some(engine) = app.try_state::<Arc<TransferEngine>>() {
        match engine.jobs.read().await.get(id) {
            Some(job) => Some(job.owner_id.clone().ok_or_else(|| {
                "ACCOUNT_REQUIRED: Review this legacy transfer first".to_string()
            })?),
            None => None,
        }
    } else {
        None
    };
    AccountGuard::open(&root, expected.as_deref())
}

pub async fn capture_operation_account(
    app: &AppHandle,
    id: &str,
    client: &grammers_client::Client,
) -> Result<AccountGuard, String> {
    let account = capture_job_account(app, id).await?;
    validate_client_account(&account, client).await?;
    Ok(account)
}

fn reserve_new_downloads(
    mut jobs: Vec<TransferJob>,
    created_ids: &std::collections::HashSet<String>,
    reserved_paths: &[PathBuf],
) -> Result<Vec<TransferJob>, String> {
    let mut reserved = reserved_paths
        .iter()
        .filter_map(|path| destination_key(path).ok())
        .collect();
    for job in &mut jobs {
        if job.direction != TransferDirection::Download
            || !created_ids.contains(&job.id)
            || job.status.is_terminal()
        {
            continue;
        }
        // Legacy imports may refer to unavailable removable drives. Preserve
        // their original paused metadata for review; never silently adopt them.
        if job.owner_id.is_none() {
            continue;
        }
        let path = Path::new(
            job.save_path
                .as_deref()
                .ok_or("Download destination is missing")?,
        );
        let reserved_path = reserve_destination(path, job.collision_policy, &mut reserved)?;
        job.filename = reserved_path
            .file_name()
            .ok_or("Download filename is missing")?
            .to_string_lossy()
            .into_owned();
        job.save_path = Some(reserved_path.to_string_lossy().into_owned());
    }
    Ok(jobs)
}

fn record_success_response(job: &mut TransferJob, response: &str) {
    if job.direction == TransferDirection::Upload {
        job.message_id = response.parse::<i32>().ok().or(job.message_id);
    } else if let Ok(publication) = serde_json::from_str::<DownloadPublication>(response) {
        job.download_outcome = Some(publication.outcome);
        job.filename = Path::new(&publication.save_path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| job.filename.clone());
        job.save_path = Some(publication.save_path);
        if publication.outcome == DownloadOutcome::Skipped {
            job.transferred_bytes = 0;
        }
    }
}

fn protected_activity_metadata(job: &TransferJob) -> bool {
    job.protection_mode
        .as_deref()
        .is_some_and(|mode| mode != "standard")
        || (job.protect_metadata == Some(true)
            && job.protection_mode.as_deref() != Some("standard"))
        || matches!(
            job.status,
            TransferStatus::WaitingForUnlock
                | TransferStatus::Encrypting
                | TransferStatus::Decrypting
        )
}

fn activity_projection(job: &TransferJob) -> TransferJob {
    let mut projected = job.clone();
    if protected_activity_metadata(job) {
        // The queue keeps its retry inputs privately. Activity receives no
        // protected names, source URLs, paths, sizes, or raw failure payloads.
        projected.filename.clear();
        projected.path = None;
        projected.url = None;
        projected.save_path = None;
        projected.temp_zip_path = None;
        projected.error = None;
        projected.total_bytes = 0;
        projected.transferred_bytes = 0;
        projected.speed_bytes_per_sec = 0;
    }
    projected
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyTransfer {
    id: String,
    filename: String,
    direction: TransferDirection,
    kind: TransferKind,
    status: TransferStatus,
    created_at: i64,
    total_bytes: u64,
    can_adopt: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferActivitySnapshot {
    owner_id: String,
    jobs: Vec<TransferJob>,
    legacy: Vec<LegacyTransfer>,
}

fn adopt_legacy(job: &TransferJob, owner: &str) -> Result<TransferJob, String> {
    if job.owner_id.is_some() {
        return Err("Only unassigned transfers can be reviewed".into());
    }
    if job.direction == TransferDirection::Download && job.status != TransferStatus::Completed {
        return Err(
            "Requeue unfinished legacy downloads from the current account's file list".into(),
        );
    }
    let mut adopted = job.clone();
    adopted.owner_id = Some(owner.into());
    if !adopted.status.is_terminal() || adopted.status != TransferStatus::Completed {
        adopted.status = TransferStatus::Paused;
    }
    adopted.error = None;
    adopted.error_category = None;
    adopted.retry_at = None;
    adopted.speed_bytes_per_sec = 0;
    adopted.revision = adopted.revision.saturating_add(1);
    adopted.updated_at = now_millis();
    Ok(adopted)
}

#[tauri::command]
pub async fn cmd_transfer_activity(
    owner_id: String,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<TransferActivitySnapshot, String> {
    let account = engine.account(Some(&owner_id))?;
    let records = engine.jobs.read().await;
    let mut jobs: Vec<_> = records
        .values()
        .filter(|job| job.owner_id.as_deref() == Some(&owner_id))
        .map(activity_projection)
        .collect();
    jobs.sort_by_key(|job| std::cmp::Reverse((job.updated_at, job.queue_position)));
    jobs.truncate(500);
    let legacy = records
        .values()
        .filter(|job| job.owner_id.is_none())
        .map(|job| LegacyTransfer {
            id: job.id.clone(),
            filename: if protected_activity_metadata(job) {
                String::new()
            } else {
                job.filename.clone()
            },
            direction: job.direction,
            kind: job.kind,
            status: job.status,
            created_at: job.created_at,
            total_bytes: if protected_activity_metadata(job) {
                0
            } else {
                job.total_bytes
            },
            can_adopt: job.direction == TransferDirection::Upload
                || job.status == TransferStatus::Completed,
        })
        .collect();
    account.validate()?;
    Ok(TransferActivitySnapshot {
        owner_id,
        jobs,
        legacy,
    })
}

#[tauri::command]
pub async fn cmd_transfer_adopt_legacy(
    owner_id: String,
    ids: Vec<String>,
    confirmed_ownership: bool,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<(), String> {
    if !confirmed_ownership {
        return Err("Confirm that these transfers belong to the current account".into());
    }
    let _mutation = engine.mutation_lock.lock().await;
    let account = engine.account(Some(&owner_id))?;
    let mut jobs = engine.jobs.write().await;
    let updates = ids
        .iter()
        .map(|id| {
            jobs.get(id)
                .ok_or_else(|| "Legacy transfer was not found".into())
                .and_then(|job| adopt_legacy(job, &owner_id))
        })
        .collect::<Result<Vec<_>, String>>()?;
    account.validate()?;
    commit_jobs(&engine.store, &mut jobs, &updates).await?;
    for job in &updates {
        engine.emit_job(job);
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_transfer_discard_legacy(
    owner_id: String,
    ids: Vec<String>,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<(), String> {
    let _mutation = engine.mutation_lock.lock().await;
    let account = engine.account(Some(&owner_id))?;
    let mut jobs = engine.jobs.write().await;
    if ids
        .iter()
        .any(|id| jobs.get(id).is_none_or(|job| job.owner_id.is_some()))
    {
        return Err("Only unassigned queue records can be discarded".into());
    }
    account.validate()?;
    engine.store.delete_many(&ids).await?;
    for id in ids {
        jobs.remove(&id);
        engine.prompt_tokens.lock().await.remove(&id);
    }
    // Source files and download destinations are never deleted by record removal.
    Ok(())
}

fn flood_wait_seconds(error: &str) -> Option<u32> {
    let marker = "FLOOD_WAIT_";
    let start = error.to_ascii_uppercase().find(marker)? + marker.len();
    let digits: String = error[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits
        .parse::<u32>()
        .ok()
        .map(|seconds| seconds.clamp(1, 300))
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub async fn cmd_transfer_enqueue(
    request: TransferEnqueueRequest,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<TransferJob, String> {
    engine.enqueue(request).await
}

#[tauri::command]
pub async fn cmd_transfer_enqueue_many(
    requests: Vec<TransferEnqueueRequest>,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    engine.enqueue_many(requests).await
}

#[tauri::command]
pub async fn cmd_transfer_list(
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    Ok(engine.snapshot().await)
}

#[tauri::command]
pub fn cmd_transfer_set_limits(
    max_uploads: usize,
    max_downloads: usize,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<(), String> {
    engine
        .max_uploads
        .store(max_uploads.clamp(1, 32), Ordering::Relaxed);
    engine
        .max_downloads
        .store(max_downloads.clamp(1, 32), Ordering::Relaxed);
    engine.notify.notify_one();
    Ok(())
}

macro_rules! item_action_command {
    ($name:ident, $action:expr) => {
        #[tauri::command]
        pub async fn $name(
            id: String,
            owner_id: Option<String>,
            engine: State<'_, Arc<TransferEngine>>,
        ) -> Result<TransferJob, String> {
            engine.transition(&id, $action, owner_id.as_deref()).await
        }
    };
}

item_action_command!(cmd_transfer_pause, TransferAction::Pause);
item_action_command!(cmd_transfer_resume, TransferAction::Resume);
item_action_command!(cmd_transfer_cancel, TransferAction::Cancel);
item_action_command!(cmd_transfer_retry, TransferAction::Retry);

#[tauri::command]
pub async fn cmd_transfer_supply_prompt_token(
    id: String,
    prompt_token: u64,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<(), String> {
    let account = engine.account(None)?;
    let jobs = engine.jobs.read().await;
    if jobs
        .get(&id)
        .is_none_or(|job| job.owner_id.as_deref() != Some(account.owner.to_string().as_str()))
    {
        return Err("ACCOUNT_CHANGED: Transfer is not owned by this account".into());
    }
    account.validate()?;
    drop(jobs);
    engine.prompt_tokens.lock().await.insert(id, prompt_token);
    Ok(())
}

#[tauri::command]
pub async fn cmd_transfer_pause_all(
    direction: TransferDirection,
    owner_id: Option<String>,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    engine
        .transition_all(direction, TransferAction::Pause, owner_id.as_deref())
        .await
}

#[tauri::command]
pub async fn cmd_transfer_resume_all(
    direction: TransferDirection,
    owner_id: Option<String>,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    engine
        .transition_all(direction, TransferAction::Resume, owner_id.as_deref())
        .await
}

#[tauri::command]
pub async fn cmd_transfer_cancel_all(
    direction: TransferDirection,
    owner_id: Option<String>,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    engine
        .transition_all(direction, TransferAction::Cancel, owner_id.as_deref())
        .await
}

#[tauri::command]
pub async fn cmd_transfer_clear_terminal(
    direction: TransferDirection,
    owner_id: Option<String>,
    include_failed_and_cancelled: bool,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<String>, String> {
    engine
        .clear_terminal(direction, include_failed_and_cancelled, owner_id.as_deref())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn request(id: &str) -> TransferEnqueueRequest {
        TransferEnqueueRequest {
            id: id.to_string(),
            owner_id: Some("100".into()),
            direction: TransferDirection::Upload,
            kind: TransferKind::LocalUpload,
            path: Some("/tmp/file.txt".to_string()),
            url: None,
            folder_id: None,
            message_id: None,
            filename: "file.txt".to_string(),
            save_path: None,
            collision_policy: DownloadCollisionPolicy::KeepBoth,
            protection_mode: Some("standard".to_string()),
            prompt_token: None,
            protect_metadata: Some(true),
            video_upload_mode: Some("file".to_string()),
            temp_zip_path: None,
            total_bytes: Some(10),
            initial_status: None,
        }
    }

    fn job(id: &str, revision: u64) -> TransferJob {
        let request = request(id);
        TransferJob {
            id: request.id,
            owner_id: request.owner_id,
            direction: request.direction,
            kind: request.kind,
            status: TransferStatus::Pending,
            download_outcome: None,
            path: request.path,
            url: None,
            folder_id: None,
            message_id: None,
            filename: request.filename,
            save_path: None,
            collision_policy: DownloadCollisionPolicy::KeepBoth,
            protection_mode: request.protection_mode,
            protect_metadata: request.protect_metadata,
            video_upload_mode: request.video_upload_mode,
            temp_zip_path: None,
            progress: 0,
            transferred_bytes: 0,
            total_bytes: 10,
            speed_bytes_per_sec: 0,
            error: None,
            error_category: None,
            persistence_pending: false,
            retry_at: None,
            queue_position: 1,
            revision,
            created_at: 1,
            updated_at: i64::try_from(revision).unwrap(),
        }
    }

    fn test_store(name: &str) -> (TransferStore, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "telegram-drive-transfer-{name}-{}-{}.db",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        (TransferStore::open(&path).unwrap().0, path)
    }

    async fn execute_test_sql(store: &TransferStore, sql: &str) {
        let sql = sql.to_string();
        crate::db::with_connection(store.connection.clone(), move |connection| {
            connection.execute(sql.as_str()).map_err(|e| e.to_string())
        })
        .await
        .unwrap();
    }

    async fn stored_jobs(store: &TransferStore) -> Vec<TransferJob> {
        crate::db::with_connection(store.connection.clone(), TransferStore::load_all_from)
            .await
            .unwrap()
    }

    #[test]
    fn rejects_incomplete_or_mismatched_jobs() {
        let mut invalid = request("upload");
        invalid.path = None;
        assert!(invalid.validate().is_err());
        let mut mismatch = request("mismatch");
        mismatch.direction = TransferDirection::Download;
        assert!(mismatch.validate().is_err());
    }

    #[tokio::test]
    async fn store_survives_reopen() {
        let (store, path) = test_store("reopen");
        store.upsert(&job("one", 1)).await.unwrap();
        drop(store);
        let (_, loaded) = TransferStore::open(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn stale_revision_cannot_overwrite_newer_state() {
        let (store, path) = test_store("revision");
        let mut newer = job("one", 2);
        newer.status = TransferStatus::Completed;
        store.upsert(&newer).await.unwrap();
        store.upsert(&job("one", 1)).await.unwrap();
        drop(store);
        let (_, loaded) = TransferStore::open(&path).unwrap();
        assert_eq!(loaded[0].status, TransferStatus::Completed);
        assert_eq!(loaded[0].revision, 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn classifies_unlock_and_flood_wait_failures() {
        let mut transfer = job("one", 1);
        apply_failure(
            &mut transfer,
            "[KEY_REQUIRED] passphrase".to_string(),
            1_000,
        );
        assert_eq!(transfer.status, TransferStatus::WaitingForUnlock);
        apply_failure(&mut transfer, "RPC FLOOD_WAIT_17".to_string(), 1_000);
        assert_eq!(transfer.status, TransferStatus::Cooldown);
        assert_eq!(transfer.retry_at, Some(18_000));
    }

    #[test]
    fn scheduler_is_fifo_and_enforces_directional_limits() {
        let mut jobs = HashMap::new();
        let mut upload_one = job("upload-one", 1);
        upload_one.queue_position = 1;
        let mut download_one = job("download-one", 1);
        download_one.direction = TransferDirection::Download;
        download_one.kind = TransferKind::Download;
        download_one.queue_position = 2;
        let mut upload_two = job("upload-two", 1);
        upload_two.queue_position = 3;
        let mut paused = job("paused", 1);
        paused.queue_position = 0;
        paused.status = TransferStatus::Paused;
        for transfer in [upload_one, download_one, upload_two, paused] {
            jobs.insert(transfer.id.clone(), transfer);
        }

        let selected = select_pending_job_ids(&jobs, &HashMap::new(), 1, 1);
        assert_eq!(selected, vec!["upload-one", "download-one"]);

        let active = HashMap::from([("upload-one".to_string(), TransferDirection::Upload)]);
        let selected = select_pending_job_ids(&jobs, &active, 1, 0);
        assert_eq!(selected, vec!["upload-two"]);
    }

    #[test]
    fn restart_recovery_preserves_pauses_and_requires_new_secret_handles() {
        let mut running = job("running", 4);
        running.status = TransferStatus::Uploading;
        assert!(recover_after_restart(&mut running));
        assert_eq!(running.status, TransferStatus::Paused);
        assert_eq!(running.revision, 5);

        let mut protected = job("protected", 7);
        protected.status = TransferStatus::Encrypting;
        protected.protection_mode = Some("passphrase".to_string());
        assert!(recover_after_restart(&mut protected));
        assert_eq!(protected.status, TransferStatus::Paused);

        let mut paused = job("paused", 2);
        paused.status = TransferStatus::Paused;
        assert!(!recover_after_restart(&mut paused));
        assert_eq!(paused.status, TransferStatus::Paused);
        assert_eq!(paused.revision, 2);
    }
    #[tokio::test]
    async fn failed_essential_commit_never_acknowledges_or_schedules_memory() {
        let (store, _) = test_store("disk-failure");
        let mut memory = HashMap::new();
        execute_test_sql(&store, "PRAGMA query_only = ON").await;
        assert!(commit_jobs(&store, &mut memory, &[job("uncommitted", 1)])
            .await
            .is_err());
        assert!(memory.is_empty());
        assert!(select_pending_job_ids(&memory, &HashMap::new(), 1, 1).is_empty());
        execute_test_sql(&store, "PRAGMA query_only = OFF").await;
        commit_jobs(&store, &mut memory, &[job("uncommitted", 1)])
            .await
            .unwrap();
        let mut active = memory["uncommitted"].clone();
        active.status = TransferStatus::Uploading;
        active.revision = 2;
        execute_test_sql(&store, "PRAGMA query_only = ON").await;
        assert!(commit_jobs(&store, &mut memory, &[active]).await.is_err());
        assert_eq!(memory["uncommitted"].status, TransferStatus::Pending);
    }

    #[tokio::test]
    async fn batch_failure_rolls_back_every_record_and_memory() {
        let (store, _) = test_store("atomic-batch");
        execute_test_sql(&store, "CREATE TRIGGER reject_second BEFORE INSERT ON transfer_jobs WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'disk failure'); END").await;
        let mut memory = HashMap::new();
        assert!(
            commit_jobs(&store, &mut memory, &[job("first", 1), job("second", 1)])
                .await
                .is_err()
        );
        assert!(memory.is_empty());
        assert!(stored_jobs(&store).await.is_empty());
    }

    #[tokio::test]
    async fn removed_records_cannot_be_resurrected_by_late_progress() {
        let (store, _) = test_store("tombstone");
        store.upsert(&job("gone", 1)).await.unwrap();
        store.delete("gone").await.unwrap();
        assert!(store.upsert(&job("gone", 900)).await.is_err());
        assert!(stored_jobs(&store).await.is_empty());
    }

    #[test]
    fn legacy_adoption_is_explicit_paused_and_rejects_account_relative_downloads() {
        let mut legacy = job("legacy", 1);
        legacy.owner_id = None;
        assert!(recover_after_restart(&mut legacy));
        assert_eq!(legacy.status, TransferStatus::Paused);
        let adopted = adopt_legacy(&legacy, "200").unwrap();
        assert_eq!(adopted.owner_id.as_deref(), Some("200"));
        assert_eq!(adopted.status, TransferStatus::Paused);
        assert_eq!(adopted.path, legacy.path);
        legacy.direction = TransferDirection::Download;
        legacy.kind = TransferKind::Download;
        assert!(adopt_legacy(&legacy, "200").is_err());
        assert!(adopt_legacy(&adopted, "300").is_err());
    }

    #[tokio::test]
    async fn completion_save_failure_preserves_result_and_restart_requires_review() {
        let (store, path) = test_store("completion-checkpoint");
        let mut initial = job("published", 1);
        initial.status = TransferStatus::Uploading;
        let mut memory = HashMap::new();
        let mut pending = HashMap::new();
        commit_jobs(&store, &mut memory, &[initial]).await.unwrap();
        let mut result = memory["published"].clone();
        result.status = TransferStatus::Completed;
        result.message_id = Some(42);
        result.revision = 2;
        execute_test_sql(&store, "PRAGMA query_only = ON").await;
        let visible = commit_result(&store, &mut memory, &mut pending, result).await;
        assert_eq!(visible.status, TransferStatus::Completed);
        assert!(visible.persistence_pending);
        assert_eq!(pending["published"].message_id, Some(42));
        assert!(select_pending_job_ids(&memory, &HashMap::new(), 1, 1).is_empty());
        let (_, recovered) = TransferStore::open(&path).unwrap();
        assert_eq!(recovered[0].status, TransferStatus::Paused);
        assert_eq!(
            recovered[0].error_category,
            Some(TransferErrorCategory::Interrupted)
        );
        execute_test_sql(&store, "PRAGMA query_only = OFF").await;
        let mut retry = pending["published"].clone();
        retry.revision = 3;
        let saved = commit_result(&store, &mut memory, &mut pending, retry).await;
        assert!(!saved.persistence_pending);
        assert!(pending.is_empty());
        let (_, durable) = TransferStore::open(&path).unwrap();
        assert_eq!(durable[0].status, TransferStatus::Completed);
        assert_eq!(durable[0].message_id, Some(42));
    }

    #[tokio::test]
    async fn record_removal_preserves_external_download_and_failed_source() {
        let (store, _) = test_store("preserve-files");
        let file =
            std::env::temp_dir().join(format!("external-transfer-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&file, "user-owned contents").unwrap();
        let mut record = job("record", 1);
        record.path = Some(file.to_string_lossy().into());
        record.save_path = record.path.clone();
        store.upsert(&record).await.unwrap();
        store.delete(&record.id).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "user-owned contents"
        );
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn activity_projection_hides_protected_metadata_without_losing_retry_identity() {
        let mut source = job("opaque-retry-id", 4);
        source.protection_mode = Some("vault_and_passphrase".into());
        source.filename = "private-title.pdf".into();
        source.path = Some("/private/source.pdf".into());
        source.url = Some("https://private.example/file?secret=1".into());
        source.save_path = Some("/private/destination.pdf".into());
        source.temp_zip_path = Some("/private/generated.zip".into());
        source.error = Some("secret failure details".into());
        let projected = activity_projection(&source);
        let serialized = serde_json::to_string(&projected).unwrap();
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("secret"));
        assert_eq!(projected.id, source.id);
        assert_eq!(projected.owner_id, source.owner_id);
        assert_eq!(projected.protection_mode, source.protection_mode);
        assert_eq!(projected.total_bytes, 0);
        assert_eq!(source.filename, "private-title.pdf");
        source.protection_mode = Some("standard".into());
        source.protect_metadata = Some(true);
        assert_eq!(activity_projection(&source).filename, source.filename);
        source.status = TransferStatus::WaitingForUnlock;
        assert!(activity_projection(&source).filename.is_empty());
    }
    #[tokio::test]
    async fn download_policy_and_actual_publication_survive_failed_save_and_restart() {
        let (store, path) = test_store("download-publication");
        let mut initial = job("download", 1);
        initial.kind = TransferKind::Download;
        initial.direction = TransferDirection::Download;
        initial.status = TransferStatus::Downloading;
        initial.collision_policy = DownloadCollisionPolicy::Skip;
        initial.save_path = Some("/tmp/original.txt".into());
        let mut memory = HashMap::new();
        let mut pending = HashMap::new();
        commit_jobs(&store, &mut memory, &[initial]).await.unwrap();
        let mut result = memory["download"].clone();
        result.status = TransferStatus::Completed;
        result.revision = 2;
        record_success_response(
            &mut result,
            &DownloadPublication {
                outcome: DownloadOutcome::Skipped,
                save_path: "/tmp/actual.txt".into(),
            }
            .response()
            .unwrap(),
        );
        execute_test_sql(&store, "PRAGMA query_only = ON").await;
        let visible = commit_result(&store, &mut memory, &mut pending, result).await;
        assert!(visible.persistence_pending);
        assert_eq!(visible.download_outcome, Some(DownloadOutcome::Skipped));
        assert_eq!(
            pending["download"].save_path.as_deref(),
            Some("/tmp/actual.txt")
        );
        assert!(select_pending_job_ids(&memory, &HashMap::new(), 1, 1).is_empty());
        let (_, recovered) = TransferStore::open(&path).unwrap();
        assert_eq!(recovered[0].status, TransferStatus::Paused);
        assert_eq!(recovered[0].collision_policy, DownloadCollisionPolicy::Skip);
        execute_test_sql(&store, "PRAGMA query_only = OFF").await;
        let mut retry = pending["download"].clone();
        retry.revision = 3;
        commit_result(&store, &mut memory, &mut pending, retry).await;
        let (_, durable) = TransferStore::open(&path).unwrap();
        assert_eq!(durable[0].save_path.as_deref(), Some("/tmp/actual.txt"));
        assert_eq!(durable[0].filename, "actual.txt");
        assert_eq!(durable[0].download_outcome, Some(DownloadOutcome::Skipped));
        assert_eq!(durable[0].owner_id, memory["download"].owner_id);
    }

    #[test]
    fn batch_reservations_cover_pending_jobs_and_unowned_imports_remain_unchanged() {
        let directory =
            std::env::temp_dir().join(format!("download-reservations-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let destination = directory.join("sanitized.txt");
        let mut a = job("a", 1);
        a.kind = TransferKind::Download;
        a.direction = TransferDirection::Download;
        a.save_path = Some(destination.to_string_lossy().into_owned());
        let mut b = a.clone();
        b.id = "b".into();
        let mut legacy = a.clone();
        legacy.id = "legacy".into();
        legacy.owner_id = None;
        legacy.status = TransferStatus::Paused;
        let created = ["a".into(), "b".into(), "legacy".into()]
            .into_iter()
            .collect();
        let jobs = reserve_new_downloads(
            vec![a, b, legacy],
            &created,
            std::slice::from_ref(&destination),
        )
        .unwrap();
        assert!(jobs[0]
            .save_path
            .as_deref()
            .unwrap()
            .ends_with("sanitized (1).txt"));
        assert!(jobs[1]
            .save_path
            .as_deref()
            .unwrap()
            .ends_with("sanitized (2).txt"));
        assert_eq!(
            jobs[2].save_path.as_deref(),
            Some(destination.to_str().unwrap())
        );
        assert!(jobs[2].owner_id.is_none());
        assert_eq!(jobs[2].status, TransferStatus::Paused);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        std::fs::remove_dir(directory).unwrap();
    }
}
