//! System tray construction and transfer summary projection.

use crate::desktop_lifecycle::{
    request_graceful_quit, show_main_window, DesktopLifecycleState, DesktopNavigationRequest,
};
use crate::transfer_engine::{TransferEngine, TransferJob, TransferStatus};
use std::sync::{Arc, Mutex};
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
}

#[derive(serde::Serialize)]
pub struct TrayProjection {
    pub status: String,
    pub open: String,
    pub transfers: String,
    pub pause: String,
    pub resume: String,
    pub quit: String,
    pub pause_enabled: bool,
    pub resume_enabled: bool,
}

pub fn project(summary: TransferSummary, language: &str) -> TrayProjection {
    use crate::native_localization::{format, text};
    let (key, count) = if summary.active > 0 {
        ("active", summary.active)
    } else if summary.paused > 0 {
        ("paused", summary.paused)
    } else if summary.waiting > 0 {
        ("attention", summary.waiting)
    } else if summary.failed > 0 {
        ("failed", summary.failed)
    } else {
        ("current", 0)
    };
    let action = |verb, name| {
        format(
            language,
            "common.action_name",
            &[
                ("action", text(language, verb)),
                ("name", text(language, name)),
            ],
        )
    };
    TrayProjection {
        status: format(
            language,
            &format!("native_tray.{key}"),
            &[("count", &count.to_string())],
        ),
        open: action("files.open", "common.app_title"),
        transfers: action("files.open", "common.transfers"),
        pause: text(language, "native_tray.pause_all").to_owned(),
        resume: action("activity.resume", "common.transfers"),
        quit: text(language, "native_tray.quit").to_owned(),
        pause_enabled: summary.active > 0 || summary.waiting > 0,
        resume_enabled: summary.paused > 0,
    }
}

/// A delayed producer cannot replace a newer coordinator snapshot.
#[derive(Default)]
pub(crate) struct TraySummaryState(Mutex<(u64, TransferSummary)>);
impl TraySummaryState {
    pub(crate) fn update(&self, summary: TransferSummary, revision: u64) -> bool {
        let mut current = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if revision < current.0 {
            return false;
        }
        *current = (revision, summary);
        true
    }
    pub(crate) fn snapshot(&self) -> TransferSummary {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .1
    }
}

pub struct DesktopTrayState {
    app: AppHandle,
    tray: TrayIcon<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    open: MenuItem<tauri::Wry>,
    transfers: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    resume: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    summary: TraySummaryState,
}

impl DesktopTrayState {
    pub fn update(&self, summary: TransferSummary, revision: u64) {
        if self.summary.update(summary, revision) {
            self.refresh();
        }
    }
    pub fn refresh(&self) {
        let app = self.app.clone();
        if let Err(error) = self.app.run_on_main_thread(move || {
            let Some(tray) = app.try_state::<DesktopTrayState>() else {
                return;
            };
            let summary = tray.summary.snapshot();
            let language = app
                .state::<crate::native_localization::NativeLanguageState>()
                .get();
            let copy = project(summary, language);
            for (item, label) in [
                (&tray.status, &copy.status),
                (&tray.open, &copy.open),
                (&tray.transfers, &copy.transfers),
                (&tray.pause, &copy.pause),
                (&tray.resume, &copy.resume),
                (&tray.quit, &copy.quit),
            ] {
                if let Err(error) = item.set_text(label) {
                    log::warn!("Could not update tray text: {error}");
                }
            }
            if let Err(error) = tray.pause.set_enabled(copy.pause_enabled) {
                log::warn!("Could not update tray pause state: {error}");
            }
            if let Err(error) = tray.resume.set_enabled(copy.resume_enabled) {
                log::warn!("Could not update tray resume state: {error}");
            }
            if let Err(error) = tray.tray.set_tooltip(Some(copy.status)) {
                log::debug!("Tray tooltip is unavailable on this desktop: {error}");
            }
        }) {
            log::warn!("Could not schedule tray update: {error}");
        }
    }
}

pub fn initialize(app: &AppHandle) -> Result<DesktopTrayState, String> {
    let copy = project(
        TransferSummary::default(),
        app.state::<crate::native_localization::NativeLanguageState>()
            .get(),
    );
    let status = MenuItem::with_id(app, "desktop_status", &copy.status, false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let open = MenuItem::with_id(app, MENU_OPEN, &copy.open, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let transfers = MenuItem::with_id(app, MENU_TRANSFERS, &copy.transfers, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let pause = MenuItem::with_id(app, MENU_PAUSE, &copy.pause, false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let resume = MenuItem::with_id(app, MENU_RESUME, &copy.resume, false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, MENU_QUIT, &copy.quit, true, None::<&str>)
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
        .tooltip(copy.status.clone())
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
        app: app.clone(),
        summary: TraySummaryState::default(),
        open,
        transfers,
        quit,
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
