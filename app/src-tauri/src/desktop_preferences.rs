//! Device-local desktop lifecycle and notification preferences.
//!
//! These values intentionally live outside Telegram settings sync: notification
//! permission, close behaviour, and lock-screen privacy are properties of one
//! operating-system installation.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Manager, State};

const PREFERENCES_FILE: &str = "desktop-preferences.v1.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    Background,
    Quit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopPreferences {
    pub schema_version: u8,
    pub background_mode_enabled: bool,
    pub close_behavior: CloseBehavior,
    pub notifications_enabled: bool,
    pub notify_completed: bool,
    pub notify_failed: bool,
    pub notify_paused: bool,
    pub notify_attention: bool,
    pub notify_while_visible: bool,
    pub show_filenames_in_notifications: bool,
    pub background_hint_seen: bool,
    pub lock_on_sleep: bool,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            background_mode_enabled: true,
            close_behavior: CloseBehavior::Background,
            notifications_enabled: false,
            notify_completed: true,
            notify_failed: true,
            notify_paused: true,
            notify_attention: true,
            notify_while_visible: false,
            show_filenames_in_notifications: false,
            background_hint_seen: false,
            lock_on_sleep: true,
        }
    }
}

pub struct DesktopPreferencesState {
    path: PathBuf,
    value: RwLock<DesktopPreferences>,
}

impl DesktopPreferencesState {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join(PREFERENCES_FILE);
        let value = load_preferences(&path);
        Ok(Self {
            path,
            value: RwLock::new(value),
        })
    }

    pub fn get(&self) -> DesktopPreferences {
        self.value
            .read()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn update(&self, mut value: DesktopPreferences) -> Result<DesktopPreferences, String> {
        value.schema_version = 1;
        persist_preferences(&self.path, &value)?;
        *self
            .value
            .write()
            .map_err(|_| "Desktop preferences are unavailable".to_string())? = value.clone();
        Ok(value)
    }

    pub fn mark_background_hint_seen(&self) {
        let mut value = self.get();
        if value.background_hint_seen {
            return;
        }
        value.background_hint_seen = true;
        if let Err(error) = self.update(value) {
            log::warn!("Could not persist the background-mode education state: {error}");
        }
    }

    #[cfg(test)]
    pub(crate) fn from_test_parts(path: PathBuf, value: RwLock<DesktopPreferences>) -> Self {
        Self { path, value }
    }
}

fn load_preferences(path: &Path) -> DesktopPreferences {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<DesktopPreferences>(&bytes) {
            Ok(mut value) => {
                value.schema_version = 1;
                value
            }
            Err(error) => {
                log::warn!("Desktop preferences were invalid; safe defaults will be used: {error}");
                DesktopPreferences::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DesktopPreferences::default(),
        Err(error) => {
            log::warn!(
                "Desktop preferences could not be read; safe defaults will be used: {error}"
            );
            DesktopPreferences::default()
        }
    }
}

fn persist_preferences(path: &Path, value: &DesktopPreferences) -> Result<(), String> {
    persist_json_atomically(path, value)
}

pub(crate) fn persist_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Desktop preferences path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".{PREFERENCES_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        atomic_replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        return fs::rename(source, destination).map_err(|error| error.to_string());
    }
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_get_desktop_preferences(
    state: State<'_, DesktopPreferencesState>,
) -> DesktopPreferences {
    state.get()
}

#[tauri::command]
pub fn cmd_update_desktop_preferences(
    preferences: DesktopPreferences,
    state: State<'_, DesktopPreferencesState>,
) -> Result<DesktopPreferences, String> {
    state.update(preferences)
}

#[tauri::command]
pub fn cmd_set_desktop_lock_on_sleep(
    enabled: bool,
    state: State<'_, DesktopPreferencesState>,
) -> Result<(), String> {
    let mut preferences = state.get();
    preferences.lock_on_sleep = enabled;
    state.update(preferences).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_private_and_background_capable() {
        let value = DesktopPreferences::default();
        assert!(value.background_mode_enabled);
        assert_eq!(value.close_behavior, CloseBehavior::Background);
        assert!(!value.notifications_enabled);
        assert!(!value.show_filenames_in_notifications);
        assert!(!value.notify_while_visible);
    }

    #[test]
    fn corrupt_preferences_fail_closed_to_safe_defaults() {
        let root = std::env::temp_dir().join(format!("desktop-prefs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(PREFERENCES_FILE);
        fs::write(&path, b"not-json").unwrap();
        assert_eq!(load_preferences(&path), DesktopPreferences::default());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preferences_round_trip_atomically() {
        let root = std::env::temp_dir().join(format!("desktop-prefs-{}", uuid::Uuid::new_v4()));
        let path = root.join(PREFERENCES_FILE);
        let value = DesktopPreferences {
            notifications_enabled: true,
            ..DesktopPreferences::default()
        };
        persist_preferences(&path, &value).unwrap();
        assert_eq!(load_preferences(&path), value);
        fs::remove_dir_all(root).unwrap();
    }
}
