use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const DEFAULT_WEBDAV_PORT: u16 = 8551;
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WebDavSettingsFile {
    pub enabled: bool,
    pub port: u16,
    pub write_enabled: bool,
    pub token_hash: Option<String>,
}

impl Default for WebDavSettingsFile {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_WEBDAV_PORT,
            write_enabled: false,
            token_hash: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WebDavSettingsResponse {
    pub supported: bool,
    pub enabled: bool,
    pub port: u16,
    pub write_enabled: bool,
    pub token_set: bool,
    pub running: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WebDavTokenResponse {
    pub token: String,
    pub url: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("webdav_settings.json"))
}

pub fn load_settings(app: &AppHandle) -> WebDavSettingsFile {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &WebDavSettingsFile) -> Result<(), String> {
    let path = settings_path(app)?;
    let temp_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    if std::fs::rename(&temp_path, &path).is_ok() {
        return Ok(());
    }
    // Windows cannot atomically rename over an existing file. Fall back to an
    // overwriting copy while retaining the temp file until the copy succeeds.
    std::fs::copy(&temp_path, &path).map_err(|error| error.to_string())?;
    std::fs::remove_file(&temp_path).map_err(|error| error.to_string())
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn verify_token(token: &str, stored_hash: &str) -> bool {
    let computed = hash_token(token);
    constant_time_eq::constant_time_eq(computed.as_bytes(), stored_hash.as_bytes())
}

fn response(app: &AppHandle, settings: WebDavSettingsFile) -> WebDavSettingsResponse {
    let (running, last_error) = app
        .try_state::<crate::WebDavServerLifecycle>()
        .map(|state| state.0.status())
        .unwrap_or((false, None));

    WebDavSettingsResponse {
        supported: cfg!(not(any(target_os = "android", target_os = "ios"))),
        enabled: settings.enabled,
        port: settings.port,
        write_enabled: settings.write_enabled,
        token_set: settings.token_hash.is_some(),
        running,
        last_error,
    }
}

fn validate_port(app: &AppHandle, port: u16, enabling: bool) -> Result<(), String> {
    if port < 1024 {
        return Err("Port must be between 1024 and 65535".to_string());
    }
    if port == crate::STREAM_PORT {
        return Err(format!(
            "Port {} is used by the media streaming server",
            crate::STREAM_PORT
        ));
    }
    let api_settings = crate::commands::api_settings::load_settings(app);
    if enabling && api_settings.enabled && api_settings.port == port {
        return Err(format!("Port {} is already used by the REST API", port));
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_webdav_settings(app: AppHandle) -> Result<WebDavSettingsResponse, String> {
    Ok(response(&app, load_settings(&app)))
}

#[tauri::command]
pub async fn cmd_update_webdav_settings(
    enabled: bool,
    port: u16,
    write_enabled: bool,
    app: AppHandle,
) -> Result<WebDavSettingsResponse, String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Err("WebDAV hosting is available in the desktop app".to_string());
    }
    validate_port(&app, port, enabled)?;

    let write_guard = SETTINGS_WRITE_LOCK
        .lock()
        .map_err(|_| "WebDAV settings lock is unavailable".to_string())?;
    let mut settings = load_settings(&app);
    if enabled && settings.token_hash.is_none() {
        return Err("Generate a WebDAV connection link before enabling the server".to_string());
    }
    let changed = settings.enabled != enabled
        || settings.port != port
        || settings.write_enabled != write_enabled;
    settings.enabled = enabled;
    settings.port = port;
    settings.write_enabled = write_enabled;
    save_settings(&app, &settings)?;
    drop(write_guard);

    if changed {
        let _ = crate::restart_webdav_server(&app).await;
    }
    Ok(response(&app, settings))
}

#[tauri::command]
pub async fn cmd_regenerate_webdav_token(app: AppHandle) -> Result<WebDavTokenResponse, String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Err("WebDAV hosting is available in the desktop app".to_string());
    }
    let token: String = {
        let mut rng = rand::rng();
        let bytes: Vec<u8> = (0..32).map(|_| rand::Rng::random(&mut rng)).collect();
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    };

    let write_guard = SETTINGS_WRITE_LOCK
        .lock()
        .map_err(|_| "WebDAV settings lock is unavailable".to_string())?;
    let mut settings = load_settings(&app);
    settings.token_hash = Some(hash_token(&token));
    save_settings(&app, &settings)?;
    drop(write_guard);
    let _ = crate::restart_webdav_server(&app).await;

    Ok(WebDavTokenResponse {
        url: format!("http://127.0.0.1:{}/dav/{}/", settings.port, token),
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::{verify_token, WebDavSettingsFile, DEFAULT_WEBDAV_PORT};

    #[test]
    fn defaults_are_disabled_and_read_only() {
        let settings = WebDavSettingsFile::default();
        assert!(!settings.enabled);
        assert!(!settings.write_enabled);
        assert_eq!(settings.port, DEFAULT_WEBDAV_PORT);
        assert!(settings.token_hash.is_none());
    }

    #[test]
    fn token_verification_is_exact() {
        let expected = "97019edd94f27971f9253dce908be0578253e4bec41bf26344a558ea35e74666";
        assert!(verify_token("telegram-drive-webdav", expected));
        assert!(!verify_token("telegram-drive-webdaV", expected));
    }
}
