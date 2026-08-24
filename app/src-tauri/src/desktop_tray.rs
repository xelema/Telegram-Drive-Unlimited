//! System tray construction and transfer summary projection.

use crate::desktop_lifecycle::{
    request_graceful_quit, show_main_window, DesktopLifecycleState, DesktopNavigationRequest,
};
use crate::transfer_engine::{TransferEngine, TransferJob, TransferStatus};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "telegram-drive-main";
const MENU_OPEN: &str = "desktop_open";
const MENU_TRANSFERS: &str = "desktop_open_transfers";
const MENU_PAUSE: &str = "desktop_pause_all";
const MENU_RESUME: &str = "desktop_resume_all";
const MENU_QUIT: &str = "desktop_quit";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TransferSummary {
    pub active: usize,
    pub paused: usize,
    pub waiting: usize,
    pub failed: usize,
}

impl TransferSummary {
    pub fn from_jobs<'a>(jobs: impl IntoIterator<Item = &'a TransferJob>) -> Self {
        let mut summary = Self::default();
        for job in jobs {
            if job.status.is_tray_active() {
                summary.active += 1;
            } else if job.status == TransferStatus::Paused {
                summary.paused += 1;
            } else if job.status.is_tray_waiting() {
                summary.waiting += 1;
            } else if job.status == TransferStatus::Failed {
                summary.failed += 1;
            }
        }
        summary
    }

    fn label(self) -> String {
        if self.active > 0 {
            format!("Telegram Drive — {} active", self.active)
        } else if self.paused > 0 {
            format!("Telegram Drive — {} paused", self.paused)
        } else if self.waiting > 0 {
            format!("Telegram Drive — {} need attention", self.waiting)
        } else if self.failed > 0 {
            format!("Telegram Drive — {} failed", self.failed)
        } else {
            "Telegram Drive — Up to date".to_string()
        }
    }
}

pub struct DesktopTrayState {
    tray: TrayIcon<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    resume: MenuItem<tauri::Wry>,
}

impl DesktopTrayState {
    pub fn update(&self, summary: TransferSummary) {
        let label = summary.label();
        if let Err(error) = self.status.set_text(&label) {
            log::warn!("Could not update tray status text: {error}");
        }
        if let Err(error) = self
            .pause
            .set_enabled(summary.active > 0 || summary.waiting > 0)
        {
            log::warn!("Could not update tray pause state: {error}");
        }
        if let Err(error) = self.resume.set_enabled(summary.paused > 0) {
            log::warn!("Could not update tray resume state: {error}");
        }
        if let Err(error) = self.tray.set_tooltip(Some(label)) {
            log::debug!("Tray tooltip is unavailable on this desktop: {error}");
        }
    }
}

pub fn initialize(app: &AppHandle) -> Result<DesktopTrayState, String> {
    let status = MenuItem::with_id(
        app,
        "desktop_status",
        "Telegram Drive — Up to date",
        false,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Telegram Drive", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let transfers = MenuItem::with_id(app, MENU_TRANSFERS, "Open Transfers", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let pause = MenuItem::with_id(app, MENU_PAUSE, "Pause All Transfers", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let resume = MenuItem::with_id(app, MENU_RESUME, "Resume Transfers", false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Telegram Drive", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator_one = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let separator_two = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &separator_one,
            &open,
            &transfers,
            &pause,
            &resume,
            &separator_two,
            &quit,
        ],
    )
    .map_err(|error| error.to_string())?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Telegram Drive — Up to date")
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) =
                    show_main_window(tray.app_handle(), DesktopNavigationRequest::home())
                {
                    log::warn!("Could not restore the main window from the tray: {error}");
                }
            }
        });
    let tray = if let Some(icon) = app.default_window_icon() {
        tray.icon(icon.clone())
    } else {
        tray
    }
    .build(app)
    .map_err(|error| error.to_string())?;

    if let Some(lifecycle) = app.try_state::<DesktopLifecycleState>() {
        lifecycle.set_tray_ready(true);
    }
    Ok(DesktopTrayState {
        tray,
        status,
        pause,
        resume,
    })
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        MENU_OPEN => {
            if let Err(error) = show_main_window(app, DesktopNavigationRequest::home()) {
                log::warn!("Could not restore the main window: {error}");
            }
        }
        MENU_TRANSFERS => {
            if let Err(error) = show_main_window(app, DesktopNavigationRequest::transfers()) {
                log::warn!("Could not open Transfers: {error}");
            }
        }
        MENU_PAUSE => run_transfer_action(app, true),
        MENU_RESUME => run_transfer_action(app, false),
        MENU_QUIT => request_graceful_quit(app, 0),
        _ => {}
    }
}

fn run_transfer_action(app: &AppHandle, pause: bool) {
    let Some(engine) = app.try_state::<Arc<TransferEngine>>() else {
        return;
    };
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = if pause {
            engine.pause_all_directions().await
        } else {
            engine.resume_all_directions().await
        };
        if let Err(error) = result {
            log::warn!("Could not update transfers from the tray: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer_engine::{TransferDirection, TransferKind};

    fn job(status: TransferStatus) -> TransferJob {
        TransferJob {
            id: "id".to_string(),
            direction: TransferDirection::Upload,
            kind: TransferKind::LocalUpload,
            status,
            path: None,
            url: None,
            folder_id: None,
            message_id: None,
            filename: "file".to_string(),
            save_path: None,
            protection_mode: None,
            protect_metadata: None,
            temp_zip_path: None,
            progress: 0,
            transferred_bytes: 0,
            total_bytes: 0,
            speed_bytes_per_sec: 0,
            error: None,
            retry_at: None,
            queue_position: 0,
            revision: 1,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn summary_classifies_each_user_visible_bucket() {
        let jobs = [
            job(TransferStatus::Uploading),
            job(TransferStatus::Paused),
            job(TransferStatus::WaitingForUnlock),
            job(TransferStatus::Failed),
            job(TransferStatus::Completed),
        ];
        assert_eq!(
            TransferSummary::from_jobs(&jobs),
            TransferSummary {
                active: 1,
                paused: 1,
                waiting: 1,
                failed: 1,
            }
        );
    }
}
