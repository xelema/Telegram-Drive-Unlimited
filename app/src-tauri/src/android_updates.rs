use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidUpdateManifest {
    pub schema: u8,
    pub package_name: String,
    pub version: String,
    pub version_code: u64,
    pub url: String,
    pub sha256: String,
    pub filename: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidUpdateProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidInstallResult {
    pub installer_launched: bool,
    pub unknown_sources_settings_opened: bool,
}

#[cfg(target_os = "android")]
const UPDATE_MANIFEST_URL: &str =
    "https://github.com/caamer20/Telegram-Drive/releases/latest/download/android-update.json";
#[cfg(target_os = "android")]
const UPDATE_SIGNATURE_URL: &str =
    "https://github.com/caamer20/Telegram-Drive/releases/latest/download/android-update.json.sig";
#[cfg(target_os = "android")]
const UPDATE_PUBLIC_KEY: &str = "untrusted comment: minisign public key: 507B700E3497963C\nRWQ8lpc0DnB7UL08Mw1DO9KFYeMLcdhVwXH40qhGBLJUc5ppbK1XHM2J\n";
#[cfg(target_os = "android")]
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
#[cfg(target_os = "android")]
const MAX_APK_BYTES: u64 = 1024 * 1024 * 1024;

#[cfg(target_os = "android")]
fn update_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(15 * 60))
        .user_agent("Telegram-Drive-Android-Updater")
        .build()
        .map_err(|error| format!("Unable to initialize the secure updater: {error}"))
}

#[cfg(target_os = "android")]
async fn fetch_limited(client: &reqwest::Client, url: &str, max: usize) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Unable to contact the update service: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The update service returned an error: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err("The update metadata exceeded the safe size limit".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Unable to read the update metadata: {error}"))?;
    if bytes.len() > max {
        return Err("The update metadata exceeded the safe size limit".into());
    }
    Ok(bytes.to_vec())
}

#[cfg(target_os = "android")]
fn validate_manifest(manifest: &AndroidUpdateManifest) -> Result<(), String> {
    if manifest.schema != 1 || manifest.package_name != "com.cameronamer.telegramdrive" {
        return Err("The update metadata targets a different application".into());
    }
    if manifest.version_code == 0
        || manifest.version.is_empty()
        || !manifest
            .version
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
    {
        return Err("The update metadata contains an invalid version".into());
    }
    if manifest.filename.len() > 160
        || !manifest.filename.ends_with(".apk")
        || manifest.filename.contains('/')
        || manifest.filename.contains('\\')
        || manifest.filename.contains("..")
    {
        return Err("The update metadata contains an unsafe filename".into());
    }
    if manifest.sha256.len() != 64
        || !manifest
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("The update metadata contains an invalid SHA-256 digest".into());
    }
    let url = reqwest::Url::parse(&manifest.url)
        .map_err(|_| "The update metadata contains an invalid download URL".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url
            .path()
            .starts_with("/caamer20/Telegram-Drive/releases/download/")
        || !url.path().ends_with(&format!("/{}", manifest.filename))
    {
        return Err("The update metadata contains an untrusted download URL".into());
    }
    Ok(())
}

#[cfg(target_os = "android")]
async fn fetch_verified_manifest() -> Result<AndroidUpdateManifest, String> {
    let client = update_client()?;
    let (manifest_bytes, signature_bytes) = tokio::try_join!(
        fetch_limited(&client, UPDATE_MANIFEST_URL, MAX_MANIFEST_BYTES),
        fetch_limited(&client, UPDATE_SIGNATURE_URL, MAX_MANIFEST_BYTES),
    )?;
    let signature_text = std::str::from_utf8(&signature_bytes)
        .map_err(|_| "The update signature is not valid UTF-8".to_string())?;
    let key = minisign_verify::PublicKey::decode(UPDATE_PUBLIC_KEY)
        .map_err(|_| "The embedded update public key is invalid".to_string())?;
    let signature = minisign_verify::Signature::decode(signature_text)
        .map_err(|_| "The update signature has an invalid format".to_string())?;
    key.verify(&manifest_bytes, &signature, false)
        .map_err(|_| "The update manifest signature is invalid".to_string())?;

    let manifest: AndroidUpdateManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "The signed update manifest is invalid".to_string())?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

#[cfg(target_os = "android")]
fn current_version_code() -> Result<u64, String> {
    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| format!("Unable to access Android package information: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to attach Android package check: {error}"))?;
    let main_class = crate::jni_cache::get_main_activity_jclass()
        .ok_or("Android update support is still initializing")?;
    let value = env
        .call_static_method(&main_class, "getInstalledVersionCode", "()J", &[])
        .map_err(|error| format!("Unable to read the installed Android version: {error}"))?
        .j()
        .map_err(|error| format!("Android returned an invalid version code: {error}"))?;
    u64::try_from(value).map_err(|_| "Android returned a negative version code".into())
}

#[tauri::command]
pub async fn cmd_check_android_update() -> Result<Option<AndroidUpdateManifest>, String> {
    #[cfg(target_os = "android")]
    {
        let manifest = fetch_verified_manifest().await?;
        return Ok((manifest.version_code > current_version_code()?).then_some(manifest));
    }
    #[cfg(not(target_os = "android"))]
    Ok(None)
}

