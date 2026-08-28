//! Durable, backend-owned desktop transfer scheduling.
//!
//! Transfer metadata is stored in a dedicated SQLite database. Credential
//! handles are intentionally memory-only and are never serialized or emitted.

use crate::bandwidth::BandwidthManager;
use crate::commands::{self, fs::DownloadFileRequest, TelegramState};
use crate::crypto::state::CryptoState;
use crate::db::DbConnection;
use crate::vpn_optimizer::NetworkConfig;
use serde::{Deserialize, Serialize};
use sqlite::State as SqliteState;
use std::collections::HashMap;
use std::path::Path;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
    pub id: String,
    pub direction: TransferDirection,
    pub kind: TransferKind,
    pub status: TransferStatus,
    pub path: Option<String>,
    pub url: Option<String>,
    pub folder_id: Option<i64>,
    pub message_id: Option<i32>,
    pub filename: String,
    pub save_path: Option<String>,
    pub protection_mode: Option<String>,
    pub protect_metadata: Option<bool>,
    pub video_upload_mode: Option<String>,
    pub temp_zip_path: Option<String>,
    pub progress: u8,
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub error: Option<String>,
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
    pub direction: TransferDirection,
    pub kind: TransferKind,
    pub path: Option<String>,
    pub url: Option<String>,
    pub folder_id: Option<i64>,
    pub message_id: Option<i32>,
    pub filename: String,
    pub save_path: Option<String>,
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

    async fn delete(&self, id: &str) -> Result<(), String> {
        let connection = self.connection.clone();
        let id = id.to_string();
        crate::db::with_connection(connection, move |connection| {
            let mut statement = connection
                .prepare("DELETE FROM transfer_jobs WHERE id = ?")
                .map_err(|error| error.to_string())?;
            statement
                .bind((1, id.as_str()))
                .map_err(|error| error.to_string())?;
            statement.next().map_err(|error| error.to_string())?;
            Ok(())
        })
        .await
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
    if job.status.is_active() {
        job.status = if matches!(
            job.protection_mode.as_deref(),
            Some("passphrase" | "vault_and_passphrase")
        ) && job.direction == TransferDirection::Upload
        {
            TransferStatus::WaitingForUnlock
        } else {
            TransferStatus::Pending
        };
        job.error = Some("Recovered after the application stopped".to_string());
    } else if job.status == TransferStatus::Cooldown
        && job
            .retry_at
            .is_some_and(|retry_at| retry_at <= now_millis())
    {
        job.status = TransferStatus::Pending;
        job.retry_at = None;
        job.error = None;
    } else {
        return false;
    }
    job.revision = job.revision.saturating_add(1);
    job.updated_at = now_millis();
    true
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

    async fn schedule_once(self: &Arc<Self>) {
        if self.shutting_down.load(Ordering::Acquire) {
            return;
        }
        let connected = self
            .app
            .state::<TelegramState>()
            .client
            .lock()
            .await
            .is_some();
        if !connected {
            return;
        }

        let recovered = {
            let mut jobs = self.jobs.write().await;
            let now = now_millis();
            jobs.values_mut()
                .filter(|job| {
                    job.status == TransferStatus::WaitingForNetwork
                        || (job.status == TransferStatus::Cooldown
                            && job.retry_at.is_some_and(|retry_at| retry_at <= now))
                })
                .map(|job| {
                    job.status = TransferStatus::Pending;
                    job.error = None;
                    job.retry_at = None;
                    job.revision = job.revision.saturating_add(1);
                    job.updated_at = now;
                    job.clone()
                })
                .collect::<Vec<_>>()
        };
        for job in recovered {
            self.persist_and_emit(job).await;
        }

        let mut active = self.active.lock().await;
        let active_uploads = active
            .values()
            .filter(|direction| **direction == TransferDirection::Upload)
            .count();
        let active_downloads = active
            .values()
            .filter(|direction| **direction == TransferDirection::Download)
            .count();
        let upload_slots = self
            .max_uploads
            .load(Ordering::Relaxed)
            .saturating_sub(active_uploads);
        let download_slots = self
            .max_downloads
            .load(Ordering::Relaxed)
            .saturating_sub(active_downloads);
        if upload_slots == 0 && download_slots == 0 {
            return;
        }

        let mut selected = Vec::new();
        {
            let mut jobs = self.jobs.write().await;
            for id in select_pending_job_ids(&jobs, &active, upload_slots, download_slots) {
                let Some(job) = jobs.get_mut(&id) else {
                    continue;
                };
                job.status = match job.kind {
                    TransferKind::LocalUpload => TransferStatus::Uploading,
                    TransferKind::UrlUpload => TransferStatus::Downloading,
                    TransferKind::Download => TransferStatus::Downloading,
                };
                job.error = None;
                job.speed_bytes_per_sec = 0;
                job.revision = job.revision.saturating_add(1);
                job.updated_at = now_millis();
                active.insert(job.id.clone(), job.direction);
                selected.push(job.clone());
            }
        }
        drop(active);

        for job in selected {
            self.persist_and_emit(job.clone()).await;
            let engine = self.clone();
            tauri::async_runtime::spawn(async move {
                engine.execute(job).await;
            });
        }
    }

    async fn execute(self: Arc<Self>, job: TransferJob) {
        let prompt_token = self.prompt_tokens.lock().await.remove(&job.id);
        let result = match job.kind {
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
                )
                .await
            }
            TransferKind::Download => {
                commands::cmd_download_file(
                    DownloadFileRequest {
                        message_id: job.message_id.unwrap_or_default(),
                        save_path: job.save_path.clone().unwrap_or_default(),
                        folder_id: job.folder_id,
                        transfer_id: Some(job.id.clone()),
                        prompt_token,
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
        };

        self.active.lock().await.remove(&job.id);
        let updated = {
            let mut jobs = self.jobs.write().await;
            let Some(current) = jobs.get_mut(&job.id) else {
                self.notify.notify_one();
                return;
            };
            match result {
                Ok(_) => {
                    // Successful publication wins over a late pause/cancel race.
                    current.status = TransferStatus::Completed;
                    current.progress = 100;
                    current.transferred_bytes = current.total_bytes.max(current.transferred_bytes);
                    current.speed_bytes_per_sec = 0;
                    current.error = None;
                    current.retry_at = None;
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
                Err(error) => apply_failure(current, error, now_millis()),
            }
            current.revision = current.revision.saturating_add(1);
            current.updated_at = now_millis();
            current.clone()
        };
        self.persist_and_emit(updated.clone()).await;
        if matches!(
            updated.status,
            TransferStatus::Completed | TransferStatus::Cancelled
        ) {
            self.cleanup_temporary_source(&updated).await;
        }
        self.notify.notify_one();
    }

    async fn persist_and_emit(&self, job: TransferJob) {
        match self.store.upsert(&job).await {
            Ok(()) => {
                let _ = self.app.emit("transfer-upserted", &job);
            }
            Err(error) => log::error!("Could not persist transfer {}: {}", job.id, error),
        }
    }

    async fn enqueue(&self, request: TransferEnqueueRequest) -> Result<TransferJob, String> {
        request.validate()?;
        if let Some(token) = request.prompt_token {
            self.prompt_tokens
                .lock()
                .await
                .insert(request.id.clone(), token);
        }
        let now = now_millis();
        let job = {
            let mut jobs = self.jobs.write().await;
            if let Some(existing) = jobs.get(&request.id) {
                return Ok(existing.clone());
            }
            let queue_position = jobs
                .values()
                .map(|job| job.queue_position)
                .max()
                .unwrap_or(0)
                .saturating_add(1);
            let requested_status = request.initial_status.unwrap_or(TransferStatus::Pending);
            let status = if requested_status.is_active() {
                TransferStatus::Pending
            } else {
                requested_status
            };
            let job = TransferJob {
                id: request.id,
                direction: request.direction,
                kind: request.kind,
                status,
                path: request.path,
                url: request.url,
                folder_id: request.folder_id,
                message_id: request.message_id,
                filename: request.filename,
                save_path: request.save_path,
                protection_mode: request.protection_mode,
                protect_metadata: request.protect_metadata,
                video_upload_mode: request.video_upload_mode,
                temp_zip_path: request.temp_zip_path,
                progress: 0,
                transferred_bytes: 0,
                total_bytes: request.total_bytes.unwrap_or(0),
                speed_bytes_per_sec: 0,
                error: None,
                retry_at: None,
                queue_position,
                revision: 1,
                created_at: now,
                updated_at: now,
            };
            jobs.insert(job.id.clone(), job.clone());
            job
        };
        self.persist_and_emit(job.clone()).await;
        self.notify.notify_one();
        Ok(job)
    }

    async fn transition(&self, id: &str, action: TransferAction) -> Result<TransferJob, String> {
        let should_cancel_backend;
        let updated = {
            let active = self.active.lock().await.contains_key(id);
            let mut jobs = self.jobs.write().await;
            let job = jobs
                .get_mut(id)
                .ok_or_else(|| "Transfer was not found".to_string())?;
            should_cancel_backend =
                active && matches!(action, TransferAction::Pause | TransferAction::Cancel);
            match action {
                TransferAction::Pause if !job.status.is_terminal() => {
                    job.status = TransferStatus::Paused;
                    job.error = None;
                }
                TransferAction::Cancel if !job.status.is_terminal() => {
                    job.status = TransferStatus::Cancelled;
                    job.error = None;
                }
                TransferAction::Resume if job.status == TransferStatus::Paused => {
                    job.status = TransferStatus::Pending;
                    job.error = None;
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
                    job.speed_bytes_per_sec = 0;
                    job.error = None;
                    job.retry_at = None;
                }
                _ => return Ok(job.clone()),
            }
            job.revision = job.revision.saturating_add(1);
            job.updated_at = now_millis();
            job.clone()
        };
        self.persist_and_emit(updated.clone()).await;
        if should_cancel_backend {
            let _ =
                commands::cmd_cancel_transfer(id.to_string(), self.app.state::<TelegramState>())
                    .await;
        }
        self.notify.notify_one();
        Ok(updated)
    }

    async fn transition_all(
        &self,
        direction: TransferDirection,
        action: TransferAction,
    ) -> Result<Vec<TransferJob>, String> {
        let ids: Vec<_> = self
            .jobs
            .read()
            .await
            .values()
            .filter(|job| job.direction == direction && !job.status.is_terminal())
            .map(|job| job.id.clone())
            .collect();
        let mut changed = Vec::new();
        for id in ids {
            changed.push(self.transition(&id, action).await?);
        }
        Ok(changed)
    }

    async fn clear_terminal(
        &self,
        direction: TransferDirection,
        include_failed_and_cancelled: bool,
    ) -> Result<Vec<String>, String> {
        let removed: Vec<_> = {
            let mut jobs = self.jobs.write().await;
            let ids: Vec<_> = jobs
                .values()
                .filter(|job| {
                    job.direction == direction
                        && (job.status == TransferStatus::Completed
                            || (include_failed_and_cancelled
                                && matches!(
                                    job.status,
                                    TransferStatus::Failed | TransferStatus::Cancelled
                                )))
                })
                .map(|job| job.id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| jobs.remove(&id).map(|job| (id, job)))
                .collect()
        };
        for (id, job) in &removed {
            self.store.delete(id).await?;
            self.cleanup_temporary_source(job).await;
            let _ = self.app.emit("transfer-removed", id);
        }
        Ok(removed.into_iter().map(|(id, _)| id).collect())
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
        let mut jobs: Vec<_> = self.jobs.read().await.values().cloned().collect();
        jobs.sort_by_key(|job| (job.queue_position, job.created_at));
        jobs
    }

    pub async fn pause_all_directions(&self) -> Result<usize, String> {
        let mut changed = 0;
        for direction in [TransferDirection::Upload, TransferDirection::Download] {
            changed += self
                .transition_all(direction, TransferAction::Pause)
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
                .transition_all(direction, TransferAction::Resume)
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
    if error.contains("Client not connected") {
        job.status = TransferStatus::WaitingForNetwork;
    } else if error.contains("Transfer cancelled") {
        job.status = TransferStatus::Cancelled;
    } else {
        job.status = TransferStatus::Failed;
    }
    job.error = Some(error);
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
    let mut jobs = Vec::with_capacity(requests.len());
    for request in requests {
        jobs.push(engine.enqueue(request).await?);
    }
    Ok(jobs)
}

#[tauri::command]
pub async fn cmd_transfer_list(
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    let mut jobs: Vec<_> = engine.jobs.read().await.values().cloned().collect();
    jobs.sort_by_key(|job| (job.queue_position, job.created_at));
    Ok(jobs)
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
            engine: State<'_, Arc<TransferEngine>>,
        ) -> Result<TransferJob, String> {
            engine.transition(&id, $action).await
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
    if !engine.jobs.read().await.contains_key(&id) {
        return Err("Transfer was not found".to_string());
    }
    engine.prompt_tokens.lock().await.insert(id, prompt_token);
    Ok(())
}

#[tauri::command]
pub async fn cmd_transfer_pause_all(
    direction: TransferDirection,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    engine
        .transition_all(direction, TransferAction::Pause)
        .await
}

#[tauri::command]
pub async fn cmd_transfer_resume_all(
    direction: TransferDirection,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    engine
        .transition_all(direction, TransferAction::Resume)
        .await
}

#[tauri::command]
pub async fn cmd_transfer_cancel_all(
    direction: TransferDirection,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<TransferJob>, String> {
    engine
        .transition_all(direction, TransferAction::Cancel)
        .await
}

#[tauri::command]
pub async fn cmd_transfer_clear_terminal(
    direction: TransferDirection,
    include_failed_and_cancelled: bool,
    engine: State<'_, Arc<TransferEngine>>,
) -> Result<Vec<String>, String> {
    engine
        .clear_terminal(direction, include_failed_and_cancelled)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn request(id: &str) -> TransferEnqueueRequest {
        TransferEnqueueRequest {
            id: id.to_string(),
            direction: TransferDirection::Upload,
            kind: TransferKind::LocalUpload,
            path: Some("/tmp/file.txt".to_string()),
            url: None,
            folder_id: None,
            message_id: None,
            filename: "file.txt".to_string(),
            save_path: None,
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
            direction: request.direction,
            kind: request.kind,
            status: TransferStatus::Pending,
            path: request.path,
            url: None,
            folder_id: None,
            message_id: None,
            filename: request.filename,
            save_path: None,
            protection_mode: request.protection_mode,
            protect_metadata: request.protect_metadata,
            video_upload_mode: request.video_upload_mode,
            temp_zip_path: None,
            progress: 0,
            transferred_bytes: 0,
            total_bytes: 10,
            speed_bytes_per_sec: 0,
            error: None,
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
        assert_eq!(running.status, TransferStatus::Pending);
        assert_eq!(running.revision, 5);

        let mut protected = job("protected", 7);
        protected.status = TransferStatus::Encrypting;
        protected.protection_mode = Some("passphrase".to_string());
        assert!(recover_after_restart(&mut protected));
        assert_eq!(protected.status, TransferStatus::WaitingForUnlock);

        let mut paused = job("paused", 2);
        paused.status = TransferStatus::Paused;
        assert!(!recover_after_restart(&mut paused));
        assert_eq!(paused.status, TransferStatus::Paused);
        assert_eq!(paused.revision, 2);
    }
}
