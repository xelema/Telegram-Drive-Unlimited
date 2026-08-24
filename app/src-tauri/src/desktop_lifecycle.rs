//! Desktop window lifecycle intents.

use crate::desktop_preferences::{CloseBehavior, DesktopPreferencesState};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopNavigationTarget {
    Home,
    Transfers,
    Settings,
    Authentication,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNavigationRequest {
    pub target: DesktopNavigationTarget,
    pub transfer_id: Option<String>,
}

impl DesktopNavigationRequest {
    pub fn home() -> Self {
        Self {
            target: DesktopNavigationTarget::Home,
            transfer_id: None,
        }
    }

    pub fn transfers() -> Self {
        Self {
            target: DesktopNavigationTarget::Transfers,
            transfer_id: None,
        }
    }
}

pub struct DesktopLifecycleState {
    tray_ready: AtomicBool,
    explicit_exit_requested: AtomicBool,
    window_hidden: AtomicBool,
    frontend_ready: AtomicBool,
    background_hint_pending: AtomicBool,
    pending_navigation: Mutex<Option<DesktopNavigationRequest>>,
}

impl Default for DesktopLifecycleState {
    fn default() -> Self {
        Self {
            tray_ready: AtomicBool::new(false),
            explicit_exit_requested: AtomicBool::new(false),
            window_hidden: AtomicBool::new(false),
            frontend_ready: AtomicBool::new(false),
            background_hint_pending: AtomicBool::new(false),
            pending_navigation: Mutex::new(None),
        }
    }
}

impl DesktopLifecycleState {
    pub fn set_tray_ready(&self, ready: bool) {
        self.tray_ready.store(ready, Ordering::Release);
    }

    pub fn should_hide_on_close(&self, preferences: &DesktopPreferencesState) -> bool {
        let preferences = preferences.get();
        !self.explicit_exit_requested.load(Ordering::Acquire)
            && self.tray_ready.load(Ordering::Acquire)
            && preferences.background_mode_enabled
            && preferences.close_behavior == CloseBehavior::Background
    }

    pub fn mark_hidden(&self, app: &AppHandle) {
        self.window_hidden.store(true, Ordering::Release);
        let _ = app.emit("desktop-backgrounded", ());
        if let Some(preferences) = app.try_state::<DesktopPreferencesState>() {
            if !preferences.get().background_hint_seen {
                self.background_hint_pending.store(true, Ordering::Release);
            }
            preferences.mark_background_hint_seen();
        }
    }

    pub fn mark_explicit_exit(&self) {
        self.explicit_exit_requested.store(true, Ordering::Release);
    }

    pub fn is_explicit_exit_requested(&self) -> bool {
        self.explicit_exit_requested.load(Ordering::Acquire)
    }

    pub fn mark_frontend_ready(&self, app: &AppHandle) {
        self.frontend_ready.store(true, Ordering::Release);
        let pending = self
            .pending_navigation
            .lock()
            .ok()
            .and_then(|mut value| value.take());
        if let Some(request) = pending {
            let _ = app.emit("desktop-navigation-request", request);
        }
    }

    pub fn mark_frontend_unready(&self) {
        self.frontend_ready.store(false, Ordering::Release);
    }

    fn route(&self, app: &AppHandle, request: DesktopNavigationRequest) {
        if self.frontend_ready.load(Ordering::Acquire)
            && app.emit("desktop-navigation-request", &request).is_ok()
        {
            return;
        }
        if let Ok(mut pending) = self.pending_navigation.lock() {
            *pending = Some(request);
        }
    }
}

pub fn show_main_window(app: &AppHandle, request: DesktopNavigationRequest) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is unavailable".to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    if let Some(lifecycle) = app.try_state::<DesktopLifecycleState>() {
        lifecycle.window_hidden.store(false, Ordering::Release);
        lifecycle.route(app, request);
        if lifecycle
            .background_hint_pending
            .swap(false, Ordering::AcqRel)
        {
            let _ = app.emit("desktop-background-hint", ());
        }
    }
    Ok(())
}

pub fn request_graceful_quit(app: &AppHandle, exit_code: i32) {
    if let Some(lifecycle) = app.try_state::<DesktopLifecycleState>() {
        lifecycle.mark_explicit_exit();
    }
    app.exit(exit_code);
}

pub fn is_main_window_visible_and_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    })
}

#[tauri::command]
pub fn cmd_desktop_frontend_ready(app: AppHandle, lifecycle: State<'_, DesktopLifecycleState>) {
    lifecycle.mark_frontend_ready(&app);
}

#[tauri::command]
pub fn cmd_desktop_frontend_unready(lifecycle: State<'_, DesktopLifecycleState>) {
    lifecycle.mark_frontend_unready();
}

#[tauri::command]
pub fn cmd_show_main_window(
    target: Option<DesktopNavigationTarget>,
    transfer_id: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    show_main_window(
        &app,
        DesktopNavigationRequest {
            target: target.unwrap_or(DesktopNavigationTarget::Home),
            transfer_id,
        },
    )
}

#[tauri::command]
pub fn cmd_quit_application(app: AppHandle) {
    request_graceful_quit(&app, 0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_preferences::DesktopPreferences;
    use std::path::PathBuf;
    use std::sync::RwLock;

    fn preference_state(value: DesktopPreferences) -> DesktopPreferencesState {
        DesktopPreferencesState::from_test_parts(PathBuf::new(), RwLock::new(value))
    }

    #[test]
    fn close_hides_only_with_a_ready_tray_and_background_policy() {
        let lifecycle = DesktopLifecycleState::default();
        let preferences = preference_state(DesktopPreferences::default());
        assert!(!lifecycle.should_hide_on_close(&preferences));
        lifecycle.set_tray_ready(true);
        assert!(lifecycle.should_hide_on_close(&preferences));
        lifecycle.mark_explicit_exit();
        assert!(!lifecycle.should_hide_on_close(&preferences));
    }

    #[test]
    fn quit_close_policy_never_hides() {
        let lifecycle = DesktopLifecycleState::default();
        lifecycle.set_tray_ready(true);
        let value = DesktopPreferences {
            close_behavior: CloseBehavior::Quit,
            ..DesktopPreferences::default()
        };
        assert!(!lifecycle.should_hide_on_close(&preference_state(value)));
    }
}
