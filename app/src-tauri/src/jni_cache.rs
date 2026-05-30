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
