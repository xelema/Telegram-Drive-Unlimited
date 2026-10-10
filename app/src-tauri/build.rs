#[path = "build/search-support.rs"]
mod search_support;

fn main() {
    search_support::verify_search_support();
    build_native_catalogs();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-lib=c++_shared");
    }
    tauri_build::build()
}

fn build_native_catalogs() {
    use std::{collections::BTreeMap, path::PathBuf};
    let directory =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../src/i18n/locales");
    let mut keys: Vec<String> = [
        "common.password",
        "files.file_name",
        "share_page.title",
        "share_page.heading",
        "share_page.description",
        "share_page.verify",
        "share_page.incorrect",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    keys.extend(
        [
            "title_completed",
            "title_failed",
            "title_paused",
            "title_attention",
            "many_completed",
            "many_failed",
            "many_paused",
            "many_attention",
            "name_completed",
            "name_failed",
            "name_paused",
            "upload_completed",
            "download_completed",
            "failed",
            "paused",
            "unlock",
            "network",
            "telegram",
            "attention",
            "unnamed_file",
        ]
        .into_iter()
        .map(|key| format!("native_notifications.{key}")),
    );
    keys.extend(
        [
            "common.action_name",
            "files.open",
            "activity.resume",
            "common.app_title",
            "common.transfers",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    keys.extend(
        [
            "pause_all",
            "quit",
            "active",
            "paused",
            "attention",
            "failed",
            "current",
        ]
        .into_iter()
        .map(|key| format!("native_tray.{key}")),
    );
    let languages = [
        "en", "es", "ru", "uk-UA", "pl-PL", "fa-IR", "ur-PK", "ms-MY", "zh-CN", "zh-TW", "fr",
        "it", "ar", "pt-BR", "de", "hi", "bn-BD", "id", "fil-PH", "tr", "th-TH", "ja", "ko", "vi",
    ];
    let mut catalogs = BTreeMap::new();
    for language in languages {
        let path = directory.join(format!("{language}.json"));
        println!("cargo:rerun-if-changed={}", path.display());
        let source: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).expect("read canonical locale"))
                .expect("canonical locale JSON");
        let mut catalog = BTreeMap::new();
        for key in &keys {
            let mut value = &source;
            for part in key.split('.') {
                value = value
                    .get(part)
                    .unwrap_or_else(|| panic!("missing native copy {language}/{key}"));
            }
            let text = value
                .as_str()
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| panic!("invalid native copy {language}/{key}"));
            let tokens = interpolation_tokens(text);
            if language != "en" {
                let reference: &BTreeMap<String, String> =
                    catalogs.get("en").expect("English native reference");
                assert_eq!(
                    tokens,
                    interpolation_tokens(&reference[key]),
                    "native variables differ {language}/{key}"
                );
            }
            catalog.insert(key.clone(), text.to_owned());
        }
        catalogs.insert(language, catalog);
    }
    let bytes = serde_json::to_vec(&catalogs).unwrap();
    println!("cargo:warning=Native locale subset: {} bytes (canonical frontend catalogs remain separately counted)", bytes.len());
    std::fs::write(
        PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("native-locales.json"),
        bytes,
    )
    .unwrap();
}

fn interpolation_tokens(text: &str) -> std::collections::BTreeSet<String> {
    let mut remaining = text;
    let mut tokens = std::collections::BTreeSet::new();
    while let Some((prefix, suffix)) = remaining.split_once("{{") {
        assert!(!prefix.contains("}}"), "unbalanced native interpolation");
        let (token, rest) = suffix
            .split_once("}}")
            .expect("balanced native interpolation");
        let token = token.trim();
        assert!(
            !token.is_empty()
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
            "invalid native interpolation"
        );
        tokens.insert(token.to_owned());
        remaining = rest;
    }
    assert!(!remaining.contains("}}"), "unbalanced native interpolation");
    tokens
}
