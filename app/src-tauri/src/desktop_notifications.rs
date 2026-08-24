//! Privacy-safe, backend-owned desktop transfer notifications.

use crate::desktop_lifecycle::is_main_window_visible_and_focused;
use crate::desktop_preferences::{persist_json_atomically, DesktopPreferencesState};
use crate::desktop_tray::{DesktopTrayState, TransferSummary};
use crate::transfer_engine::{TransferDirection, TransferJob, TransferStatus};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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

pub struct DesktopNotificationCoordinator {
    app: AppHandle,
    jobs: Mutex<HashMap<String, TransferJob>>,
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
        let receipts = load_receipts(&receipts_path);
        let receipt_index = receipts.iter().cloned().collect();
        Ok(Arc::new(Self {
            app: app.clone(),
            jobs: Mutex::new(HashMap::new()),
            receipts: Mutex::new(receipts),
            receipt_index: Mutex::new(receipt_index),
            receipts_path,
            pending: Mutex::new(Vec::new()),
            flush_scheduled: AtomicBool::new(false),
            listener_installed: AtomicBool::new(false),
        }))
    }

    pub fn seed(&self, jobs: Vec<TransferJob>) {
        if let Ok(mut current) = self.jobs.lock() {
            current.extend(jobs.into_iter().map(|job| (job.id.clone(), job)));
            self.update_tray_locked(&current);
        }
    }

    pub fn start(self: &Arc<Self>) {
        if self.listener_installed.swap(true, Ordering::AcqRel) {
            return;
        }
        let coordinator = self.clone();
        self.app.listen(
            "transfer-upserted",
            move |event| match serde_json::from_str::<TransferJob>(event.payload()) {
                Ok(job) => coordinator.record(job),
                Err(error) => log::warn!("Ignored an invalid transfer update: {error}"),
            },
        );
        let coordinator = self.clone();
        self.app.listen("transfer-removed", move |event| {
            if let Ok(id) = serde_json::from_str::<String>(event.payload()) {
                coordinator.remove(&id);
            }
        });
    }

    fn record(self: &Arc<Self>, job: TransferJob) {
        let previous = if let Ok(mut jobs) = self.jobs.lock() {
            let previous = jobs.insert(job.id.clone(), job.clone());
            self.update_tray_locked(&jobs);
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

    fn remove(&self, id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(id);
            self.update_tray_locked(&jobs);
        }
    }

    fn update_tray_locked(&self, jobs: &HashMap<String, TransferJob>) {
        if let Some(tray) = self.app.try_state::<DesktopTrayState>() {
            tray.update(TransferSummary::from_jobs(jobs.values()));
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
        let Some(preferences) = self.app.try_state::<DesktopPreferencesState>() else {
            return;
        };
        let preferences = preferences.get();
        if !notification_category_enabled(&preferences, candidate.receipt.category)
            || (!preferences.notify_while_visible && is_main_window_visible_and_focused(&self.app))
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
            .map(|mut pending| pending.drain(..).collect::<Vec<_>>())
            .unwrap_or_default();
        self.flush_scheduled.store(false, Ordering::Release);
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
            let claimed: Vec<_> = candidates
                .into_iter()
                .filter(|candidate| self.claim_receipt(candidate.receipt.clone()))
                .collect();
            if claimed.is_empty() {
                continue;
            }
            let preferences = self
                .app
                .try_state::<DesktopPreferencesState>()
                .map(|state| state.get())
                .unwrap_or_default();
            let (title, body) = notification_copy(category, &claimed, &preferences);
            if let Err(error) = self
                .app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show()
            {
                log::warn!("Desktop notification service is unavailable: {error}");
            }
        }
    }

    fn claim_receipt(&self, receipt: NotificationReceipt) -> bool {
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
        if let Err(error) = persist_json_atomically(&self.receipts_path, &snapshot) {
            log::warn!("Could not persist notification deduplication state: {error}");
        }
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
) -> (String, String) {
    let count = candidates.len();
    let title = match category {
        NotificationCategory::Completed => "Transfer complete",
        NotificationCategory::Failed => "Transfer failed",
        NotificationCategory::Paused => "Transfer paused",
        NotificationCategory::Attention => "Transfer needs attention",
    }
    .to_string();
    if count > 1 {
        let body = match category {
            NotificationCategory::Completed => format!("{count} transfers completed."),
            NotificationCategory::Failed => {
                format!("{count} transfers failed. Open Transfers for details.")
            }
            NotificationCategory::Paused => format!("{count} transfers were paused."),
            NotificationCategory::Attention => format!("{count} transfers need attention."),
        };
        return (title, body);
    }
    let candidate = &candidates[0];
    let display_name = preferences
        .show_filenames_in_notifications
        .then_some(candidate.filename.as_str());
    let body = match (category, display_name) {
        (NotificationCategory::Completed, Some(name)) => format!("{name} completed."),
        (NotificationCategory::Completed, None) => match candidate.direction {
            TransferDirection::Upload => "An upload completed.".to_string(),
            TransferDirection::Download => "A download completed.".to_string(),
        },
        (NotificationCategory::Failed, Some(name)) => {
            format!("{name} failed. Open Transfers for details.")
        }
        (NotificationCategory::Failed, None) => {
            "A transfer failed. Open Transfers for details.".to_string()
        }
        (NotificationCategory::Paused, Some(name)) => format!("{name} was paused."),
        (NotificationCategory::Paused, None) => "A transfer was paused.".to_string(),
        (NotificationCategory::Attention, _) => match candidate.status {
            TransferStatus::WaitingForUnlock => {
                "Unlock the encryption vault to continue a transfer.".to_string()
            }
            TransferStatus::WaitingForNetwork => {
                "A transfer is waiting for the network.".to_string()
            }
            TransferStatus::Cooldown => {
                "A transfer is waiting for Telegram to become available.".to_string()
            }
            _ => "A transfer needs attention.".to_string(),
        },
    };
    (title, body)
}

fn safe_filename(value: &str) -> String {
    let basename = value
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("file");
    let sanitized: String = basename
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    if sanitized.is_empty() {
        "file".to_string()
    } else {
        sanitized
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_preferences::DesktopPreferences;
    use std::hash::{Hash, Hasher};

    fn candidate(category: NotificationCategory) -> NotificationCandidate {
        NotificationCandidate {
            receipt: NotificationReceipt {
                transfer_id: "id".to_string(),
                revision: 2,
                category,
            },
            direction: TransferDirection::Download,
            status: TransferStatus::Completed,
            filename: "report.pdf".to_string(),
        }
    }

    #[test]
    fn transition_classifier_ignores_progress_and_cancellation() {
        assert_eq!(
            category_for_transition(TransferStatus::Downloading, TransferStatus::Downloading),
            None
        );
        assert_eq!(
            category_for_transition(TransferStatus::Downloading, TransferStatus::Cancelled),
            None
        );
        assert_eq!(
            category_for_transition(TransferStatus::Downloading, TransferStatus::Completed),
            Some(NotificationCategory::Completed)
        );
    }

    #[test]
    fn default_copy_does_not_expose_a_filename() {
        let (_, body) = notification_copy(
            NotificationCategory::Completed,
            &[candidate(NotificationCategory::Completed)],
            &DesktopPreferences::default(),
        );
        assert_eq!(body, "A download completed.");
        assert!(!body.contains("report.pdf"));
    }

    #[test]
    fn filenames_are_basenames_control_stripped_and_bounded() {
        let unsafe_name = format!("C:\\private\\path/{}\nsecret.txt", "x".repeat(100));
        let safe = safe_filename(&unsafe_name);
        assert!(!safe.contains('/'));
        assert!(!safe.contains('\\'));
        assert!(!safe.contains('\n'));
        assert!(safe.chars().count() <= 80);
    }

    #[test]
    fn category_controls_are_fail_closed_behind_the_master_toggle() {
        let mut preferences = DesktopPreferences::default();
        assert!(!notification_category_enabled(
            &preferences,
            NotificationCategory::Failed
        ));
        preferences.notifications_enabled = true;
        assert!(notification_category_enabled(
            &preferences,
            NotificationCategory::Failed
        ));
    }

    #[test]
    fn receipt_hash_includes_revision_and_category() {
        let one = candidate(NotificationCategory::Completed).receipt;
        let mut two = one.clone();
        two.revision += 1;
        let mut hasher_one = std::collections::hash_map::DefaultHasher::new();
        let mut hasher_two = std::collections::hash_map::DefaultHasher::new();
        one.hash(&mut hasher_one);
        two.hash(&mut hasher_two);
        assert_ne!(hasher_one.finish(), hasher_two.finish());
    }
}
