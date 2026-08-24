use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
#[cfg(not(target_os = "android"))]
use keyring::Entry;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[cfg(not(target_os = "android"))]
const KEYRING_SERVICE: &str = "com.cameronamer.telegramdrive.supporter";
const DEVICE_KEY_ACCOUNT: &str = "device-signing-key-v1";
const RECOVERY_CODE_ACCOUNT: &str = "recovery-code-v1";
const CHECKOUT_SECRET_ACCOUNT: &str = "checkout-claim-secret-v1";
const TERMS_VERSION: &str = "2026-08-11";

fn service_url() -> Option<&'static str> {
    option_env!("TELEGRAM_DRIVE_SUPPORTER_SERVICE_URL")
        .map(str::trim)
        .filter(|value| value.starts_with("https://") && !value.ends_with('/'))
}

fn configured_public_key() -> Option<&'static str> {
    option_env!("TELEGRAM_DRIVE_SUPPORTER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SupporterLocalState {
    device_public_key: Option<String>,
    entitlement_token: Option<String>,
    checkout_claim_id: Option<String>,
    checkout_expires_at: Option<i64>,
    #[serde(default)]
    revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EntitlementClaims {
    iss: String,
    aud: String,
    entitlement_id: String,
    device_key_hash: String,
    terms_version: String,
    issued_at: i64,
    expires_at: i64,
    offline_until: i64,
}

#[derive(Debug, Deserialize)]
struct EntitlementHeader {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntitlementAccess {
    Active,
    OfflineGrace,
    Expired,
}

#[derive(Debug, Serialize)]
pub struct SupporterStatus {
    state: &'static str,
    ad_free: bool,
    message: String,
    terms_version: &'static str,
    terms_url: Option<String>,
    expires_at: Option<i64>,
    offline_until: Option<i64>,
    recovery_code_saved: bool,
    checkout_pending: bool,
}

#[derive(Debug, Deserialize)]
struct CheckoutResponse {
    claim_id: String,
    claim_secret: String,
    approval_url: String,
    expires_at: i64,
}

#[derive(Debug, Serialize)]
pub struct CheckoutStarted {
    approval_url: String,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct CheckoutStatusResponse {
    status: String,
    entitlement_token: Option<String>,
    recovery_code: Option<String>,
    error_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CheckoutPollResult {
    status: String,
    recovery_code: Option<String>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    entitlement_token: String,
}

#[derive(Debug, Deserialize)]
struct ChallengeResponse {
    challenge_id: String,
    nonce: String,
}

#[derive(Debug, Deserialize)]
struct ServiceErrorEnvelope {
    error: Option<ServiceError>,
}

#[derive(Debug, Deserialize)]
struct ServiceError {
    code: String,
    message: String,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("supporter-entitlement-v1.json"))
        .map_err(|error| format!("Unable to locate app data: {error}"))
}

fn load_state(app: &AppHandle) -> SupporterLocalState {
    state_path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_state(app: &AppHandle, state: &SupporterLocalState) -> Result<(), String> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create app data directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Unable to encode supporter state: {error}"))?;
    persist_state_file(&path, &bytes)
}

fn persist_state_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
        .map_err(|error| format!("Unable to save supporter state: {error}"))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Unable to save supporter state: {error}"))?;
    drop(file);
    replace_state_file(&temporary, path)
        .map_err(|error| format!("Unable to commit supporter state: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn replace_state_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_state_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source = windows_extended_path(source);
    let destination = windows_extended_path(destination);
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

#[cfg(target_os = "windows")]
fn windows_extended_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().collect();
    const SLASH: u16 = b'\\' as u16;
    const QUESTION: u16 = b'?' as u16;
    let mut extended = if path.starts_with(&[SLASH, SLASH, QUESTION, SLASH]) {
        path
    } else if path.starts_with(&[SLASH, SLASH]) {
        "\\\\?\\UNC\\"
            .encode_utf16()
            .chain(path.into_iter().skip(2))
            .collect()
    } else {
        "\\\\?\\".encode_utf16().chain(path).collect()
    };
    extended.push(0);
    extended
}

#[cfg(not(target_os = "android"))]
fn keyring_entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, account)
        .map_err(|error| format!("Secure credential storage is unavailable: {error}"))
}

#[cfg(not(target_os = "android"))]
fn load_signing_key() -> Result<Option<SigningKey>, String> {
    match keyring_entry(DEVICE_KEY_ACCOUNT)?.get_password() {
        Ok(encoded) => {
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| "Stored supporter device key is invalid".to_string())?;
            let key_bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| "Stored supporter device key has the wrong length".to_string())?;
            Ok(Some(SigningKey::from_bytes(&key_bytes)))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Unable to read secure supporter credential: {error}"
        )),
    }
}