#[cfg(target_os = "android")]
fn launch_installer(path: &std::path::Path) -> Result<AndroidInstallResult, String> {
    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| format!("Unable to access Android's package installer: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to attach Android's package installer: {error}"))?;
    let main_class = crate::jni_cache::get_main_activity_jclass()
        .ok_or("Android update support is still initializing")?;
    let path = env
        .new_string(path.to_string_lossy().as_ref())
        .map_err(|error| format!("Unable to prepare the verified APK path: {error}"))?;
    let result = env
        .call_static_method(
            &main_class,
            "installVerifiedApk",
            "(Ljava/lang/String;)I",
            &[jni::objects::JValue::from(&path)],
        )
        .map_err(|error| format!("Unable to open Android's package installer: {error}"))?
        .i()
        .map_err(|error| {
            format!("Android's package installer returned an invalid result: {error}")
        })?;
    match result {
        1 => Ok(AndroidInstallResult {
            installer_launched: true,
            unknown_sources_settings_opened: false,
        }),
        2 => Ok(AndroidInstallResult {
            installer_launched: false,
            unknown_sources_settings_opened: true,
        }),
        _ => Err("Android could not open the package installer".into()),
    }
}

#[tauri::command]
pub async fn cmd_download_and_install_android_update(
    app: tauri::AppHandle,
) -> Result<AndroidInstallResult, String> {
    #[cfg(target_os = "android")]
    {
        use futures::StreamExt;
        use sha2::{Digest, Sha256};
        use tauri::{Emitter, Manager};
        use tokio::io::AsyncWriteExt;

        let manifest = fetch_verified_manifest().await?;
        if manifest.version_code <= current_version_code()? {
            return Err("This update is not newer than the installed application".into());
        }
        let client = update_client()?;
        let response = client
            .get(&manifest.url)
            .send()
            .await
            .map_err(|error| format!("Unable to download the Android update: {error}"))?
            .error_for_status()
            .map_err(|error| format!("The Android update download failed: {error}"))?;
        if response.url().scheme() != "https" {
            return Err("The Android update redirected to an insecure URL".into());
        }
        let total = response.content_length();
        if total.is_some_and(|length| length > MAX_APK_BYTES) {
            return Err("The Android update exceeded the safe size limit".into());
        }

        let update_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("Unable to resolve the Android update cache: {error}"))?
            .join("updates");
        tokio::fs::create_dir_all(&update_dir)
            .await
            .map_err(|error| format!("Unable to create the Android update cache: {error}"))?;
        let final_path = update_dir.join(&manifest.filename);
        let partial_path = update_dir.join(format!("{}.partial", manifest.filename));
        let mut file = tokio::fs::File::create(&partial_path)
            .await
            .map_err(|error| format!("Unable to create the Android update file: {error}"))?;
        let mut stream = response.bytes_stream();
        let mut digest = Sha256::new();
        let mut downloaded = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|error| format!("The Android update download was interrupted: {error}"))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > MAX_APK_BYTES {
                let _ = tokio::fs::remove_file(&partial_path).await;
                return Err("The Android update exceeded the safe size limit".into());
            }
            digest.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("Unable to save the Android update: {error}"))?;
            let percent = total
                .filter(|length| *length > 0)
                .map(|length| ((downloaded.saturating_mul(100) / length).min(99)) as u8);
            let _ = app.emit(
                "android-update-progress",
                AndroidUpdateProgress {
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                    percent,
                },
            );
        }
        file.flush()
            .await
            .map_err(|error| format!("Unable to finish the Android update: {error}"))?;
        drop(file);
        if total.is_some_and(|length| length != downloaded) {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Err("The Android update download was incomplete".into());
        }
        let actual_sha = format!("{:x}", digest.finalize());
        if !constant_time_eq::constant_time_eq(
            actual_sha.as_bytes(),
            manifest.sha256.to_ascii_lowercase().as_bytes(),
        ) {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Err("The Android update failed SHA-256 verification".into());
        }
        tokio::fs::rename(&partial_path, &final_path)
            .await
            .map_err(|error| format!("Unable to finalize the Android update: {error}"))?;
        let _ = app.emit(
            "android-update-progress",
            AndroidUpdateProgress {
                downloaded_bytes: downloaded,
                total_bytes: total,
                percent: Some(100),
            },
        );
        launch_installer(&final_path)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android sideload updates are only available on Android".into())
    }
}

#[cfg(all(test, target_os = "android"))]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_github_update_urls() {
        let manifest = AndroidUpdateManifest {
            schema: 1,
            package_name: "com.cameronamer.telegramdrive".into(),
            version: "4.0.0".into(),
            version_code: 4_000_000,
            url: "https://example.com/Telegram-Drive-v4.0.0-android-universal.apk".into(),
            sha256: "a".repeat(64),
            filename: "Telegram-Drive-v4.0.0-android-universal.apk".into(),
        };
        assert!(validate_manifest(&manifest).is_err());
    }
}
