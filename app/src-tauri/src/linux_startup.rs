#[cfg(target_os = "linux")]
use serde::Deserialize;
#[cfg(any(target_os = "linux", test))]
use std::ffi::OsStr;

/// Must match the application identifier in tauri.conf.json.
#[cfg(target_os = "linux")]
const BUNDLE_ID: &str = "com.cameronamer.telegramdrive";

#[cfg(target_os = "linux")]
#[derive(Deserialize)]
struct SettingsFile {
    settings: Option<SettingsPayload>,
}

#[cfg(target_os = "linux")]
#[derive(Deserialize)]
struct SettingsPayload {
    #[serde(rename = "linuxRenderingFix")]
    linux_rendering_fix: Option<bool>,
}

#[cfg(any(target_os = "linux", test))]
fn is_wayland_session(session_type: Option<&OsStr>, wayland_display: Option<&OsStr>) -> bool {
    session_type
        .and_then(OsStr::to_str)
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("wayland"))
        || wayland_display.is_some_and(|value| !value.is_empty())
}

#[cfg(target_os = "linux")]
fn rendering_fix_enabled() -> bool {
    let Some(home) = std::env::var_os("HOME") else {
        return true;
    };
    let settings_path = std::path::PathBuf::from(home)
        .join(".local/share")
        .join(BUNDLE_ID)
        .join("settings.json");
    let Ok(content) = std::fs::read_to_string(settings_path) else {
        return true;
    };
    serde_json::from_str::<SettingsFile>(&content)
        .ok()
        .and_then(|file| file.settings)
        .and_then(|settings| settings.linux_rendering_fix)
        .unwrap_or(true)
}

/// Configure Linux rendering before Tauri initializes WebKitGTK.
///
/// Explicit user-provided environment values always win. On detected Wayland
/// sessions, the defaults prevent GTK/EGL from selecting an incompatible X11
/// path. The existing DMA-BUF preference remains fail-safe for upgrades.
#[cfg(target_os = "linux")]
pub fn configure_before_webview() {
    if is_wayland_session(
        std::env::var_os("XDG_SESSION_TYPE").as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").as_deref(),
    ) {
        if std::env::var_os("EGL_PLATFORM").is_none() {
            std::env::set_var("EGL_PLATFORM", "wayland");
        }
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "wayland");
        }
    }

    if rendering_fix_enabled() {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    } else if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        std::env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn configure_before_webview() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_wayland_from_session_type_or_display_socket() {
        assert!(is_wayland_session(Some(OsStr::new("wayland")), None));
        assert!(is_wayland_session(Some(OsStr::new("WayLand")), None));
        assert!(is_wayland_session(
            Some(OsStr::new("x11")),
            Some(OsStr::new("wayland-0")),
        ));
    }

    #[test]
    fn does_not_force_wayland_for_x11_or_empty_values() {
        assert!(!is_wayland_session(Some(OsStr::new("x11")), None));
        assert!(!is_wayland_session(None, Some(OsStr::new(""))));
        assert!(!is_wayland_session(None, None));
    }
}
