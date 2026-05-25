#[cfg(target_os = "android")]
pub fn start_foreground_service() {
    // Placeholder for JNI call to Android foreground service
    println!("Foreground service started (Android).");
}

#[cfg(not(target_os = "android"))]
pub fn start_foreground_service() {
    // Desktop doesn't need this.
}
