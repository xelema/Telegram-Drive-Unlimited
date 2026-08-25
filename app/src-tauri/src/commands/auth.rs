use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use grammers_client::Client;
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use grammers_session::types::{PeerAuth, PeerInfo, UpdateState, UpdatesState};
use grammers_session::Session;
use grammers_tl_types as tl;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tauri::Manager;
use tauri::State;
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

use crate::commands::utils::map_error;
use crate::commands::PhoneLoginState;
use crate::models::{AuthCodeDelivery, AuthCodeRequestResult, AuthCodeRequestStatus, AuthResult};
use crate::TelegramState;
use grammers_client::types::PasswordToken;
use grammers_mtsender::InvocationError;

/// Ensures the Telegram client is initialized.
///
/// IMPORTANT: This function properly manages runner lifecycle to prevent stack overflow.
/// Before spawning a new runner, it signals the old runner to shutdown.
pub async fn ensure_client_initialized(
    app_handle: &tauri::AppHandle,
    state: &State<'_, TelegramState>,
    api_id: i32,
) -> Result<Client, String> {
    #[cfg(target_os = "android")]
    {
        let mut count = 0;
        while ndk_context::android_context().vm().is_null()
            || ndk_context::android_context().context().is_null()
        {
            if count >= 200 {
                // 10 seconds timeout
                return Err("Timeout waiting for Android JNI context initialization.".to_string());
            }
            log::info!(
                "Waiting for Android JNI context to initialize ({}ms)...",
                count * 50
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
            count += 1;
        }
        log::info!("Android JNI context is ready!");
    }

    let mut client_guard = state.client.lock().await;

    if let Some(client) = client_guard.as_ref() {
        return Ok(client.clone());
    }

    // CRITICAL: Shutdown existing runner before creating a new one
    // This prevents runner task accumulation which causes stack overflow
    let did_shutdown_old_runner = {
        let mut guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = guard.take() {
            log::info!("Signaling old runner to shutdown...");
            let _ = shutdown_tx.send(());
            true
        } else {
            false
        }
    }; // MutexGuard dropped here — before the await
    if did_shutdown_old_runner {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let runner_num = state.runner_count.fetch_add(1, Ordering::SeqCst) + 1;
    log::info!(
        "Initializing Telegram Client #{} with API ID: {}",
        runner_num,
        api_id
    );

    // Resolve session path safely
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }

    let session_path = app_data_dir.join("telegram.session");
    let session_path_str = session_path.to_string_lossy().to_string();
    log::info!("Opening session at: {}", session_path_str);

    let mut session_open_result = SqliteSession::open(&session_path_str);

    // Retry opening the session database up to 5 times (every 100ms)
    // in case the database is temporarily locked by the old shutting down runner.
    if session_open_result.is_err() {
        for attempt in 1..=5 {
            log::warn!("Failed to open session on attempt {} (database may be locked). Retrying in 100ms...", attempt);
            tokio::time::sleep(Duration::from_millis(100)).await;
            session_open_result = SqliteSession::open(&session_path_str);
            if session_open_result.is_ok() {
                break;
            }
        }
    }

    let session = match session_open_result.map_err(|e| e.to_string()) {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                "Session file could not be opened after retries ({}). Recreating...",
                e
            );
            let _ = std::fs::remove_file(&session_path);
            let _ = std::fs::remove_file(format!("{}-wal", session_path_str));
            let _ = std::fs::remove_file(format!("{}-shm", session_path_str));

            SqliteSession::open(&session_path_str)
                .map_err(|err| format!("Failed to open session after recreation: {}", err))?
        }
    };

    let net_config = app_handle.state::<Arc<crate::vpn_optimizer::NetworkConfig>>();
    let preferred_dc = {
        let vpn = net_config.vpn.read().unwrap();
        if vpn.enabled {
            vpn.preferred_dc.clone()
        } else {
            "auto".to_string()
        }
    };
    if preferred_dc.starts_with("dc") && preferred_dc.len() > 2 {
        if let Ok(dc_id) = preferred_dc[2..].parse::<i32>() {
            log::info!("Setting preferred home DC ID: {}", dc_id);
            session.set_home_dc_id(dc_id);
        }
    }

    let mut connection_params = grammers_mtsender::ConnectionParams::default();
    if let Some(proxy_url) = net_config.effective_proxy_url() {
        let proxy = net_config.proxy.read().map_err(|error| error.to_string())?;
        log::info!(
            "Using configured {} proxy at {}:{} (credentials redacted)",
            proxy.proxy_type,
            proxy.host,
            proxy.port
        );
        drop(proxy);
        connection_params.proxy_url = Some(proxy_url);
    }

    let session = Arc::new(session);
    *state.session.lock().await = Some(session.clone());
    let pool = SenderPool::with_configuration(session, api_id, connection_params);
    let client = Client::new(&pool);

    // Create shutdown channel for this runner
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    *state.runner_shutdown.lock().unwrap() = Some(shutdown_tx);

    // Spawn the network runner with shutdown support
    let SenderPool { runner, .. } = pool;
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            // Normal runner operation
            _ = runner.run() => {
                log::info!("Runner #{} exited normally", runner_num);
            }
            // Shutdown requested
            _ = shutdown_rx => {
                log::info!("Runner #{} shutdown requested, exiting", runner_num);
            }
        }
    });

    *client_guard = Some(client.clone());
    Ok(client)
}

