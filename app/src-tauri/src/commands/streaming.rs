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
    /// Decimal string preserves the full opaque u64 across JavaScript's
    /// 53-bit integer boundary.
    pub operation_token: Option<String>,
}

/// Returns the streaming server's session token and base URL to the frontend.
/// The frontend must use the returned base_url to construct stream URLs,
/// never hardcoding the port.
#[tauri::command]
pub fn cmd_get_stream_info(
    config: State<'_, StreamConfig>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
) -> StreamInfo {
    // Always use "localhost" on all platforms.
    // "localhost" is treated as a secure context by all major browser
    // engines (Chromium/WebView2, WebKit) and is exempt from Mixed Content
    // blocking.  This is critical on Windows where Tauri v2 serves the
    // frontend from https://tauri.localhost — fetching http://127.0.0.1
    // from an HTTPS origin triggers a Mixed Content block in WebView2.
    // The server binds exclusively to 127.0.0.1, so name resolution
    // differences between platforms are not a concern.
    let host = "localhost";
    let operation_token = crypto_state
        .current_session()
        .and_then(|session| {
            crypto_state
                .create_operation_handle(session, crate::crypto::state::OperationClass::MediaStream)
                .ok()
        })
        .map(|handle| handle.to_string());

    StreamInfo {
        token: config.token.clone(),
        base_url: format!("http://{}:{}", host, config.port),
        operation_token,
    }
}
