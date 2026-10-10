//! Privacy-safe, backend-owned desktop transfer notifications.

use crate::desktop_lifecycle::is_main_window_visible_and_focused;
use crate::desktop_preferences::{persist_json_atomically, DesktopPreferencesState};
use crate::desktop_tray::{DesktopTrayState, TransferSummary};
use crate::transfer_engine::{TransferDirection, TransferJob, TransferStatus};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Listener, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

const RECEIPTS_FILE: &str = "desktop-notification-receipts.v1.json";
const MAX_RECEIPTS: usize = 2_000;
const AGGREGATION_DELAY: Duration = Duration::from_millis(850);
const NETWORK_ATTENTION_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum NotificationCategory {
    Completed,
    Failed,
    Paused,
    Attention,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
struct NotificationReceipt {
    transfer_id: String,
    revision: u64,
    category: NotificationCategory,
}

#[derive(Debug, Clone)]
struct NotificationCandidate {
    receipt: NotificationReceipt,
    direction: TransferDirection,
    status: TransferStatus,
    filename: String,
}

/// Delivery and desktop-state boundaries around the shared notification lifecycle.
pub(crate) trait NotificationHost: Send + Sync {
    fn preferences(&self) -> crate::desktop_preferences::DesktopPreferences;
    fn language(&self) -> &'static str;
    fn visible_and_focused(&self) -> bool;
    fn update_tray(&self, summary: TransferSummary, revision: u64);
    fn deliver(&self, title: String, body: String) -> Result<(), String>;
    #[cfg(feature = "native-e2e")]
    fn pending_drained(&self) {}
    #[cfg(feature = "native-e2e")]
    fn before_receipt_write(&self, _count: usize) {}
    #[cfg(feature = "native-e2e")]
    fn after_receipt_write(&self, _count: usize) {}
    #[cfg(feature = "native-e2e")]
    fn flush_complete(&self) {}
}

struct TauriNotificationHost(AppHandle);
impl NotificationHost for TauriNotificationHost {
    fn language(&self) -> &'static str {
        self.0
            .state::<crate::native_localization::NativeLanguageState>()
            .get()
    }
    fn preferences(&self) -> crate::desktop_preferences::DesktopPreferences {
        self.0
            .try_state::<DesktopPreferencesState>()
            .map(|state| state.get())
            .unwrap_or_default()
    }
    fn visible_and_focused(&self) -> bool {
        is_main_window_visible_and_focused(&self.0)
    }
    fn update_tray(&self, summary: TransferSummary, revision: u64) {
        if let Some(tray) = self.0.try_state::<DesktopTrayState>() {
            tray.update(summary, revision);
        }
    }
    fn deliver(&self, title: String, body: String) -> Result<(), String> {
        self.0
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

pub struct DesktopNotificationCoordinator {
    app: Option<AppHandle>,
    host: Arc<dyn NotificationHost>,
    jobs: Mutex<HashMap<String, TransferJob>>,
    tray_revision: AtomicU64,
    receipt_writer: Mutex<()>,
    receipts: Mutex<VecDeque<NotificationReceipt>>,
    receipt_index: Mutex<HashSet<NotificationReceipt>>,
    receipts_path: PathBuf,
    pending: Mutex<Vec<NotificationCandidate>>,
    flush_scheduled: AtomicBool,
    listener_installed: AtomicBool,
}

impl DesktopNotificationCoordinator {
    pub fn initialize(app: &AppHandle) -> Result<Arc<Self>, String> {
        let receipts_path = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join(RECEIPTS_FILE);
        Ok(Self::create(
            Some(app.clone()),
            Arc::new(TauriNotificationHost(app.clone())),
            receipts_path,
        ))
    }

    #[cfg(feature = "native-e2e")]
    pub(crate) fn with_host(host: Arc<dyn NotificationHost>, receipts_path: PathBuf) -> Arc<Self> {
        Self::create(None, host, receipts_path)
    }

    fn create(
        app: Option<AppHandle>,
        host: Arc<dyn NotificationHost>,
        receipts_path: PathBuf,
    ) -> Arc<Self> {
        let receipts = load_receipts(&receipts_path);
        let receipt_index = receipts.iter().cloned().collect();
        Arc::new(Self {
            app,
            host,
            jobs: Mutex::new(HashMap::new()),
            tray_revision: AtomicU64::new(0),
            receipt_writer: Mutex::new(()),
            receipts: Mutex::new(receipts),
            receipt_index: Mutex::new(receipt_index),
            receipts_path,
            pending: Mutex::new(Vec::new()),
            flush_scheduled: AtomicBool::new(false),
            listener_installed: AtomicBool::new(false),
        })
    }

    pub fn seed(&self, jobs: Vec<TransferJob>) {
        let summary = self.jobs.lock().ok().map(|mut current| {
            current.extend(jobs.into_iter().map(|job| (job.id.clone(), job)));
            (
                TransferSummary::from_jobs(current.values()),
                self.tray_revision.fetch_add(1, Ordering::Relaxed) + 1,
            )
        });
        if let Some((summary, revision)) = summary {
            self.host.update_tray(summary, revision);
        }
    }

    pub(crate) fn refresh_tray(&self) {
        let summary = self.jobs.lock().ok().map(|jobs| {
            (
                TransferSummary::from_jobs(jobs.values()),
                self.tray_revision.load(Ordering::Relaxed),
            )
        });
        if let Some((summary, revision)) = summary {
            self.host.update_tray(summary, revision);
        }
    }

    pub fn start(self: &Arc<Self>) {
        let Some(app) = self.app.as_ref() else {
            return;
        };
        if self.listener_installed.swap(true, Ordering::AcqRel) {
            return;
        }
        let coordinator = self.clone();
        app.listen(
            "transfer-upserted",
            move |event| match serde_json::from_str::<TransferJob>(event.payload()) {
                Ok(job) => coordinator.record(job),
                Err(error) => log::warn!("Ignored an invalid transfer update: {error}"),
            },
        );
        let coordinator = self.clone();
        app.listen("transfer-removed", move |event| {
            if let Ok(id) = serde_json::from_str::<String>(event.payload()) {
                coordinator.remove(&id);
            }
        });
    }

    pub(crate) fn record(self: &Arc<Self>, job: TransferJob) {
        // Folder Sync reports its own work; its transfers do not also raise
        // a notification each.
        if job.origin.is_some() {
            return;
        }
        let previous = if let Ok(mut jobs) = self.jobs.lock() {
            let previous = jobs.insert(job.id.clone(), job.clone());
            let summary = TransferSummary::from_jobs(jobs.values());
            let revision = self.tray_revision.fetch_add(1, Ordering::Relaxed) + 1;
            drop(jobs);
            self.host.update_tray(summary, revision);
            previous
        } else {
            None
        };
        let Some(previous) = previous else {
            return;
        };
        if previous.status == job.status {
            return;
        }
        if let Some(category) = category_for_transition(previous.status, job.status) {
            let candidate = NotificationCandidate {
                receipt: NotificationReceipt {
                    transfer_id: job.id.clone(),
                    revision: job.revision,
                    category,
                },
                direction: job.direction,
                status: job.status,
                filename: safe_filename(&job.filename),
            };
            let delay = if job.status == TransferStatus::WaitingForNetwork {
                NETWORK_ATTENTION_DELAY
            } else {
                Duration::ZERO
            };
            if delay.is_zero() {
                self.enqueue(candidate);
            } else {
                let coordinator = self.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(delay).await;
                    coordinator.enqueue_if_current(candidate);
                });
            }
        }
    }

    pub(crate) fn remove(&self, id: &str) {
        let summary = self.jobs.lock().ok().map(|mut jobs| {
            jobs.remove(id);
            (
                TransferSummary::from_jobs(jobs.values()),
                self.tray_revision.fetch_add(1, Ordering::Relaxed) + 1,
            )
        });
        if let Some((summary, revision)) = summary {
            self.host.update_tray(summary, revision);
        }
    }

    fn enqueue_if_current(self: Arc<Self>, candidate: NotificationCandidate) {
        let current = self.jobs.lock().ok().and_then(|jobs| {
            jobs.get(&candidate.receipt.transfer_id)
                .map(|job| (job.revision, job.status))
        });
        if current == Some((candidate.receipt.revision, candidate.status)) {
            self.enqueue(candidate);
        }
    }

    fn enqueue(self: &Arc<Self>, candidate: NotificationCandidate) {
        let preferences = self.host.preferences();
        if !notification_category_enabled(&preferences, candidate.receipt.category)
            || (!preferences.notify_while_visible && self.host.visible_and_focused())
        {
            return;
        }
        if let Ok(index) = self.receipt_index.lock() {
            if index.contains(&candidate.receipt) {
                return;
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            if pending
                .iter()
                .any(|queued| queued.receipt == candidate.receipt)
            {
                return;
            }
            pending.push(candidate);
        }
        if !self.flush_scheduled.swap(true, Ordering::AcqRel) {
            let coordinator = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(AGGREGATION_DELAY).await;
                coordinator.flush();
            });
        }
    }

    fn flush(&self) {
        let candidates = self
            .pending
            .lock()
            .map(|mut pending| {
                let candidates = pending.drain(..).collect::<Vec<_>>();
                // Release ownership while the queue is locked: an arrival after
                // this drain must be able to schedule its own delivery.
                self.flush_scheduled.store(false, Ordering::Release);
                candidates
            })
            .unwrap_or_default();
        #[cfg(feature = "native-e2e")]
        self.host.pending_drained();
        if candidates.is_empty() {
            return;
        }

        let mut grouped: HashMap<NotificationCategory, Vec<NotificationCandidate>> = HashMap::new();
        for candidate in candidates {
            grouped
                .entry(candidate.receipt.category)
                .or_default()
                .push(candidate);
        }
        for (category, candidates) in grouped {
            let preferences = self.host.preferences();
            if !notification_category_enabled(&preferences, category)
                || (!preferences.notify_while_visible && self.host.visible_and_focused())
            {
                continue;
            }
            let claimed: Vec<_> = candidates
                .into_iter()
                .filter(|candidate| self.claim_receipt(candidate.receipt.clone()))
                .collect();
            if claimed.is_empty() {
                continue;
            }
            // Durable receipt writes can wait. Respect the current privacy
            // choices and foreground state at the actual delivery boundary.
            let preferences = self.host.preferences();
            if !notification_category_enabled(&preferences, category)
                || (!preferences.notify_while_visible && self.host.visible_and_focused())
            {
                continue;
            }
            let (title, body) =
                notification_copy(category, &claimed, &preferences, self.host.language());
            if let Err(error) = self.host.deliver(title, body) {
                log::warn!("Desktop notification service is unavailable: {error}");
            }
        }
        #[cfg(feature = "native-e2e")]
        self.host.flush_complete();
    }

    fn claim_receipt(&self, receipt: NotificationReceipt) -> bool {
        // Serialize the mutation and durable snapshot, without holding this
        // guard during GUI or notification delivery.
        let Ok(_receipt_write) = self.receipt_writer.lock() else {
            return false;
        };
        let Ok(mut index) = self.receipt_index.lock() else {
            return false;
        };
        if !index.insert(receipt.clone()) {
            return false;
        }
        let snapshot = if let Ok(mut receipts) = self.receipts.lock() {
            receipts.push_back(receipt);
            while receipts.len() > MAX_RECEIPTS {
                if let Some(removed) = receipts.pop_front() {
                    index.remove(&removed);
                }
            }
            receipts.iter().cloned().collect::<Vec<_>>()
        } else {
            return false;
        };
        drop(index);
        #[cfg(feature = "native-e2e")]
        self.host.before_receipt_write(snapshot.len());
        if let Err(error) = persist_json_atomically(&self.receipts_path, &snapshot) {
            log::warn!("Could not persist notification deduplication state: {error}");
        }
        #[cfg(feature = "native-e2e")]
        self.host.after_receipt_write(snapshot.len());
        true
    }
}