#[tauri::command]
pub async fn cmd_connect(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    api_id: i32,
) -> Result<bool, String> {
    // Store API ID for auto-reconnect
    *state.api_id.lock().await = Some(api_id);
    ensure_client_initialized(&app_handle, &state, api_id).await?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_check_connection(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // 1. Check if client exists and is responsive
    let client_msg_opt = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned()
    };

    if let Some(client) = client_msg_opt {
        // Ping (e.g., get_me)
        if client.get_me().await.is_ok() {
            return Ok(true);
        }
        log::warn!("Connection check failed (get_me). Attempting reconnect...");
    } else {
        log::warn!("Connection check: No client found. Checking for saved API ID...");
    }

    // 2. Reconnect Logic
    let api_id_opt = *state.api_id.lock().await;
    if let Some(api_id) = api_id_opt {
        // Force re-init: Clear old client first to ensure fresh pool
        *state.client.lock().await = None;

        match ensure_client_initialized(&app_handle, &state, api_id).await {
            Ok(c) => {
                // Double check
                if c.get_me().await.is_ok() {
                    log::info!("Auto-reconnect successful.");
                    return Ok(true);
                } else {
                    return Err("Reconnect succeeded but ping failed.".to_string());
                }
            }
            Err(e) => return Err(format!("Auto-reconnect failed: {}", e)),
        }
    }

    Ok(false) // Not connected and no credentials to reconnect
}

