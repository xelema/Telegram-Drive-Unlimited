#[cfg(target_os = "android")]
use jni::objects::GlobalRef;
#[cfg(target_os = "android")]
use std::sync::OnceLock;

#[cfg(target_os = "android")]
static CLASS_LOADER: OnceLock<GlobalRef> = OnceLock::new();
#[cfg(target_os = "android")]
static MAIN_ACTIVITY_CLASS: OnceLock<GlobalRef> = OnceLock::new();

#[cfg(target_os = "android")]
pub fn set_class_loader(class_loader: GlobalRef) -> Result<(), GlobalRef> {
    CLASS_LOADER.set(class_loader)
}

#[cfg(target_os = "android")]
pub fn get_class_loader() -> Option<&'static GlobalRef> {
    CLASS_LOADER.get()
}

#[cfg(target_os = "android")]
pub fn set_main_activity_class(main_activity_class: GlobalRef) -> Result<(), GlobalRef> {
    MAIN_ACTIVITY_CLASS.set(main_activity_class)
}

#[cfg(target_os = "android")]
pub fn get_main_activity_class() -> Option<&'static GlobalRef> {
    MAIN_ACTIVITY_CLASS.get()
}

/// Returns a JClass for the cached MainActivity class reference.
///
/// # Safety
///
/// Uses `transmute_copy` to convert `&JObject` to `JClass`. This is safe because:
/// - `JClass` is a transparent wrapper around `JObject` (both hold a single raw JNI pointer).
/// - The `GlobalRef` stored in the static cache ensures the JNI global reference
///   is never garbage-collected for the lifetime of the process.
/// - This is the standard idiom in jni 0.21 where no safe `From<&JObject>` impl exists.
#[cfg(target_os = "android")]
pub fn get_main_activity_jclass() -> Option<jni::objects::JClass<'static>> {
    MAIN_ACTIVITY_CLASS.get().map(|global_ref| {
        // SAFETY: JClass is repr(transparent) over JObject; both wrap the same raw pointer.
        // The GlobalRef ensures the underlying class reference is never GC'd.
        unsafe { std::mem::transmute_copy(global_ref.as_obj()) }
    })
}