#[cfg(not(target_os = "android"))]
fn signing_key() -> Result<SigningKey, String> {
    if let Some(key) = load_signing_key()? {
        return Ok(key);
    }
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("Unable to create a secure device key: {error}"))?;
    let key = SigningKey::from_bytes(&bytes);
    keyring_entry(DEVICE_KEY_ACCOUNT)?
        .set_password(&URL_SAFE_NO_PAD.encode(key.to_bytes()))
        .map_err(|error| {
            format!("Unable to save the device key in secure credential storage: {error}")
        })?;
    Ok(key)
}

#[cfg(not(target_os = "android"))]
fn recovery_code_is_saved() -> bool {
    keyring_entry(RECOVERY_CODE_ACCOUNT)
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .is_ok()
}

#[cfg(not(target_os = "android"))]
fn save_recovery_code(code: &str) -> Result<(), String> {
    keyring_entry(RECOVERY_CODE_ACCOUNT)?
        .set_password(code)
        .map_err(|error| format!("Unable to save the recovery code securely: {error}"))
}

#[cfg(not(target_os = "android"))]
fn save_checkout_secret(secret: &str) -> Result<(), String> {
    keyring_entry(CHECKOUT_SECRET_ACCOUNT)?
        .set_password(secret)
        .map_err(|error| format!("Unable to save the checkout verification credential: {error}"))
}

#[cfg(not(target_os = "android"))]
fn load_checkout_secret() -> Result<String, String> {
    keyring_entry(CHECKOUT_SECRET_ACCOUNT)?
        .get_password()
        .map_err(|error| {
            format!("The secure checkout verification credential is unavailable: {error}")
        })
}

#[cfg(not(target_os = "android"))]
fn clear_checkout_secret() -> Result<(), String> {
    match keyring_entry(CHECKOUT_SECRET_ACCOUNT)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Unable to clear the checkout verification credential: {error}"
        )),
    }
}

#[cfg(target_os = "android")]
fn android_main_class() -> Result<jni::objects::JClass<'static>, String> {
    crate::jni_cache::get_main_activity_jclass().ok_or_else(|| {
        "Android secure credential storage is still starting; try again in a moment".to_string()
    })
}

#[cfg(target_os = "android")]
fn load_android_secret(account: &str) -> Result<Option<String>, String> {
    let main_class = android_main_class()?;
    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| format!("Unable to access Android secure storage: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to attach Android secure storage: {error}"))?;
    let account = env
        .new_string(account)
        .map_err(|error| format!("Unable to prepare Android credential name: {error}"))?;
    let value = env
        .call_static_method(
            &main_class,
            "getSupporterSecret",
            "(Ljava/lang/String;)Ljava/lang/String;",
            &[jni::objects::JValue::from(&account)],
        )
        .map_err(|error| format!("Unable to read Android secure credential: {error}"))?
        .l()
        .map_err(|error| format!("Android secure credential returned an invalid value: {error}"))?;
    if value.is_null() {
        return Ok(None);
    }
    let value = jni::objects::JString::from(value);
    let value: String = env
        .get_string(&value)
        .map_err(|error| format!("Unable to decode Android secure credential: {error}"))?
        .into();
    Ok((!value.is_empty()).then_some(value))
}

