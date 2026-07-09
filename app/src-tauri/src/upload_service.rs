#[cfg(target_os = "android")]
pub fn start_foreground_service() {
    log::info!("JNI: start_foreground_service called");
    let ctx_obj = ndk_context::android_context();
    if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx_obj.vm().cast()) } {
        if let Ok(mut env) = vm.attach_current_thread() {
            let ctx = unsafe { jni::objects::JObject::from_raw(ctx_obj.context().cast()) };
            
            // Get class loader from Context
            match env.call_method(
                &ctx,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            ) {
                Ok(class_loader_val) => {
                    if let Ok(class_loader) = class_loader_val.l() {
                        let class_name = env.new_string("com.cameronamer.telegramdrive.UploadForegroundService");
                        if let Ok(class_name_obj) = class_name {
                            let class_obj_val = env.call_method(
                                &class_loader,
                                "loadClass",
                                "(Ljava/lang/String;)Ljava/lang/Class;",
                                &[jni::objects::JValue::from(&class_name_obj)],
                            );
                            match class_obj_val {
                                Ok(class_obj_res) => {
                                    if let Ok(class_obj) = class_obj_res.l() {
                                        let j_class: jni::objects::JClass = class_obj.into();
                                        let call_res = env.call_static_method(
                                            &j_class,
                                            "startService",
                                            "(Landroid/content/Context;)V",
                                            &[jni::objects::JValue::from(&ctx)],
                                        );
                                        if let Err(e) = call_res {
                                            log::error!("JNI: startService call failed: {}", e);
                                            if env.exception_check().unwrap_or(false) {
                                                let _ = env.exception_describe();
                                                let _ = env.exception_clear();
                                            }
                                        } else {
                                            log::info!("JNI: successfully called UploadForegroundService.startService");
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::error!("JNI: loadClass UploadForegroundService failed: {}", e);
                                    if env.exception_check().unwrap_or(false) {
                                        let _ = env.exception_describe();
                                        let _ = env.exception_clear();
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    log::error!("JNI: getClassLoader failed: {}", e);
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "android")]
pub fn stop_foreground_service() {
    log::info!("JNI: stop_foreground_service called");
    let ctx_obj = ndk_context::android_context();
    if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx_obj.vm().cast()) } {
        if let Ok(mut env) = vm.attach_current_thread() {
            let ctx = unsafe { jni::objects::JObject::from_raw(ctx_obj.context().cast()) };
            
            // Get class loader from Context
            match env.call_method(
                &ctx,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            ) {
                Ok(class_loader_val) => {
                    if let Ok(class_loader) = class_loader_val.l() {
                        let class_name = env.new_string("com.cameronamer.telegramdrive.UploadForegroundService");
                        if let Ok(class_name_obj) = class_name {
                            let class_obj_val = env.call_method(
                                &class_loader,
                                "loadClass",
                                "(Ljava/lang/String;)Ljava/lang/Class;",
                                &[jni::objects::JValue::from(&class_name_obj)],
                            );
                            match class_obj_val {
                                Ok(class_obj_res) => {
                                    if let Ok(class_obj) = class_obj_res.l() {
                                        let j_class: jni::objects::JClass = class_obj.into();
                                        let call_res = env.call_static_method(
                                            &j_class,
                                            "stopService",
                                            "(Landroid/content/Context;)V",
                                            &[jni::objects::JValue::from(&ctx)],
                                        );
                                        if let Err(e) = call_res {
                                            log::error!("JNI: stopService call failed: {}", e);
                                            if env.exception_check().unwrap_or(false) {
                                                let _ = env.exception_describe();
                                                let _ = env.exception_clear();
                                            }
                                        } else {
                                            log::info!("JNI: successfully called UploadForegroundService.stopService");
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::error!("JNI: loadClass UploadForegroundService failed: {}", e);
                                    if env.exception_check().unwrap_or(false) {
                                        let _ = env.exception_describe();
                                        let _ = env.exception_clear();
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    log::error!("JNI: getClassLoader failed: {}", e);
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                    }
                }
            }
        }
    }
}

/// Update the foreground-service notification with the current upload progress.
/// No-op if the service class or method is missing (best-effort).
#[cfg(target_os = "android")]
pub fn update_notification_progress(percent: u8, text: &str) {
    let ctx_obj = ndk_context::android_context();
    let Ok(vm) = (unsafe { jni::JavaVM::from_raw(ctx_obj.vm().cast()) }) else { return };
    let Ok(mut env) = vm.attach_current_thread() else { return };
    let ctx = unsafe { jni::objects::JObject::from_raw(ctx_obj.context().cast()) };

    let Ok(class_loader_val) = env.call_method(&ctx, "getClassLoader", "()Ljava/lang/ClassLoader;", &[]) else { return };
    let Ok(class_loader) = class_loader_val.l() else { return };
    let Ok(class_name) = env.new_string("com.cameronamer.telegramdrive.UploadForegroundService") else { return };
    let class_res = env.call_method(
        &class_loader,
        "loadClass",
        "(Ljava/lang/String;)Ljava/lang/Class;",
        &[jni::objects::JValue::from(&class_name)],
    );
    let Ok(class_val) = class_res else { let _ = env.exception_clear(); return };
    let Ok(class_obj) = class_val.l() else { return };
    let j_class: jni::objects::JClass = class_obj.into();

    let Ok(j_text) = env.new_string(text) else { return };
    let res = env.call_static_method(
        &j_class,
        "updateProgress",
        "(Landroid/content/Context;ILjava/lang/String;)V",
        &[
            jni::objects::JValue::from(&ctx),
            jni::objects::JValue::from(percent as i32),
            jni::objects::JValue::from(&j_text),
        ],
    );
    if res.is_err() {
        let _ = env.exception_clear();
    }
}

#[cfg(not(target_os = "android"))]
pub fn update_notification_progress(_percent: u8, _text: &str) {}

#[cfg(not(target_os = "android"))]
pub fn start_foreground_service() {
    // Desktop doesn't need this.
}

#[cfg(not(target_os = "android"))]
pub fn stop_foreground_service() {
    // Desktop doesn't need this.
}

#[tauri::command]
pub fn cmd_start_foreground_service() {
    #[cfg(target_os = "android")]
    start_foreground_service();
}

#[tauri::command]
pub fn cmd_stop_foreground_service() {
    #[cfg(target_os = "android")]
    stop_foreground_service();
}