#[tauri::command]
pub async fn cmd_reconnect_with_network_settings(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let api_id = *state.api_id.lock().await;
    let api_id = match api_id {
        Some(id) => id,
        None => return Err("Not authenticated — no API ID saved.".into()),
    };

    log::info!("Reconnecting with updated network settings...");

    // 1. Shutdown existing runner
    {
        let mut shutdown_guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = shutdown_guard.take() {
            log::info!("Signaling runner shutdown for reconnect...");
            let _ = shutdown_tx.send(());
        }
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 2. Clear old client
    *state.client.lock().await = None;

    // 3. Reinitialize with current network config (reads from NetworkConfig state)
    let client = ensure_client_initialized(&app_handle, &state, api_id).await?;

    // 4. Verify the new connection works
    match client.get_me().await {
        Ok(_me) => {
            log::info!("Reconnect successful — verified via get_me().");
            Ok(true)
        }
        Err(e) => {
            log::error!("Reconnect init succeeded but get_me failed: {}", e);
            Err(format!("Reconnected but ping failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn cmd_logout(
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
) -> Result<bool, String> {
    log::info!("Logging out...");
    crypto_state.lock();

    // 1. Shutdown the network runner FIRST to prevent any operations
    {
        let mut shutdown_guard = state.runner_shutdown.lock().unwrap();
        if let Some(shutdown_tx) = shutdown_guard.take() {
            log::info!("Signaling runner shutdown for logout...");
            let _ = shutdown_tx.send(());
        }
    }

    // 2. Try to sign out from Telegram (if connected)
    let client_opt = { state.client.lock().await.clone() };
    if let Some(client) = client_opt {
        // We don't strictly care if this fails (e.g. network down), we just want to clear local state.
        let _ = client.sign_out().await;
    }

    // 3. Clear State
    *state.client.lock().await = None;
    state.auth_attempt_counter.fetch_add(1, Ordering::SeqCst);
    *state.phone_login.lock().await = None;
    *state.password_token.lock().await = None;
    *state.api_id.lock().await = None;
    *state.session.lock().await = None;
    crate::commands::utils::clear_peer_cache(&state.peer_cache).await;
    state.active_file_loads.write().await.clear();
    state.cancelled_transfers.write().await.clear();

    // 4. Remove Session File
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let session_path = app_data_dir.join("telegram.session");
    let _ = std::fs::remove_file(session_path);
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session-wal"));
    let _ = std::fs::remove_file(app_data_dir.join("telegram.session-shm"));

    log::info!(
        "Logout complete. Vault locked. Runner count: {}",
        state.runner_count.load(Ordering::SeqCst)
    );
    Ok(true)
}

fn normalize_phone_number(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let mut normalized = String::with_capacity(trimmed.len());

    for (index, character) in trimmed.chars().enumerate() {
        if character.is_ascii_digit() || (character == '+' && index == 0) {
            normalized.push(character);
        } else if character.is_whitespace() || matches!(character, '-' | '(' | ')' | '.') {
            continue;
        } else {
            return Err(
                "Enter the phone number in international format, for example +15551234567."
                    .to_string(),
            );
        }
    }

    let digits = normalized.strip_prefix('+').ok_or_else(|| {
        "Enter the phone number in international format, starting with + and the country code."
            .to_string()
    })?;

    if !(7..=15).contains(&digits.len())
        || digits.starts_with('0')
        || !digits.chars().all(|character| character.is_ascii_digit())
    {
        return Err(
            "Enter a valid international phone number, for example +15551234567.".to_string(),
        );
    }

    Ok(normalized)
}

fn redact_phone_number(phone: &str) -> String {
    let visible_start = phone.chars().take(2).collect::<String>();
    let visible_end = phone
        .chars()
        .rev()
        .take(2)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{}••••{}", visible_start, visible_end)
}

fn map_next_delivery(delivery: &tl::enums::auth::CodeType) -> AuthCodeDelivery {
    match delivery {
        tl::enums::auth::CodeType::Sms => AuthCodeDelivery::Sms,
        tl::enums::auth::CodeType::Call => AuthCodeDelivery::Call,
        tl::enums::auth::CodeType::FlashCall => AuthCodeDelivery::FlashCall,
        tl::enums::auth::CodeType::MissedCall => AuthCodeDelivery::MissedCall,
        tl::enums::auth::CodeType::FragmentSms => AuthCodeDelivery::Fragment,
    }
}

fn describe_sent_code(code: &tl::types::auth::SentCode) -> AuthCodeRequestResult {
    let (delivery, code_length, destination_hint, fragment_url, numeric_code) = match &code.r#type {
        tl::enums::auth::SentCodeType::App(value) => (
            AuthCodeDelivery::TelegramApp,
            Some(value.length),
            None,
            None,
            true,
        ),
        tl::enums::auth::SentCodeType::Sms(value) => {
            (AuthCodeDelivery::Sms, Some(value.length), None, None, true)
        }
        tl::enums::auth::SentCodeType::Call(value) => {
            (AuthCodeDelivery::Call, Some(value.length), None, None, true)
        }
        tl::enums::auth::SentCodeType::FlashCall(value) => (
            AuthCodeDelivery::FlashCall,
            None,
            Some(value.pattern.clone()),
            None,
            true,
        ),
        tl::enums::auth::SentCodeType::MissedCall(value) => (
            AuthCodeDelivery::MissedCall,
            Some(value.length),
            Some(value.prefix.clone()),
            None,
            true,
        ),
        tl::enums::auth::SentCodeType::EmailCode(value) => (
            AuthCodeDelivery::Email,
            Some(value.length),
            Some(value.email_pattern.clone()),
            None,
            true,
        ),
        tl::enums::auth::SentCodeType::SetUpEmailRequired(_) => {
            (AuthCodeDelivery::EmailSetup, None, None, None, false)
        }
        tl::enums::auth::SentCodeType::FragmentSms(value) => (
            AuthCodeDelivery::Fragment,
            Some(value.length),
            None,
            Some(value.url.clone()),
            true,
        ),
        tl::enums::auth::SentCodeType::FirebaseSms(value) => (
            AuthCodeDelivery::Firebase,
            Some(value.length),
            None,
            None,
            true,
        ),
        tl::enums::auth::SentCodeType::SmsWord(value) => (
            AuthCodeDelivery::SmsWord,
            None,
            value.beginning.clone(),
            None,
            false,
        ),
        tl::enums::auth::SentCodeType::SmsPhrase(value) => (
            AuthCodeDelivery::SmsPhrase,
            None,
            value.beginning.clone(),
            None,
            false,
        ),
    };

    let status = if matches!(
        delivery,
        AuthCodeDelivery::EmailSetup | AuthCodeDelivery::Firebase | AuthCodeDelivery::Unsupported
    ) {
        AuthCodeRequestStatus::QrRecommended
    } else {
        AuthCodeRequestStatus::CodeRequired
    };

    AuthCodeRequestResult {
        status,
        delivery,
        code_length,
        destination_hint,
        fragment_url,
        resend_after_seconds: Some(code.timeout.unwrap_or(60).max(0)),
        next_delivery: code.next_type.as_ref().map(map_next_delivery),
        numeric_code,
    }
}

fn map_auth_error(error: InvocationError) -> String {
    let raw = error.to_string();
    let mappings = [
        ("API_ID_INVALID", "The API ID or API Hash is invalid."),
        (
            "API_ID_PUBLISHED_FLOOD",
            "Telegram has disabled this API ID because it was published. Create new API credentials.",
        ),
        ("PHONE_NUMBER_INVALID", "Telegram rejected that phone number. Check the country code and try again."),
        ("PHONE_NUMBER_BANNED", "Telegram has banned this phone number."),
        ("PHONE_NUMBER_FLOOD", "Too many login codes were requested for this phone number. Please wait before trying again."),
        ("PHONE_PASSWORD_FLOOD", "Too many login attempts were made. Please wait before trying again."),
        ("SMS_CODE_CREATE_FAILED", "Telegram could not create a login code. Use QR login or try again later."),
        ("SEND_CODE_UNAVAILABLE", "Telegram has no additional code-delivery method available. Use QR login instead."),
        ("UPDATE_APP_TO_LOGIN", "Telegram requires a newer authentication protocol. Please update Telegram Drive."),
    ];

    for (needle, message) in mappings {
        if raw.contains(needle) {
            return message.to_string();
        }
    }

    map_error(error)
}

async fn current_client(state: &TelegramState) -> Result<Client, String> {
    state
        .client
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "Telegram client is not initialized.".to_string())
}

async fn invoke_send_code(
    client: &Client,
    state: &TelegramState,
    request: &tl::functions::auth::SendCode,
) -> Result<tl::enums::auth::SentCode, String> {
    let mut transient_attempts = 0u8;
    let mut migrated = false;

    loop {
        let response = timeout(Duration::from_secs(30), client.invoke(request))
            .await
            .map_err(|_| "Telegram did not respond while requesting a code. Check your connection or proxy settings.".to_string())?;

        match response {
            Ok(sent_code) => return Ok(sent_code),
            Err(InvocationError::Rpc(error)) if error.code == 303 && !migrated => {
                let dc_id = error
                    .value
                    .and_then(|value| i32::try_from(value).ok())
                    .ok_or_else(|| {
                        "Telegram requested an invalid data-center migration.".to_string()
                    })?;
                let session = state
                    .session
                    .lock()
                    .await
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| "Telegram session is not initialized.".to_string())?;
                session.set_home_dc_id(dc_id);
                migrated = true;
                log::info!("Telegram login moved to data center {}", dc_id);
            }
            Err(error)
                if transient_attempts < 1
                    && (error.to_string().contains("AUTH_RESTART")
                        || matches!(&error, InvocationError::Rpc(rpc) if rpc.code == 500)) =>
            {
                transient_attempts += 1;
                log::warn!("Telegram requested an authentication restart; retrying once");
            }
            Err(error) => return Err(map_auth_error(error)),
        }
    }
}

async fn complete_raw_login(
    client: &Client,
    state: &TelegramState,
    authorization: tl::types::auth::Authorization,
) -> Result<(), String> {
    let session = state
        .session
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "Telegram session is not initialized.".to_string())?;

    match &authorization.user {
        tl::enums::User::User(user) => {
            session.cache_peer(&PeerInfo::User {
                id: user.id,
                auth: Some(
                    user.access_hash
                        .map(PeerAuth::from_hash)
                        .unwrap_or_default(),
                ),
                bot: Some(user.bot),
                is_self: Some(true),
            });
        }
        tl::enums::User::Empty(user) => {
            session.cache_peer(&PeerInfo::User {
                id: user.id,
                auth: Some(PeerAuth::default()),
                bot: Some(false),
                is_self: Some(true),
            });
        }
    }

    if let Ok(Ok(tl::enums::updates::State::State(update))) = timeout(
        Duration::from_secs(15),
        client.invoke(&tl::functions::updates::GetState {}),
    )
    .await
    {
        session.set_update_state(UpdateState::All(UpdatesState {
            pts: update.pts,
            qts: update.qts,
            date: update.date,
            seq: update.seq,
            channels: Vec::new(),
        }));
    }

    Ok(())
}

async fn store_sent_code(
    client: &Client,
    state: &TelegramState,
    attempt_id: u64,
    phone: String,
    sent_code: tl::enums::auth::SentCode,
) -> Result<AuthCodeRequestResult, String> {
    if state.auth_attempt_counter.load(Ordering::SeqCst) != attempt_id {
        return Err("This login request was replaced by a newer attempt.".to_string());
    }

    match sent_code {
        tl::enums::auth::SentCode::Code(code) => {
            let delivery = describe_sent_code(&code);
            let resend_after = delivery.resend_after_seconds.unwrap_or(60).max(0) as u64;
            *state.phone_login.lock().await = Some(PhoneLoginState {
                attempt_id,
                phone,
                phone_code_hash: code.phone_code_hash,
                delivery: delivery.clone(),
                resend_available_at: Instant::now() + Duration::from_secs(resend_after),
                request_in_flight: false,
            });
            Ok(delivery)
        }
        tl::enums::auth::SentCode::Success(success) => match success.authorization {
            tl::enums::auth::Authorization::Authorization(authorization) => {
                complete_raw_login(client, state, authorization).await?;
                *state.phone_login.lock().await = None;
                Ok(AuthCodeRequestResult {
                    status: AuthCodeRequestStatus::Authorized,
                    delivery: AuthCodeDelivery::TelegramApp,
                    code_length: None,
                    destination_hint: None,
                    fragment_url: None,
                    resend_after_seconds: None,
                    next_delivery: None,
                    numeric_code: true,
                })
            }
            tl::enums::auth::Authorization::SignUpRequired(_) => Err(
                "This phone number must be registered in an official Telegram app before it can be used here."
                    .to_string(),
            ),
        },
        tl::enums::auth::SentCode::PaymentRequired(_) => {
            *state.phone_login.lock().await = None;
            Ok(AuthCodeRequestResult {
                status: AuthCodeRequestStatus::QrRecommended,
                delivery: AuthCodeDelivery::Unsupported,
                code_length: None,
                destination_hint: None,
                fragment_url: None,
                resend_after_seconds: None,
                next_delivery: None,
                numeric_code: false,
            })
        }
    }
}

#[tauri::command]
pub async fn cmd_auth_request_code(
    app_handle: tauri::AppHandle,
    phone: String,
    api_id: i32,
    api_hash: String,
    state: State<'_, TelegramState>,
) -> Result<AuthCodeRequestResult, String> {
    if api_hash.trim().is_empty() {
        return Err("API Hash cannot be empty.".to_string());
    }

    let phone = normalize_phone_number(&phone)?;
    let attempt_id = state.auth_attempt_counter.fetch_add(1, Ordering::SeqCst) + 1;
    *state.phone_login.lock().await = None;
    *state.password_token.lock().await = None;

    // Store API ID
    *state.api_id.lock().await = Some(api_id);

    let client_handle = ensure_client_initialized(&app_handle, &state, api_id).await?;

    log::info!("Requesting login code for {}", redact_phone_number(&phone));

    let request = tl::functions::auth::SendCode {
        phone_number: phone.clone(),
        api_id,
        api_hash,
        settings: tl::types::CodeSettings {
            allow_flashcall: false,
            current_number: false,
            allow_app_hash: false,
            allow_missed_call: true,
            allow_firebase: false,
            unknown_number: false,
            logout_tokens: None,
            token: None,
            app_sandbox: None,
        }
        .into(),
    };

    let sent_code = invoke_send_code(&client_handle, &state, &request).await?;
    store_sent_code(&client_handle, &state, attempt_id, phone, sent_code).await
}

#[tauri::command]
pub async fn cmd_auth_resend_code(
    state: State<'_, TelegramState>,
) -> Result<AuthCodeRequestResult, String> {
    let client = current_client(&state).await?;
    let login = {
        let mut guard = state.phone_login.lock().await;
        let login = guard
            .as_mut()
            .ok_or("No active phone login. Start again with your phone number.")?;

        if login.request_in_flight {
            return Err("A login request is already in progress.".to_string());
        }

        let now = Instant::now();
        if now < login.resend_available_at {
            let remaining = login
                .resend_available_at
                .duration_since(now)
                .as_secs()
                .max(1);
            return Err(format!("The code can be resent in {} seconds.", remaining));
        }

        login.request_in_flight = true;
        login.clone()
    };

    let request = tl::functions::auth::ResendCode {
        phone_number: login.phone.clone(),
        phone_code_hash: login.phone_code_hash,
        reason: None,
    };

    let sent_code = match timeout(Duration::from_secs(30), client.invoke(&request)).await {
        Ok(Ok(sent_code)) => sent_code,
        Ok(Err(error)) => {
            if let Some(active) = state.phone_login.lock().await.as_mut() {
                if active.attempt_id == login.attempt_id {
                    active.request_in_flight = false;
                }
            }
            return Err(map_auth_error(error));
        }
        Err(_) => {
            if let Some(active) = state.phone_login.lock().await.as_mut() {
                if active.attempt_id == login.attempt_id {
                    active.request_in_flight = false;
                }
            }
            return Err(
                "Telegram did not respond while resending the code. Please try again.".to_string(),
            );
        }
    };

    store_sent_code(&client, &state, login.attempt_id, login.phone, sent_code).await
}

#[tauri::command]
pub async fn cmd_auth_cancel_code(state: State<'_, TelegramState>) -> Result<bool, String> {
    state.auth_attempt_counter.fetch_add(1, Ordering::SeqCst);
    *state.password_token.lock().await = None;
    let login = state.phone_login.lock().await.take();

    let Some(login) = login else {
        return Ok(true);
    };

    let client = current_client(&state).await?;
    let request = tl::functions::auth::CancelCode {
        phone_number: login.phone,
        phone_code_hash: login.phone_code_hash,
    };

    match timeout(Duration::from_secs(10), client.invoke(&request)).await {
        Ok(Ok(_)) => Ok(true),
        Ok(Err(error)) => {
            log::warn!("Telegram rejected login-code cancellation: {}", error);
            Ok(true)
        }
        Err(_) => {
            log::warn!("Telegram login-code cancellation timed out");
            Ok(true)
        }
    }
}

#[tauri::command]
pub async fn cmd_auth_sign_in(
    code: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    log::info!("Signing in with code...");

    let code = code.trim();
    if code.is_empty() {
        return Err("Enter the authentication code you received.".to_string());
    }

    let client = current_client(&state).await?;
    let login = state
        .phone_login
        .lock()
        .await
        .clone()
        .ok_or("No active phone login. Start again with your phone number.")?;

    let request = tl::functions::auth::SignIn {
        phone_number: login.phone,
        phone_code_hash: login.phone_code_hash,
        phone_code: Some(code.to_string()),
        email_verification: None,
    };

    match timeout(Duration::from_secs(30), client.invoke(&request)).await {
        Err(_) => Err("Telegram did not respond while verifying the code. Please try again.".to_string()),
        Ok(Ok(tl::enums::auth::Authorization::Authorization(auth))) => {
            complete_raw_login(&client, &state, auth).await?;
            *state.phone_login.lock().await = None;
            log::info!("Successfully logged in with a phone code.");
            Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Ok(Ok(tl::enums::auth::Authorization::SignUpRequired(_))) => {
            Err("This phone number must be registered in an official Telegram app before it can be used here.".to_string())
        }
        Ok(Err(error)) if error.is("SESSION_PASSWORD_NEEDED") => {
            let password: tl::types::account::Password = timeout(
                Duration::from_secs(30),
                client.invoke(&tl::functions::account::GetPassword {}),
            )
            .await
            .map_err(|_| "Telegram did not respond while requesting two-step verification.".to_string())?
            .map_err(map_auth_error)?
            .into();
            *state.password_token.lock().await = Some(PasswordToken::new(password));

            Ok(AuthResult {
                success: false,
                next_step: Some("password".to_string()),
                error: None,
            })
        }
        Ok(Err(error)) if error.is("PHONE_CODE_EMPTY") => {
            Err("Enter the authentication code you received.".to_string())
        }
        Ok(Err(error)) if error.is("PHONE_CODE_INVALID") => {
            Err("That authentication code is invalid. Check it and try again.".to_string())
        }
        Ok(Err(error)) if error.is("PHONE_CODE_EXPIRED") => {
            Err("That authentication code has expired. Request a new code.".to_string())
        }
        Ok(Err(error)) => Err(map_auth_error(error)),
    }
}

#[tauri::command]
pub async fn cmd_auth_check_password(
    password: String,
    state: State<'_, TelegramState>,
) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let mut pw_guard = state.password_token.lock().await;
    let pw_token = pw_guard.take().ok_or("No password session found")?;

    match client.check_password(pw_token, password.as_str()).await {
        Ok(_user) => {
            log::info!("2FA Success.");
            *state.phone_login.lock().await = None;
            Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(e) => Err(format!("2FA Failed: {}", e)),
    }
}

/// QR Login -- Step 1: Export a login token and return the `tg://login?token=...` URL.
/// The frontend renders this as a QR code for the user to scan with their phone.
#[tauri::command]
pub async fn cmd_auth_qr_login(
    app_handle: tauri::AppHandle,
    api_id: i32,
    api_hash: String,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    if api_hash.trim().is_empty() {
        return Err("API Hash cannot be empty.".to_string());
    }

    // Store API ID
    *state.api_id.lock().await = Some(api_id);

    let client = ensure_client_initialized(&app_handle, &state, api_id).await?;

    // Switching authentication methods invalidates any outstanding phone-code flow.
    state.auth_attempt_counter.fetch_add(1, Ordering::SeqCst);
    let previous_phone_login = state.phone_login.lock().await.take();
    *state.password_token.lock().await = None;
    if let Some(login) = previous_phone_login {
        let cancel = tl::functions::auth::CancelCode {
            phone_number: login.phone,
            phone_code_hash: login.phone_code_hash,
        };
        let _ = timeout(Duration::from_secs(10), client.invoke(&cancel)).await;
    }

    log::info!("Requesting QR login token...");

    let result = client
        .invoke(&tl::functions::auth::ExportLoginToken {
            api_id,
            api_hash: api_hash.clone(),
            except_ids: vec![],
        })
        .await
        .map_err(|e| format!("ExportLoginToken failed: {}", e))?;

    match result {
        tl::enums::auth::LoginToken::Token(t) => {
            let encoded = URL_SAFE_NO_PAD.encode(&t.token);
            let url = format!("tg://login?token={}", encoded);
            log::info!("QR login URL generated, expires at {}", t.expires);
            Ok(url)
        }
        tl::enums::auth::LoginToken::Success(_s) => {
            // Already authorized (e.g. from a previous session)
            log::info!("QR login: already authorized");
            Ok("__authorized__".to_string())
        }
        tl::enums::auth::LoginToken::MigrateTo(m) => {
            log::info!("QR login: need to migrate to DC {}", m.dc_id);
            let encoded = URL_SAFE_NO_PAD.encode(&m.token);
            let url = format!("tg://login?token={}", encoded);
            Ok(url)
        }
    }
}

/// QR Login -- Step 2: Poll for scan completion.
/// Checks if the session became authorized after the user scanned the QR code.
///
/// IMPORTANT: We must NOT call auth.exportLoginToken here for polling.
/// Each call to exportLoginToken generates a NEW token and invalidates the
/// previous one, causing the scanned QR code to fail with "Invalid code".
/// Instead, we check is_authorized() which succeeds once the phone app
/// accepts the token via auth.acceptLoginToken.
#[tauri::command]
pub async fn cmd_auth_qr_poll(state: State<'_, TelegramState>) -> Result<AuthResult, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    // Check if the session is now authorized (user scanned QR on phone)
    match client.is_authorized().await {
        Ok(true) => {
            log::info!("QR login: session authorized!");
            *state.phone_login.lock().await = None;
            Ok(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Ok(false) => {
            // Not yet scanned or accepted
            Ok(AuthResult {
                success: false,
                next_step: Some("waiting".to_string()),
                error: None,
            })
        }
        Err(e) => {
            log::warn!("QR poll auth check failed: {}", e);
            Ok(AuthResult {
                success: false,
                next_step: Some("waiting".to_string()),
                error: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent_code(code_type: tl::enums::auth::SentCodeType) -> tl::types::auth::SentCode {
        tl::types::auth::SentCode {
            r#type: code_type,
            phone_code_hash: "hash".to_string(),
            next_type: Some(tl::enums::auth::CodeType::Sms),
            timeout: Some(42),
        }
    }

    #[test]
    fn normalizes_common_international_phone_formats() {
        assert_eq!(
            normalize_phone_number(" +1 (415) 555-0132 ").unwrap(),
            "+14155550132"
        );
        assert_eq!(
            normalize_phone_number("+44 20 7946 0958").unwrap(),
            "+442079460958"
        );
    }

    #[test]
    fn rejects_non_e164_phone_numbers() {
        assert!(normalize_phone_number("4155550132").is_err());
        assert!(normalize_phone_number("+0123456789").is_err());
        assert!(normalize_phone_number("+1/415/555/0132").is_err());
        assert!(normalize_phone_number("+123").is_err());
    }

    #[test]
    fn redacts_phone_numbers_in_logs() {
        let redacted = redact_phone_number("+14155550132");
        assert_eq!(redacted, "+1••••32");
        assert!(!redacted.contains("415555"));
    }

    #[test]
    fn maps_every_supported_sent_code_type() {
        let cases = vec![
            (
                tl::enums::auth::SentCodeType::App(tl::types::auth::SentCodeTypeApp { length: 5 }),
                AuthCodeDelivery::TelegramApp,
                true,
            ),
            (
                tl::enums::auth::SentCodeType::Sms(tl::types::auth::SentCodeTypeSms { length: 5 }),
                AuthCodeDelivery::Sms,
                true,
            ),
            (
                tl::enums::auth::SentCodeType::Call(tl::types::auth::SentCodeTypeCall {
                    length: 5,
                }),
                AuthCodeDelivery::Call,
                true,
            ),
            (
                tl::enums::auth::SentCodeType::FlashCall(tl::types::auth::SentCodeTypeFlashCall {
                    pattern: "*123".to_string(),
                }),
                AuthCodeDelivery::FlashCall,
                true,
            ),
            (
                tl::enums::auth::SentCodeType::MissedCall(
                    tl::types::auth::SentCodeTypeMissedCall {
                        prefix: "+12".to_string(),
                        length: 4,
                    },
                ),
                AuthCodeDelivery::MissedCall,
                true,
            ),
            (
                tl::enums::auth::SentCodeType::EmailCode(tl::types::auth::SentCodeTypeEmailCode {
                    apple_signin_allowed: false,
                    google_signin_allowed: false,
                    email_pattern: "a***@example.com".to_string(),
                    length: 6,
                    reset_available_period: None,
                    reset_pending_date: None,
                }),
                AuthCodeDelivery::Email,
                true,
            ),
            (
                tl::enums::auth::SentCodeType::SetUpEmailRequired(
                    tl::types::auth::SentCodeTypeSetUpEmailRequired {
                        apple_signin_allowed: false,
                        google_signin_allowed: false,
                    },
                ),
                AuthCodeDelivery::EmailSetup,
                false,
            ),
            (
                tl::enums::auth::SentCodeType::FragmentSms(
                    tl::types::auth::SentCodeTypeFragmentSms {
                        url: "https://fragment.com/login".to_string(),
                        length: 5,
                    },
                ),
                AuthCodeDelivery::Fragment,
                true,
            ),
            (
                tl::enums::auth::SentCodeType::FirebaseSms(
                    tl::types::auth::SentCodeTypeFirebaseSms {
                        nonce: None,
                        play_integrity_project_id: None,
                        play_integrity_nonce: None,
                        receipt: None,
                        push_timeout: None,
                        length: 5,
                    },
                ),
                AuthCodeDelivery::Firebase,
                true,
            ),
            (
                tl::enums::auth::SentCodeType::SmsWord(tl::types::auth::SentCodeTypeSmsWord {
                    beginning: Some("a".to_string()),
                }),
                AuthCodeDelivery::SmsWord,
                false,
            ),
            (
                tl::enums::auth::SentCodeType::SmsPhrase(tl::types::auth::SentCodeTypeSmsPhrase {
                    beginning: Some("open".to_string()),
                }),
                AuthCodeDelivery::SmsPhrase,
                false,
            ),
        ];

        for (code_type, expected_delivery, expected_numeric) in cases {
            let result = describe_sent_code(&sent_code(code_type));
            assert_eq!(result.delivery, expected_delivery);
            assert_eq!(result.numeric_code, expected_numeric);
            assert_eq!(result.resend_after_seconds, Some(42));
            assert_eq!(result.next_delivery, Some(AuthCodeDelivery::Sms));
        }
    }

    #[test]
    fn recommends_qr_for_desktop_unsupported_delivery_types() {
        let email_setup = describe_sent_code(&sent_code(
            tl::enums::auth::SentCodeType::SetUpEmailRequired(
                tl::types::auth::SentCodeTypeSetUpEmailRequired {
                    apple_signin_allowed: false,
                    google_signin_allowed: false,
                },
            ),
        ));
        let firebase = describe_sent_code(&sent_code(tl::enums::auth::SentCodeType::FirebaseSms(
            tl::types::auth::SentCodeTypeFirebaseSms {
                nonce: None,
                play_integrity_project_id: None,
                play_integrity_nonce: None,
                receipt: None,
                push_timeout: None,
                length: 5,
            },
        )));

        assert_eq!(email_setup.status, AuthCodeRequestStatus::QrRecommended);
        assert_eq!(firebase.status, AuthCodeRequestStatus::QrRecommended);
    }
}