#[cfg(target_os = "android")]
fn save_android_secret(account: &str, secret: &str) -> Result<(), String> {
    let main_class = android_main_class()?;
    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| format!("Unable to access Android secure storage: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to attach Android secure storage: {error}"))?;
    let account = env
        .new_string(account)
        .map_err(|error| format!("Unable to prepare Android credential name: {error}"))?;
    let secret = env
        .new_string(secret)
        .map_err(|error| format!("Unable to prepare Android secure credential: {error}"))?;
    let saved = env
        .call_static_method(
            &main_class,
            "putSupporterSecret",
            "(Ljava/lang/String;Ljava/lang/String;)Z",
            &[
                jni::objects::JValue::from(&account),
                jni::objects::JValue::from(&secret),
            ],
        )
        .map_err(|error| format!("Unable to save Android secure credential: {error}"))?
        .z()
        .map_err(|error| format!("Android secure storage returned an invalid result: {error}"))?;
    if saved {
        Ok(())
    } else {
        Err("Android Keystore could not save the supporter credential".to_string())
    }
}

#[cfg(target_os = "android")]
fn delete_android_secret(account: &str) -> Result<(), String> {
    let main_class = android_main_class()?;
    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| format!("Unable to access Android secure storage: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to attach Android secure storage: {error}"))?;
    let account = env
        .new_string(account)
        .map_err(|error| format!("Unable to prepare Android credential name: {error}"))?;
    let deleted = env
        .call_static_method(
            &main_class,
            "deleteSupporterSecret",
            "(Ljava/lang/String;)Z",
            &[jni::objects::JValue::from(&account)],
        )
        .map_err(|error| format!("Unable to clear Android secure credential: {error}"))?
        .z()
        .map_err(|error| format!("Android secure storage returned an invalid result: {error}"))?;
    if deleted {
        Ok(())
    } else {
        Err("Android Keystore could not clear the supporter credential".to_string())
    }
}

#[cfg(target_os = "android")]
fn load_signing_key() -> Result<Option<SigningKey>, String> {
    let Some(encoded) = load_android_secret(DEVICE_KEY_ACCOUNT)? else {
        return Ok(None);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Stored supporter device key is invalid".to_string())?;
    let key_bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Stored supporter device key has the wrong length".to_string())?;
    Ok(Some(SigningKey::from_bytes(&key_bytes)))
}

#[cfg(target_os = "android")]
fn signing_key() -> Result<SigningKey, String> {
    if let Some(key) = load_signing_key()? {
        return Ok(key);
    }
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("Unable to create a secure device key: {error}"))?;
    let key = SigningKey::from_bytes(&bytes);
    save_android_secret(DEVICE_KEY_ACCOUNT, &URL_SAFE_NO_PAD.encode(key.to_bytes()))?;
    Ok(key)
}

#[cfg(target_os = "android")]
fn recovery_code_is_saved() -> bool {
    load_android_secret(RECOVERY_CODE_ACCOUNT)
        .ok()
        .flatten()
        .is_some()
}

#[cfg(target_os = "android")]
fn save_recovery_code(code: &str) -> Result<(), String> {
    save_android_secret(RECOVERY_CODE_ACCOUNT, code)
}

#[cfg(target_os = "android")]
fn save_checkout_secret(secret: &str) -> Result<(), String> {
    save_android_secret(CHECKOUT_SECRET_ACCOUNT, secret)
}

#[cfg(target_os = "android")]
fn load_checkout_secret() -> Result<String, String> {
    load_android_secret(CHECKOUT_SECRET_ACCOUNT)?
        .ok_or_else(|| "The secure checkout verification credential is unavailable".to_string())
}

#[cfg(target_os = "android")]
fn clear_checkout_secret() -> Result<(), String> {
    delete_android_secret(CHECKOUT_SECRET_ACCOUNT)
}

fn public_key(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
}

