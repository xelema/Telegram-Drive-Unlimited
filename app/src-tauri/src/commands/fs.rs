use crate::bandwidth::{BandwidthManager, BandwidthReservation};
use crate::commands::utils::{map_error, media_size, resolve_peer};
use crate::crypto::envelope::encrypt_reader::{EncryptingReader, EncryptionSession};
use crate::crypto::envelope::header::{EnvelopeHeader, KeySlotEntry};
use crate::crypto::envelope::key_slot::{wrap_dek, KeySlotContext};
use crate::crypto::kdf;
use crate::crypto::policy;
use crate::crypto::random;
use crate::crypto::registry::{upsert_encrypted_file, EncryptedFileRecord, EncryptedFileState};
use crate::crypto::secret::{SecretBytes, SecretKey};
use crate::db::DbConnection;
use crate::models::{FileMetadata, FolderMetadata};
use crate::vpn_optimizer::{backoff_ms, NetworkConfig};
use crate::TelegramState;
use base64::Engine;
use grammers_client::types::{Media, Peer};
use grammers_client::InputMessage;
use grammers_tl_types as tl;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlite;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::{Emitter, State};
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramCooldownPayload {
    operation: &'static str,
    retry_at: u64,
    seconds: u64,
    active: bool,
}

async fn wait_for_telegram_cooldown(app: &tauri::AppHandle, operation: &'static str, seconds: u64) {
    let retry_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        + seconds.saturating_mul(1_000);
    let _ = app.emit(
        "telegram-cooldown",
        TelegramCooldownPayload {
            operation,
            retry_at,
            seconds,
            active: true,
        },
    );
    tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
    let _ = app.emit(
        "telegram-cooldown",
        TelegramCooldownPayload {
            operation,
            retry_at,
            seconds: 0,
            active: false,
        },
    );
}

#[derive(Serialize)]
struct ProtectedFileMetadata<'a> {
    schema_version: u16,
    original_name: &'a str,
    mime_type: &'a str,
}

#[derive(Deserialize)]
struct DecodedProtectedFileMetadata {
    schema_version: u16,
    original_name: String,
    mime_type: String,
}

struct EncryptedListInfo {
    remote_name: String,
    envelope_version: u16,
    protection_mode: String,
    metadata_protected: bool,
    header_blob: Option<Vec<u8>>,
    plaintext_size: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UploadProtectionMode {
    Standard,
    Vault,
    Passphrase,
    VaultAndPassphrase,
}

impl UploadProtectionMode {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("standard") {
            "standard" => Ok(Self::Standard),
            "vault" => Ok(Self::Vault),
            "passphrase" | "file_key" => Ok(Self::Passphrase),
            "vault_and_passphrase" => Ok(Self::VaultAndPassphrase),
            _ => Err("[POLICY_REJECTED] Unknown upload protection mode".to_string()),
        }
    }

    fn needs_vault(self) -> bool {
        matches!(self, Self::Vault | Self::VaultAndPassphrase)
    }

    fn needs_passphrase(self) -> bool {
        matches!(self, Self::Passphrase | Self::VaultAndPassphrase)
    }

    fn registry_name(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Vault => "vault",
            Self::Passphrase => "passphrase",
            Self::VaultAndPassphrase => "vault_and_passphrase",
        }
    }
}

fn protection_mode_from_header(header: &EnvelopeHeader) -> Result<&'static str, String> {
    let has_vault = header
        .key_slots
        .iter()
        .any(|slot| slot.kind == policy::SlotKind::Vault as u8);
    let has_passphrase = header
        .key_slots
        .iter()
        .any(|slot| slot.kind == policy::SlotKind::Passphrase as u8);
    match (has_vault, has_passphrase) {
        (true, true) => Ok("vault_and_passphrase"),
        (true, false) => Ok("vault"),
        (false, true) => Ok("passphrase"),
        (false, false) => Err("Encrypted file has no supported unlock slot".to_string()),
    }
}

fn registry_record_from_header(
    folder_id: Option<i64>,
    message_id: i32,
    remote_name: String,
    ciphertext_size: u64,
    header_bytes: Vec<u8>,
    reconciliation_state: &str,
) -> Result<EncryptedFileRecord, String> {
    let header = EnvelopeHeader::parse(&header_bytes).map_err(|error| error.to_string())?;
    let expected_size = crate::crypto::envelope::length::calculate_ciphertext_length(
        header.core.total_plaintext_length,
        header.core.chunk_size,
        header.core.header_length,
    )
    .map_err(|error| error.to_string())?;
    if expected_size != ciphertext_size {
        return Err("Encrypted envelope length does not match Telegram media size".to_string());
    }
    let protection_mode = protection_mode_from_header(&header)?.to_string();
    let header_sha256 = Sha256::digest(&header_bytes).to_vec();
    Ok(EncryptedFileRecord {
        folder_key: folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "home".to_string()),
        message_id,
        file_uuid: header.core.file_uuid.to_vec(),
        envelope_version: header.core.format_version,
        cipher_suite: header.core.cipher_suite,
        ciphertext_size,
        plaintext_size: Some(header.core.total_plaintext_length),
        remote_name,
        key_profile_id: Some(protection_mode.clone()),
        protection_mode,
        metadata_protected: header.core.encrypted_metadata_length > 0,
        header_blob: Some(header_bytes),
        header_sha256: Some(header_sha256),
        record_state: EncryptedFileState::Active,
        reconciliation_state: reconciliation_state.to_string(),
        created_at: chrono::Utc::now().timestamp(),
        last_verified_at: None,
    })
}

async fn probe_tdenc2_header(
    client: &grammers_client::Client,
    media: &Media,
) -> Result<Vec<u8>, String> {
    let mut download = client.iter_download(media);
    let mut header_bytes = Vec::with_capacity(policy::CORE_HEADER_SIZE);
    let mut expected_length: Option<usize> = None;

    while expected_length.is_none_or(|length| header_bytes.len() < length) {
        let Some(chunk) = download.next().await.transpose() else {
            return Err("Encrypted envelope ended before its header was complete".to_string());
        };
        let bytes = chunk.map_err(|error| map_error(&error))?;
        let target = expected_length.unwrap_or(policy::CORE_HEADER_SIZE);
        let needed = target.saturating_sub(header_bytes.len());
        header_bytes.extend_from_slice(&bytes[..bytes.len().min(needed)]);

        if expected_length.is_none() && header_bytes.len() == policy::CORE_HEADER_SIZE {
            let core = crate::crypto::envelope::header::CoreHeader::parse(&header_bytes)
                .map_err(|error| error.to_string())?;
            expected_length = Some(core.header_length as usize);
            header_bytes.reserve(core.header_length as usize - policy::CORE_HEADER_SIZE);
        }
    }

    EnvelopeHeader::parse(&header_bytes).map_err(|error| error.to_string())?;
    Ok(header_bytes)
}

fn inferred_mime_type(path: &str) -> &'static str {
    match std::path::Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "txt" => "text/plain",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

static UPLOAD_CANCELLATIONS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    OnceLock::new();

fn get_upload_cancellations() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    UPLOAD_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn url_decode(s: &str) -> String {
    let mut result = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    result.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).into_owned()
}

pub fn clean_android_path(raw_path: &str) -> String {
    let decoded = url_decode(raw_path);
    log::info!("URL Decoded path: {}", decoded);
    let mut cleaned = decoded;
    if cleaned.starts_with("raw%3/") {
        cleaned = cleaned.replace("raw%3/", "/");
    }
    if cleaned.starts_with("raw://") {
        cleaned = cleaned.replace("raw://", "/");
    } else if cleaned.starts_with("file://") {
        cleaned = cleaned.replace("file://", "");
    } else if cleaned.starts_with("raw:") {
        cleaned = cleaned.replace("raw:", "");
    }
    if !cleaned.starts_with("content://") {
        cleaned = cleaned.replace("//", "/");
    }
    log::info!("Cleaned absolute path: {}", cleaned);
    cleaned
}

