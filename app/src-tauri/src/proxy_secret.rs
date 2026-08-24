//! Secure storage for proxy authentication material.
//!
//! Proxy passwords must never be serialized with ordinary application settings.
//! Desktop builds keep the password in the operating-system credential store;
//! mobile builds intentionally keep it in memory only until a platform keystore
//! implementation is available.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::Entry;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYRING_SERVICE: &str = "com.cameronamer.telegramdrive.proxy";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const PROXY_PASSWORD_ACCOUNT: &str = "proxy-password-v1";

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, PROXY_PASSWORD_ACCOUNT)
        .map_err(|error| format!("Secure proxy credential storage is unavailable: {error}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn load_password() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Unable to read the saved proxy credential: {error}"
        )),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn load_password() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn store_password(password: &str) -> Result<(), String> {
    if password.is_empty() {
        return delete_password();
    }
    entry()?
        .set_password(password)
        .map_err(|error| format!("Unable to save the proxy credential securely: {error}"))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn store_password(_password: &str) -> Result<(), String> {
    Err("Secure proxy credential persistence is not available on this platform".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn delete_password() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Unable to remove the saved proxy credential: {error}"
        )),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn delete_password() -> Result<(), String> {
    Ok(())
}
