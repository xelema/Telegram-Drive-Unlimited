//! VPN Optimizer & Proxy Configuration
//!
//! Stores runtime network configuration that all network operations read from.
//! When vpnMode is off, helpers return hardcoded defaults (zero behaviour change).
//! When vpnMode is on, helpers return user-configured values.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::Write;
use std::sync::RwLock;
use tauri::Manager;

/// Proxy configuration received from the frontend
#[derive(Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub proxy_type: String, // "socks5" | "mtproto"
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing)]
    pub password: String, // Loaded from the OS credential store; never persisted as JSON.
}

impl fmt::Debug for ProxyConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProxyConfig")
            .field("enabled", &self.enabled)
            .field("proxy_type", &self.proxy_type)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            proxy_type: "socks5".into(),
            host: String::new(),
            port: 1080,
            username: String::new(),
            password: String::new(),
        }
    }
}

/// VPN optimizer configuration received from the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpnConfig {
    pub enabled: bool,
    pub timeout_multiplier: u32,    // 1–5
    pub retry_attempts: u32,        // 0–5
    pub retry_base_backoff_ms: u64, // 500–5000
    pub retry_max_backoff_ms: u64,  // 8000–60000
    pub adaptive_polling: bool,
    pub polling_min_sec: u32,      // 10–30
    pub polling_max_sec: u32,      // 45–120
    pub preferred_dc: String,      // "auto" | "dc1"–"dc5"
    pub dc_fallback_attempts: u32, // 1–4
    pub flood_wait_respect: bool,
    pub peer_cache_size: usize,        // 100–2000
    pub bandwidth_limit_up_kbs: u32,   // 0 = unlimited
    pub bandwidth_limit_down_kbs: u32, // 0 = unlimited
    pub chunk_size_kb: u32,            // 128, 256, 512
    pub keep_alive_interval_sec: u32,  // 0 = disabled, 30–120
    pub auto_detect_vpn: bool,
    pub archive_max_bytes: u64, // 0 = unlimited, max bytes for bulk archive (API)
}

impl Default for VpnConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            timeout_multiplier: 3,
            retry_attempts: 3,
            retry_base_backoff_ms: 1000,
            retry_max_backoff_ms: 30000,
            adaptive_polling: true,
            polling_min_sec: 15,
            polling_max_sec: 60,
            preferred_dc: "auto".into(),
            dc_fallback_attempts: 2,
            flood_wait_respect: true,
            peer_cache_size: 500,
            bandwidth_limit_up_kbs: 0,
            bandwidth_limit_down_kbs: 0,
            chunk_size_kb: 512,
            keep_alive_interval_sec: 0,
            auto_detect_vpn: false,
            archive_max_bytes: 256 * 1024 * 1024, // 256 MiB
        }
    }
}

/// Combined network config snapshot (what the frontend receives)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfigSnapshot {
    pub proxy: ProxyConfig,
    pub vpn: VpnConfig,
}

/// Thread-safe global state managed via Tauri's state system
pub struct NetworkConfig {
    pub proxy: RwLock<ProxyConfig>,
    pub vpn: RwLock<VpnConfig>,
    pub bridge_handle: std::sync::Mutex<Option<(u16, tokio::task::JoinHandle<()>)>>,
}

impl NetworkConfig {
    pub fn new() -> Self {
        Self {
            proxy: RwLock::new(ProxyConfig::default()),
            vpn: RwLock::new(VpnConfig::default()),
            bridge_handle: std::sync::Mutex::new(None),
        }
    }