#[cfg(target_os = "android")]
pub fn copy_to_android_cache(raw_path: &str) -> Result<String, String> {
    log::info!("JNI copy_to_android_cache started for path: {}", raw_path);
    let ctx_obj = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx_obj.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {}", e))?;

    let ctx = unsafe { jni::objects::JObject::from_raw(ctx_obj.context().cast()) };

    // 1. URL Decode & Clean Path in Rust
    let cleaned = clean_android_path(raw_path);
    log::info!("JNI Cleaned path: {}", cleaned);

    // 2. Check if the main thread already pre-cached this URI.
    //    This is the primary path for content:// URIs — the background thread
    //    MUST NOT call ContentResolver.openInputStream() directly.
    if cleaned.starts_with("content://")
        || cleaned.starts_with("msf:")
        || cleaned.starts_with("/msf:")
        || cleaned.contains("msf%")
    {
        // Retrieve globally cached MainActivity class reference
        let main_class = crate::jni_cache::get_main_activity_jclass().ok_or_else(|| {
            "JNI: MainActivity class reference was NOT cached globally!".to_string()
        })?;

        // Step A: Check if onActivityResult pre-cached this URI.
        // Validate the cached file is non-empty before accepting it.
        {
            let j_uri_str = env
                .new_string(raw_path)
                .map_err(|e| format!("Failed to create URI string: {}", e))?;
            let cached_result = env.call_static_method(
                &main_class,
                "getCachedPath",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[jni::objects::JValue::from(&j_uri_str)],
            );
            if let Ok(cached_val) = cached_result {
                if let Ok(cached_jobj) = cached_val.l() {
                    if !cached_jobj.is_null() {
                        let cached_jstr: jni::objects::JString = cached_jobj.into();
                        if let Ok(cached_path) = env.get_string(&cached_jstr).map(String::from) {
                            if !cached_path.is_empty() {
                                // Validate the cached file actually exists and has content
                                match std::fs::metadata(&cached_path) {
                                    Ok(meta) if meta.len() > 0 => {
                                        log::info!("JNI: Found valid pre-cached path for URI: {} ({} bytes)", cached_path, meta.len());
                                        return Ok(cached_path);
                                    }
                                    Ok(meta) => {
                                        log::warn!("JNI: Pre-cache wrote invalid file: {} ({} bytes). Falling back to InputStream.", cached_path, meta.len());
                                    }
                                    Err(e) => {
                                        log::warn!("JNI: Pre-cached file missing: {} ({}). Falling back to InputStream.", cached_path, e);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let _ = env.exception_clear();
        }

        // Step B: HARD BOUNDARY fallback — call getLocalFileFromUri() which posts the
        // ContentResolver.openInputStream work to the MAIN thread and blocks until done.
        // Background thread NEVER touches ContentResolver directly.
        // Validate the returned file is non-empty before accepting it.
        {
            log::info!(
                "JNI: Pre-cache miss or invalid. Calling getLocalFileFromUri on main thread: {}",
                raw_path
            );
            let j_uri_fallback = env
                .new_string(raw_path)
                .map_err(|e| format!("Failed to create URI string for fallback: {}", e))?;
            let fallback_result = env.call_static_method(
                &main_class,
                "getLocalFileFromUri",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[jni::objects::JValue::from(&j_uri_fallback)],
            );
            if let Ok(fallback_val) = fallback_result {
                if let Ok(fallback_jobj) = fallback_val.l() {
                    if !fallback_jobj.is_null() {
                        let fallback_jstr: jni::objects::JString = fallback_jobj.into();
                        if let Ok(fallback_path) = env.get_string(&fallback_jstr).map(String::from)
                        {
                            if !fallback_path.is_empty() {
                                // Validate the fallback file actually exists and has content
                                match std::fs::metadata(&fallback_path) {
                                    Ok(meta) if meta.len() > 0 => {
                                        log::info!("JNI: getLocalFileFromUri succeeded with valid file: {} ({} bytes)", fallback_path, meta.len());
                                        return Ok(fallback_path);
                                    }
                                    Ok(meta) => {
                                        log::warn!("JNI: getLocalFileFromUri wrote invalid file: {} ({} bytes). Falling back to InputStream.", fallback_path, meta.len());
                                    }
                                    Err(e) => {
                                        log::warn!("JNI: getLocalFileFromUri file missing: {} ({}). Falling back to InputStream.", fallback_path, e);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let _ = env.exception_clear();
        }

        // Step C: All pre-cache paths failed or returned empty files.
        // Fall through to the raw InputStream approach below (step 3+).
        log::info!("JNI: Pre-cache and getLocalFileFromUri both failed or returned empty. Falling through to raw InputStream copy.");
    }

    // 3. Parse URI (fallback for non-content:// paths or pre-cache misses)
    let uri_class = env
        .find_class("android/net/Uri")
        .map_err(|e| format!("Failed to find android/net/Uri: {}", e))?;
    let j_cleaned = env
        .new_string(&cleaned)
        .map_err(|e| format!("Failed to create Java string: {}", e))?;
    let uri_val = env
        .call_static_method(
            &uri_class,
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[jni::objects::JValue::from(&j_cleaned)],
        )
        .map_err(|e| format!("Failed to parse URI: {}", e))?;

    let uri = uri_val
        .l()
        .map_err(|e| format!("URI result is not an object: {}", e))?;

    if uri.is_null() {
        return Err("Parsed URI is null".to_string());
    }

    // 4. Get ContentResolver
    let content_resolver = env
        .call_method(
            &ctx,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .map_err(|e| format!("Failed to get ContentResolver: {}", e))?
        .l()
        .map_err(|e| format!("ContentResolver is not an object: {}", e))?;

    // 5. Take Persistable URI Permission (best-effort, won't throw if it fails)
    if cleaned.starts_with("content://") {
        let intent_class = env
            .find_class("android/content/Intent")
            .map_err(|e| format!("Failed to find android/content/Intent: {}", e))?;
        if let Ok(flag_val) =
            env.get_static_field(&intent_class, "FLAG_GRANT_READ_URI_PERMISSION", "I")
        {
            if let Ok(flag_grant_read) = flag_val.i() {
                let res = env.call_method(
                    &content_resolver,
                    "takePersistableUriPermission",
                    "(Landroid/net/Uri;I)V",
                    &[
                        jni::objects::JValue::from(&uri),
                        jni::objects::JValue::from(flag_grant_read),
                    ],
                );
                if res.is_err() {
                    log::warn!("JNI: takePersistableUriPermission failed; clearing exception.");
                    let _ = env.exception_clear();
                }
            }
        }
    }

    // 6. Open Input Stream
    let input_stream = env
        .call_method(
            &content_resolver,
            "openInputStream",
            "(Landroid/net/Uri;)Ljava/io/InputStream;",
            &[jni::objects::JValue::from(&uri)],
        )
        .map_err(|e| format!("Failed to openInputStream: {}", e))?
        .l()
        .map_err(|e| format!("InputStream is not an object: {}", e))?;

    if input_stream.is_null() {
        return Err("InputStream is null".to_string());
    }

    // 7. Get Cache Dir
    let cache_dir_file = env
        .call_method(&ctx, "getCacheDir", "()Ljava/io/File;", &[])
        .map_err(|e| format!("Failed to getCacheDir: {}", e))?
        .l()
        .map_err(|e| format!("Cache dir is not an object: {}", e))?;

    let cache_path_jstr = env
        .call_method(
            &cache_dir_file,
            "getAbsolutePath",
            "()Ljava/lang/String;",
            &[],
        )
        .map_err(|e| format!("Failed to get absolute path of cache: {}", e))?
        .l()
        .map_err(|e| format!("Cache path is not String: {}", e))?;

    let cache_path_jstring: jni::objects::JString = cache_path_jstr.into();
    let cache_path: String = env
        .get_string(&cache_path_jstring)
        .map_err(|e| format!("Failed to convert cache path to Rust: {}", e))?
        .into();

    // 8. Get display name or file name
    let mut file_name = "temp_upload".to_string();
    if cleaned.starts_with("content://") {
        let cursor_val = env.call_method(
            &content_resolver,
            "query",
            "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
            &[
                jni::objects::JValue::from(&uri),
                jni::objects::JValue::from(&jni::objects::JObject::null()),
                jni::objects::JValue::from(&jni::objects::JObject::null()),
                jni::objects::JValue::from(&jni::objects::JObject::null()),
                jni::objects::JValue::from(&jni::objects::JObject::null()),
            ],
        );

        if let Ok(c_res) = cursor_val {
            if let Ok(cursor_obj) = c_res.l() {
                if !cursor_obj.is_null() {
                    let j_display_name = env
                        .new_string("_display_name")
                        .map_err(|e| format!("Failed to create display name string: {}", e))?;

                    let col_index = env
                        .call_method(
                            &cursor_obj,
                            "getColumnIndex",
                            "(Ljava/lang/String;)I",
                            &[jni::objects::JValue::from(&j_display_name)],
                        )
                        .ok()
                        .and_then(|r| r.i().ok())
                        .unwrap_or(-1);

                    let has_first = env
                        .call_method(&cursor_obj, "moveToFirst", "()Z", &[])
                        .ok()
                        .and_then(|r| r.z().ok())
                        .unwrap_or(false);

                    if col_index != -1 && has_first {
                        if let Ok(name_val) = env.call_method(
                            &cursor_obj,
                            "getString",
                            "(I)Ljava/lang/String;",
                            &[jni::objects::JValue::from(col_index)],
                        ) {
                            if let Ok(name_jstr_obj) = name_val.l() {
                                if !name_jstr_obj.is_null() {
                                    let name_jstring: jni::objects::JString = name_jstr_obj.into();
                                    if let Ok(name_rust) =
                                        env.get_string(&name_jstring).map(String::from)
                                    {
                                        file_name = name_rust;
                                    }
                                }
                            }
                        }
                    }
                    let _ = env.call_method(&cursor_obj, "close", "()V", &[]);
                }
            }
        }
    } else {
        if let Some(name) = std::path::Path::new(&cleaned).file_name() {
            file_name = name.to_string_lossy().to_string();
        }
    }

    // 9. Create cache file destination
    let cache_file_name = format!(
        "upload_{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        file_name
    );
    let dest_path = std::path::Path::new(&cache_path).join(cache_file_name);
    let dest_path_str = dest_path.to_string_lossy().to_string();

    // 10. Read InputStream bytes and write to local file in Rust (with retry).
    //    Uses a helper to avoid duplicating the read loop between first attempt and retry.

    // Helper: read all bytes from an InputStream JObject and write them to dest_path.
    // Returns Ok(total_bytes_read) on success, or Err(message) on failure.
    // Closes the stream when done (both on success and on read failure).
    let read_stream_to_file = |env: &mut jni::JNIEnv,
                               stream: &jni::objects::JObject,
                               dest_path: &str|
     -> Result<u64, String> {
        let mut out_file = std::fs::File::create(dest_path)
            .map_err(|e| format!("Failed to create destination cache file: {}", e))?;

        const BUFFER_SIZE: i32 = 65536;
        let byte_array = env
            .new_byte_array(BUFFER_SIZE)
            .map_err(|e| format!("Failed to create Java byte array: {}", e))?;

        let mut total_read: u64 = 0;
        loop {
            let bytes_read = match env.call_method(
                stream,
                "read",
                "([B)I",
                &[jni::objects::JValue::from(&byte_array)],
            ) {
                Ok(val) => match val.i() {
                    Ok(n) => n,
                    Err(e) => return Err(format!("read result error: {}", e)),
                },
                Err(e) => {
                    let _ = env.exception_clear();
                    return Err(format!("Failed to read from InputStream: {}", e));
                }
            };

            if bytes_read <= 0 {
                break;
            }

            let java_bytes = env
                .convert_byte_array(&byte_array)
                .map_err(|e| format!("Failed to convert Java byte array: {}", e))?;

            use std::io::Write;
            out_file
                .write_all(&java_bytes[..bytes_read as usize])
                .map_err(|e| format!("Failed to write bytes to cache file: {}", e))?;
            total_read += bytes_read as u64;
        }

        let _ = env.call_method(stream, "close", "()V", &[]);

        // Validate the written file is non-empty
        match std::fs::metadata(dest_path) {
            Ok(meta) if meta.len() > 0 => Ok(total_read),
            Ok(meta) => Err(format!(
                "File written is {} bytes (read {} bytes from stream)",
                meta.len(),
                total_read
            )),
            Err(e) => Err(format!("Result file missing: {}", e)),
        }
    };

    // First attempt: use the already-opened input_stream
    match read_stream_to_file(&mut env, &input_stream, &dest_path_str) {
        Ok(total_read) => {
            log::info!(
                "JNI InputStream first attempt succeeded: {} ({} bytes)",
                dest_path_str,
                total_read
            );
            return Ok(dest_path_str);
        }
        Err(err) => {
            log::warn!("JNI InputStream first attempt failed: {}. Retrying...", err);
        }
    }

    // Retry: re-open the InputStream and try again
    log::info!("JNI InputStream retry attempt for: {}", dest_path_str);
    let retry_result = env.call_method(
        &content_resolver,
        "openInputStream",
        "(Landroid/net/Uri;)Ljava/io/InputStream;",
        &[jni::objects::JValue::from(&uri)],
    );
    let retry_stream = match retry_result {
        Ok(val) => match val.l() {
            Ok(obj) if !obj.is_null() => obj,
            _ => return Err("Retry: Failed to open InputStream".to_string()),
        },
        Err(e) => {
            let _ = env.exception_clear();
            return Err(format!("Retry: Failed to open InputStream: {}", e));
        }
    };

    match read_stream_to_file(&mut env, &retry_stream, &dest_path_str) {
        Ok(total_read) => {
            log::info!(
                "JNI InputStream retry succeeded: {} ({} bytes)",
                dest_path_str,
                total_read
            );
            Ok(dest_path_str)
        }
        Err(err) => Err(format!("InputStream copy failed after retry: {}", err)),
    }
}
#[cfg(not(target_os = "android"))]
pub fn copy_to_android_cache(_raw_path: &str) -> Result<String, String> {
    Err("Not supported on this platform".to_string())
}

#[tauri::command]
pub async fn cmd_stage_android_upload(
    path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        let remove_intermediate =
            path.contains("content://") || path.contains("msf:") || path.contains("msf%");
        let copied_path = tokio::task::spawn_blocking(move || {
            if path.contains("content://") || path.contains("msf:") || path.contains("msf%") {
                copy_to_android_cache(&path)
            } else {
                let metadata = std::fs::metadata(&path)
                    .map_err(|error| format!("Unable to inspect Android upload source: {error}"))?;
                if !metadata.is_file() || metadata.len() == 0 {
                    return Err("Android upload source is missing or empty".to_string());
                }
                Ok(path)
            }
        })
        .await
        .map_err(|error| format!("Android upload staging task failed: {error}"))??;
        let copied_path = std::path::PathBuf::from(copied_path);
        let file_name = copied_path
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or("Android upload staging produced an invalid filename")?
            .to_os_string();
        let staging_root = app_handle
            .path()
            .app_data_dir()
            .map_err(|error| format!("Unable to locate Android app storage: {error}"))?
            .join("android-transfer-staging");
        let unique_directory = format!(
            "{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            rand::random::<u64>()
        );
        let destination_directory = staging_root.join(unique_directory);
        tokio::fs::create_dir_all(&destination_directory)
            .await
            .map_err(|error| {
                format!("Unable to create Android upload staging directory: {error}")
            })?;
        let destination = destination_directory.join(file_name);
        if let Err(error) = tokio::fs::copy(&copied_path, &destination).await {
            if remove_intermediate {
                let _ = tokio::fs::remove_file(&copied_path).await;
            }
            let _ = tokio::fs::remove_dir_all(&destination_directory).await;
            return Err(format!(
                "Unable to preserve the Android upload for recovery: {error}"
            ));
        }
        if remove_intermediate {
            let _ = tokio::fs::remove_file(&copied_path).await;
        }
        let staged_size = tokio::fs::metadata(&destination)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if staged_size == 0 {
            let _ = tokio::fs::remove_dir_all(&destination_directory).await;
            return Err("Android upload staging produced an empty file".to_string());
        }
        Ok(destination.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (path, app_handle);
        Err("Android upload staging is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub async fn cmd_delete_android_staged_upload(
    path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        let staging_root = app_handle
            .path()
            .app_data_dir()
            .map_err(|error| format!("Unable to locate Android app storage: {error}"))?
            .join("android-transfer-staging");
        let target = std::path::PathBuf::from(path);
        if tokio::fs::metadata(&target).await.is_err() {
            return Ok(());
        }
        let canonical_root = tokio::fs::canonicalize(&staging_root)
            .await
            .map_err(|error| format!("Unable to validate Android upload storage: {error}"))?;
        let canonical_target = tokio::fs::canonicalize(&target)
            .await
            .map_err(|error| format!("Unable to validate staged Android upload: {error}"))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err("Refusing to remove a file outside Android upload staging".to_string());
        }
        tokio::fs::remove_file(&canonical_target)
            .await
            .map_err(|error| format!("Unable to remove staged Android upload: {error}"))?;
        if let Some(parent) = canonical_target.parent() {
            if parent.parent() == Some(canonical_root.as_path()) {
                let _ = tokio::fs::remove_dir(parent).await;
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (path, app_handle);
        Err("Android upload staging is unavailable on this platform".to_string())
    }
}

pub async fn create_folder_inner(
    name: &str,
    client: &grammers_client::Client,
    peer_cache: &Arc<tokio::sync::RwLock<HashMap<i64, Peer>>>,
) -> Result<FolderMetadata, String> {
    log::info!("Creating Telegram Channel: {}", name);

    let result = client
        .invoke(&tl::functions::channels::CreateChannel {
            broadcast: true,
            megagroup: false,
            title: format!("{} [TD]", name),
            about: "Telegram Drive Storage Folder\n[telegram-drive-folder]".to_string(),
            geo_point: None,
            address: None,
            for_import: false,
            forum: false,
            ttl_period: None,
        })
        .await
        .map_err(map_error)?;

    let (chat_id, access_hash) = match &result {
        tl::enums::Updates::Updates(u) => {
            let chat = u.chats.first().ok_or("No chat in updates")?;
            match chat {
                tl::enums::Chat::Channel(c) => {
                    let channel_obj = grammers_client::types::Channel { raw: c.clone() };
                    peer_cache
                        .write()
                        .await
                        .insert(c.id, grammers_client::types::Peer::Channel(channel_obj));
                    (c.id, c.access_hash.unwrap_or(0))
                }
                _ => return Err("Created chat is not a channel".to_string()),
            }
        }
        _ => return Err("Unexpected response (not Updates::Updates)".to_string()),
    };

    let _ = client
        .invoke(&tl::functions::messages::SetHistoryTtl {
            peer: tl::enums::InputPeer::Channel(tl::types::InputPeerChannel {
                channel_id: chat_id,
                access_hash,
            }),
            period: 0,
        })
        .await;
    Ok(FolderMetadata {
        id: chat_id,
        name: name.to_string(),
        parent_id: None,
        username: None,
        is_public: false,
        group_id: None,
        display_order: 0,
    })
}

#[tauri::command]
pub async fn cmd_create_folder(
    name: String,
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
) -> Result<FolderMetadata, String> {
    let client_opt = { state.client.lock().await.clone() };

    let mut folder = if client_opt.is_none() {
        let mock_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        log::info!("[MOCK] Created folder '{}' with ID {}", name, mock_id);
        FolderMetadata {
            id: mock_id,
            name,
            parent_id: None,
            username: None,
            is_public: false,
            group_id: None,
            display_order: 0,
        }
    } else {
        let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;
        create_folder_inner(&name, &client, &state.peer_cache).await?
    };

    // Save to SQLite
    let folder_for_db = folder.clone();
    let display_order = crate::db::with_connection(db_pool.inner().clone(), move |conn| {
    // Calculate new display order
    let mut max_stmt = conn.prepare("SELECT MAX(display_order) FROM folder_metadata").map_err(|e: sqlite::Error| e.to_string())?;
    let mut display_order = 0;
    if let sqlite::State::Row = max_stmt.next().map_err(|e: sqlite::Error| e.to_string())? {
        display_order = max_stmt.read::<Option<i64>, _>(0).ok().flatten().unwrap_or(0) + 1;
    }

    let mut insert_stmt = conn
        .prepare("INSERT INTO folder_metadata (channel_id, name, username, is_public, display_order, group_id) VALUES (?, ?, ?, ?, ?, NULL)")
        .map_err(|e: sqlite::Error| e.to_string())?;
    insert_stmt.bind((1, folder_for_db.id)).map_err(|e: sqlite::Error| e.to_string())?;
    insert_stmt.bind((2, folder_for_db.name.as_str())).map_err(|e: sqlite::Error| e.to_string())?;
    insert_stmt.bind((3, folder_for_db.username.as_deref())).map_err(|e: sqlite::Error| e.to_string())?;
    insert_stmt.bind((4, if folder_for_db.is_public { 1 } else { 0 })).map_err(|e: sqlite::Error| e.to_string())?;
    insert_stmt.bind((5, display_order)).map_err(|e: sqlite::Error| e.to_string())?;
    insert_stmt.next().map_err(|e: sqlite::Error| e.to_string())?;
    Ok(display_order)
    }).await?;

    folder.display_order = display_order as i32;
    Ok(folder)
}

pub async fn delete_folder_inner(
    folder_id: i64,
    client: &grammers_client::Client,
    peer_cache: &Arc<tokio::sync::RwLock<HashMap<i64, Peer>>>,
) -> Result<bool, String> {
    log::info!("Deleting folder/channel: {}", folder_id);

    let peer = resolve_peer(client, Some(folder_id), peer_cache).await?;

    let input_channel = match peer {
        Peer::Channel(c) => {
            let chan = &c.raw;
            tl::enums::InputChannel::Channel(tl::types::InputChannel {
                channel_id: chan.id,
                access_hash: chan.access_hash.ok_or("No access hash for channel")?,
            })
        }
        _ => return Err("Only channels (folders) can be deleted.".to_string()),
    };

    client
        .invoke(&tl::functions::channels::DeleteChannel {
            channel: input_channel,
        })
        .await
        .map_err(|e| format!("Failed to delete channel: {}", e))?;

    Ok(true)
}

#[tauri::command]
pub async fn cmd_delete_folder(
    folder_id: i64,
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
) -> Result<bool, String> {
    let client_opt = { state.client.lock().await.clone() };

    if client_opt.is_none() {
        log::info!("[MOCK] Deleted folder ID {}", folder_id);
    } else {
        let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;
        delete_folder_inner(folder_id, &client, &state.peer_cache).await?;
    }

    // Delete from SQLite
    crate::db::with_connection(db_pool.inner().clone(), move |conn| {
        let mut stmt = conn
            .prepare("DELETE FROM folder_metadata WHERE channel_id = ?")
            .map_err(|e: sqlite::Error| e.to_string())?;
        stmt.bind((1, folder_id))
            .map_err(|e: sqlite::Error| e.to_string())?;
        stmt.next().map_err(|e: sqlite::Error| e.to_string())?;
        Ok(())
    })
    .await?;

    Ok(true)
}

pub async fn rename_folder_inner(
    folder_id: i64,
    new_name: &str,
    client: &grammers_client::Client,
    peer_cache: &Arc<tokio::sync::RwLock<HashMap<i64, Peer>>>,
) -> Result<bool, String> {
    log::info!("Renaming folder/channel: {} to {}", folder_id, new_name);

    let peer = resolve_peer(client, Some(folder_id), peer_cache).await?;

    let input_channel = match peer {
        Peer::Channel(c) => {
            let chan = &c.raw;
            tl::enums::InputChannel::Channel(tl::types::InputChannel {
                channel_id: chan.id,
                access_hash: chan.access_hash.ok_or("No access hash for channel")?,
            })
        }
        _ => return Err("Only channels (folders) can be renamed.".to_string()),
    };

    client
        .invoke(&tl::functions::channels::EditTitle {
            channel: input_channel,
            title: format!("{} [TD]", new_name),
        })
        .await
        .map_err(|e| format!("Failed to rename channel: {}", e))?;

    Ok(true)
}

#[tauri::command]
pub async fn cmd_rename_folder(
    folder_id: i64,
    new_name: String,
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
) -> Result<bool, String> {
    let client_opt = { state.client.lock().await.clone() };

    if client_opt.is_none() {
        log::info!("[MOCK] Renamed folder ID {} to {}", folder_id, new_name);
    } else {
        let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;
        rename_folder_inner(folder_id, &new_name, &client, &state.peer_cache).await?;
    }

    // Update SQLite
    let new_name_for_db = new_name.clone();
    crate::db::with_connection(db_pool.inner().clone(), move |conn| {
        let mut stmt = conn
            .prepare("UPDATE folder_metadata SET name = ? WHERE channel_id = ?")
            .map_err(|e: sqlite::Error| e.to_string())?;
        stmt.bind((1, new_name_for_db.as_str()))
            .map_err(|e: sqlite::Error| e.to_string())?;
        stmt.bind((2, folder_id))
            .map_err(|e: sqlite::Error| e.to_string())?;
        stmt.next().map_err(|e: sqlite::Error| e.to_string())?;
        Ok(())
    })
    .await?;

    Ok(true)
}

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    id: String,
    percent: u8,
    uploaded_bytes: u64,
    total_bytes: u64,
    speed_bytes_per_sec: u64,
}

/// Async reader wrapper that tracks bytes read for progress reporting.
/// Wraps a tokio File and counts how many bytes have been consumed.
struct ProgressReader {
    inner: tokio::io::BufReader<tokio::fs::File>,
    bytes_read: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl ProgressReader {
    async fn new(
        path: &str,
    ) -> Result<(Self, u64, std::sync::Arc<std::sync::atomic::AtomicU64>), String> {
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| e.to_string())?;
        let metadata = file.metadata().await.map_err(|e| e.to_string())?;
        let size = metadata.len();
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reader = Self {
            inner: tokio::io::BufReader::new(file),
            bytes_read: counter.clone(),
        };
        Ok((reader, size, counter))
    }
}

impl tokio::io::AsyncRead for ProgressReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        if let std::task::Poll::Ready(Ok(())) = &result {
            let after = buf.filled().len();
            let delta = (after - before) as u64;
            self.bytes_read
                .fetch_add(delta, std::sync::atomic::Ordering::Relaxed);
        }
        result
    }
}

struct PartialFileGuard {
    path: std::path::PathBuf,
    armed: bool,
}

impl PartialFileGuard {
    fn new(path: std::path::PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PartialFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn create_private_partial_file(path: &std::path::Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
}

fn download_partial_path(destination: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    Ok(parent.join(format!(
        ".{}.{}.tdpart",
        destination_name,
        uuid::Uuid::new_v4()
    )))
}

#[cfg(not(target_os = "windows"))]
fn replace_download_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::rename(source, destination)?;
    #[cfg(unix)]
    if let Some(parent) = destination.parent() {
        if let Err(error) = std::fs::File::open(parent).and_then(|directory| directory.sync_all()) {
            // The atomic publish already succeeded. Do not report the transfer as failed (and
            // release its quota) merely because this filesystem cannot fsync directories.
            log::warn!(
                "Downloaded file was published, but its parent directory could not be synced: {}",
                error
            );
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn replace_download_file(
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

async fn publish_download_file(
    source: std::path::PathBuf,
    destination: std::path::PathBuf,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || replace_download_file(&source, &destination))
        .await
        .map_err(|error| format!("Download publish task failed: {error}"))?
        .map_err(|error| format!("Failed to publish verified download: {error}"))
}

#[cfg(target_os = "android")]
fn publish_verified_android_download(
    cache_path: &str,
    file_name: &str,
    mime_type: &str,
) -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|error| format!("Failed to access Android VM: {}", error))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Failed to attach Android thread: {}", error))?;
    let main_class = crate::jni_cache::get_main_activity_jclass()
        .ok_or_else(|| "Android activity is unavailable".to_string())?;
    let j_cache_path = env
        .new_string(cache_path)
        .map_err(|error| error.to_string())?;
    let j_file_name = env
        .new_string(file_name)
        .map_err(|error| error.to_string())?;
    let j_mime_type = env
        .new_string(mime_type)
        .map_err(|error| error.to_string())?;
    let result = env.call_static_method(
        &main_class,
        "saveFileToPublicDownloads",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z",
        &[
            jni::objects::JValue::from(&j_cache_path),
            jni::objects::JValue::from(&j_file_name),
            jni::objects::JValue::from(&j_mime_type),
        ],
    );
    match result {
        Ok(value) => {
            if value.z().unwrap_or(false) {
                Ok(())
            } else {
                Err("Android MediaStore rejected the verified file".to_string())
            }
        }
        Err(error) => {
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
            }
            Err(format!("Failed to publish verified file: {}", error))
        }
    }
}

fn initialize_tdenc2_decryptor(
    header_bytes: &[u8],
    vault_key: Option<&SecretKey>,
    prompt_passphrase: Option<&SecretBytes>,
) -> Result<crate::crypto::envelope::decrypt_reader::DecryptReader, String> {
    use crate::crypto::envelope::decrypt_reader::DecryptReader;
    use crate::crypto::envelope::header::EnvelopeHeader;
    use crate::crypto::envelope::key_slot::unwrap_dek;

    let header = EnvelopeHeader::parse(header_bytes)
        .map_err(|error| format!("Failed to parse encrypted header: {}", error))?;
    let context = KeySlotContext {
        file_uuid: &header.core.file_uuid,
        format_version: header.core.format_version,
    };

    for slot in &header.key_slots {
        let wrapping_key = if slot.kind == policy::SlotKind::Vault as u8 {
            let Some(master_key) = vault_key else {
                continue;
            };
            kdf::derive_file_wrapping_key(
                master_key,
                &header.core.file_uuid,
                &slot.salt,
                slot.kind,
                slot.slot_id,
            )
        } else if slot.kind == policy::SlotKind::Passphrase as u8 {
            let Some(passphrase) = prompt_passphrase else {
                continue;
            };
            kdf::derive_passphrase_key(
                passphrase.expose(),
                &slot.salt,
                slot.argon2_memory_kib,
                slot.argon2_iterations,
                slot.argon2_parallelism,
            )
        } else {
            continue;
        };
        let Ok(wrapping_key) = wrapping_key else {
            continue;
        };
        let Ok(dek) = unwrap_dek(
            &context,
            &slot.wrapped_dek,
            &slot.wrap_nonce,
            &wrapping_key,
            slot.kind,
            slot.slot_id,
            slot.kdf_algorithm,
            slot.argon2_memory_kib,
            slot.argon2_iterations,
            slot.argon2_parallelism,
            &slot.salt,
        ) else {
            continue;
        };
        return DecryptReader::new(header_bytes, dek).map_err(|error| {
            format!(
                "[WRONG_KEY_OR_CORRUPT] Failed to authenticate encrypted header: {}",
                error
            )
        });
    }

    if header
        .key_slots
        .iter()
        .any(|slot| slot.kind == policy::SlotKind::Passphrase as u8)
        && prompt_passphrase.is_none()
        && !header
            .key_slots
            .iter()
            .any(|slot| slot.kind == policy::SlotKind::Vault as u8 && vault_key.is_some())
    {
        return Err("[KEY_REQUIRED] This file requires its file passphrase".to_string());
    }
    if header
        .key_slots
        .iter()
        .any(|slot| slot.kind == policy::SlotKind::Vault as u8)
        && vault_key.is_none()
        && !header.key_slots.iter().any(|slot| {
            slot.kind == policy::SlotKind::Passphrase as u8 && prompt_passphrase.is_some()
        })
    {
        return Err("[VAULT_LOCKED] Unlock the vault to decrypt this file".to_string());
    }
    Err("[WRONG_KEY_OR_CORRUPT] The supplied credential could not unlock this file".to_string())
}

#[tauri::command]
pub async fn cmd_cancel_transfer(
    transfer_id: String,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    log::info!("Cancelling transfer: {}", transfer_id);
    state
        .cancelled_transfers
        .write()
        .await
        .insert(transfer_id.clone());
    if let Some(tx) = get_upload_cancellations()
        .lock()
        .unwrap()
        .remove(&transfer_id)
    {
        let _ = tx.send(());
    }
    Ok(true)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DroppedPathRejection {
    path: String,
    reason: &'static str,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DroppedPathValidation {
    accepted: Vec<String>,
    rejected: Vec<DroppedPathRejection>,
}

async fn validate_dropped_paths(paths: Vec<String>) -> DroppedPathValidation {
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    let mut seen = HashSet::new();

    for path in paths {
        if path.trim().is_empty() || !seen.insert(path.clone()) {
            continue;
        }

        let metadata = match tokio::fs::metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                let reason = if error.kind() == std::io::ErrorKind::NotFound {
                    "missing"
                } else {
                    "unreadable"
                };
                rejected.push(DroppedPathRejection { path, reason });
                continue;
            }
        };

        if metadata.is_dir() {
            rejected.push(DroppedPathRejection {
                path,
                reason: "directory",
            });
            continue;
        }
        if !metadata.is_file() {
            rejected.push(DroppedPathRejection {
                path,
                reason: "unsupported",
            });
            continue;
        }

        match tokio::fs::File::open(&path).await {
            Ok(_) => accepted.push(path),
            Err(_) => rejected.push(DroppedPathRejection {
                path,
                reason: "unreadable",
            }),
        }
    }

    DroppedPathValidation { accepted, rejected }
}

#[tauri::command]
pub async fn cmd_validate_dropped_paths(paths: Vec<String>) -> DroppedPathValidation {
    validate_dropped_paths(paths).await
}

#[cfg(test)]
mod dropped_path_tests {
    use super::validate_dropped_paths;

    #[tokio::test]
    async fn accepts_files_and_rejects_directories_missing_paths_and_duplicates() {
        let root = std::env::temp_dir().join(format!(
            "telegram-drive-drop-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos(),
        ));
        std::fs::create_dir_all(&root).expect("test directory should be created");
        let file = root.join("upload.txt");
        std::fs::write(&file, b"upload").expect("test file should be created");
        let missing = root.join("missing.txt");

        let result = validate_dropped_paths(vec![
            file.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ])
        .await;

        assert_eq!(result.accepted, vec![file.to_string_lossy().into_owned()]);
        assert_eq!(result.rejected.len(), 2);
        assert_eq!(result.rejected[0].reason, "directory");
        assert_eq!(result.rejected[1].reason, "missing");

        std::fs::remove_dir_all(&root).expect("test directory should be removed");
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_mut))]
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects the command state parameters individually.
pub async fn cmd_upload_file(
    mut path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    protection_mode: Option<String>,
    prompt_token: Option<u64>,
    protect_metadata: Option<bool>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    net_config: State<'_, std::sync::Arc<NetworkConfig>>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    let mut temp_cache_path: Option<String> = None;

    // Strict JNI Interception Guard for Android URI Schemes
    #[cfg(target_os = "android")]
    {
        if path.contains("content://") || path.contains("msf:") || path.contains("msf%") {
            match copy_to_android_cache(&path) {
                Ok(cached_path) => {
                    log::info!(
                        "JNI STRICT GUARD: Intercepted raw URI. Overwriting path: {} -> {}",
                        path,
                        cached_path
                    );
                    temp_cache_path = Some(cached_path.clone());
                    path = cached_path;
                }
                Err(err) => {
                    return Err(format!(
                        "JNI STRICT GUARD FAILURE: Failed to copy raw URI {} to android cache: {}",
                        path, err
                    ));
                }
            }
        }
    }

    let result = cmd_upload_file_inner(
        path.clone(),
        folder_id,
        transfer_id,
        protection_mode,
        prompt_token,
        protect_metadata,
        app_handle,
        state,
        bw_state,
        net_config,
        crypto_state,
        db_pool,
    )
    .await;

    if let Some(ref cache_path) = temp_cache_path {
        let _ = tokio::fs::remove_file(cache_path).await;
        log::info!("Removed temporary upload cache file: {}", cache_path);
    }

    result
}

#[allow(clippy::too_many_arguments)] // Mirrors the public Tauri command after URI normalization.
async fn cmd_upload_file_inner(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    protection_mode: Option<String>,
    prompt_token: Option<u64>,
    protect_metadata: Option<bool>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    net_config: State<'_, std::sync::Arc<NetworkConfig>>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    let plaintext_size = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?
        .len();
    let protection_mode = UploadProtectionMode::parse(protection_mode.as_deref())?;
    let is_encrypted = protection_mode != UploadProtectionMode::Standard;

    // --- Encrypted upload path ---
    if is_encrypted {
        if !crypto_state.get_features().upload_enabled {
            return Err(
                "[ENCRYPTION_BLOCKED] Encrypted uploads are temporarily disabled while the corrected envelope and persistent vault are being completed. The file was not uploaded."
                    .to_string(),
            );
        }
        return cmd_upload_file_encrypted(
            path,
            folder_id,
            transfer_id,
            app_handle,
            state,
            bw_state,
            net_config,
            crypto_state,
            db_pool,
            plaintext_size,
            protection_mode,
            prompt_token,
            protect_metadata.unwrap_or(true),
        )
        .await;
    }

    // --- Standard upload path (unchanged) ---
    let size = plaintext_size;
    bw_state.try_reserve_up(size)?;

    let tid = transfer_id.unwrap_or_default();

    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        log::info!("[MOCK] Uploaded file {} to {:?}", path, folder_id);
        bw_state.release_up(size);
        return Ok("Mock upload successful".to_string());
    }
    let client = client_opt.ok_or_else(|| {
        bw_state.release_up(size);
        "Client not connected".to_string()
    })?;

    // Emit start progress
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "upload-progress",
            ProgressPayload {
                id: tid.clone(),
                percent: 0,
                uploaded_bytes: 0,
                total_bytes: size,
                speed_bytes_per_sec: 0,
            },
        );
    }

    // Create progress-tracking reader
    let (mut reader, file_size, bytes_counter) =
        ProgressReader::new(&path).await.inspect_err(|_| {
            bw_state.release_up(size);
        })?;
    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    // Spawn a progress reporter task that emits events every 250ms
    let cancelled = state.cancelled_transfers.clone();
    let progress_tid = tid.clone();
    let progress_handle = app_handle.clone();
    let progress_counter = bytes_counter.clone();
    let progress_task = if !tid.is_empty() {
        Some(tokio::spawn(async move {
            let mut last_bytes: u64 = 0;
            let mut last_time = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let current = progress_counter.load(std::sync::atomic::Ordering::Relaxed);
                let now = std::time::Instant::now();
                let dt = now.duration_since(last_time).as_secs_f64();
                let speed = if dt > 0.0 {
                    ((current - last_bytes) as f64 / dt) as u64
                } else {
                    0
                };
                let percent = if file_size > 0 {
                    ((current as f64 / file_size as f64) * 100.0).min(99.0) as u8
                } else {
                    0
                };

                let _ = progress_handle.emit(
                    "upload-progress",
                    ProgressPayload {
                        id: progress_tid.clone(),
                        percent,
                        uploaded_bytes: current,
                        total_bytes: file_size,
                        speed_bytes_per_sec: speed,
                    },
                );

                last_bytes = current;
                last_time = now;

                if current >= file_size {
                    break;
                }
                if cancelled.read().await.contains(&progress_tid) {
                    break;
                }
            }
        }))
    } else {
        None
    };

    // Check cancellation before starting
    if state.cancelled_transfers.read().await.contains(&tid) {
        state.cancelled_transfers.write().await.remove(&tid);
        if let Some(t) = progress_task {
            t.abort();
        }
        return Err("Transfer cancelled".to_string());
    }

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if !tid.is_empty() {
        get_upload_cancellations()
            .lock()
            .unwrap()
            .insert(tid.clone(), cancel_tx);
    }

    let client_clone = client.clone();
    let mut upload_task = tokio::spawn(async move {
        client_clone
            .upload_stream(&mut reader, file_size as usize, file_name)
            .await
    });

    let upload_result = {
        tokio::select! {
            res = &mut upload_task => {
                if !tid.is_empty() {
                    get_upload_cancellations().lock().unwrap().remove(&tid);
                }
                res.map_err(|e| {
                    bw_state.release_up(size);
                    format!("Task join error: {}", e)
                })?
            }
            _ = cancel_rx => {
                log::info!("Aborting upload task for transfer ID: {}", tid);
                upload_task.abort();
                state.cancelled_transfers.write().await.remove(&tid);
                if let Some(t) = progress_task { t.abort(); }
                bw_state.release_up(size);
                return Err("Transfer cancelled".to_string());
            }
        }
    };

    if let Some(t) = progress_task {
        t.abort();
    }

    let uploaded_file = upload_result.map_err(map_error)?;
    let message = InputMessage::new().text("").file(uploaded_file);

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    let max_retries = net_config.retry_attempts();
    let base_ms = net_config.retry_base_backoff_ms();
    let max_ms = net_config.retry_max_backoff_ms();
    let respect_flood = net_config.should_respect_flood_wait();
    let mut last_err = String::new();

    for attempt in 0..=max_retries {
        match client.send_message(&peer, message.clone()).await {
            Ok(sent) => {
                if !tid.is_empty() {
                    let _ = app_handle.emit(
                        "upload-progress",
                        ProgressPayload {
                            id: tid,
                            percent: 100,
                            uploaded_bytes: size,
                            total_bytes: size,
                            speed_bytes_per_sec: 0,
                        },
                    );
                }
                return Ok(sent.id().to_string());
            }
            Err(e) => {
                let err = map_error(e);
                log::warn!(
                    "send_message attempt {}/{}: {}",
                    attempt + 1,
                    max_retries + 1,
                    err
                );
                if respect_flood && err.starts_with("FLOOD_WAIT_") {
                    if let Ok(secs) = err.trim_start_matches("FLOOD_WAIT_").parse::<u64>() {
                        let wait = secs.min(300);
                        log::info!("Respecting FLOOD_WAIT: sleeping {}s", wait);
                        wait_for_telegram_cooldown(&app_handle, "Upload", wait).await;
                        last_err = err;
                        continue;
                    }
                }
                last_err = err;
                if attempt < max_retries {
                    let delay = backoff_ms(attempt, base_ms, max_ms);
                    log::info!("Retrying in {}ms...", delay);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }
    }

    Err(format!(
        "Upload failed after {} attempts: {}",
        max_retries + 1,
        last_err
    ))
}

/// Encrypted upload path: wraps the file with EncryptingReader, uploads TDENC1 bytes.
#[allow(clippy::too_many_arguments)] // Carries the same state bundle as the upload command.
async fn cmd_upload_file_encrypted(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    net_config: State<'_, std::sync::Arc<NetworkConfig>>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    db_pool: State<'_, DbConnection>,
    plaintext_size: u64,
    protection_mode: UploadProtectionMode,
    prompt_token: Option<u64>,
    protect_metadata: bool,
) -> Result<String, String> {
    use crate::crypto::envelope::length::calculate_ciphertext_length;

    let vault_wrapping_key = if protection_mode.needs_vault() {
        Some(crypto_state.get_current_wrapping_key().map_err(|_| {
            "[VAULT_LOCKED] Unlock the vault before starting this upload".to_string()
        })?)
    } else {
        None
    };
    let prompt_secret = if protection_mode.needs_passphrase() {
        let token = prompt_token.ok_or_else(|| {
            "[KEY_REQUIRED] Enter a file passphrase before starting this upload".to_string()
        })?;
        Some(
            crypto_state
                .consume_prompt_secret(token)
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };

    // Generate keys for the encryption session
    let dek = SecretKey::new(random::random_key());
    let file_uuid = random::random_uuid();
    let nonce_prefix = random::random_nonce_prefix();

    let ctx = KeySlotContext {
        file_uuid: &file_uuid,
        format_version: policy::FORMAT_VERSION,
    };
    let mut key_slots = Vec::with_capacity(
        if protection_mode == UploadProtectionMode::VaultAndPassphrase {
            2
        } else {
            1
        },
    );

    if let Some(wrapping_key) = vault_wrapping_key.as_ref() {
        let salt = random::random_salt();
        let slot_kind = policy::SlotKind::Vault as u8;
        let slot_id = 0;
        let file_wrapping_key =
            kdf::derive_file_wrapping_key(wrapping_key, &file_uuid, &salt, slot_kind, slot_id)
                .map_err(|e| format!("Failed to derive file wrapping key: {}", e))?;
        let (wrapped_dek, wrap_nonce) = wrap_dek(
            &ctx,
            &dek,
            &file_wrapping_key,
            slot_kind,
            slot_id,
            policy::KdfAlgorithm::HkdfSha256 as u16,
            0,
            0,
            0,
            &salt,
        )
        .map_err(|e| format!("Failed to wrap DEK: {}", e))?;
        key_slots.push(KeySlotEntry {
            kind: slot_kind,
            slot_id,
            kdf_algorithm: policy::KdfAlgorithm::HkdfSha256 as u16,
            argon2_memory_kib: 0,
            argon2_iterations: 0,
            argon2_parallelism: 0,
            salt,
            wrap_nonce,
            wrapped_dek,
        });
    }

    if let Some(passphrase) = prompt_secret.as_ref() {
        let salt = random::random_salt();
        let slot_kind = policy::SlotKind::Passphrase as u8;
        let slot_id = if key_slots.is_empty() { 0 } else { 1 };
        let memory_kib = policy::ARGON2_MEMORY_FLOOR_KIB;
        let iterations = policy::ARGON2_ITERATIONS_FLOOR;
        let parallelism = policy::ARGON2_PARALLELISM_FLOOR;
        let file_wrapping_key = kdf::derive_passphrase_key(
            passphrase.expose(),
            &salt,
            memory_kib,
            iterations,
            parallelism,
        )
        .map_err(|e| format!("Failed to derive passphrase key: {}", e))?;
        let (wrapped_dek, wrap_nonce) = wrap_dek(
            &ctx,
            &dek,
            &file_wrapping_key,
            slot_kind,
            slot_id,
            policy::KdfAlgorithm::Argon2id as u16,
            memory_kib,
            iterations,
            parallelism,
            &salt,
        )
        .map_err(|e| format!("Failed to wrap DEK: {}", e))?;
        key_slots.push(KeySlotEntry {
            kind: slot_kind,
            slot_id,
            kdf_algorithm: policy::KdfAlgorithm::Argon2id as u16,
            argon2_memory_kib: memory_kib,
            argon2_iterations: iterations,
            argon2_parallelism: parallelism,
            salt,
            wrap_nonce,
            wrapped_dek,
        });
    }

    let original_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Encrypted file");
    let mime_type = inferred_mime_type(&path);
    let metadata_plaintext = if protect_metadata {
        serde_json::to_vec(&ProtectedFileMetadata {
            schema_version: 1,
            original_name,
            mime_type,
        })
        .map_err(|e| format!("Failed to encode protected metadata: {}", e))?
    } else {
        Vec::new()
    };

    // Create encryption session with a protected original name and MIME type.
    let session = EncryptionSession::new_with_keys(
        plaintext_size,
        key_slots,
        metadata_plaintext,
        dek,
        file_uuid,
        nonce_prefix,
    )
    .map_err(|e| format!("Failed to create encryption session: {}", e))?;

    let ciphertext_size = calculate_ciphertext_length(
        plaintext_size,
        policy::DEFAULT_CHUNK_SIZE,
        session.header_bytes.len() as u32,
    )
    .map_err(|e| format!("Ciphertext size overflow: {}", e))?;

    // RAII reservation prevents quota leaks on every error and cancellation path.
    let mut bandwidth_reservation =
        BandwidthReservation::upload(bw_state.inner().clone(), ciphertext_size)?;

    let tid = transfer_id.unwrap_or_default();

    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        log::info!("[MOCK] Uploaded encrypted file {} to {:?}", path, folder_id);
        return Ok("Mock encrypted upload successful".to_string());
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    // Emit start progress (based on plaintext size for user familiarity)
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "upload-progress",
            ProgressPayload {
                id: tid.clone(),
                percent: 0,
                uploaded_bytes: 0,
                total_bytes: plaintext_size,
                speed_bytes_per_sec: 0,
            },
        );
    }

    // Use the standard plaintext-relative progress reader under encryption.
    let (reader, observed_plaintext_size, bytes_counter) = ProgressReader::new(&path).await?;
    if observed_plaintext_size != plaintext_size {
        return Err("Source file size changed before encryption started".to_string());
    }

    let cancelled = state.cancelled_transfers.clone();
    let progress_tid = tid.clone();
    let progress_handle = app_handle.clone();
    let progress_counter = bytes_counter.clone();
    let progress_task = if tid.is_empty() {
        None
    } else {
        Some(tokio::spawn(async move {
            let mut last_bytes = 0u64;
            let mut last_time = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let current = progress_counter.load(std::sync::atomic::Ordering::Relaxed);
                let now = std::time::Instant::now();
                let elapsed = now.duration_since(last_time).as_secs_f64();
                let speed = if elapsed > 0.0 {
                    ((current.saturating_sub(last_bytes)) as f64 / elapsed) as u64
                } else {
                    0
                };
                let percent = if plaintext_size == 0 {
                    0
                } else {
                    ((current as f64 / plaintext_size as f64) * 100.0).min(99.0) as u8
                };
                let _ = progress_handle.emit(
                    "upload-progress",
                    ProgressPayload {
                        id: progress_tid.clone(),
                        percent,
                        uploaded_bytes: current,
                        total_bytes: plaintext_size,
                        speed_bytes_per_sec: speed,
                    },
                );
                last_bytes = current;
                last_time = now;
                if current >= plaintext_size || cancelled.read().await.contains(&progress_tid) {
                    break;
                }
            }
        }))
    };

    // Wrap with EncryptingReader
    let mut encrypting_reader = EncryptingReader::new(reader, session);

    // Extract session info BEFORE the reader is moved into the spawn closure
    let file_uuid = encrypting_reader.session.file_uuid;
    let header_bytes_for_registry = encrypting_reader.session.header_bytes.clone();
    let b32_name = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(file_uuid);
    let remote_name = format!("tdrive_{}.tdenc", &b32_name[..b32_name.len().min(32)]);
    let remote_name_for_spawn = remote_name.clone();

    // Check cancellation before starting
    if state.cancelled_transfers.read().await.contains(&tid) {
        state.cancelled_transfers.write().await.remove(&tid);
        if let Some(task) = progress_task {
            task.abort();
        }
        return Err("Transfer cancelled".to_string());
    }

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if !tid.is_empty() {
        get_upload_cancellations()
            .lock()
            .unwrap()
            .insert(tid.clone(), cancel_tx);
    }

    let client_clone = client.clone();
    let mut upload_task = tokio::spawn(async move {
        client_clone
            .upload_stream(
                &mut encrypting_reader,
                ciphertext_size as usize,
                remote_name_for_spawn,
            )
            .await
    });

    let upload_result = {
        tokio::select! {
            res = &mut upload_task => {
                if !tid.is_empty() {
                    get_upload_cancellations().lock().unwrap().remove(&tid);
                }
                res.map_err(|e| {
                    format!("Task join error: {}", e)
                })?
            }
            _ = cancel_rx => {
                log::info!("Aborting encrypted upload for transfer ID: {}", tid);
                upload_task.abort();
                state.cancelled_transfers.write().await.remove(&tid);
                if let Some(task) = progress_task { task.abort(); }
                return Err("Transfer cancelled".to_string());
            }
        }
    };

    if let Some(task) = progress_task {
        task.abort();
    }

    let _uploaded_file = upload_result.map_err(map_error)?;
    let message = InputMessage::new().text("TDENC2").file(_uploaded_file);

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    let max_retries = net_config.retry_attempts();
    let base_ms = net_config.retry_base_backoff_ms();
    let max_ms = net_config.retry_max_backoff_ms();
    let respect_flood = net_config.should_respect_flood_wait();
    let mut last_err = String::new();

    for attempt in 0..=max_retries {
        match client.send_message(&peer, message.clone()).await {
            Ok(_sent) => {
                bandwidth_reservation.commit();
                if !tid.is_empty() {
                    let _ = app_handle.emit(
                        "upload-progress",
                        ProgressPayload {
                            id: tid,
                            percent: 100,
                            uploaded_bytes: plaintext_size,
                            total_bytes: plaintext_size,
                            speed_bytes_per_sec: 0,
                        },
                    );
                }
                let folder_key = folder_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "home".to_string());
                let header_sha256 = Sha256::digest(&header_bytes_for_registry).to_vec();
                let record = EncryptedFileRecord {
                    folder_key,
                    message_id: _sent.id(),
                    file_uuid: file_uuid.to_vec(),
                    envelope_version: policy::FORMAT_VERSION,
                    cipher_suite: policy::CIPHER_SUITE_XCHACHA20_POLY1305,
                    ciphertext_size,
                    plaintext_size: Some(plaintext_size),
                    remote_name: remote_name.clone(),
                    key_profile_id: Some(protection_mode.registry_name().to_string()),
                    protection_mode: protection_mode.registry_name().to_string(),
                    metadata_protected: protect_metadata,
                    header_blob: Some(header_bytes_for_registry.clone()),
                    header_sha256: Some(header_sha256),
                    record_state: EncryptedFileState::Active,
                    reconciliation_state: "ok".to_string(),
                    created_at: chrono::Utc::now().timestamp(),
                    last_verified_at: None,
                };
                let registry_result =
                    crate::db::with_connection(db_pool.inner().clone(), move |connection| {
                        upsert_encrypted_file(connection, &record)
                            .map_err(|error| error.to_string())
                    })
                    .await;
                if let Err(error) = registry_result {
                    log::error!(
                        "Encrypted upload {} succeeded as message {}, but registry reconciliation is required: {}",
                        remote_name,
                        _sent.id(),
                        error
                    );
                    return Ok(_sent.id().to_string());
                }
                return Ok(_sent.id().to_string());
            }
            Err(e) => {
                let err = map_error(e);
                log::warn!(
                    "send_message attempt {}/{}: {}",
                    attempt + 1,
                    max_retries + 1,
                    err
                );
                if respect_flood && err.starts_with("FLOOD_WAIT_") {
                    if let Ok(secs) = err.trim_start_matches("FLOOD_WAIT_").parse::<u64>() {
                        let wait = secs.min(300);
                        wait_for_telegram_cooldown(&app_handle, "Protected upload", wait).await;
                        last_err = err;
                        continue;
                    }
                }
                last_err = err;
                if attempt < max_retries {
                    let delay = backoff_ms(attempt, base_ms, max_ms);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }
    }

    Err(format!(
        "Encrypted upload failed after {} attempts: {}",
        max_retries + 1,
        last_err
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command dependency injection is intentionally explicit.
pub async fn initiate_upload(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    protection_mode: Option<String>,
    prompt_token: Option<u64>,
    protect_metadata: Option<bool>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    net_config: State<'_, std::sync::Arc<NetworkConfig>>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    crate::upload_service::start_foreground_service();
    cmd_upload_file(
        path,
        folder_id,
        transfer_id,
        protection_mode,
        prompt_token,
        protect_metadata,
        app_handle,
        state,
        bw_state,
        net_config,
        crypto_state,
        db_pool,
    )
    .await
}

#[tauri::command]
pub async fn cmd_rename_file(
    message_id: i32,
    folder_id: Option<i64>,
    new_name: String,
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
) -> Result<bool, String> {
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    let encrypted = crate::db::with_connection(db_pool.inner().clone(), move |connection| {
        let mut statement = connection
            .prepare("SELECT 1 FROM encrypted_files WHERE folder_key = ? AND message_id = ? AND record_state = 'active'")
            .map_err(|error| error.to_string())?;
        statement.bind((1, folder_key.as_str())).map_err(|error| error.to_string())?;
        statement.bind((2, i64::from(message_id))).map_err(|error| error.to_string())?;
        Ok(matches!(statement.next(), Ok(sqlite::State::Row)))
    }).await?;
    if encrypted {
        return Err("[ENCRYPTED_RENAME_UNAVAILABLE] Renaming encrypted files requires authenticated metadata rewrapping and is not yet available".to_string());
    }
    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        log::info!("[MOCK] Renamed message {} to {}", message_id, new_name);
        return Ok(true);
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    // Verify the message exists before attempting to edit it.
    // This avoids a cryptic MESSAGE_ID_INVALID RPC error when the message
    // was moved (forwarded → new ID) or deleted since the file list was loaded.
    let messages = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|e| format!("Failed to fetch message for rename: {}", e))?;
    if messages.iter().flatten().next().is_none() {
        return Err(format!(
            "Message {} not found in folder {:?}. The file may have been moved or deleted. Please refresh the folder.",
            message_id, folder_id
        ));
    }

    let input_peer = match &peer {
        Peer::User(u) => {
            let (id, access_hash) = match &u.raw {
                tl::enums::User::User(usr) => (usr.id, usr.access_hash.unwrap_or(0)),
                tl::enums::User::Empty(usr) => (usr.id, 0),
            };
            tl::enums::InputPeer::User(tl::types::InputPeerUser {
                user_id: id,
                access_hash,
            })
        }
        Peer::Channel(c) => tl::enums::InputPeer::Channel(tl::types::InputPeerChannel {
            channel_id: c.raw.id,
            access_hash: c.raw.access_hash.ok_or("No access hash for channel")?,
        }),
        _ => return Err("Unsupported peer type".to_string()),
    };

    client
        .invoke(&tl::functions::messages::EditMessage {
            peer: input_peer,
            id: message_id,
            no_webpage: false,
            invert_media: false,
            message: Some(new_name),
            media: None,
            reply_markup: None,
            entities: None,
            schedule_date: None,
            quick_reply_shortcut_id: None,
            schedule_repeat_period: None,
        })
        .await
        .map_err(|e| format!("Failed to rename file: {}", e))?;

    Ok(true)
}

#[tauri::command]
pub async fn cmd_delete_file(
    message_id: i32,
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
) -> Result<bool, String> {
    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        log::info!(
            "[MOCK] Deleted message {} from folder {:?}",
            message_id,
            folder_id
        );
        return Ok(true);
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    // Verify the message exists before attempting to delete it.
    // This avoids a cryptic MESSAGE_ID_INVALID RPC error when the message
    // was already moved or deleted since the file list was loaded.
    let messages = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|e| format!("Failed to fetch message for delete: {}", e))?;
    if messages.iter().flatten().next().is_none() {
        return Err(format!(
            "Message {} not found in folder {:?}. The file may have already been moved or deleted. Please refresh the folder.",
            message_id, folder_id
        ));
    }

    client
        .delete_messages(&peer, &[message_id])
        .await
        .map_err(|e| e.to_string())?;
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    let cleanup = crate::db::with_connection(db_pool.inner().clone(), move |connection| {
        let mut statement = connection
            .prepare("DELETE FROM encrypted_files WHERE folder_key = ? AND message_id = ?")
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, folder_key.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, i64::from(message_id)))
            .map_err(|error| error.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        Ok(())
    })
    .await;
    if let Err(error) = cleanup {
        log::error!(
            "Remote delete succeeded but encrypted registry cleanup failed: {}",
            error
        );
    }
    Ok(true)
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct DownloadFileRequest {
    pub message_id: i32,
    pub save_path: String,
    pub folder_id: Option<i64>,
    pub transfer_id: Option<String>,
    pub prompt_token: Option<u64>,
}

#[tauri::command]
pub async fn cmd_download_file(
    req: DownloadFileRequest,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    net_config: State<'_, std::sync::Arc<NetworkConfig>>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    let tid = req.transfer_id.unwrap_or_default();
    let save_path = req.save_path;
    let folder_id = req.folder_id;
    let message_id = req.message_id;
    let prompt_token = req.prompt_token;

    #[cfg(target_os = "android")]
    let (actual_save_path, android_file_name) = {
        use tauri::Manager;
        let cache_dir = app_handle
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to get cache dir: {}", e))?;
        if !cache_dir.exists() {
            let _ = std::fs::create_dir_all(&cache_dir);
        }
        // Android: save_path may be a content:// URI. Try to extract a clean filename.
        let raw = std::path::Path::new(&save_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download.bin");
        // URL-decode in case the path came from a content:// URI (e.g. primary%2Fmyfile.pdf)
        let decoded = url_decode(raw).trim_end_matches('/').to_string();
        // If the decoded value still looks like a URI path, take only the last segment
        let clean_name = std::path::Path::new(&decoded)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&decoded)
            .to_string();
        let file_name = if clean_name.is_empty() {
            "download.bin".to_string()
        } else {
            clean_name
        };
        let cache_path = cache_dir.join(&file_name).to_string_lossy().to_string();
        log::info!(
            "Android download: save_path='{}', extracted filename='{}', cache='{}'",
            save_path,
            file_name,
            cache_path
        );
        (cache_path, file_name)
    };

    #[cfg(not(target_os = "android"))]
    let actual_save_path = save_path.clone();
    #[cfg(target_os = "android")]
    let encrypted_android_file_name = Some(android_file_name.clone());
    #[cfg(not(target_os = "android"))]
    let encrypted_android_file_name: Option<String> = None;

    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        log::info!(
            "[MOCK] Downloaded message {} from {:?} to {}",
            message_id,
            folder_id,
            actual_save_path
        );
        if let Err(e) = tokio::fs::write(&actual_save_path, b"Mock Content").await {
            return Err(e.to_string());
        }
        return Ok("Download successful".to_string());
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    // Check if this file is encrypted in the registry
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    let encrypted_mode = crate::db::with_connection(db_pool.inner().clone(), move |conn| {
        let query = "SELECT protection_mode FROM encrypted_files WHERE folder_key = ? AND message_id = ? AND record_state = 'active'";
        let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
        stmt.bind((1, folder_key.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((2, message_id as i64)).map_err(|e| e.to_string())?;
        let mode = if matches!(stmt.next(), Ok(sqlite::State::Row)) {
            Some(stmt.read::<String, _>(0).unwrap_or_else(|_| "vault".to_string()))
        } else {
            None
        };
        Ok(mode)
    }).await?;

    let appears_to_be_unindexed_encrypted = if encrypted_mode.is_none() {
        let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
        let messages = client
            .get_messages_by_id(&peer, &[message_id])
            .await
            .map_err(|error| error.to_string())?;
        messages
            .into_iter()
            .flatten()
            .next()
            .is_some_and(|message| {
                let caption_matches = message.text() == "TDENC2";
                let name_matches = matches!(
                    message.media(),
                    Some(Media::Document(document))
                        if document.name().to_ascii_lowercase().ends_with(".tdenc")
                );
                caption_matches || name_matches
            })
    } else {
        false
    };

    if let Some(protection_mode) = encrypted_mode.as_deref() {
        if !crypto_state.get_features().read_enabled {
            return Err(
                "[ENCRYPTION_EXPERIMENTAL_UNSUPPORTED] This file uses the quarantined experimental encryption format. Its ciphertext has been preserved, but this build will not attempt unsafe decryption."
                    .to_string(),
            );
        }
        if protection_mode == "vault" && crypto_state.is_locked() {
            return Err("[VAULT_LOCKED] Unlock the vault before downloading this file".to_string());
        }
        return cmd_download_encrypted_file(
            message_id,
            folder_id,
            actual_save_path,
            tid,
            app_handle,
            state,
            bw_state,
            net_config,
            crypto_state,
            db_pool,
            client,
            prompt_token,
            encrypted_android_file_name,
        )
        .await;
    }
    if appears_to_be_unindexed_encrypted {
        if !crypto_state.get_features().read_enabled {
            return Err("[ENCRYPTION_BLOCKED] Encrypted reads are disabled".to_string());
        }
        return cmd_download_encrypted_file(
            message_id,
            folder_id,
            actual_save_path,
            tid,
            app_handle,
            state,
            bw_state,
            net_config,
            crypto_state,
            db_pool,
            client,
            prompt_token,
            encrypted_android_file_name,
        )
        .await;
    }

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    // Use get_messages_by_id for efficient message lookup (same as server.rs)
    let messages = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|e| e.to_string())?;

    let msg = messages
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "Message not found".to_string())?;

    let media = msg
        .media()
        .ok_or_else(|| "No media in message".to_string())?;

    let declared_size = media_size(&media);
    let expected_file_size = (declared_size > 0).then_some(declared_size);
    let total_size = declared_size;

    let mut bandwidth_reservation =
        BandwidthReservation::download(bw_state.inner().clone(), total_size)?;

    // Emit start
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "download-progress",
            ProgressPayload {
                id: tid.clone(),
                percent: 0,
                uploaded_bytes: 0,
                total_bytes: total_size,
                speed_bytes_per_sec: 0,
            },
        );
    }

    // Stream into a private sibling file. The destination remains untouched
    // until the complete payload has been flushed, synced, and verified.
    let mut download_iter = client.iter_download(&media);
    let destination = std::path::PathBuf::from(&actual_save_path);
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Failed to create download directory: {error}"))?;
    let partial_path = download_partial_path(&destination)?;
    let private_file = create_private_partial_file(&partial_path)
        .map_err(|error| format!("Failed to create secure download staging file: {error}"))?;
    let mut partial_guard = PartialFileGuard::new(partial_path.clone());
    let mut file = tokio::fs::File::from_std(private_file);
    let mut downloaded: u64 = 0;
    let mut last_emit_time = std::time::Instant::now();
    let mut last_emit_bytes: u64 = 0;
    let mut chunk_retry_budget = net_config.retry_attempts();

    while let Some(chunk) = download_iter.next().await.transpose() {
        // Check cancellation
        if state.cancelled_transfers.read().await.contains(&tid) {
            state.cancelled_transfers.write().await.remove(&tid);
            return Err("Transfer cancelled".to_string());
        }

        let bytes = match chunk {
            Ok(b) => {
                chunk_retry_budget = net_config.retry_attempts(); // reset on success
                b
            }
            Err(e) => {
                let err = map_error(&e);
                if chunk_retry_budget > 0 {
                    chunk_retry_budget -= 1;
                    log::warn!(
                        "Download chunk error (retries left: {}): {}",
                        chunk_retry_budget,
                        err
                    );
                    let delay = backoff_ms(
                        0,
                        net_config.retry_base_backoff_ms(),
                        net_config.retry_max_backoff_ms(),
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    continue;
                }
                return Err(format!("Download chunk error: {}", err));
            }
        };
        tokio::io::AsyncWriteExt::write_all(&mut file, &bytes)
            .await
            .map_err(|error| format!("Failed to write download staging file: {error}"))?;
        downloaded += bytes.len() as u64;

        // Time-based progress emission (every 250ms)
        if !tid.is_empty() {
            let now = std::time::Instant::now();
            let dt = now.duration_since(last_emit_time).as_secs_f64();
            if dt >= 0.25 || downloaded >= total_size {
                let speed = if dt > 0.0 {
                    ((downloaded - last_emit_bytes) as f64 / dt) as u64
                } else {
                    0
                };
                let percent = if total_size > 0 {
                    ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u8
                } else {
                    0
                };
                let _ = app_handle.emit(
                    "download-progress",
                    ProgressPayload {
                        id: tid.clone(),
                        percent,
                        uploaded_bytes: downloaded,
                        total_bytes: total_size,
                        speed_bytes_per_sec: speed,
                    },
                );
                last_emit_time = now;
                last_emit_bytes = downloaded;
            }
        }

        // Bandwidth throttle: if download limit is set, sleep to maintain rate
        let dl_limit = net_config.download_limit_bytes_per_sec();
        if dl_limit > 0 {
            let elapsed = last_emit_time.elapsed().as_secs_f64().max(0.001);
            let current_rate = (downloaded - last_emit_bytes) as f64 / elapsed;
            if current_rate > dl_limit as f64 {
                let sleep_ms = ((current_rate / dl_limit as f64 - 1.0) * elapsed * 1000.0) as u64;
                if sleep_ms > 0 && sleep_ms < 5000 {
                    tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                }
            }
        }
    }

    // Explicitly flush, sync, and close the file before JNI/MediaStore copies it.
    if let Err(e) = tokio::io::AsyncWriteExt::flush(&mut file).await {
        return Err(format!("Failed to flush downloaded file: {}", e));
    }
    if let Err(e) = file.sync_all().await {
        return Err(format!("Failed to sync downloaded file: {}", e));
    }
    drop(file);

    let actual_written = tokio::fs::metadata(&partial_path)
        .await
        .map_err(|e| format!("Downloaded file missing before save: {}", e))?
        .len();
    if actual_written == 0 {
        return Err("Downloaded file was empty before saving".to_string());
    }
    if actual_written != downloaded {
        return Err(format!(
            "Downloaded file size mismatch before saving: streamed {} bytes, file has {} bytes",
            downloaded, actual_written
        ));
    }
    if let Some(expected) = expected_file_size {
        if expected > 0 && downloaded != expected {
            return Err(format!(
                "Incomplete download before saving: expected {} bytes, received {} bytes",
                expected, downloaded
            ));
        }
    }
    publish_download_file(partial_path.clone(), destination.clone()).await?;
    partial_guard.disarm();
    log::info!(
        "Download verified and published to {} ({} bytes)",
        actual_save_path,
        actual_written
    );

    // Emit completion
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "download-progress",
            ProgressPayload {
                id: tid,
                percent: 100,
                uploaded_bytes: downloaded,
                total_bytes: total_size,
                speed_bytes_per_sec: 0,
            },
        );
    }

    #[cfg(target_os = "android")]
    {
        // Copy from actual_save_path to public downloads via MediaStore JNI!
        // Use the already-decoded filename from the cache path computation above
        let file_name = &android_file_name;

        let lower_ext = std::path::Path::new(file_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_lowercase();

        let mime_type = match lower_ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "pdf" => "application/pdf",
            "mp4" => "video/mp4",
            "mp3" => "audio/mpeg",
            "txt" => "text/plain",
            "zip" => "application/zip",
            "bin" => "application/octet-stream",
            _ => "application/octet-stream",
        };

        log::info!(
            "JNI: Copying {} from cache {} to public downloads",
            file_name,
            actual_save_path
        );

        let jni_success = {
            let mut success = false;
            let ctx = ndk_context::android_context();
            if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) } {
                if let Ok(mut env) = vm.attach_current_thread() {
                    if let Some(main_class) = crate::jni_cache::get_main_activity_jclass() {
                        if let Ok(j_cache_path) = env.new_string(&actual_save_path) {
                            if let Ok(j_file_name) = env.new_string(file_name) {
                                if let Ok(j_mime_type) = env.new_string(mime_type) {
                                    let call_res = env.call_static_method(
                                        &main_class,
                                        "saveFileToPublicDownloads",
                                        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z",
                                        &[
                                            jni::objects::JValue::from(&j_cache_path),
                                            jni::objects::JValue::from(&j_file_name),
                                            jni::objects::JValue::from(&j_mime_type),
                                        ],
                                    );

                                    match call_res {
                                        Ok(val) => {
                                            if let Ok(b) = val.z() {
                                                success = b;
                                            }
                                        }
                                        Err(e) => {
                                            log::error!(
                                                "JNI: saveFileToPublicDownloads call failed: {}",
                                                e
                                            );
                                            if env.exception_check().unwrap_or(false) {
                                                let _ = env.exception_describe();
                                                let _ = env.exception_clear();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        log::error!("JNI: MainActivity class reference was NOT cached globally!");
                    }
                }
            }
            success
        };

        if !jni_success {
            // Keep the cache file as a fallback so the user's data is not lost
            log::error!(
                "JNI: Failed to copy to public downloads. Cache file preserved at: {}",
                actual_save_path
            );
            return Err("Failed to save downloaded file to public downloads folder".to_string());
        }

        // Only clean up the cache copy AFTER confirming JNI succeeded
        let _ = tokio::fs::remove_file(&actual_save_path).await;
        log::info!(
            "JNI: Successfully copied to public downloads and cleaned up cache: {}",
            actual_save_path
        );
    }

    bandwidth_reservation.commit();

    Ok("Download successful".to_string())
}

/// Download a TDENC2 file with bounded memory. Each record is authenticated
/// before its plaintext is written to an owner-only partial file.
#[allow(clippy::too_many_arguments)] // Internal transfer orchestration keeps injected state explicit.
async fn cmd_download_encrypted_file(
    message_id: i32,
    folder_id: Option<i64>,
    save_path: String,
    tid: String,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    _net_config: State<'_, std::sync::Arc<NetworkConfig>>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    db_pool: State<'_, DbConnection>,
    client: grammers_client::Client,
    prompt_token: Option<u64>,
    _android_file_name: Option<String>,
) -> Result<String, String> {
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let messages = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|e| e.to_string())?;
    let msg = messages
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "Message not found".to_string())?;
    let media = msg
        .media()
        .ok_or_else(|| "No media in message".to_string())?;

    let ciphertext_size = match &media {
        Media::Document(d) => d.size() as u64,
        _ => {
            return Err("Encrypted file must be a document".to_string());
        }
    };
    let remote_name = match &media {
        Media::Document(document) => document.name().to_string(),
        _ => "encrypted.tdenc".to_string(),
    };

    let mut bandwidth_reservation =
        BandwidthReservation::download(bw_state.inner().clone(), ciphertext_size)?;

    // Emit decrypting phase
    if !tid.is_empty() {
        let _ = app_handle.emit(
            "download-progress",
            ProgressPayload {
                id: tid.clone(),
                percent: 0,
                uploaded_bytes: 0,
                total_bytes: ciphertext_size,
                speed_bytes_per_sec: 0,
            },
        );
    }

    let mut download_iter = client.iter_download(&media);
    let mut downloaded_ciphertext = 0u64;
    let mut header_bytes = Vec::with_capacity(policy::MAX_HEADER_LENGTH);
    let mut expected_header_length: Option<usize> = None;
    let vault_key = crypto_state.get_current_wrapping_key().ok();
    let prompt_passphrase = match prompt_token {
        Some(token) => Some(
            crypto_state
                .consume_prompt_secret(token)
                .map_err(|error| error.to_string())?,
        ),
        None => None,
    };
    let mut decryptor: Option<crate::crypto::envelope::decrypt_reader::DecryptReader> = None;
    let destination = std::path::PathBuf::from(&save_path);
    let parent = destination
        .parent()
        .ok_or_else(|| "Download destination has no parent directory".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Failed to create download directory: {}", error))?;
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let part_path = parent.join(format!(
        ".{}.{}.tdpart",
        destination_name,
        random::random_u64()
    ));
    let mut partial_guard = PartialFileGuard::new(part_path.clone());
    let mut output_file: Option<tokio::fs::File> = None;
    let mut plaintext_written = 0u64;
    let mut decoded_metadata: Option<DecodedProtectedFileMetadata> = None;

    while let Some(chunk) = download_iter.next().await.transpose() {
        if state.cancelled_transfers.read().await.contains(&tid) {
            state.cancelled_transfers.write().await.remove(&tid);
            return Err("Transfer cancelled".to_string());
        }
        let bytes =
            chunk.map_err(|error| format!("Download chunk error: {}", map_error(&error)))?;
        downloaded_ciphertext = downloaded_ciphertext.saturating_add(bytes.len() as u64);
        if downloaded_ciphertext > ciphertext_size {
            return Err("Encrypted download exceeded its declared size".to_string());
        }
        let mut remaining = bytes.as_slice();

        if decryptor.is_none() {
            while !remaining.is_empty() && decryptor.is_none() {
                let target = expected_header_length.unwrap_or(policy::CORE_HEADER_SIZE);
                let needed = target.saturating_sub(header_bytes.len());
                let take = needed.min(remaining.len());
                header_bytes.extend_from_slice(&remaining[..take]);
                remaining = &remaining[take..];

                if expected_header_length.is_none()
                    && header_bytes.len() == policy::CORE_HEADER_SIZE
                {
                    let core = crate::crypto::envelope::header::CoreHeader::parse(&header_bytes)
                        .map_err(|error| {
                            format!("Failed to parse encrypted preamble: {}", error)
                        })?;
                    expected_header_length = Some(core.header_length as usize);
                }

                if let Some(expected) = expected_header_length {
                    if header_bytes.len() == expected {
                        let parsed =
                            crate::crypto::envelope::header::EnvelopeHeader::parse(&header_bytes)
                                .map_err(|error| {
                                format!("Failed to parse encrypted header: {}", error)
                            })?;
                        let expected_total =
                            crate::crypto::envelope::length::calculate_ciphertext_length(
                                parsed.core.total_plaintext_length,
                                parsed.core.chunk_size,
                                parsed.core.header_length,
                            )
                            .map_err(|error| format!("Invalid encrypted length: {}", error))?;
                        if expected_total != ciphertext_size {
                            return Err(format!(
                                "Encrypted file length mismatch: expected {}, Telegram reported {}",
                                expected_total, ciphertext_size
                            ));
                        }
                        let probed_record = registry_record_from_header(
                            folder_id,
                            message_id,
                            remote_name.clone(),
                            ciphertext_size,
                            header_bytes.clone(),
                            "probed_unverified",
                        )?;
                        let probed_record_for_db = probed_record.clone();
                        crate::db::with_connection(db_pool.inner().clone(), move |connection| {
                            upsert_encrypted_file(connection, &probed_record_for_db).map_err(
                                |error| format!("[ENCRYPTION_REGISTRY_UNAVAILABLE] {}", error),
                            )
                        })
                        .await?;
                        let reader = initialize_tdenc2_decryptor(
                            &header_bytes,
                            vault_key.as_ref(),
                            prompt_passphrase.as_ref(),
                        )?;
                        let mut authenticated_record = probed_record;
                        authenticated_record.reconciliation_state =
                            "header_authenticated".to_string();
                        let registry_update = crate::db::with_connection(
                            db_pool.inner().clone(),
                            move |connection| {
                                upsert_encrypted_file(connection, &authenticated_record)
                                    .map_err(|error| error.to_string())
                            },
                        )
                        .await;
                        if let Err(error) = registry_update {
                            log::error!("Authenticated encrypted header could not update registry state: {}", error);
                        }
                        if !reader.metadata_plaintext().is_empty() {
                            let metadata: DecodedProtectedFileMetadata =
                                serde_json::from_slice(reader.metadata_plaintext())
                                    .map_err(|_| "Encrypted metadata is invalid".to_string())?;
                            if metadata.schema_version != 1
                                || metadata.original_name.is_empty()
                                || metadata.mime_type.is_empty()
                            {
                                return Err(
                                    "Encrypted metadata version or fields are invalid".to_string()
                                );
                            }
                            decoded_metadata = Some(metadata);
                        }
                        let std_file =
                            create_private_partial_file(&part_path).map_err(|error| {
                                format!("Failed to create secure partial file: {}", error)
                            })?;
                        output_file = Some(tokio::fs::File::from_std(std_file));
                        decryptor = Some(reader);
                    }
                }
            }
        }

        if !remaining.is_empty() {
            let reader = decryptor
                .as_mut()
                .ok_or_else(|| "Encrypted header was not initialized".to_string())?;
            let mut plaintext = reader
                .feed(remaining)
                .map_err(|error| format!("Encrypted record authentication failed: {}", error))?;
            if !plaintext.is_empty() {
                use tokio::io::AsyncWriteExt;
                output_file
                    .as_mut()
                    .ok_or_else(|| "Secure partial file is unavailable".to_string())?
                    .write_all(&plaintext)
                    .await
                    .map_err(|error| format!("Failed to write verified plaintext: {}", error))?;
                plaintext_written = plaintext_written.saturating_add(plaintext.len() as u64);
                zeroize::Zeroize::zeroize(&mut plaintext);
            }
        }

        if !tid.is_empty() {
            let total_plaintext = decryptor
                .as_ref()
                .map(|reader| reader.plaintext_length())
                .unwrap_or(0);
            let percent = if total_plaintext == 0 {
                0
            } else {
                ((plaintext_written as f64 / total_plaintext as f64) * 100.0).min(99.0) as u8
            };
            let _ = app_handle.emit(
                "download-progress",
                ProgressPayload {
                    id: tid.clone(),
                    percent,
                    uploaded_bytes: plaintext_written,
                    total_bytes: total_plaintext,
                    speed_bytes_per_sec: 0,
                },
            );
        }
    }

    if downloaded_ciphertext != ciphertext_size {
        return Err("Encrypted download ended before its declared size".to_string());
    }
    let reader = decryptor
        .as_ref()
        .ok_or_else(|| "Encrypted file ended before a complete header was received".to_string())?;
    reader
        .finish()
        .map_err(|error| format!("Encrypted final record is missing or invalid: {}", error))?;
    if plaintext_written != reader.plaintext_length() {
        return Err("Verified plaintext length mismatch".to_string());
    }

    use tokio::io::AsyncWriteExt;
    let mut file = output_file
        .take()
        .ok_or_else(|| "Secure partial file is unavailable".to_string())?;
    file.flush()
        .await
        .map_err(|error| format!("Failed to flush verified file: {}", error))?;
    file.sync_all()
        .await
        .map_err(|error| format!("Failed to sync verified file: {}", error))?;
    drop(file);
    publish_download_file(part_path.clone(), destination).await?;
    partial_guard.disarm();
    bandwidth_reservation.commit();
    if crypto_state.record_activity() {
        let _ = app_handle.emit("vault-locked", "auto_lock");
    }

    if !tid.is_empty() {
        let _ = app_handle.emit(
            "download-progress",
            ProgressPayload {
                id: tid,
                percent: 100,
                uploaded_bytes: plaintext_written,
                total_bytes: plaintext_written,
                speed_bytes_per_sec: 0,
            },
        );
    }

    let protected_mime = decoded_metadata
        .as_ref()
        .map(|metadata| metadata.mime_type.as_str())
        .unwrap_or("application/octet-stream");
    #[cfg(target_os = "android")]
    if let Some(file_name) = _android_file_name.as_deref() {
        let publish_name = decoded_metadata
            .as_ref()
            .map(|metadata| metadata.original_name.as_str())
            .unwrap_or(file_name);
        publish_verified_android_download(&save_path, publish_name, protected_mime).map_err(
            |error| {
                format!(
                    "{}; verified cache copy was preserved at {}",
                    error, save_path
                )
            },
        )?;
        tokio::fs::remove_file(&save_path).await.map_err(|error| {
            format!(
                "Published file but failed to clear verified cache copy: {}",
                error
            )
        })?;
    }
    log::info!(
        "Encrypted download complete: message {} -> {} ({} verified plaintext bytes, MIME {})",
        message_id,
        save_path,
        plaintext_written,
        protected_mime
    );
    Ok("Encrypted download successful".to_string())
}

#[tauri::command]
pub async fn cmd_move_files(
    message_ids: Vec<i32>,
    source_folder_id: Option<i64>,
    target_folder_id: Option<i64>,
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
) -> Result<bool, String> {
    if source_folder_id == target_folder_id {
        return Ok(true);
    }
    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        log::info!(
            "[MOCK] Moved msgs {:?} from {:?} to {:?}",
            message_ids,
            source_folder_id,
            target_folder_id
        );
        return Ok(true);
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    let source_peer = resolve_peer(&client, source_folder_id, &state.peer_cache).await?;
    let target_peer = resolve_peer(&client, target_folder_id, &state.peer_cache).await?;

    let forwarded = match client
        .forward_messages(&target_peer, &message_ids, &source_peer)
        .await
    {
        Ok(messages) => messages,
        Err(e) => return Err(format!("Forward failed: {}", e)),
    };

    match client.delete_messages(&source_peer, &message_ids).await {
        Ok(_) => {}
        Err(e) => return Err(format!("Delete original failed: {}", e)),
    }

    if forwarded.len() == message_ids.len() {
        let source_key = source_folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "home".to_string());
        let target_key = target_folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "home".to_string());
        let relocations = message_ids
            .iter()
            .zip(forwarded.iter())
            .map(|(old_id, new_message)| {
                new_message.as_ref().map(|message| (*old_id, message.id()))
            })
            .collect::<Option<Vec<_>>>();
        if let Some(relocations) = relocations {
            let registry_result = crate::db::with_connection(db_pool.inner().clone(), move |connection| {
                connection.execute("BEGIN IMMEDIATE").map_err(|error| error.to_string())?;
                let relocation = (|| {
                for (old_id, new_message_id) in relocations {
                    let update = connection
                        .prepare("UPDATE encrypted_files SET folder_key = ?, message_id = ?, reconciliation_state = 'ok' WHERE folder_key = ? AND message_id = ?")
                        .and_then(|mut statement| {
                            statement.bind((1, target_key.as_str()))?;
                            statement.bind((2, i64::from(new_message_id)))?;
                            statement.bind((3, source_key.as_str()))?;
                            statement.bind((4, i64::from(old_id)))?;
                            statement.next().map(|_| ())
                        });
                    update.map_err(|error| error.to_string())?;
                }
                Ok::<(), String>(())
                })();
                match relocation {
                    Ok(()) => connection.execute("COMMIT").map_err(|error| error.to_string()),
                    Err(error) => {
                        let _ = connection.execute("ROLLBACK");
                        Err(error)
                    }
                }
            }).await;
            if let Err(error) = registry_result {
                log::error!(
                    "Remote move succeeded but encrypted registry relocation failed: {}",
                    error
                );
            }
        } else {
            log::error!(
                "Remote move did not return a message identifier; registry reconciliation required"
            );
        }
    } else {
        log::error!(
            "Remote move returned {} forwarded messages for {} source messages; registry reconciliation required",
            forwarded.len(),
            message_ids.len()
        );
    }

    Ok(true)
}

#[tauri::command]
pub async fn cmd_get_files(
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
) -> Result<Vec<FileMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        log::info!("[MOCK] Returning mock files for folder {:?}", folder_id);
        return Ok(Vec::new()); // No mock files for now
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    // Pre-load encrypted file registry for this folder
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    let (encrypted_map, activity_flags): (HashMap<i32, EncryptedListInfo>, HashMap<i32, (bool, bool)>) =
        crate::db::with_connection(db_pool.inner().clone(), move |conn| {
        let mut encrypted_map = HashMap::new();
        let query = "SELECT message_id, remote_name, envelope_version, protection_mode, metadata_protected, header_blob, plaintext_size FROM encrypted_files WHERE folder_key = ? AND record_state = 'active'";
        if let Ok(mut stmt) = conn.prepare(query) {
            let _ = stmt.bind((1, folder_key.as_str()));
            while let Ok(sqlite::State::Row) = stmt.next() {
                let msg_id: i64 = stmt.read::<i64, _>(0).unwrap_or(0);
                let remote_name: String = stmt.read::<String, _>(1).unwrap_or_default();
                let envelope_version = stmt.read::<i64, _>(2).unwrap_or(0) as u16;
                let protection_mode = stmt.read::<String, _>(3).unwrap_or_else(|_| "vault".to_string());
                let metadata_protected = stmt.read::<i64, _>(4).unwrap_or(1) != 0;
                let header_blob = stmt.read::<Option<Vec<u8>>, _>(5).ok().flatten();
                let plaintext_size = stmt
                    .read::<Option<i64>, _>(6)
                    .ok()
                    .flatten()
                    .and_then(|value| u64::try_from(value).ok());
                encrypted_map.insert(msg_id as i32, EncryptedListInfo {
                    remote_name,
                    envelope_version,
                    protection_mode,
                    metadata_protected,
                    header_blob,
                    plaintext_size,
                });
            }
        }
        let mut activity_flags = HashMap::new();
        if let Ok(mut statement) = conn.prepare(
            "SELECT message_id, is_favorite, is_pinned FROM file_activity WHERE folder_key = ?",
        ) {
            let _ = statement.bind((1, folder_key.as_str()));
            while let Ok(sqlite::State::Row) = statement.next() {
                let message_id = statement.read::<i64, _>(0).unwrap_or(0) as i32;
                let favorite = statement.read::<i64, _>(1).unwrap_or(0) != 0;
                let pinned = statement.read::<i64, _>(2).unwrap_or(0) != 0;
                activity_flags.insert(message_id, (favorite, pinned));
            }
        }
        Ok((encrypted_map, activity_flags))
    }).await?;

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let vault_key = crypto_state.get_current_wrapping_key().ok();

    let mut msgs = client.iter_messages(&peer);
    let mut last_msg_id: Option<i32> = None;
    let mut safety_counter = 0;
    const MAX_FILES_LIMIT: usize = 50000; // Hard safety cap to prevent infinite loops (50,000 files)

    let mut chunk = Vec::new();

    while let Some(msg) = msgs.next().await.map_err(|e| e.to_string())? {
        // Prevent infinite loop if API returns same message ID
        let current_msg_id = msg.id();
        if let Some(last_id) = last_msg_id {
            if current_msg_id == last_id {
                break;
            }
        }
        last_msg_id = Some(current_msg_id);

        if let Some(doc) = msg.media() {
            let declared_size = media_size(&doc);
            let (mut name, mut size, mut mime, mut ext, remote_document_name) = match doc {
                Media::Document(d) => {
                    let doc_name = d.name().to_string();
                    // Prefer the message caption (set by rename via EditMessage) over the
                    // document's built-in filename attribute, so renames persist across refreshes.
                    let caption = msg.text();
                    let display_name = if caption.is_empty() {
                        doc_name.clone()
                    } else {
                        caption.to_string()
                    };
                    let m = d.mime_type().map(|s| s.to_string());
                    // Extension always from the original document name for correct file-type icon
                    let e = std::path::Path::new(&doc_name)
                        .extension()
                        .map(|os| os.to_str().unwrap_or("").to_string());
                    (display_name, declared_size, m, e, doc_name)
                }
                Media::Photo(_) => (
                    "Photo.jpg".to_string(),
                    declared_size,
                    Some("image/jpeg".into()),
                    Some("jpg".into()),
                    "Photo.jpg".to_string(),
                ),
                _ => ("Unknown".to_string(), 0, None, None, "Unknown".to_string()),
            };
            let file_id_i64 = msg.id() as i64;
            let msg_id_i32 = msg.id();
            let suspected_tdenc2 = name == "TDENC2"
                || remote_document_name
                    .to_ascii_lowercase()
                    .ends_with(".tdenc");
            let mut reconciled_info: Option<EncryptedListInfo> = None;
            let mut probe_failed = false;
            if !encrypted_map.contains_key(&msg_id_i32) && suspected_tdenc2 {
                if let Some(media) = msg.media() {
                    match probe_tdenc2_header(&client, &media)
                        .await
                        .and_then(|header_bytes| {
                            registry_record_from_header(
                                folder_id,
                                msg_id_i32,
                                remote_document_name.clone(),
                                size,
                                header_bytes,
                                "probed_unverified",
                            )
                        }) {
                        Ok(record) => {
                            let info = EncryptedListInfo {
                                remote_name: record.remote_name.clone(),
                                envelope_version: record.envelope_version,
                                protection_mode: record.protection_mode.clone(),
                                metadata_protected: record.metadata_protected,
                                header_blob: record.header_blob.clone(),
                                plaintext_size: record.plaintext_size,
                            };
                            let registry_result = crate::db::with_connection(
                                db_pool.inner().clone(),
                                move |connection| {
                                    upsert_encrypted_file(connection, &record)
                                        .map_err(|error| error.to_string())
                                },
                            )
                            .await;
                            if let Err(error) = registry_result {
                                log::error!(
                                    "Failed to index probed encrypted file {}: {}",
                                    msg_id_i32,
                                    error
                                );
                                probe_failed = true;
                            } else {
                                reconciled_info = Some(info);
                            }
                        }
                        Err(error) => {
                            log::warn!("TDENC2 probe failed for message {}: {}", msg_id_i32, error);
                            probe_failed = true;
                        }
                    }
                }
            }
            let encrypted_info = encrypted_map.get(&msg_id_i32).or(reconciled_info.as_ref());
            let enc_state = if let Some(info) = encrypted_info {
                if info.envelope_version != policy::FORMAT_VERSION {
                    "encrypted_unsupported_version"
                } else if vault_key.is_some()
                    && matches!(
                        info.protection_mode.as_str(),
                        "vault" | "vault_and_passphrase"
                    )
                {
                    "encrypted_unlocked"
                } else {
                    "encrypted_locked"
                }
            } else if probe_failed && name == "TDENC2" {
                "encrypted_corrupt"
            } else if suspected_tdenc2 {
                "encrypted_key_missing"
            } else {
                "plain"
            };
            if let Some(info) = encrypted_info {
                if let Some(plaintext_size) = info.plaintext_size {
                    size = plaintext_size;
                }
                if info.metadata_protected {
                    name = "Encrypted file".to_string();
                    mime = Some("application/octet-stream".to_string());
                    ext = None;
                    if let Some(header) = info.header_blob.as_deref() {
                        if let Ok(reader) =
                            initialize_tdenc2_decryptor(header, vault_key.as_ref(), None)
                        {
                            if let Ok(metadata) =
                                serde_json::from_slice::<DecodedProtectedFileMetadata>(
                                    reader.metadata_plaintext(),
                                )
                            {
                                if metadata.schema_version == 1
                                    && !metadata.original_name.is_empty()
                                {
                                    name = metadata.original_name;
                                    mime = Some(metadata.mime_type);
                                    ext = std::path::Path::new(&name)
                                        .extension()
                                        .and_then(|value| value.to_str())
                                        .map(str::to_string);
                                }
                            }
                        }
                    }
                } else if !info.remote_name.is_empty() && name == "TDENC2" {
                    name = info.remote_name.clone();
                }
            } else if suspected_tdenc2 {
                name = "Encrypted file".to_string();
                mime = Some("application/octet-stream".to_string());
                ext = None;
            }
            let (is_favorite, is_pinned) = activity_flags
                .get(&msg_id_i32)
                .copied()
                .unwrap_or((false, false));
            chunk.push(FileMetadata {
                id: file_id_i64,
                folder_id,
                name,
                size,
                mime_type: mime,
                file_ext: ext,
                created_at: msg.date().to_string(),
                icon_type: "file".into(),
                encryption_state: enc_state.to_string(),
                is_favorite,
                is_pinned,
            });

            if chunk.len() >= 500 {
                #[derive(Clone, serde::Serialize)]
                struct FolderLoadPayload {
                    #[serde(rename = "folderId")]
                    folder_id: Option<i64>,
                    files: Vec<FileMetadata>,
                }
                let _ = app_handle.emit(
                    "folder-load-chunk",
                    FolderLoadPayload {
                        folder_id,
                        files: chunk.clone(),
                    },
                );

                safety_counter += chunk.len();
                chunk.clear();

                if safety_counter >= MAX_FILES_LIMIT {
                    break;
                }
            }
        }
    }

    if !chunk.is_empty() {
        #[derive(Clone, serde::Serialize)]
        struct FolderLoadPayload {
            #[serde(rename = "folderId")]
            folder_id: Option<i64>,
            files: Vec<FileMetadata>,
        }
        let _ = app_handle.emit(
            "folder-load-chunk",
            FolderLoadPayload {
                folder_id,
                files: chunk,
            },
        );
    }

    Ok(Vec::new())
}

/// Extract FileMetadata entries from a list of Telegram messages returned by SearchGlobal.
fn extract_search_files(msgs: &[tl::enums::Message]) -> Vec<FileMetadata> {
    let mut files = Vec::new();
    for msg in msgs {
        if let tl::enums::Message::Message(m) = msg {
            if let Some(tl::enums::MessageMedia::Document(d)) = &m.media {
                if let Some(tl::enums::Document::Document(doc)) = &d.document {
                    let doc_name = doc
                        .attributes
                        .iter()
                        .find_map(|a| match a {
                            tl::enums::DocumentAttribute::Filename(f) => Some(f.file_name.clone()),
                            _ => None,
                        })
                        .unwrap_or("Unknown".to_string());
                    // Prefer the message caption over the built-in document filename
                    let name = if m.message.is_empty() {
                        doc_name.clone()
                    } else {
                        m.message.clone()
                    };
                    let size = doc.size as u64;
                    let mime = doc.mime_type.clone();
                    let ext = std::path::Path::new(&doc_name)
                        .extension()
                        .map(|os| os.to_str().unwrap_or("").to_string());
                    let folder_id = match &m.peer_id {
                        tl::enums::Peer::Channel(c) => Some(c.channel_id),
                        tl::enums::Peer::User(u) => Some(u.user_id),
                        tl::enums::Peer::Chat(c) => Some(c.chat_id),
                    };
                    files.push(FileMetadata {
                        id: m.id as i64,
                        folder_id,
                        name,
                        size,
                        mime_type: Some(mime),
                        file_ext: ext,
                        created_at: m.date.to_string(),
                        icon_type: "file".into(),
                        encryption_state: "plain".to_string(),
                        is_favorite: false,
                        is_pinned: false,
                    });
                }
            }
        }
    }
    files
}

#[tauri::command]
pub async fn cmd_search_global(
    query: String,
    state: State<'_, TelegramState>,
) -> Result<Vec<FileMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        return Ok(Vec::new());
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    log::info!("Searching global for: {}", query);

    let result = client
        .invoke(&tl::functions::messages::SearchGlobal {
            q: query,
            filter: tl::enums::MessagesFilter::InputMessagesFilterDocument,
            min_date: 0,
            max_date: 0,
            offset_rate: 0,
            offset_peer: tl::enums::InputPeer::Empty,
            offset_id: 0,
            limit: 50,
            folder_id: None,
            broadcasts_only: false,
            groups_only: false,
            users_only: false,
        })
        .await
        .map_err(map_error)?;

    let files = match result {
        tl::enums::messages::Messages::Messages(msgs) => extract_search_files(&msgs.messages),
        tl::enums::messages::Messages::Slice(msgs) => extract_search_files(&msgs.messages),
        _ => Vec::new(),
    };

    Ok(files)
}

#[tauri::command]
pub async fn cmd_scan_folders(
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
) -> Result<Vec<FolderMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        // If not connected, return whatever is already in the database
        return crate::commands::folder_groups::cmd_get_enriched_folders(db_pool).await;
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    let mut folders = Vec::new();
    let mut dialogs = client.iter_dialogs();
    let mut discovered = HashMap::new();

    log::info!("Starting Folder Scan...");

    while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
        // Populate peer cache for every dialog we encounter (free priming)
        match &dialog.peer {
            Peer::Channel(c) => {
                let id = c.raw.id;
                discovered.insert(id, dialog.peer.clone());

                let name = c.raw.title.clone();
                let access_hash = c.raw.access_hash.unwrap_or(0);

                log::debug!("[SCAN] Processing Channel: '{}' (ID: {})", name, id);

                // Strategy 1: Title
                if name.to_lowercase().contains("[td]") {
                    log::info!(" -> MATCH via Title: {}", name);
                    let display_name = name
                        .replace(" [TD]", "")
                        .replace(" [td]", "")
                        .replace("[TD]", "")
                        .replace("[td]", "")
                        .trim()
                        .to_string();
                    let username = c.raw.username.clone();
                    let is_public = username.is_some();
                    folders.push(FolderMetadata {
                        id,
                        name: display_name,
                        parent_id: None,
                        username,
                        is_public,
                        group_id: None,
                        display_order: 0,
                    });
                    continue;
                }

                // Strategy 2: About (Only if we are the creator to avoid rate limits on third-party channels)
                if c.raw.creator {
                    let input_chan = tl::enums::InputChannel::Channel(tl::types::InputChannel {
                        channel_id: c.raw.id,
                        access_hash,
                    });

                    match client
                        .invoke(&tl::functions::channels::GetFullChannel {
                            channel: input_chan,
                        })
                        .await
                    {
                        Ok(tl::enums::messages::ChatFull::Full(f)) => {
                            if let tl::enums::ChatFull::Full(cf) = f.full_chat {
                                if cf.about.contains("[telegram-drive-folder]") {
                                    log::info!(" -> MATCH via About: {}", name);
                                    let username = c.raw.username.clone();
                                    let is_public = username.is_some();
                                    folders.push(FolderMetadata {
                                        id,
                                        name: name.clone(),
                                        parent_id: None,
                                        username,
                                        is_public,
                                        group_id: None,
                                        display_order: 0,
                                    });
                                }
                            }
                        }
                        Err(e) => log::warn!(" -> Failed to get full info: {}", e),
                    }
                }
            }
            Peer::User(u) => {
                discovered.insert(u.raw.id(), dialog.peer.clone());
                log::debug!("[SCAN] Cached User Peer: {}", u.raw.id());
            }
            peer => {
                log::debug!("[SCAN] Skipped Peer: {:?}", peer);
            }
        }
    }

    {
        let mut cache = state.peer_cache.write().await;
        cache.extend(discovered);
    }

    let cache_len = state.peer_cache.read().await.len();
    log::info!(
        "Scan complete. Found {} folders. Peer cache size: {}.",
        folders.len(),
        cache_len
    );

    // Enrich folders via the local DB
    let enriched = crate::db::with_connection(db_pool.inner().clone(), move |conn| {
        crate::commands::folder_groups::get_enriched_folders_internal(conn, folders)
    })
    .await?;
    Ok(enriched)
}

const MAX_ZIP_SOURCE_BYTES: u64 = 2_147_483_648;
const MAX_ZIP_FILE_COUNT: usize = 100_000;

fn zip_artifact_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Unable to locate the application cache: {error}"))?
        .join("transfer-zips");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Unable to create the ZIP staging directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Unable to protect the ZIP staging directory: {error}"))?;
    }
    root.canonicalize()
        .map_err(|error| format!("Unable to resolve the ZIP staging directory: {error}"))
}

fn is_owned_zip_artifact(root: &std::path::Path, path: &std::path::Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 2 {
        return false;
    }
    let Some(directory) = components[0].as_os_str().to_str() else {
        return false;
    };
    let Some(filename) = components[1].as_os_str().to_str() else {
        return false;
    };
    uuid::Uuid::parse_str(directory).is_ok()
        && std::path::Path::new(filename)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

/// Zip a folder's contents into an application-owned temporary file and return the path.
/// The resulting zip preserves the relative directory structure.
#[tauri::command]
pub async fn cmd_zip_folder(folder_path: String, app: tauri::AppHandle) -> Result<String, String> {
    let folder_path = if cfg!(target_os = "android") {
        clean_android_path(&folder_path)
    } else {
        folder_path
    };

    let src = std::path::Path::new(&folder_path)
        .canonicalize()
        .map_err(|e| format!("Invalid folder path: {}", e))?;
    if !src.is_dir() {
        return Err(format!("'{}' is not a directory", folder_path));
    }

    let folder_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "folder".to_string());

    let zip_root = zip_artifact_root(&app)?;
    let artifact_directory = zip_root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&artifact_directory)
        .map_err(|error| format!("Unable to create private ZIP staging: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&artifact_directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Unable to protect private ZIP staging: {error}"))?;
    }
    let zip_path = artifact_directory.join(format!("{}.zip", folder_name));
    let src_owned = src.clone();
    let out_path = zip_path.clone();

    // Run blocking I/O on a dedicated thread so we don't stall the async runtime
    let zip_result = tokio::task::spawn_blocking(move || {
        let mut entries = Vec::new();
        let mut file_count = 0usize;
        let mut source_bytes = 0u64;
        for entry in walkdir::WalkDir::new(&src_owned).follow_links(false) {
            let entry = entry.map_err(|error| format!("Unable to read folder entry: {error}"))?;
            if entry.file_type().is_symlink() {
                return Err(format!(
                    "Symbolic links are not included in folder uploads: {}",
                    entry.path().display()
                ));
            }
            if entry.file_type().is_file() {
                file_count = file_count.saturating_add(1);
                if file_count > MAX_ZIP_FILE_COUNT {
                    return Err(format!(
                        "Folder upload exceeds the {MAX_ZIP_FILE_COUNT} file safety limit"
                    ));
                }
                let size = entry
                    .metadata()
                    .map_err(|error| format!("Unable to read {}: {error}", entry.path().display()))?
                    .len();
                source_bytes = source_bytes.saturating_add(size);
                if source_bytes > MAX_ZIP_SOURCE_BYTES {
                    return Err("Folder upload exceeds the 2 GB source safety limit".to_string());
                }
            }
            entries.push(entry);
        }

        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&out_path)
            .map_err(|e| format!("Failed to create zip file: {}", e))?;
        let mut zip_writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for entry in entries {
            let path = entry.path();
            let relative = path.strip_prefix(&src_owned).unwrap_or(path);

            if entry.file_type().is_file() {
                let name = relative.to_string_lossy().replace('\\', "/");
                zip_writer
                    .start_file(&name, options)
                    .map_err(|e| format!("Failed to add '{}': {}", name, e))?;
                let mut f = std::fs::File::open(path)
                    .map_err(|e| format!("Failed to open '{}': {}", name, e))?;
                let copied = std::io::copy(&mut f, &mut zip_writer)
                    .map_err(|e| format!("Failed to write '{}': {}", name, e))?;
                let expected = f
                    .metadata()
                    .map_err(|error| format!("Unable to verify '{}': {error}", name))?
                    .len();
                if copied != expected {
                    return Err(format!("Source file changed while archiving: {name}"));
                }
            } else if entry.file_type().is_dir() && path != src_owned {
                let dir_name = format!("{}/", relative.to_string_lossy().replace('\\', "/"));
                zip_writer
                    .add_directory(&dir_name, options)
                    .map_err(|e| format!("Failed to add dir '{}': {}", dir_name, e))?;
            }
        }

        zip_writer
            .finish()
            .map_err(|e| format!("Failed to finalize zip: {}", e))?;
        let size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        if size > MAX_ZIP_SOURCE_BYTES {
            return Err("Created ZIP exceeds the 2 GB upload safety limit".to_string());
        }
        Ok::<(String, u64), String>((out_path.to_string_lossy().to_string(), size))
    })
    .await
    .map_err(|e| format!("Zip task panicked: {}", e))?
    .map_err(|e: String| e);

    let (zip_path_str, zip_size) = match zip_result {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_file(&zip_path);
            let _ = std::fs::remove_dir(&artifact_directory);
            return Err(error);
        }
    };
    if let Err(error) = crate::temp_artifacts::register(&zip_path) {
        let _ = std::fs::remove_file(&zip_path);
        let _ = std::fs::remove_dir(&artifact_directory);
        return Err(error);
    }

    log::info!(
        "Zipped '{}' -> '{}' ({} bytes)",
        folder_name,
        zip_path_str,
        zip_size
    );

    Ok(zip_path_str)
}

