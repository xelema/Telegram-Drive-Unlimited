//! Canonical language aliases and the build-validated native translation subset.
use std::collections::BTreeMap;
use std::sync::LazyLock;

pub const LANGUAGES: &[&str] = &[
    "en", "es", "ru", "uk-UA", "pl-PL", "fa-IR", "ur-PK", "ms-MY", "zh-CN", "zh-TW", "fr", "it",
    "ar", "pt-BR", "de", "hi", "bn-BD", "id", "fil-PH", "tr", "th-TH", "ja", "ko", "vi",
];

pub fn canonical_language(input: &str) -> Option<&'static str> {
    if input.len() > 64 {
        return None;
    }
    let normalized = input.trim().replace('_', "-").to_ascii_lowercase();
    if normalized
        .split('-')
        .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    {
        return None;
    }
    let aliases: &[(&str, &str)] = &[
        ("zh-hant", "zh-TW"),
        ("zh-tw", "zh-TW"),
        ("zh-hk", "zh-TW"),
        ("zh-mo", "zh-TW"),
        ("zh-hans", "zh-CN"),
        ("zh-cn", "zh-CN"),
        ("zh-sg", "zh-CN"),
        ("zh", "zh-CN"),
        ("en", "en"),
        ("es", "es"),
        ("ru", "ru"),
        ("uk", "uk-UA"),
        ("pl", "pl-PL"),
        ("fa", "fa-IR"),
        ("ur", "ur-PK"),
        ("ms", "ms-MY"),
        ("fr", "fr"),
        ("it", "it"),
        ("ar", "ar"),
        ("pt", "pt-BR"),
        ("de", "de"),
        ("hi", "hi"),
        ("bn", "bn-BD"),
        ("id", "id"),
        ("in", "id"),
        ("fil", "fil-PH"),
        ("tl", "fil-PH"),
        ("tr", "tr"),
        ("th", "th-TH"),
        ("ja", "ja"),
        ("ko", "ko"),
        ("vi", "vi"),
    ];
    aliases
        .iter()
        .find(|(alias, _)| {
            normalized == *alias
                || normalized
                    .strip_prefix(alias)
                    .is_some_and(|rest| rest.starts_with('-'))
        })
        .map(|(_, language)| *language)
}

pub fn direction(language: &str) -> &'static str {
    if ["ar", "fa-IR", "ur-PK"].contains(&language) {
        "rtl"
    } else {
        "ltr"
    }
}

type Catalogs = BTreeMap<String, BTreeMap<String, String>>;
static CATALOGS: LazyLock<Catalogs> = LazyLock::new(|| {
    serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/native-locales.json"
    )))
    .expect("build validated native catalogs")
});

pub fn text(language: &str, key: &str) -> &'static str {
    CATALOGS
        .get(language)
        .and_then(|catalog| catalog.get(key))
        .expect("build validated native translation key")
}

/// Read the existing plugin-store preference without creating or repairing it.
pub struct NativeLanguageState(std::sync::RwLock<&'static str>);
impl NativeLanguageState {
    pub fn load(root: &std::path::Path, system_language: Option<&str>) -> Self {
        use std::io::Read;
        let preference = (|| {
            let file = std::fs::File::open(root.join("settings.json")).ok()?;
            let mut bytes = Vec::new();
            file.take(512 * 1024 + 1).read_to_end(&mut bytes).ok()?;
            if bytes.len() > 512 * 1024 {
                return None;
            }
            let source: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
            source
                .get("settings")?
                .get("language")?
                .as_str()
                .and_then(canonical_language)
        })();
        Self(std::sync::RwLock::new(
            preference
                .or_else(|| system_language.and_then(canonical_language))
                .unwrap_or("en"),
        ))
    }
    pub fn get(&self) -> &'static str {
        *self
            .0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    pub fn set(&self, language: &str) -> Result<(), String> {
        let language = canonical_language(language).ok_or("Unsupported native language")?;
        *self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = language;
        Ok(())
    }
}

/// Substitute catalog tokens once; inserted filenames cannot become new tokens.
pub fn format(language: &str, key: &str, arguments: &[(&str, &str)]) -> String {
    let mut remaining = text(language, key);
    let mut output = String::new();
    while let Some((prefix, suffix)) = remaining.split_once("{{") {
        output.push_str(prefix);
        let (name, rest) = suffix
            .split_once("}}")
            .expect("build validated native interpolation");
        output.push_str(
            arguments
                .iter()
                .find(|(key, _)| *key == name.trim())
                .expect("native interpolation argument")
                .1,
        );
        remaining = rest;
    }
    output.push_str(remaining);
    output
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn cmd_set_native_language(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeLanguageState>,
    language: String,
) -> Result<(), String> {
    use tauri::Manager;
    state.set(&language)?;
    if let Some(notifications) = app
        .try_state::<std::sync::Arc<crate::desktop_notifications::DesktopNotificationCoordinator>>()
    {
        notifications.refresh_tray();
    } else if let Some(tray) = app.try_state::<crate::desktop_tray::DesktopTrayState>() {
        tray.refresh();
    }
    Ok(())
}