fn sha256_base64url(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

fn parse_and_verify_token(
    token: &str,
    expected_device_public_key: &str,
) -> Result<EntitlementClaims, String> {
    let configured_key =
        configured_public_key().ok_or("Supporter verification is not configured in this build")?;
    parse_and_verify_token_with_key(token, expected_device_public_key, configured_key)
}

fn parse_and_verify_token_with_key(
    token: &str,
    expected_device_public_key: &str,
    configured_key: &str,
) -> Result<EntitlementClaims, String> {
    let mut parts = token.split('.');
    let header = parts.next().ok_or("Supporter token is malformed")?;
    let payload = parts.next().ok_or("Supporter token is malformed")?;
    let encoded_signature = parts.next().ok_or("Supporter token is malformed")?;
    if parts.next().is_some() {
        return Err("Supporter token is malformed".to_string());
    }

    let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(configured_key)
        .map_err(|_| "Configured supporter public key is invalid".to_string())?
        .try_into()
        .map_err(|_| "Configured supporter public key has the wrong length".to_string())?;
    let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .map_err(|_| "Supporter token signature is invalid".to_string())?
        .try_into()
        .map_err(|_| "Supporter token signature has the wrong length".to_string())?;
    VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| "Configured supporter public key is invalid".to_string())?
        .verify(
            format!("{header}.{payload}").as_bytes(),
            &Signature::from_bytes(&signature_bytes),
        )
        .map_err(|_| "Supporter token signature could not be verified".to_string())?;

    let entitlement_header: EntitlementHeader = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(header)
            .map_err(|_| "Supporter token header is invalid".to_string())?,
    )
    .map_err(|_| "Supporter token header is invalid".to_string())?;
    if entitlement_header.alg != "EdDSA"
        || entitlement_header.typ != "TD-SUPPORTER"
        || entitlement_header.kid != "v1"
    {
        return Err("Supporter token header is not supported".to_string());
    }

    let claims: EntitlementClaims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| "Supporter token payload is invalid".to_string())?,
    )
    .map_err(|_| "Supporter token claims are invalid".to_string())?;
    if claims.iss != "telegram-drive-supporter" || claims.aud != "telegram-drive-desktop" {
        return Err("Supporter token was issued for a different application".to_string());
    }
    if claims.device_key_hash != sha256_base64url(expected_device_public_key) {
        return Err("Supporter token belongs to a different device".to_string());
    }
    if claims.entitlement_id.is_empty()
        || claims.terms_version.is_empty()
        || claims.issued_at < 0
        || claims.issued_at > claims.expires_at
        || claims.expires_at > claims.offline_until
    {
        return Err("Supporter token validity claims are invalid".to_string());
    }
    Ok(claims)
}

fn entitlement_access_at(claims: &EntitlementClaims, now: i64) -> EntitlementAccess {
    if now <= claims.expires_at {
        EntitlementAccess::Active
    } else if now <= claims.offline_until {
        EntitlementAccess::OfflineGrace
    } else {
        EntitlementAccess::Expired
    }
}

fn unix_time() -> i64 {
    chrono::Utc::now().timestamp()
}

fn checkout_is_pending(state: &SupporterLocalState) -> bool {
    state.checkout_claim_id.is_some()
        && state
            .checkout_expires_at
            .is_some_and(|expires_at| expires_at > unix_time())
}

fn clear_pending_checkout(app: &AppHandle, state: &mut SupporterLocalState) -> Result<(), String> {
    state.checkout_claim_id = None;
    state.checkout_expires_at = None;
    save_state(app, state)?;
    let _ = clear_checkout_secret();
    Ok(())
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    match response.json::<ServiceErrorEnvelope>().await {
        Ok(body) => body
            .error
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| format!("Supporter service returned {status}")),
        Err(_) => format!("Supporter service returned {status}"),
    }
}