/// Delete a temporary artifact created and registered by this app.
#[tauri::command]
pub async fn cmd_delete_temp_zip(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let path_clone = path.clone();
    let zip_root = zip_artifact_root(&app)?;
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path_clone);
        if !p.exists() {
            return Ok(());
        }
        let canonical_p = p
            .canonicalize()
            .map_err(|e| format!("Invalid path: {}", e))?;
        if !crate::temp_artifacts::is_registered(&canonical_p)? {
            if !is_owned_zip_artifact(&zip_root, &canonical_p) {
                return Err("Refusing to delete an unregistered temporary artifact".to_string());
            }
            // ZIP queue recovery can legitimately outlive the process-local
            // registry. Only the strict app-owned UUID/file layout is restored.
            crate::temp_artifacts::register(&canonical_p)?;
        }
        let deleted = crate::temp_artifacts::delete_registered(&canonical_p)?;
        if deleted.starts_with(&zip_root) {
            if let Some(parent) = deleted.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
        log::info!("Cleaned up temp zip: {}", path_clone);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

/// Toggle a folder (channel) between private and public.
/// When making public, a username is generated from the channel title.
/// When making private, the username is removed.
#[tauri::command]
pub async fn cmd_toggle_folder_visibility(
    folder_id: i64,
    make_public: bool,
    desired_username: Option<String>,
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
) -> Result<FolderMetadata, String> {
    let client_opt = { state.client.lock().await.clone() };

    let mut folder = if client_opt.is_none() {
        log::info!(
            "[MOCK] Toggle visibility for folder {}. Public: {}",
            folder_id,
            make_public
        );
        FolderMetadata {
            id: folder_id,
            name: "Mock Folder".to_string(),
            parent_id: None,
            username: if make_public { desired_username } else { None },
            is_public: make_public,
            group_id: None,
            display_order: 0,
        }
    } else {
        let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

        let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;
        let (channel_id, access_hash) = match &peer {
            Peer::Channel(c) => (
                c.raw.id,
                c.raw.access_hash.ok_or("No access hash for channel")?,
            ),
            _ => return Err("Only channels (folders) can be toggled.".to_string()),
        };

        let input_channel = tl::enums::InputChannel::Channel(tl::types::InputChannel {
            channel_id,
            access_hash,
        });

        // Extract channel name from the resolved peer for the return value
        let channel_name = match &peer {
            Peer::Channel(c) => c
                .raw
                .title
                .replace(" [TD]", "")
                .replace(" [td]", "")
                .trim()
                .to_string(),
            _ => "Folder".to_string(),
        };

        if make_public {
            // Generate a username from the desired_username or channel title.
            // If desired_username is provided AND non-empty, use it directly;
            // otherwise auto-generate from the channel title.
            let username = if let Some(ref u) = desired_username {
                if !u.is_empty() {
                    Some(u.clone())
                } else {
                    None // empty string → fall through to auto-generation below
                }
            } else {
                None
            };

            let username = match username {
                Some(given) => {
                    // User-provided username: check availability first
                    let available = client
                        .invoke(&tl::functions::channels::CheckUsername {
                            channel: tl::enums::InputChannel::Channel(tl::types::InputChannel {
                                channel_id,
                                access_hash,
                            }),
                            username: given.clone(),
                        })
                        .await
                        .map_err(|e| {
                            format!("Failed to check username availability: {}", map_error(e))
                        })?;
                    if !available {
                        return Err(format!(
                            "Username '{}' is not available. Try a different one.",
                            given
                        ));
                    }
                    given
                }
                None => {
                    // Auto-generate username from channel title
                    // channel_name already has [TD] stripped above
                    let mut base = channel_name
                        .clone()
                        .to_lowercase()
                        .chars()
                        .filter(|c| c.is_alphanumeric() || *c == '_')
                        .take(30)
                        .collect::<String>();
                    if base.len() < 5 {
                        let suffix: String = (0..6)
                            .map(|_| char::from(b'a' + (rand::random::<u8>() % 26)))
                            .collect();
                        base = format!("{}_{}", base, suffix);
                    }
                    // Try to find an available username
                    let mut candidate = base.clone();
                    for attempt in 1..=10 {
                        match client
                            .invoke(&tl::functions::channels::CheckUsername {
                                channel: tl::enums::InputChannel::Channel(
                                    tl::types::InputChannel {
                                        channel_id,
                                        access_hash,
                                    },
                                ),
                                username: candidate.clone(),
                            })
                            .await
                        {
                            Ok(true) => break,
                            _ => {
                                candidate = format!("{}{}", base, attempt);
                                if attempt == 10 {
                                    return Err(
                                        "Could not find an available username after 10 attempts"
                                            .to_string(),
                                    );
                                }
                            }
                        }
                    }
                    candidate
                }
            };

            log::info!("Setting channel {} username to '{}'", channel_id, username);
            client
                .invoke(&tl::functions::channels::UpdateUsername {
                    channel: input_channel,
                    username: username.clone(),
                })
                .await
                .map_err(|e| format!("Failed to set username: {}", map_error(e)))?;

            FolderMetadata {
                id: channel_id,
                name: channel_name,
                parent_id: None,
                username: Some(username),
                is_public: true,
                group_id: None,
                display_order: 0,
            }
        } else {
            // Make private: remove username
            log::info!("Removing username from channel {}", channel_id);
            client
                .invoke(&tl::functions::channels::UpdateUsername {
                    channel: input_channel,
                    username: String::new(),
                })
                .await
                .map_err(|e| format!("Failed to remove username: {}", map_error(e)))?;

            FolderMetadata {
                id: channel_id,
                name: channel_name,
                parent_id: None,
                username: None,
                is_public: false,
                group_id: None,
                display_order: 0,
            }
        }
    };

    // Update SQLite cache
    let folder_id_for_db = folder.id;
    let folder_username_for_db = folder.username.clone();
    let folder_is_public_for_db = folder.is_public;
    let (group_id, display_order) =
        crate::db::with_connection(db_pool.inner().clone(), move |conn| {
            let mut stmt = conn
                .prepare(
                    "UPDATE folder_metadata SET username = ?, is_public = ? WHERE channel_id = ?",
                )
                .map_err(|e: sqlite::Error| e.to_string())?;
            stmt.bind((1, folder_username_for_db.as_deref()))
                .map_err(|e: sqlite::Error| e.to_string())?;
            stmt.bind((2, if folder_is_public_for_db { 1 } else { 0 }))
                .map_err(|e: sqlite::Error| e.to_string())?;
            stmt.bind((3, folder_id_for_db))
                .map_err(|e: sqlite::Error| e.to_string())?;
            stmt.next().map_err(|e: sqlite::Error| e.to_string())?;

            // Retrieve group_id and display_order from DB to ensure they are returned correctly
            let mut fm_stmt = conn
                .prepare("SELECT group_id, display_order FROM folder_metadata WHERE channel_id = ?")
                .map_err(|e: sqlite::Error| e.to_string())?;
            fm_stmt
                .bind((1, folder_id_for_db))
                .map_err(|e: sqlite::Error| e.to_string())?;
            if let sqlite::State::Row = fm_stmt.next().map_err(|e: sqlite::Error| e.to_string())? {
                let group_id = fm_stmt
                    .read::<Option<i64>, _>("group_id")
                    .ok()
                    .flatten()
                    .map(|id| id as i32);
                let display_order = fm_stmt
                    .read::<i64, _>("display_order")
                    .map_err(|e: sqlite::Error| e.to_string())?
                    as i32;
                return Ok((group_id, display_order));
            }
            Ok((None, 0))
        })
        .await?;
    folder.group_id = group_id;
    folder.display_order = display_order;

    Ok(folder)
}

/// Export a Telegram invite link for a folder (channel).
/// For public channels, returns the t.me/username link directly.
/// For private channels, exports a hash-based invite link via the API.
#[derive(Debug, Serialize)]
pub struct FolderInviteInfo {
    pub link: String,
    pub is_public: bool,
    pub username: Option<String>,
}

#[tauri::command]
pub async fn cmd_export_folder_invite(
    folder_id: i64,
    state: State<'_, TelegramState>,
) -> Result<FolderInviteInfo, String> {
    let client_opt = { state.client.lock().await.clone() };

    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        log::info!("[MOCK] Export invite for folder {}", folder_id);
        return Ok(FolderInviteInfo {
            link: "https://t.me/joinchat/mock-invite-hash".to_string(),
            is_public: false,
            username: None,
        });
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;
    let (channel_id, access_hash) = match &peer {
        Peer::Channel(c) => (
            c.raw.id,
            c.raw.access_hash.ok_or("No access hash for channel")?,
        ),
        _ => return Err("Only channels (folders) can have invite links.".to_string()),
    };

    // Check if channel already has a public username (use the resolved peer directly)
    let username: Option<String> = match &peer {
        Peer::Channel(c) => c.raw.username.clone(),
        _ => None,
    };

    if let Some(ref uname) = username {
        // Public channel: return the t.me/username link
        Ok(FolderInviteInfo {
            link: format!("https://t.me/{}", uname),
            is_public: true,
            username: Some(uname.clone()),
        })
    } else {
        // Private channel: export an invite link
        let result = client
            .invoke(&tl::functions::messages::ExportChatInvite {
                peer: tl::enums::InputPeer::Channel(tl::types::InputPeerChannel {
                    channel_id,
                    access_hash,
                }),
                legacy_revoke_permanent: false,
                request_needed: false,
                expire_date: None,
                usage_limit: None,
                title: None,
                subscription_pricing: None,
            })
            .await
            .map_err(|e| format!("Failed to export invite: {}", map_error(e)))?;

        let link = match result {
            tl::enums::ExportedChatInvite::ChatInviteExported(c) => c.link,
            tl::enums::ExportedChatInvite::ChatInvitePublicJoinRequests => {
                return Err("Public join request channels do not have a custom private invite link. Share the public username directly instead.".to_string());
            }
        };

        Ok(FolderInviteInfo {
            link,
            is_public: false,
            username: None,
        })
    }
}

#[derive(Clone, serde::Serialize)]
struct RemoteProgressPayload {
    id: String,
    phase: &'static str,
    percent: u8,
    speed: u64,
    uploaded_bytes: u64,
    total_bytes: u64,
}

const MAX_REMOTE_UPLOAD_BYTES: u64 = 2_147_483_648;
const MAX_REMOTE_REDIRECTS: usize = 10;

fn is_public_remote_ip(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(ip) => {
            let octets = ip.octets();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || octets[0] >= 240)
        }
        std::net::IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_remote_ip(std::net::IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

fn validate_remote_url_syntax(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only HTTP and HTTPS URLs can be uploaded".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Credentials embedded in upload URLs are not allowed".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "The upload URL has no hostname".to_string())?;
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
        || normalized.ends_with(".internal")
        || normalized.ends_with(".lan")
        || normalized.ends_with(".home")
    {
        return Err("Upload URLs cannot target local or private hosts".to_string());
    }
    if let Ok(address) = normalized.parse::<std::net::IpAddr>() {
        if !is_public_remote_ip(address) {
            return Err("Upload URLs cannot target private or reserved IP addresses".to_string());
        }
    }
    Ok(())
}

async fn resolve_public_remote_addrs(
    url: &reqwest::Url,
) -> Result<Vec<std::net::SocketAddr>, String> {
    validate_remote_url_syntax(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| "The upload URL has no hostname".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "The upload URL has no usable port".to_string())?;
    let mut addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("Unable to resolve the upload URL hostname: {error}"))?
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err("The upload URL hostname did not resolve".to_string());
    }
    if addresses
        .iter()
        .any(|address| !is_public_remote_ip(address.ip()))
    {
        return Err("The upload URL resolved to a private or reserved network address".to_string());
    }
    Ok(addresses)
}

