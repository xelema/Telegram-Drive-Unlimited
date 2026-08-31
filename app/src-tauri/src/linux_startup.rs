#[cfg(target_os = "linux")]
use serde::Deserialize;
#[cfg(any(target_os = "linux", test))]
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

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
#[derive(Debug, Default, PartialEq, Eq)]
struct RenderingPolicy {
    set_force_shared_memory: bool,
    set_disable_compositing: bool,
}

#[cfg(any(target_os = "linux", test))]
fn is_truthy(value: Option<&OsStr>) -> bool {
    value.and_then(OsStr::to_str).is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

#[cfg(any(target_os = "linux", test))]
fn is_appimage(appimage: Option<&OsStr>, appdir: Option<&OsStr>) -> bool {
    [appimage, appdir]
        .into_iter()
        .flatten()
        .any(|value| !value.is_empty())
}

#[cfg(target_os = "linux")]
fn settings_path(home: Option<&OsStr>, xdg_data_home: Option<&OsStr>) -> Option<PathBuf> {
    let data_home = xdg_data_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            home.map(PathBuf::from)
                .map(|path| path.join(".local/share"))
        })?;

    Some(data_home.join(BUNDLE_ID).join("settings.json"))
}

#[cfg(any(target_os = "linux", test))]
fn choose_rendering_policy(
    appimage: bool,
    rendering_fix_enabled: bool,
    safe_mode: bool,
    force_shm_is_set: bool,
    legacy_disable_is_set: bool,
    disable_compositing_is_set: bool,
) -> RenderingPolicy {
    RenderingPolicy {
        // The automatic workaround belongs only to AppImages. Native packages
        // should use the WebKitGTK behavior selected by their distribution.
        // Any explicit WebKit rendering variable always wins.
        set_force_shared_memory: appimage
            && rendering_fix_enabled
            && !safe_mode
            && !force_shm_is_set
            && !legacy_disable_is_set
            && !disable_compositing_is_set,
        // Safe mode remains available to users who cannot reach Settings. It
        // is intentionally explicit because disabling compositing is slower.
        set_disable_compositing: safe_mode && !disable_compositing_is_set,
    }
}

#[cfg(target_os = "linux")]
fn rendering_fix_enabled() -> bool {
    let Some(path) = settings_path(
        std::env::var_os("HOME").as_deref(),
        std::env::var_os("XDG_DATA_HOME").as_deref(),
    ) else {
        return true;
    };

    let Ok(content) = std::fs::read_to_string(path) else {
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
/// The compatibility fallback is intentionally narrow: AppImage launches use
/// WebKitGTK's shared-memory transport unless the user chose another rendering
/// mode. Native packages, GTK/EGL backend selection, and explicit environment
/// values are left untouched.
#[cfg(target_os = "linux")]
pub fn configure_before_webview() {
    let safe_mode = is_truthy(std::env::var_os("TELEGRAM_DRIVE_SAFE_RENDERING").as_deref());
    let policy = choose_rendering_policy(
        is_appimage(
            std::env::var_os("APPIMAGE").as_deref(),
            std::env::var_os("APPDIR").as_deref(),
        ),
        rendering_fix_enabled(),
        safe_mode,
        std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_some(),
        std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some(),
        std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_some(),
    );

    if policy.set_force_shared_memory {
        std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
    }
    if policy.set_disable_compositing {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn configure_before_webview() {}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::path::Path;

    #[test]
    fn detects_appimage_from_either_runtime_variable() {
        assert!(is_appimage(Some(OsStr::new("/tmp/App.AppImage")), None));
        assert!(is_appimage(None, Some(OsStr::new("/tmp/.mount_App"))));
        assert!(!is_appimage(None, None));
        assert!(!is_appimage(Some(OsStr::new("")), Some(OsStr::new(""))));
    }

    #[test]
    fn limits_the_automatic_fallback_to_appimages() {
        assert_eq!(
            choose_rendering_policy(true, true, false, false, false, false),
            RenderingPolicy {
                set_force_shared_memory: true,
                set_disable_compositing: false,
            }
        );
        assert_eq!(
            choose_rendering_policy(false, true, false, false, false, false),
            RenderingPolicy::default()
        );
        assert_eq!(
            choose_rendering_policy(true, false, false, false, false, false),
            RenderingPolicy::default()
        );
    }

    #[test]
    fn preserves_every_explicit_webkit_rendering_choice() {
        for explicit_values in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            assert_eq!(
                choose_rendering_policy(
                    true,
                    true,
                    false,
                    explicit_values.0,
                    explicit_values.1,
                    explicit_values.2,
                ),
                RenderingPolicy::default()
            );
        }
    }

    #[test]
    fn safe_mode_is_explicit_and_does_not_replace_an_existing_value() {
        assert_eq!(
            choose_rendering_policy(true, true, true, false, false, false),
            RenderingPolicy {
                set_force_shared_memory: false,
                set_disable_compositing: true,
            }
        );
        assert_eq!(
            choose_rendering_policy(true, true, true, false, false, true),
            RenderingPolicy::default()
        );
    }

    #[test]
    fn recognizes_documented_safe_mode_values() {
        for value in ["1", "true", "TRUE", "yes", "on"] {
            assert!(is_truthy(Some(OsStr::new(value))));
        }
        assert!(!is_truthy(Some(OsStr::new("0"))));
        assert!(!is_truthy(None));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn honors_an_absolute_xdg_data_home() {
        assert_eq!(
            settings_path(Some(OsStr::new("/home/user")), Some(OsStr::new("/data"))),
            Some(Path::new("/data/com.cameronamer.telegramdrive/settings.json").to_path_buf())
        );
        assert_eq!(
            settings_path(Some(OsStr::new("/home/user")), Some(OsStr::new("relative"))),
            Some(
                Path::new("/home/user/.local/share/com.cameronamer.telegramdrive/settings.json")
                    .to_path_buf()
            )
        );
        assert_eq!(settings_path(None, None), None);
    }
}