fn status_from_state(state: &SupporterLocalState) -> SupporterStatus {
    let terms_url = service_url().map(|url| format!("{url}/terms"));
    let unavailable = |message: String| SupporterStatus {
        state: "unavailable",
        ad_free: false,
        message,
        terms_version: TERMS_VERSION,
        terms_url: terms_url.clone(),
        expires_at: None,
        offline_until: None,
        recovery_code_saved: recovery_code_is_saved(),
        checkout_pending: checkout_is_pending(state),
    };
    if service_url().is_none() || configured_public_key().is_none() {
        return unavailable(
            "Verified supporter activation is not configured in this build.".to_string(),
        );
    }
    if state.revoked {
        return SupporterStatus {
            state: "revoked",
            ad_free: false,
            message: "This supporter entitlement was revoked after a refund, reversal, dispute, or device deactivation.".to_string(),
            terms_version: TERMS_VERSION,
            terms_url,
            expires_at: None,
            offline_until: None,
            recovery_code_saved: recovery_code_is_saved(),
            checkout_pending: checkout_is_pending(state),
        };
    }
    let Some(token) = state.entitlement_token.as_deref() else {
        return SupporterStatus {
            state: "inactive",
            ad_free: false,
            message: "No verified supporter activation is stored on this device.".to_string(),
            terms_version: TERMS_VERSION,
            terms_url,
            expires_at: None,
            offline_until: None,
            recovery_code_saved: recovery_code_is_saved(),
            checkout_pending: checkout_is_pending(state),
        };
    };
    let Some(device_public_key) = state.device_public_key.as_deref() else {
        return unavailable("The local supporter device identity is missing.".to_string());
    };
    #[cfg(target_os = "android")]
    {
        let device_key = match load_signing_key() {
            Ok(Some(key)) => key,
            Ok(None) => return unavailable(
                "The Android secure device credential is missing; restore with your recovery code."
                    .to_string(),
            ),
            Err(error) => return unavailable(error),
        };
        if public_key(&device_key) != device_public_key {
            return unavailable(
                "The Android secure device credential does not match this activation; restore with your recovery code."
                    .to_string(),
            );
        }
    }
    match parse_and_verify_token(token, device_public_key) {
        Ok(claims) => {
            let now = unix_time();
            let (status, ad_free, message) = match entitlement_access_at(&claims, now) {
                EntitlementAccess::Active => (
                    "active",
                    true,
                    "Verified ad-free supporter access is active.".to_string(),
                ),
                EntitlementAccess::OfflineGrace => ("needs_refresh", true, "Ad-free access is active during the offline grace period. Connect to refresh verification.".to_string()),
                EntitlementAccess::Expired => (
                    "expired",
                    false,
                    "Supporter verification expired. Connect to refresh or use your recovery code."
                        .to_string(),
                ),
            };
            SupporterStatus {
                state: status,
                ad_free,
                message,
                terms_version: TERMS_VERSION,
                terms_url,
                expires_at: Some(claims.expires_at),
                offline_until: Some(claims.offline_until),
                recovery_code_saved: recovery_code_is_saved(),
                checkout_pending: checkout_is_pending(state),
            }
        }
        Err(error) => unavailable(error),
    }
}

#[tauri::command]
pub async fn cmd_get_supporter_status(app: AppHandle) -> Result<SupporterStatus, String> {
    let mut state = load_state(&app);
    if state.checkout_claim_id.is_some() && !checkout_is_pending(&state) {
        let _ = clear_pending_checkout(&app, &mut state);
    }
    Ok(status_from_state(&state))
}

#[tauri::command]
pub async fn cmd_begin_supporter_checkout(
    app: AppHandle,
    accepted_terms_version: String,
) -> Result<CheckoutStarted, String> {
    let base_url = service_url().ok_or("Supporter activation is not configured in this build")?;
    if accepted_terms_version != TERMS_VERSION {
        return Err("Accept the current supporter terms before continuing".to_string());
    }
    let key = signing_key()?;
    let device_public_key = public_key(&key);
    let response = reqwest::Client::new()
        .post(format!("{base_url}/v1/checkout"))
        .json(&serde_json::json!({
            "device_public_key": device_public_key,
            "terms_version": TERMS_VERSION,
            "terms_accepted": true,
            "app_version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
        }))
        .send()
        .await
        .map_err(|error| format!("Unable to reach the supporter service: {error}"))?;
    if response.status() != StatusCode::CREATED {
        return Err(response_error(response).await);
    }
    let checkout = response
        .json::<CheckoutResponse>()
        .await
        .map_err(|error| format!("Supporter service returned an invalid checkout: {error}"))?;
    save_checkout_secret(&checkout.claim_secret)?;
    let mut state = load_state(&app);
    state.device_public_key = Some(public_key(&key));
    state.checkout_claim_id = Some(checkout.claim_id);
    state.checkout_expires_at = Some(checkout.expires_at);
    save_state(&app, &state)?;
    Ok(CheckoutStarted {
        approval_url: checkout.approval_url,
        expires_at: checkout.expires_at,
    })
}

