#[cfg(target_os = "android")]
fn call_authentication_available() -> Result<bool, String> {
    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| format!("Unable to access Android authentication: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to attach Android authentication: {error}"))?;
    let main_class = crate::jni_cache::get_main_activity_jclass()
        .ok_or("Android authentication is still initializing")?;
    env.call_static_method(&main_class, "isDeviceAuthenticationAvailable", "()Z", &[])
        .map_err(|error| format!("Unable to inspect Android authentication: {error}"))?
        .z()
        .map_err(|error| format!("Android authentication returned an invalid value: {error}"))
}

#[tauri::command]
pub fn cmd_get_android_authentication_available() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    return call_authentication_available();
    #[cfg(not(target_os = "android"))]
    Ok(false)
}

#[tauri::command]
pub async fn cmd_android_authenticate(reason: String) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        if reason.is_empty() || reason.len() > 160 {
            return Err("Authentication reason is invalid".into());
        }
        return tokio::task::spawn_blocking(move || {
            let context = ndk_context::android_context();
            let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
                .map_err(|error| format!("Unable to access Android authentication: {error}"))?;
            let mut env = vm
                .attach_current_thread()
                .map_err(|error| format!("Unable to attach Android authentication: {error}"))?;
            let main_class = crate::jni_cache::get_main_activity_jclass()
                .ok_or("Android authentication is still initializing")?;
            let reason = env
                .new_string(reason)
                .map_err(|error| format!("Unable to prepare Android authentication: {error}"))?;
            env.call_static_method(
                &main_class,
                "authenticateForSensitiveAction",
                "(Ljava/lang/String;)Z",
                &[jni::objects::JValue::from(&reason)],
            )
            .map_err(|error| format!("Unable to request Android authentication: {error}"))?
            .z()
            .map_err(|error| format!("Android authentication returned an invalid value: {error}"))
        })
        .await
        .map_err(|error| format!("Android authentication task failed: {error}"))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = reason;
        Ok(true)
    }
}

#[tauri::command]
pub fn cmd_configure_android_privacy(
    biometric_lock: bool,
    privacy_screen: bool,
    timeout_minutes: i32,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let context = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
            .map_err(|error| format!("Unable to access Android privacy settings: {error}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|error| format!("Unable to attach Android privacy settings: {error}"))?;
        let main_class = crate::jni_cache::get_main_activity_jclass()
            .ok_or("Android privacy settings are still initializing")?;
        return env
            .call_static_method(
                &main_class,
                "configurePrivacy",
                "(ZZI)Z",
                &[
                    jni::objects::JValue::Bool(if biometric_lock { 1 } else { 0 }),
                    jni::objects::JValue::Bool(if privacy_screen { 1 } else { 0 }),
                    jni::objects::JValue::Int(timeout_minutes.clamp(0, 240)),
                ],
            )
            .map_err(|error| format!("Unable to configure Android privacy settings: {error}"))?
            .z()
            .map_err(|error| {
                format!("Android privacy settings returned an invalid value: {error}")
            });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (biometric_lock, privacy_screen, timeout_minutes);
        Ok(false)
    }
}
