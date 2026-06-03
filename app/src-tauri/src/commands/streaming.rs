use tauri::State;

/// Holds the per-session streaming config (token + port)
pub struct StreamConfig {
    pub token: String,
    pub port: u16,
}

/// Returned to the frontend so it can construct stream URLs dynamically
#[derive(serde::Serialize)]
pub struct StreamInfo {
    pub token: String,
    pub base_url: String,
}

/// Returns the streaming server's session token and base URL to the frontend.
/// The frontend must use the returned base_url to construct stream URLs,
/// never hardcoding the port.
#[tauri::command]
pub fn cmd_get_stream_info(config: State<'_, StreamConfig>) -> StreamInfo {
    // Use 127.0.0.1 on Android (emulator loopback) and Windows (localhost
    // resolves to ::1 IPv6 first on many configurations, causing connection
    // refused since the server binds 0.0.0.0 IPv4 only).
    // macOS and Linux handle localhost → 127.0.0.1 correctly.
    #[cfg(any(target_os = "android", target_os = "windows"))]
    let host = "127.0.0.1";
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    let host = "localhost";

    StreamInfo {
        token: config.token.clone(),
        base_url: format!("http://{}:{}", host, config.port),
    }
}