fn category_for_transition(
    previous: TransferStatus,
    current: TransferStatus,
) -> Option<NotificationCategory> {
    if previous == current {
        return None;
    }
    match current {
        TransferStatus::Completed => Some(NotificationCategory::Completed),
        TransferStatus::Failed => Some(NotificationCategory::Failed),
        TransferStatus::Paused if !previous.is_terminal() => Some(NotificationCategory::Paused),
        TransferStatus::WaitingForUnlock
        | TransferStatus::WaitingForNetwork
        | TransferStatus::Cooldown => Some(NotificationCategory::Attention),
        _ => None,
    }
}

fn notification_category_enabled(
    preferences: &crate::desktop_preferences::DesktopPreferences,
    category: NotificationCategory,
) -> bool {
    preferences.notifications_enabled
        && match category {
            NotificationCategory::Completed => preferences.notify_completed,
            NotificationCategory::Failed => preferences.notify_failed,
            NotificationCategory::Paused => preferences.notify_paused,
            NotificationCategory::Attention => preferences.notify_attention,
        }
}

fn notification_copy(
    category: NotificationCategory,
    candidates: &[NotificationCandidate],
    preferences: &crate::desktop_preferences::DesktopPreferences,
    language: &str,
) -> (String, String) {
    use crate::native_localization::{format, text};
    let category_name = match category {
        NotificationCategory::Completed => "completed",
        NotificationCategory::Failed => "failed",
        NotificationCategory::Paused => "paused",
        NotificationCategory::Attention => "attention",
    };
    let title = text(
        language,
        &format!("native_notifications.title_{category_name}"),
    )
    .to_owned();
    if candidates.len() > 1 {
        let count = candidates.len().to_string();
        return (
            title,
            format(
                language,
                &format!("native_notifications.many_{category_name}"),
                &[("count", &count)],
            ),
        );
    }
    let candidate = &candidates[0];
    let display_name = preferences.show_filenames_in_notifications.then(|| {
        if candidate.filename.is_empty() {
            text(language, "native_notifications.unnamed_file")
        } else {
            candidate.filename.as_str()
        }
    });
    let key = match (category, display_name) {
        (NotificationCategory::Completed, Some(_)) => "name_completed",
        (NotificationCategory::Failed, Some(_)) => "name_failed",
        (NotificationCategory::Paused, Some(_)) => "name_paused",
        (NotificationCategory::Completed, None) => match candidate.direction {
            TransferDirection::Upload => "upload_completed",
            TransferDirection::Download => "download_completed",
        },
        (NotificationCategory::Failed, None) => "failed",
        (NotificationCategory::Paused, None) => "paused",
        (NotificationCategory::Attention, _) => match candidate.status {
            TransferStatus::WaitingForUnlock => "unlock",
            TransferStatus::WaitingForNetwork => "network",
            TransferStatus::Cooldown => "telegram",
            _ => "attention",
        },
    };
    (
        title,
        format(
            language,
            &format!("native_notifications.{key}"),
            &[("name", display_name.unwrap_or_default())],
        ),
    )
}

fn safe_filename(value: &str) -> String {
    let basename = value
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or_default();
    let sanitized: String = basename
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    sanitized
}

fn load_receipts(path: &Path) -> VecDeque<NotificationReceipt> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<NotificationReceipt>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .rev()
        .take(MAX_RECEIPTS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[tauri::command]
pub fn cmd_get_notification_permission(app: AppHandle) -> String {
    app.notification()
        .permission_state()
        .map(permission_label)
        .unwrap_or_else(|_| "unavailable".to_string())
}

#[tauri::command]
pub fn cmd_request_notification_permission(app: AppHandle) -> String {
    app.notification()
        .request_permission()
        .map(permission_label)
        .unwrap_or_else(|_| "unavailable".to_string())
}

fn permission_label(state: PermissionState) -> String {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "prompt",
    }
    .to_string()
}