#[tauri::command]
pub async fn cmd_poll_supporter_checkout(app: AppHandle) -> Result<CheckoutPollResult, String> {
    let base_url = service_url().ok_or("Supporter activation is not configured in this build")?;
    let mut state = load_state(&app);
    if state.checkout_claim_id.is_some() && !checkout_is_pending(&state) {
        clear_pending_checkout(&app, &mut state)?;
        return Ok(CheckoutPollResult {
            status: "expired".to_string(),
            recovery_code: None,
            message: "This checkout expired before payment was verified. Start a new checkout if no payment was completed.".to_string(),
        });
    }
    let claim_id = state
        .checkout_claim_id
        .as_deref()
        .ok_or("No supporter checkout is waiting for verification")?;
    let claim_secret = load_checkout_secret()?;
    let response = reqwest::Client::new()
        .get(format!("{base_url}/v1/checkout/{claim_id}/status"))
        .bearer_auth(&claim_secret)
        .send()
        .await
        .map_err(|error| format!("Unable to check payment status: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let checkout = response
        .json::<CheckoutStatusResponse>()
        .await
        .map_err(|error| format!("Supporter service returned an invalid status: {error}"))?;
    if checkout.status == "completed" {
        let token = checkout
            .entitlement_token
            .ok_or("Completed checkout did not include an entitlement")?;
        let device_public_key = state
            .device_public_key
            .as_deref()
            .ok_or("The local device identity is missing")?;
        parse_and_verify_token(&token, device_public_key)?;
        if let Some(code) = checkout.recovery_code.as_deref() {
            save_recovery_code(code)?;
        }
        state.entitlement_token = Some(token);
        state.revoked = false;
        state.checkout_claim_id = None;
        state.checkout_expires_at = None;
        save_state(&app, &state)?;
        let _ = clear_checkout_secret();
        return Ok(CheckoutPollResult {
            status: "completed".to_string(),
            recovery_code: checkout.recovery_code,
            message: "Payment verified. Ad-free supporter access is active.".to_string(),
        });
    }
    if checkout.status == "failed" {
        clear_pending_checkout(&app, &mut state)?;
    }
    Ok(CheckoutPollResult {
        status: checkout.status,
        recovery_code: None,
        message: checkout
            .error_code
            .unwrap_or_else(|| "Waiting for PayPal confirmation.".to_string()),
    })
}

#[tauri::command]
pub async fn cmd_activate_supporter(
    app: AppHandle,
    recovery_code: String,
    accepted_terms_version: String,
) -> Result<SupporterStatus, String> {
    let base_url = service_url().ok_or("Supporter activation is not configured in this build")?;
    if accepted_terms_version != TERMS_VERSION {
        return Err("Accept the current supporter terms before continuing".to_string());
    }
    let key = signing_key()?;
    let device_public_key = public_key(&key);
    let response = reqwest::Client::new()
        .post(format!("{base_url}/v1/activate"))
        .json(&serde_json::json!({
            "recovery_code": recovery_code,
            "device_public_key": device_public_key,
            "terms_version": TERMS_VERSION,
            "terms_accepted": true,
        }))
        .send()
        .await
        .map_err(|error| format!("Unable to reach the supporter service: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let token = response
        .json::<TokenResponse>()
        .await
        .map_err(|error| format!("Supporter service returned an invalid activation: {error}"))?
        .entitlement_token;
    parse_and_verify_token(&token, &device_public_key)?;
    save_recovery_code(&recovery_code)?;
    let mut state = load_state(&app);
    state.device_public_key = Some(device_public_key);
    state.entitlement_token = Some(token);
    state.checkout_claim_id = None;
    state.checkout_expires_at = None;
    state.revoked = false;
    save_state(&app, &state)?;
    let _ = clear_checkout_secret();
    Ok(status_from_state(&state))
}

#[tauri::command]
pub async fn cmd_refresh_supporter(app: AppHandle) -> Result<SupporterStatus, String> {
    let base_url = service_url().ok_or("Supporter activation is not configured in this build")?;
    let mut state = load_state(&app);
    let token = state
        .entitlement_token
        .clone()
        .ok_or("No supporter activation is stored on this device")?;
    let key = load_signing_key()?
        .ok_or("The secure supporter device key is missing; use your recovery code")?;
    let device_public_key = public_key(&key);
    let claims = parse_and_verify_token(&token, &device_public_key)?;
    let client = reqwest::Client::new();
    let challenge_response = client
        .post(format!("{base_url}/v1/challenge"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|error| format!("Unable to request supporter verification: {error}"))?;
    if !challenge_response.status().is_success() {
        if challenge_response.status() == StatusCode::FORBIDDEN {
            state.entitlement_token = None;
            state.revoked = true;
            save_state(&app, &state)?;
        }
        return Err(response_error(challenge_response).await);
    }
    let challenge = challenge_response
        .json::<ChallengeResponse>()
        .await
        .map_err(|error| format!("Supporter service returned an invalid challenge: {error}"))?;
    let proof = format!(
        "telegram-drive-supporter-refresh:{}:{}",
        challenge.challenge_id, challenge.nonce
    );
    let signature = URL_SAFE_NO_PAD.encode(key.sign(proof.as_bytes()).to_bytes());
    let response = client
        .post(format!("{base_url}/v1/refresh"))
        .json(&serde_json::json!({
            "entitlement_token": token,
            "challenge_id": challenge.challenge_id,
            "nonce": challenge.nonce,
            "signature": signature,
        }))
        .send()
        .await
        .map_err(|error| format!("Unable to refresh supporter verification: {error}"))?;
    if !response.status().is_success() {
        if response.status() == StatusCode::FORBIDDEN {
            state.entitlement_token = None;
            state.revoked = true;
            save_state(&app, &state)?;
        }
        return Err(response_error(response).await);
    }
    let refreshed_token = response
        .json::<TokenResponse>()
        .await
        .map_err(|error| format!("Supporter service returned an invalid entitlement: {error}"))?
        .entitlement_token;
    let refreshed_claims = parse_and_verify_token(&refreshed_token, &device_public_key)?;
    if refreshed_claims.entitlement_id != claims.entitlement_id {
        return Err(
            "Refreshed supporter entitlement did not match the stored purchase".to_string(),
        );
    }
    state.entitlement_token = Some(refreshed_token);
    save_state(&app, &state)?;
    Ok(status_from_state(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_claims(device_public_key: &str) -> EntitlementClaims {
        EntitlementClaims {
            iss: "telegram-drive-supporter".to_string(),
            aud: "telegram-drive-desktop".to_string(),
            entitlement_id: "entitlement-1".to_string(),
            device_key_hash: sha256_base64url(device_public_key),
            terms_version: "2026-08-11".to_string(),
            issued_at: 1_700_000_000,
            expires_at: 1_800_000_000,
            offline_until: 1_800_604_800,
        }
    }

    fn signed_token(
        signing_key: &SigningKey,
        header_json: &[u8],
        claims: &EntitlementClaims,
    ) -> String {
        let header = URL_SAFE_NO_PAD.encode(header_json);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signing_input = format!("{header}.{payload}");
        let signature =
            URL_SAFE_NO_PAD.encode(signing_key.sign(signing_input.as_bytes()).to_bytes());
        format!("{signing_input}.{signature}")
    }

    #[test]
    fn recovery_style_device_hash_is_stable() {
        assert_eq!(
            sha256_base64url("device-key"),
            sha256_base64url("device-key")
        );
        assert_ne!(
            sha256_base64url("device-key"),
            sha256_base64url("other-key")
        );
    }

    #[test]
    fn pending_checkout_survives_restart_only_until_its_expiration() {
        let mut state = SupporterLocalState {
            checkout_claim_id: Some("claim-1".to_string()),
            checkout_expires_at: Some(unix_time() + 60),
            ..Default::default()
        };
        assert!(checkout_is_pending(&state));
        state.checkout_expires_at = Some(unix_time() - 1);
        assert!(!checkout_is_pending(&state));
    }

    #[test]
    fn configured_service_requires_https_without_trailing_slash() {
        if let Some(url) = service_url() {
            assert!(url.starts_with("https://"));
            assert!(!url.ends_with('/'));
        }
    }

    #[test]
    fn signed_entitlement_survives_app_version_changes() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let device_key = SigningKey::from_bytes(&[11_u8; 32]);
        let device_public_key = public_key(&device_key);
        let claims = test_claims(&device_public_key);
        let token = signed_token(
            &signing_key,
            br#"{"alg":"EdDSA","typ":"TD-SUPPORTER","kid":"v1"}"#,
            &claims,
        );
        let verification_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());

        let verified =
            parse_and_verify_token_with_key(&token, &device_public_key, &verification_key).unwrap();
        assert_eq!(verified.entitlement_id, "entitlement-1");
        assert_eq!(verified.terms_version, "2026-08-11");
    }

    #[test]
    fn signed_entitlement_rejects_an_unsupported_header() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let device_key = SigningKey::from_bytes(&[11_u8; 32]);
        let device_public_key = public_key(&device_key);
        let claims = test_claims(&device_public_key);
        let token = signed_token(
            &signing_key,
            br#"{"alg":"none","typ":"TD-SUPPORTER","kid":"v1"}"#,
            &claims,
        );
        let verification_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());

        let error = parse_and_verify_token_with_key(&token, &device_public_key, &verification_key)
            .unwrap_err();
        assert_eq!(error, "Supporter token header is not supported");
    }

    #[test]
    fn signed_entitlement_rejects_reversed_validity_dates() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let device_key = SigningKey::from_bytes(&[11_u8; 32]);
        let device_public_key = public_key(&device_key);
        let mut claims = test_claims(&device_public_key);
        claims.offline_until = claims.expires_at - 1;
        let token = signed_token(
            &signing_key,
            br#"{"alg":"EdDSA","typ":"TD-SUPPORTER","kid":"v1"}"#,
            &claims,
        );
        let verification_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());

        let error = parse_and_verify_token_with_key(&token, &device_public_key, &verification_key)
            .unwrap_err();
        assert_eq!(error, "Supporter token validity claims are invalid");
    }

    #[test]
    fn cached_entitlement_keeps_access_through_the_offline_grace_boundary() {
        let device_key = SigningKey::from_bytes(&[11_u8; 32]);
        let claims = test_claims(&public_key(&device_key));

        assert_eq!(
            entitlement_access_at(&claims, claims.expires_at),
            EntitlementAccess::Active
        );
        assert_eq!(
            entitlement_access_at(&claims, claims.expires_at + 1),
            EntitlementAccess::OfflineGrace
        );
        assert_eq!(
            entitlement_access_at(&claims, claims.offline_until),
            EntitlementAccess::OfflineGrace
        );
        assert_eq!(
            entitlement_access_at(&claims, claims.offline_until + 1),
            EntitlementAccess::Expired
        );
    }

    #[test]
    fn cached_entitlement_state_can_be_replaced_after_refresh() {
        let directory = std::env::temp_dir().join(format!(
            "telegram-drive-supporter-state-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("supporter-entitlement-v1.json");

        persist_state_file(&path, br#"{"entitlement_token":"old"}"#).unwrap();
        persist_state_file(&path, br#"{"entitlement_token":"refreshed"}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"entitlement_token":"refreshed"}"#
        );

        std::fs::remove_dir_all(directory).unwrap();
    }
}
