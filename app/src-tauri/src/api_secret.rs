//! Secure persistence for the Telegram API hash.
//!
//! The API ID is public configuration, but the API hash is a credential. New
//! values live in the platform credential manager and are never serialized to
//! the ordinary Tauri plugin-store JSON file.

#[cfg(not(target_os = "android"))]
use keyring::Entry;

#[cfg(not(target_os = "android"))]
const KEYRING_SERVICE: &str = "com.cameronamer.telegramdrive.telegram-api";
const API_HASH_ACCOUNT: &str = "api-hash-v1";

#[cfg(not(target_os = "android"))]
fn entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, API_HASH_ACCOUNT)
        .map_err(|error| format!("Secure Telegram credential storage is unavailable: {error}"))
}

#[cfg(not(target_os = "android"))]
pub fn load_api_hash() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Unable to read the saved Telegram credential: {error}"
        )),
    }
}

#[cfg(not(target_os = "android"))]
pub fn store_api_hash(value: &str) -> Result<(), String> {
    validate_api_hash(value)?;
    entry()?
        .set_password(value)
        .map_err(|error| format!("Unable to save the Telegram credential securely: {error}"))
}

#[cfg(not(target_os = "android"))]
pub fn delete_api_hash() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Unable to remove the saved Telegram credential: {error}"
        )),
    }
}

#[cfg(target_os = "android")]
fn android_secret(operation: &str, value: Option<&str>) -> Result<Option<String>, String> {
    let main_class = crate::jni_cache::get_main_activity_jclass().ok_or_else(|| {
        "Android secure credential storage is still starting; try again in a moment".to_string()
    })?;
    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| format!("Unable to access Android secure storage: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to attach Android secure storage: {error}"))?;
    let account = env
        .new_string(API_HASH_ACCOUNT)
        .map_err(|error| format!("Unable to prepare Android credential name: {error}"))?;

    match operation {
        "get" => {
            let result = env
                .call_static_method(
                    &main_class,
                    "getSupporterSecret",
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[jni::objects::JValue::from(&account)],
                )
                .map_err(|error| format!("Unable to read Android secure credential: {error}"))?
                .l()
                .map_err(|error| {
                    format!("Android secure credential returned an invalid value: {error}")
                })?;
            if result.is_null() {
                return Ok(None);
            }
            let result = jni::objects::JString::from(result);
            let decoded: String = env
                .get_string(&result)
                .map_err(|error| format!("Unable to decode Android secure credential: {error}"))?
                .into();
            Ok((!decoded.is_empty()).then_some(decoded))
        }
        "put" => {
            let secret = env
                .new_string(value.unwrap_or_default())
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
                .map_err(|error| {
                    format!("Android secure storage returned an invalid result: {error}")
                })?;
            saved.then_some(None).ok_or_else(|| {
                "Android Keystore could not save the Telegram credential".to_string()
            })
        }
        "delete" => {
            let deleted = env
                .call_static_method(
                    &main_class,
                    "deleteSupporterSecret",
                    "(Ljava/lang/String;)Z",
                    &[jni::objects::JValue::from(&account)],
                )
                .map_err(|error| format!("Unable to clear Android secure credential: {error}"))?
                .z()
                .map_err(|error| {
                    format!("Android secure storage returned an invalid result: {error}")
                })?;
            deleted.then_some(None).ok_or_else(|| {
                "Android Keystore could not clear the Telegram credential".to_string()
            })
        }
        _ => Err("Unknown secure credential operation".to_string()),
    }
}

#[cfg(target_os = "android")]
pub fn load_api_hash() -> Result<Option<String>, String> {
    android_secret("get", None)
}

#[cfg(target_os = "android")]
pub fn store_api_hash(value: &str) -> Result<(), String> {
    validate_api_hash(value)?;
    android_secret("put", Some(value)).map(|_| ())
}

#[cfg(target_os = "android")]
pub fn delete_api_hash() -> Result<(), String> {
    android_secret("delete", None).map(|_| ())
}

fn validate_api_hash(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_whitespace) {
        return Err("The Telegram API hash is invalid".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_load_api_hash() -> Result<Option<String>, String> {
    load_api_hash()
}

#[tauri::command]
pub fn cmd_store_api_hash(api_hash: String) -> Result<(), String> {
    store_api_hash(api_hash.trim())
}

#[tauri::command]
pub fn cmd_clear_api_hash() -> Result<(), String> {
    delete_api_hash()
}

#[cfg(test)]
mod tests {
    use super::validate_api_hash;

    #[test]
    fn api_hash_policy_rejects_blank_whitespace_and_oversized_values() {
        assert!(validate_api_hash("").is_err());
        assert!(validate_api_hash("has a space").is_err());
        assert!(validate_api_hash(&"x".repeat(257)).is_err());
        assert!(validate_api_hash("0123456789abcdef0123456789abcdef").is_ok());
    }
}