fn redirect_target(current: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let target = current
        .join(location)
        .map_err(|error| format!("The upload server returned an invalid redirect: {error}"))?;
    validate_remote_url_syntax(&target)?;
    Ok(target)
}

async fn validated_remote_get(
    initial_url: reqwest::Url,
    range_start: Option<u64>,
    net_config: &NetworkConfig,
) -> Result<(reqwest::Url, reqwest::Response), String> {
    let mut current = initial_url;
    for redirect_count in 0..=MAX_REMOTE_REDIRECTS {
        let addresses = resolve_public_remote_addrs(&current).await?;
        let host = current
            .host_str()
            .ok_or_else(|| "The upload URL has no hostname".to_string())?;
        let mut builder = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            // Pin the validated DNS result so a second resolver lookup cannot
            // rebind a public hostname to a private address.
            .resolve_to_addrs(host, &addresses);

        if net_config.is_proxy_active() {
            if let Some(proxy_url) = net_config.effective_proxy_url() {
                let proxy = reqwest::Proxy::all(&proxy_url)
                    .map_err(|error| format!("The configured proxy is invalid: {error}"))?;
                builder = builder.proxy(proxy);
            }
        }

        let client = builder.build().map_err(|error| error.to_string())?;
        let mut request = client.get(current.clone());
        if let Some(start) = range_start {
            request = request.header(reqwest::header::RANGE, format!("bytes={start}-"));
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        if response.status().is_redirection() {
            if redirect_count == MAX_REMOTE_REDIRECTS {
                return Err("The upload URL exceeded the redirect limit".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    "The upload server returned a redirect without a valid location".to_string()
                })?;
            current = redirect_target(&current, location)?;
            continue;
        }
        let response = response
            .error_for_status()
            .map_err(|error| format!("The upload server returned an error: {error}"))?;
        return Ok((current, response));
    }
    Err("The upload URL exceeded the redirect limit".to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command dependency injection is intentionally explicit.
pub async fn cmd_upload_from_url(
    url: String,
    folder_id: Option<i64>,
    transfer_id: String,
    protection_mode: Option<String>,
    prompt_token: Option<u64>,
    protect_metadata: Option<bool>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    net_config: State<'_, std::sync::Arc<NetworkConfig>>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    let initial_url =
        reqwest::Url::parse(&url).map_err(|error| format!("Invalid upload URL: {error}"))?;
    validate_remote_url_syntax(&initial_url)?;
    let (final_url, res) = validated_remote_get(initial_url, None, &net_config).await?;
    let url = final_url.to_string();
    let headers = res.headers();

    // Reject HTML pages — they're download gateways, not actual files
    if let Some(ct) = headers.get(reqwest::header::CONTENT_TYPE) {
        let ct_str = ct.to_str().unwrap_or_default().to_lowercase();
        if ct_str.contains("text/html") {
            return Err("URL returned an HTML page, not a downloadable file. The server may require a direct download link or authentication.".to_string());
        }
    }

    // Prefer Content-Disposition filename over URL path extraction
    let server_filename: Option<String> = headers
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(|header_value| {
            // Parse RFC 6266/5987 Content-Disposition: attachment; filename="..." or filename*=UTF-8''...
            // Look for filename* first (RFC 5987), then filename
            if let Some(encoded) = header_value
                .split(';')
                .map(|p| p.trim())
                .find(|p| p.starts_with("filename*="))
                .and_then(|p| p.strip_prefix("filename*="))
            {
                // filename*=UTF-8''percent%20encoded
                if let Some((_charset, value)) = encoded.split_once('\'') {
                    let value = value.split('\'').next_back().unwrap_or(value);
                    urlencoding::decode(value)
                        .ok()
                        .filter(|s| !s.is_empty())
                        .map(|s| s.into_owned())
                } else {
                    None
                }
            } else {
                header_value
                    .split(';')
                    .map(|p| p.trim())
                    .find(|p| p.starts_with("filename="))
                    .and_then(|p| p.strip_prefix("filename="))
                    .map(|f| f.trim_matches('"').to_string())
                    .filter(|f| !f.is_empty())
            }
        });

    let known_size: Option<u64> = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    let temp_dir = std::env::temp_dir();

    if let Some(sz) = known_size {
        if sz > MAX_REMOTE_UPLOAD_BYTES {
            return Err("Exceeds 2GB Telegram limit.".into());
        }
        let free_space = tokio::task::spawn_blocking({
            let temp_dir = temp_dir.clone();
            move || {
                let disks = sysinfo::Disks::new_with_refreshed_list();
                disks
                    .iter()
                    .filter(|d| temp_dir.starts_with(d.mount_point()))
                    .map(|d| d.available_space())
                    .next()
                    .unwrap_or(u64::MAX)
            }
        })
        .await
        .map_err(|e| format!("Disk check panicked: {}", e))?;
        if free_space < sz + 52_428_800 {
            return Err("Insufficient disk space in temp directory.".to_string());
        }
        bw_state.try_reserve_down(sz)?;
        if let Err(e) = bw_state.try_reserve_up(sz) {
            bw_state.release_down(sz);
            return Err(e);
        }
    }

    let display_total = known_size.unwrap_or(0); // 0 = unknown size to frontend
    let _ = app_handle.emit(
        "remote-upload-progress",
        RemoteProgressPayload {
            id: transfer_id.clone(),
            phase: "downloading",
            percent: 0,
            speed: 0,
            uploaded_bytes: 0,
            total_bytes: display_total,
        },
    );

    let temp_file_path = temp_dir.join(format!("tg_drive_{}.tmp", transfer_id));
    let temp_file_str = temp_file_path.to_string_lossy().to_string();

    let mut downloaded = 0u64;
    let mut range_supported = false;

    if let Some(accept_ranges) = headers.get(reqwest::header::ACCEPT_RANGES) {
        if accept_ranges.to_str().unwrap_or_default() == "bytes" {
            range_supported = true;
        }
    }

    if temp_file_path.exists() {
        if range_supported {
            if let Some(sz) = known_size {
                if let Ok(metadata) = std::fs::metadata(&temp_file_path) {
                    downloaded = metadata.len();
                    if downloaded >= sz {
                        downloaded = sz;
                    }
                }
            } else {
                let _ = std::fs::remove_file(&temp_file_path);
            }
        } else {
            // No resumption without both range support and a known total size
            let _ = std::fs::remove_file(&temp_file_path);
        }
    }

    let need_download = known_size.is_none_or(|sz| downloaded < sz);

    let stream_res = if downloaded > 0 && need_download {
        match validated_remote_get(final_url.clone(), Some(downloaded), &net_config).await {
            Ok((_resolved_url, response)) => response,
            Err(e) => {
                if let Some(sz) = known_size {
                    bw_state.release_down(sz);
                    bw_state.release_up(sz);
                }
                return Err(e);
            }
        }
    } else {
        res
    };

    let mut file = if downloaded > 0 && need_download {
        let status = stream_res.status();
        if status == reqwest::StatusCode::PARTIAL_CONTENT {
            match tokio::fs::OpenOptions::new()
                .write(true)
                .append(true)
                .open(&temp_file_path)
                .await
            {
                Ok(f) => f,
                Err(e) => {
                    if let Some(sz) = known_size {
                        bw_state.release_down(sz);
                        bw_state.release_up(sz);
                    }
                    return Err(e.to_string());
                }
            }
        } else {
            downloaded = 0;
            match tokio::fs::File::create(&temp_file_path).await {
                Ok(f) => f,
                Err(e) => {
                    if let Some(sz) = known_size {
                        bw_state.release_down(sz);
                        bw_state.release_up(sz);
                    }
                    return Err(e.to_string());
                }
            }
        }
    } else if !need_download {
        match tokio::fs::OpenOptions::new()
            .read(true)
            .open(&temp_file_path)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                if let Some(sz) = known_size {
                    bw_state.release_down(sz);
                    bw_state.release_up(sz);
                }
                return Err(e.to_string());
            }
        }
    } else {
        match tokio::fs::File::create(&temp_file_path).await {
            Ok(f) => f,
            Err(e) => {
                if let Some(sz) = known_size {
                    bw_state.release_down(sz);
                    bw_state.release_up(sz);
                }
                return Err(e.to_string());
            }
        }
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            tokio::fs::set_permissions(&temp_file_path, std::fs::Permissions::from_mode(0o600))
                .await
        {
            drop(file);
            let _ = tokio::fs::remove_file(&temp_file_path).await;
            if let Some(size) = known_size {
                bw_state.release_down(size);
                bw_state.release_up(size);
            }
            return Err(format!(
                "Failed to protect remote-upload temporary file: {}",
                error
            ));
        }
    }

    if need_download {
        let mut stream = stream_res.bytes_stream();
        let mut last_emit_time = std::time::Instant::now();
        let mut last_emit_bytes = downloaded;

        while let Some(chunk_result) = futures::StreamExt::next(&mut stream).await {
            if state
                .cancelled_transfers
                .read()
                .await
                .contains(&transfer_id)
            {
                state.cancelled_transfers.write().await.remove(&transfer_id);
                drop(file);
                let _ = tokio::fs::remove_file(&temp_file_path).await;
                if let Some(sz) = known_size {
                    bw_state.release_down(sz);
                    bw_state.release_up(sz);
                }
                return Err("Transfer cancelled".to_string());
            }

            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    if let Some(sz) = known_size {
                        bw_state.release_down(sz);
                        bw_state.release_up(sz);
                    }
                    return Err(e.to_string());
                }
            };

            if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
                if let Some(sz) = known_size {
                    bw_state.release_down(sz);
                    bw_state.release_up(sz);
                }
                return Err(e.to_string());
            }
            downloaded += chunk.len() as u64;

            // Dynamic 2GB check when total size is unknown
            if downloaded > MAX_REMOTE_UPLOAD_BYTES {
                drop(file);
                let _ = tokio::fs::remove_file(&temp_file_path).await;
                return Err("Downloaded file exceeds 2GB Telegram limit.".to_string());
            }

            let now = std::time::Instant::now();
            let dt = now.duration_since(last_emit_time).as_secs_f64();
            let emit_total = known_size.unwrap_or(downloaded);
            let emit_done = known_size.is_some_and(|sz| downloaded >= sz);
            if dt >= 0.25 || emit_done {
                let speed = if dt > 0.0 {
                    ((downloaded - last_emit_bytes) as f64 / dt) as u64
                } else {
                    0
                };
                let percent = if let Some(sz) = known_size {
                    if sz > 0 {
                        ((downloaded as f64 / sz as f64) * 100.0).min(99.0) as u8
                    } else {
                        0
                    }
                } else {
                    0u8
                };

                let _ = app_handle.emit(
                    "remote-upload-progress",
                    RemoteProgressPayload {
                        id: transfer_id.clone(),
                        phase: "downloading",
                        percent,
                        speed,
                        uploaded_bytes: downloaded,
                        total_bytes: emit_total,
                    },
                );
                last_emit_time = now;
                last_emit_bytes = downloaded;
            }

            let dl_limit = net_config.download_limit_bytes_per_sec();
            if dl_limit > 0 {
                let elapsed = last_emit_time.elapsed().as_secs_f64().max(0.001);
                let current_rate = (downloaded - last_emit_bytes) as f64 / elapsed;
                if current_rate > dl_limit as f64 {
                    let sleep_ms =
                        ((current_rate / dl_limit as f64 - 1.0) * elapsed * 1000.0) as u64;
                    if sleep_ms > 0 && sleep_ms < 5000 {
                        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                    }
                }
            }
        }

        if let Err(e) = tokio::io::AsyncWriteExt::flush(&mut file).await {
            if let Some(sz) = known_size {
                bw_state.release_down(sz);
                bw_state.release_up(sz);
            }
            return Err(e.to_string());
        }
        if let Err(e) = file.sync_all().await {
            if let Some(sz) = known_size {
                bw_state.release_down(sz);
                bw_state.release_up(sz);
            }
            return Err(e.to_string());
        }
    }

    drop(file);
    if let Some(sz) = known_size {
        bw_state.release_down(sz);
        // Release the upfront upload reservation — we'll re-reserve based on actual size below
        bw_state.release_up(sz);
    }

    // Determine actual file size from disk (authoritative, works even without Content-Length)
    let actual_size = tokio::fs::metadata(&temp_file_path)
        .await
        .map_err(|e| format!("Failed to read downloaded file metadata: {}", e))?
        .len();

    if actual_size == 0 {
        let _ = tokio::fs::remove_file(&temp_file_path).await;
        return Err("Downloaded file is empty".to_string());
    }

    if actual_size > MAX_REMOTE_UPLOAD_BYTES {
        let _ = tokio::fs::remove_file(&temp_file_path).await;
        return Err("Downloaded file exceeds 2GB Telegram limit.".to_string());
    }

    // Remote uploads must preserve the same protection intent as every other
    // upload origin. Stage the downloaded file under its logical server name so
    // protected metadata never records the randomized temporary filename.
    let parsed_protection = match UploadProtectionMode::parse(protection_mode.as_deref()) {
        Ok(mode) => mode,
        Err(error) => {
            let _ = tokio::fs::remove_file(&temp_file_path).await;
            return Err(error);
        }
    };
    if parsed_protection != UploadProtectionMode::Standard {
        let logical_name = server_filename.clone().unwrap_or_else(|| {
            reqwest::Url::parse(&url)
                .ok()
                .and_then(|parsed| {
                    parsed
                        .path_segments()
                        .and_then(|mut segments| segments.next_back())
                        .filter(|segment| !segment.is_empty())
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "remote_file".to_string())
        });
        let safe_name = std::path::Path::new(&logical_name)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("remote_file")
            .to_string();
        let staged_dir = temp_dir.join(format!("tg_drive_encrypted_{}", transfer_id));
        if let Err(error) = tokio::fs::create_dir_all(&staged_dir).await {
            let _ = tokio::fs::remove_file(&temp_file_path).await;
            return Err(format!(
                "Failed to stage encrypted remote upload: {}",
                error
            ));
        }
        let staged_path = staged_dir.join(safe_name);
        if let Err(error) = tokio::fs::rename(&temp_file_path, &staged_path).await {
            let _ = tokio::fs::remove_file(&temp_file_path).await;
            let _ = tokio::fs::remove_dir(&staged_dir).await;
            return Err(format!(
                "Failed to stage encrypted remote upload: {}",
                error
            ));
        }

        let result = cmd_upload_file_inner(
            staged_path.to_string_lossy().to_string(),
            folder_id,
            Some(transfer_id),
            protection_mode,
            prompt_token,
            protect_metadata,
            app_handle,
            state,
            bw_state,
            net_config,
            crypto_state,
            db_pool,
        )
        .await;
        let _ = tokio::fs::remove_file(&staged_path).await;
        let _ = tokio::fs::remove_dir(&staged_dir).await;
        return result;
    }

    // Reserve upload bandwidth based on the real file size (handles both known and unknown upfront)
    if let Err(e) = bw_state.try_reserve_up(actual_size) {
        let _ = tokio::fs::remove_file(&temp_file_path).await;
        return Err(e);
    }

    let client_opt = { state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => {
            bw_state.release_up(actual_size);
            let _ = tokio::fs::remove_file(&temp_file_path).await;
            return Err("Client not connected".to_string());
        }
    };

    let _ = app_handle.emit(
        "remote-upload-progress",
        RemoteProgressPayload {
            id: transfer_id.clone(),
            phase: "uploading",
            percent: 0,
            speed: 0,
            uploaded_bytes: 0,
            total_bytes: actual_size,
        },
    );

    let (mut reader, file_size, bytes_counter) = match ProgressReader::new(&temp_file_str).await {
        Ok(res) => res,
        Err(e) => {
            bw_state.release_up(actual_size);
            let _ = tokio::fs::remove_file(&temp_file_path).await;
            return Err(e);
        }
    };

    let cancelled = state.cancelled_transfers.clone();
    let progress_tid = transfer_id.clone();
    let progress_handle = app_handle.clone();
    let progress_counter = bytes_counter.clone();
    let progress_task = tokio::spawn(async move {
        let mut last_bytes: u64 = 0;
        let mut last_time = std::time::Instant::now();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let current = progress_counter.load(std::sync::atomic::Ordering::Relaxed);
            let now = std::time::Instant::now();
            let dt = now.duration_since(last_time).as_secs_f64();
            let speed = if dt > 0.0 {
                ((current - last_bytes) as f64 / dt) as u64
            } else {
                0
            };
            let percent = if file_size > 0 {
                ((current as f64 / file_size as f64) * 100.0).min(99.0) as u8
            } else {
                0
            };

            let _ = progress_handle.emit(
                "remote-upload-progress",
                RemoteProgressPayload {
                    id: progress_tid.clone(),
                    phase: "uploading",
                    percent,
                    speed,
                    uploaded_bytes: current,
                    total_bytes: file_size,
                },
            );

            last_bytes = current;
            last_time = now;

            if current >= file_size {
                break;
            }
            if cancelled.read().await.contains(&progress_tid) {
                break;
            }
        }
    });

    if state
        .cancelled_transfers
        .read()
        .await
        .contains(&transfer_id)
    {
        state.cancelled_transfers.write().await.remove(&transfer_id);
        progress_task.abort();
        bw_state.release_up(actual_size);
        let _ = tokio::fs::remove_file(&temp_file_path).await;
        return Err("Transfer cancelled".to_string());
    }

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    get_upload_cancellations()
        .lock()
        .unwrap()
        .insert(transfer_id.clone(), cancel_tx);

    let client_clone = client.clone();
    let file_name = server_filename.unwrap_or_else(|| {
        reqwest::Url::parse(&url)
            .ok()
            .and_then(|u| {
                u.path_segments()
                    .and_then(|mut segs| segs.next_back())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "remote_file".to_string())
    });

    let mut upload_task = tokio::spawn(async move {
        client_clone
            .upload_stream(&mut reader, file_size as usize, file_name)
            .await
    });

    let uploaded_file = {
        tokio::select! {
            res = &mut upload_task => {
                get_upload_cancellations().lock().unwrap().remove(&transfer_id);
                match res {
                    Ok(Ok(file)) => file,
                    Ok(Err(e)) => {
                        bw_state.release_up(actual_size);
                        progress_task.abort();
                        let _ = tokio::fs::remove_file(&temp_file_path).await;
                        return Err(map_error(e));
                    }
                    Err(e) => {
                        bw_state.release_up(actual_size);
                        progress_task.abort();
                        let _ = tokio::fs::remove_file(&temp_file_path).await;
                        return Err(format!("Task join error: {}", e));
                    }
                }
            }
            _ = cancel_rx => {
                log::info!("Aborting remote upload task for transfer ID: {}", transfer_id);
                upload_task.abort();
                state.cancelled_transfers.write().await.remove(&transfer_id);
                progress_task.abort();
                bw_state.release_up(actual_size);
                let _ = tokio::fs::remove_file(&temp_file_path).await;
                return Err("Transfer cancelled".to_string());
            }
        }
    };

    progress_task.abort();

    let message = InputMessage::new().text("").file(uploaded_file);

    let peer = match resolve_peer(&client, folder_id, &state.peer_cache).await {
        Ok(p) => p,
        Err(e) => {
            bw_state.release_up(actual_size);
            let _ = tokio::fs::remove_file(&temp_file_path).await;
            return Err(e);
        }
    };

    let max_retries = net_config.retry_attempts();
    let base_ms = net_config.retry_base_backoff_ms();
    let max_ms = net_config.retry_max_backoff_ms();
    let respect_flood = net_config.should_respect_flood_wait();
    let mut last_err = String::new();
    let mut send_success = false;

    for attempt in 0..=max_retries {
        match client.send_message(&peer, message.clone()).await {
            Ok(_) => {
                send_success = true;
                break;
            }
            Err(e) => {
                let err = map_error(e);
                log::warn!(
                    "send_message attempt {}/{}: {}",
                    attempt + 1,
                    max_retries + 1,
                    err
                );

                if respect_flood && err.starts_with("FLOOD_WAIT_") {
                    if let Ok(secs) = err.trim_start_matches("FLOOD_WAIT_").parse::<u64>() {
                        let wait = secs.min(300);
                        wait_for_telegram_cooldown(&app_handle, "Remote upload", wait).await;
                        last_err = err;
                        continue;
                    }
                }

                last_err = err;
                if attempt < max_retries {
                    let delay = backoff_ms(attempt, base_ms, max_ms);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }
    }

    let _ = tokio::fs::remove_file(&temp_file_path).await;

    if send_success {
        let _ = app_handle.emit(
            "remote-upload-progress",
            RemoteProgressPayload {
                id: transfer_id,
                phase: "uploading",
                percent: 100,
                speed: 0,
                uploaded_bytes: actual_size,
                total_bytes: actual_size,
            },
        );
        Ok("File uploaded successfully".to_string())
    } else {
        bw_state.release_up(actual_size);
        Err(format!(
            "Upload failed after {} attempts: {}",
            max_retries + 1,
            last_err
        ))
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;

    #[test]
    fn remote_upload_blocks_local_and_reserved_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            let address = address.parse().unwrap();
            assert!(!is_public_remote_ip(address), "{address} must be blocked");
        }
        assert!(is_public_remote_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_remote_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn remote_upload_accepts_only_public_http_urls_without_embedded_credentials() {
        for blocked in [
            "file:///etc/passwd",
            "http://localhost/file",
            "http://service.local/file",
            "http://169.254.169.254/latest/meta-data",
            "https://user:password@example.com/file",
        ] {
            let url = reqwest::Url::parse(blocked).unwrap();
            assert!(
                validate_remote_url_syntax(&url).is_err(),
                "{blocked} must be blocked"
            );
        }
        assert!(validate_remote_url_syntax(
            &reqwest::Url::parse("https://example.com/file.zip").unwrap()
        )
        .is_ok());
    }

    #[test]
    fn redirect_validation_blocks_private_targets() {
        let current = reqwest::Url::parse("https://example.com/file").unwrap();
        assert!(redirect_target(&current, "http://127.0.0.1/private").is_err());
        assert!(redirect_target(&current, "https://cdn.example.com/file").is_ok());
    }

    #[test]
    fn zip_cleanup_layout_accepts_only_uuid_scoped_zip_files() {
        let root = std::path::Path::new("/app-cache/transfer-zips");
        let id = uuid::Uuid::new_v4();
        assert!(is_owned_zip_artifact(
            root,
            &root.join(id.to_string()).join("folder.zip")
        ));
        assert!(!is_owned_zip_artifact(root, &root.join("other.txt")));
        assert!(!is_owned_zip_artifact(
            root,
            &root.join("not-a-uuid").join("folder.zip")
        ));
    }

    #[test]
    fn atomic_download_publish_replaces_destination_only_when_source_exists() {
        let directory = std::env::temp_dir().join(format!(
            "telegram-drive-publish-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("result.bin");
        let source = directory.join("result.part");
        std::fs::write(&destination, b"old").unwrap();
        assert!(replace_download_file(&directory.join("missing"), &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"old");
        std::fs::write(&source, b"new").unwrap();
        replace_download_file(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"new");
        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::remove_dir(&directory);
    }
}