    pub fn new_with_config(config: NetworkConfigSnapshot) -> Self {
        Self {
            proxy: RwLock::new(config.proxy),
            vpn: RwLock::new(config.vpn),
            bridge_handle: std::sync::Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> NetworkConfigSnapshot {
        NetworkConfigSnapshot {
            proxy: self.proxy.read().unwrap().clone(),
            vpn: self.vpn.read().unwrap().clone(),
        }
    }

    pub fn effective_proxy_url(&self) -> Option<String> {
        let proxy = self.proxy.read().unwrap();
        if !proxy.enabled || proxy.host.is_empty() {
            return None;
        }
        if proxy.proxy_type == "socks5" {
            if !proxy.username.is_empty() {
                let encoded_user = urlencoding::encode(&proxy.username);
                let encoded_pass = urlencoding::encode(&proxy.password);
                Some(format!(
                    "socks5://{}:{}@{}:{}",
                    encoded_user, encoded_pass, proxy.host, proxy.port
                ))
            } else {
                Some(format!("socks5://{}:{}", proxy.host, proxy.port))
            }
        } else if proxy.proxy_type == "http" || proxy.proxy_type == "https" {
            let guard = self.bridge_handle.lock().unwrap();
            if let Some((port, _)) = &*guard {
                Some(format!("socks5://127.0.0.1:{}", port))
            } else {
                None
            }
        } else {
            None
        }
    }

    pub async fn start_http_bridge(&self) -> Result<(), String> {
        self.stop_http_bridge();

        let (enabled, proxy_type, host, port, scheme, user, pass) = {
            let proxy = self.proxy.read().unwrap();
            (
                proxy.enabled,
                proxy.proxy_type.clone(),
                proxy.host.clone(),
                proxy.port,
                proxy.proxy_type.clone(),
                proxy.username.clone(),
                proxy.password.clone(),
            )
        };

        if !enabled || host.is_empty() || (proxy_type != "http" && proxy_type != "https") {
            return Ok(());
        }

        match crate::socks5_bridge::start_bridge(host, port, scheme, user, pass).await {
            Ok((local_port, handle)) => {
                let mut guard = self.bridge_handle.lock().unwrap();
                *guard = Some((local_port, handle));
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    pub fn stop_http_bridge(&self) {
        let mut guard = self.bridge_handle.lock().unwrap();
        if let Some((_, handle)) = guard.take() {
            handle.abort();
            log::info!("SOCKS5 bridge stopped.");
        }
    }

    // ── Helpers that return effective values ────────────────

    /// Network connect timeout in seconds. Default 5s, multiplied when VPN mode on.
    pub fn connect_timeout_secs(&self) -> u64 {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled {
            5 * vpn.timeout_multiplier as u64
        } else {
            5
        }
    }

    /// Network read/write timeout in seconds. Default 10s, multiplied when VPN mode on.
    pub fn rw_timeout_secs(&self) -> u64 {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled {
            10 * vpn.timeout_multiplier as u64
        } else {
            10
        }
    }

    /// How many retry attempts for API calls. Default 0 (no retry) when VPN off.
    pub fn retry_attempts(&self) -> u32 {
        let vpn = self.vpn.read().unwrap();
        // One reliability retry is always available so mandatory Telegram
        // FLOOD_WAIT cooling periods can resume even when VPN tuning is off.
        if vpn.enabled {
            vpn.retry_attempts
        } else {
            1
        }
    }

    /// Base backoff duration in milliseconds for retries.
    pub fn retry_base_backoff_ms(&self) -> u64 {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled {
            vpn.retry_base_backoff_ms
        } else {
            1000
        }
    }

    /// Max backoff duration in milliseconds for retries.
    pub fn retry_max_backoff_ms(&self) -> u64 {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled {
            vpn.retry_max_backoff_ms
        } else {
            30000
        }
    }

    /// Whether to automatically sleep on FLOOD_WAIT errors.
    pub fn should_respect_flood_wait(&self) -> bool {
        let vpn = self.vpn.read().unwrap();
        // Telegram rate limits must be honored on every network. The setting
        // remains an advanced override while VPN mode is active.
        if vpn.enabled {
            vpn.flood_wait_respect
        } else {
            true
        }
    }

    /// Peer cache size. Default 500.
    pub fn peer_cache_size(&self) -> usize {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled {
            vpn.peer_cache_size
        } else {
            500
        }
    }

    /// Whether proxy is active and has a valid host.
    pub fn is_proxy_active(&self) -> bool {
        let proxy = self.proxy.read().unwrap();
        proxy.enabled && !proxy.host.is_empty()
    }

    /// Get proxy address as "host:port" if active.
    pub fn proxy_addr(&self) -> Option<String> {
        let proxy = self.proxy.read().unwrap();
        if proxy.enabled && !proxy.host.is_empty() {
            Some(format!("{}:{}", proxy.host, proxy.port))
        } else {
            None
        }
    }

    /// Upload bandwidth limit in bytes/sec. 0 = unlimited.
    pub fn upload_limit_bytes_per_sec(&self) -> u64 {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled && vpn.bandwidth_limit_up_kbs > 0 {
            vpn.bandwidth_limit_up_kbs as u64 * 1024
        } else {
            0 // unlimited
        }
    }

    /// Download bandwidth limit in bytes/sec. 0 = unlimited.
    pub fn download_limit_bytes_per_sec(&self) -> u64 {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled && vpn.bandwidth_limit_down_kbs > 0 {
            vpn.bandwidth_limit_down_kbs as u64 * 1024
        } else {
            0 // unlimited
        }
    }

    /// Chunk size in bytes for transfers.
    pub fn chunk_size_bytes(&self) -> usize {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled {
            (vpn.chunk_size_kb as usize) * 1024
        } else {
            512 * 1024 // default 512KB
        }
    }

    /// Keep-alive ping interval in seconds. 0 = disabled.
    pub fn keep_alive_interval_sec(&self) -> u32 {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled {
            vpn.keep_alive_interval_sec
        } else {
            0
        }
    }

    /// Maximum total uncompressed bytes for a single bulk archive (API).
    /// 0 = unlimited.
    pub fn archive_max_bytes(&self) -> u64 {
        let vpn = self.vpn.read().unwrap();
        if vpn.enabled {
            vpn.archive_max_bytes // 0 = unlimited when VPN is on
        } else {
            256 * 1024 * 1024 // default 256 MiB when VPN off
        }
    }
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute exponential backoff with jitter for a given attempt.
/// Returns duration in milliseconds.
pub fn backoff_ms(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let exp = base_ms.saturating_mul(1u64 << attempt.min(10));
    let capped = exp.min(max_ms);
    // Add ~25% jitter
    let jitter = (capped as f64 * 0.25 * rand::random::<f64>()) as u64;
    capped + jitter
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("network_settings.json"))
}

pub fn load_network_config(app: &tauri::AppHandle) -> NetworkConfigSnapshot {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => {
            return NetworkConfigSnapshot {
                proxy: ProxyConfig::default(),
                vpn: VpnConfig::default(),
            }
        }
    };
    let mut snapshot = match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|_| NetworkConfigSnapshot {
            proxy: ProxyConfig::default(),
            vpn: VpnConfig::default(),
        }),
        Err(_) => NetworkConfigSnapshot {
            proxy: ProxyConfig::default(),
            vpn: VpnConfig::default(),
        },
    };

    // Scrub a legacy plaintext password only after the credential store
    // confirms the write. If migration fails, retain the value in memory and
    // leave the source file untouched so credentials are not lost.
    let legacy_password = std::mem::take(&mut snapshot.proxy.password);
    if !legacy_password.is_empty() {
        match crate::proxy_secret::store_password(&legacy_password) {
            Ok(()) => {
                snapshot.proxy.password = legacy_password;
                if let Err(error) = save_network_config(app, &snapshot) {
                    log::error!(
                        "Unable to scrub migrated proxy credentials from legacy settings: {error}"
                    );
                }
            }
            Err(error) => {
                log::error!("Proxy credential migration could not use secure storage: {error}");
                snapshot.proxy.password = legacy_password;
            }
        }
    } else {
        match crate::proxy_secret::load_password() {
            Ok(Some(password)) => snapshot.proxy.password = password,
            Ok(None) => {}
            Err(error) => log::error!("Unable to load the saved proxy credential: {error}"),
        }
    }

    snapshot
}

pub fn save_network_config(
    app: &tauri::AppHandle,
    config: &NetworkConfigSnapshot,
) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(json.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(file);
    replace_network_settings_file(&temporary, &path).map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
fn replace_network_settings_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_network_settings_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    fn wide(path: &std::path::Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let source = wide(source);
    let destination = wide(destination);
    let result = unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_password_is_not_serialized_or_debugged() {
        let proxy = ProxyConfig {
            enabled: true,
            proxy_type: "socks5".to_string(),
            host: "proxy.example".to_string(),
            port: 1080,
            username: "alice".to_string(),
            password: "top-secret".to_string(),
        };
        let serialized = serde_json::to_string(&proxy).unwrap();
        let debug = format!("{proxy:?}");

        assert!(!serialized.contains("top-secret"));
        assert!(!serialized.contains("password"));
        assert!(!debug.contains("top-secret"));
        assert!(debug.contains("[REDACTED]"));
    }
}
