#[tauri::command]
pub fn show_ad() {
    #[cfg(target_os = "android")]
    {
        let ctx = ndk_context::android_context();
        if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) } {
            if let Ok(mut env) = vm.attach_current_thread() {
                if let Ok(class) = env.find_class("com/cameronamer/telegramdrive/MainActivity") {
                    let _ = env.call_static_method(class, "showAd", "()V", &[]);
                }
            }
        }
    }
}
