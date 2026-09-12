//! Device storage inventory. Only application-owned disposable files are
//! removable; downloads and deliberately retained files are inventory only.
use super::{account::AccountGuard, assets, store::Store};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};
use tauri::Manager;

const MIB: u64 = 1024 * 1024;
const ORPHAN_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLimits {
    pub previews: u64,
    pub thumbnails: u64,
    pub converted: u64,
}
impl Default for StorageLimits {
    fn default() -> Self {
        Self {
            previews: 512 * MIB,
            thumbnails: 64 * MIB,
            converted: 5 * 1024 * MIB,
        }
    }
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub bytes: u64,
    pub reclaimable_bytes: u64,
    pub file_count: usize,
    pub measured: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSnapshot {
    pub owner_id: String,
    pub categories: Vec<Category>,
    pub free_bytes: Option<u64>,
    pub limits: StorageLimits,
}

#[derive(Debug)]
struct Entry {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

/// Reject symlinks at every component under the trusted application root.
fn private_subdir(base: &Path, suffix: &str) -> Result<PathBuf, String> {
    let mut path = base.to_path_buf();
    for component in Path::new(suffix).components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Invalid storage category".into());
        }
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_dir() => {}
            Ok(_) => {
                return Err("STORAGE_UNAVAILABLE: Cache contains an unexpected directory".into())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(path)
}
fn inventory(root: &Path, recursive: bool) -> Result<Vec<Entry>, String> {
    match fs::symlink_metadata(root) {
        Ok(meta) if meta.file_type().is_dir() => {}
        Ok(_) => return Err("STORAGE_UNAVAILABLE: Invalid cache directory".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    }
    let mut files = Vec::new();
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .max_depth(if recursive { usize::MAX } else { 1 });
    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        files.push(Entry {
            path: entry.into_path(),
            bytes: meta.len(),
            modified: meta.modified().unwrap_or(SystemTime::now()),
        });
    }
    Ok(files)
}
fn is_temporary(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("part" | "source")
    )
}
fn pinned(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "pin") || path.with_extension("pin").is_file()
}
fn old(entry: &Entry) -> bool {
    entry.modified.elapsed().is_ok_and(|age| age >= ORPHAN_AGE)
}
fn add(category: &mut Category, entry: &Entry, reclaimable: bool) {
    category.bytes = category.bytes.saturating_add(entry.bytes);
    category.file_count += 1;
    if reclaimable {
        category.reclaimable_bytes = category.reclaimable_bytes.saturating_add(entry.bytes);
    }
}

/// Existing settings use this path too: pin markers and private subtrees must
/// survive clearing the legacy preview cache.
pub fn clear_legacy_previews(cache: &Path) -> Result<u64, String> {
    let mutation = crate::commands::preview::legacy_preview_mutation();
    let directory = private_subdir(cache, "previews")?;
    remove_files(
        inventory(&directory, false)?
            .into_iter()
            .filter(|entry| {
                !pinned(&entry.path)
                    && !is_temporary(&entry.path)
                    && !mutation.is_active(&entry.path)
            })
            .collect(),
    )
}
fn remove_files(entries: Vec<Entry>) -> Result<u64, String> {
    let mut reclaimed = 0u64;
    for entry in entries {
        match fs::symlink_metadata(&entry.path) {
            Ok(meta) if meta.file_type().is_file() && meta.len() == entry.bytes => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        }
        fs::remove_file(entry.path).map_err(|e| e.to_string())?;
        reclaimed = reclaimed.saturating_add(entry.bytes);
    }
    Ok(reclaimed)
}
fn category(id: &str) -> Category {
    Category {
        id: id.into(),
        measured: true,
        ..Default::default()
    }
}

#[cfg(target_os = "android")]
fn android_downloads() -> Result<(u64, usize, bool), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Summary {
        bytes: u64,
        file_count: usize,
        measured: bool,
    }
    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let main_class =
        crate::jni_cache::get_main_activity_jclass().ok_or("Android storage is unavailable")?;
    let value = env
        .call_static_method(
            &main_class,
            "getDeviceDownloadsJson",
            "()Ljava/lang/String;",
            &[],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let value = jni::objects::JString::from(value);
    let text: String = env.get_string(&value).map_err(|e| e.to_string())?.into();
    let summary: Summary = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok((summary.bytes, summary.file_count, summary.measured))
}

fn collect(
    data: &Path,
    cache: &Path,
    owner: i64,
    transcodes: &Path,
    active: &HashSet<PathBuf>,
    downloads: &[PathBuf],
) -> Result<Vec<Category>, String> {
    let mut previews = category("previews");
    let mut thumbnails = category("thumbnails");
    let mut native = category("nativePreviews");
    let mut kept = category("kept");
    let mut staging = category("staging");
    let mut converted = category("converted");
    let mut downloaded = category("downloads");
    for entry in inventory(&private_subdir(cache, "previews")?, false)? {
        if pinned(&entry.path) {
            add(&mut kept, &entry, false);
        } else if is_temporary(&entry.path) {
            add(&mut staging, &entry, false);
        } else {
            add(&mut previews, &entry, !active.contains(&entry.path));
        }
    }
    for (suffix, thumb) in [
        (format!("previews/workspace/{owner}/previews"), false),
        (format!("previews/workspace/{owner}/thumbnails"), true),
    ] {
        for entry in inventory(&private_subdir(cache, &suffix)?, true)? {
            if is_temporary(&entry.path) {
                add(
                    &mut staging,
                    &entry,
                    old(&entry) && !active.contains(&entry.path),
                );
            } else {
                add(
                    if thumb {
                        &mut thumbnails
                    } else {
                        &mut previews
                    },
                    &entry,
                    true,
                );
            }
        }
    }
    for entry in inventory(&private_subdir(data, "thumbnails")?, true)? {
        add(
            &mut thumbnails,
            &entry,
            !is_temporary(&entry.path) && !active.contains(&entry.path),
        );
    }
    let native_status = crate::workspace::device_cache::status(data, cache)?;
    native.bytes = native_status.total_bytes;
    native.reclaimable_bytes = native_status.total_bytes;
    native.file_count = native_status.file_count;
    for suffix in [
        format!("workspace/{owner}/offline"),
        format!("files/android-offline/{owner}"),
    ] {
        for entry in inventory(&private_subdir(data, &suffix)?, true)? {
            if entry
                .path
                .components()
                .any(|part| part.as_os_str() == "previews")
            {
                continue;
            }
            if is_temporary(&entry.path) {
                add(&mut staging, &entry, false);
            } else {
                add(&mut kept, &entry, false);
            }
        }
    }
    for suffix in [
        format!("camera-staging/{owner}"),
        "android-transfer-staging".into(),
    ] {
        // These may be resumable even after a long pause; their owning queues
        // are responsible for removal. Age alone is never proof of abandonment.
        for entry in inventory(&private_subdir(data, &suffix)?, true)? {
            add(&mut staging, &entry, false);
        }
    }
    for entry in inventory(transcodes, true)? {
        add(&mut converted, &entry, true);
    }
    let mut seen = HashSet::new();
    for path in downloads {
        if !seen.insert(path.clone()) {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(path) {
            if meta.file_type().is_file() {
                add(
                    &mut downloaded,
                    &Entry {
                        path: path.clone(),
                        bytes: meta.len(),
                        modified: SystemTime::now(),
                    },
                    false,
                );
            }
        }
    }
    #[cfg(target_os = "android")]
    {
        let (bytes, count, measured) = android_downloads().unwrap_or((0, 0, false));
        downloaded.bytes = bytes;
        downloaded.file_count = count;
        downloaded.measured = measured;
    }
    #[cfg(target_os = "ios")]
    {
        downloaded.measured = false;
    }
    Ok(vec![
        kept, previews, thumbnails, native, converted, downloaded, staging,
    ])
}

pub async fn apply_limits(app: &tauri::AppHandle, limits: &StorageLimits) {
    // The preview slider is an aggregate allowance split across the legacy,
    // workspace and native caches. Deliberately kept files are outside it.
    let share = (limits.previews / 3).max(1);
    assets::configure_limits(share, limits.thumbnails / 2);
    crate::workspace::device_cache::set_limit_bytes(share);
    crate::commands::preview::configure_limits(share, limits.thumbnails / 2);
    if let Some(manager) = app.try_state::<Arc<crate::transcode::TranscodeManager>>() {
        manager.set_max_cache_bytes(limits.converted).await;
    }
}

#[tauri::command]
pub async fn cmd_storage_read(
    app: tauri::AppHandle,
    owner_id: String,
) -> Result<StorageSnapshot, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&data, Some(&owner_id))?;
    let limits = Store::open(&data, account.owner)?
        .record::<StorageLimits>("storage", "limits")?
        .unwrap_or_default();
    apply_limits(&app, &limits).await;
    let manager = app.state::<Arc<crate::transcode::TranscodeManager>>();
    let transcodes = manager.cache_root.clone();
    let mut conversion_busy = false;
    for job in manager.get_job_snapshot().await.values() {
        if job.lock().await.has_live_writer() {
            conversion_busy = true;
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let (mut active, downloads) =
        if let Some(engine) = app.try_state::<Arc<crate::transfer_engine::TransferEngine>>() {
            (
                engine
                    .active_paths()
                    .await
                    .into_iter()
                    .collect::<HashSet<_>>(),
                engine
                    .completed_downloads(&owner_id)
                    .await?
                    .into_iter()
                    .filter_map(|job| job.save_path.map(PathBuf::from))
                    .collect::<Vec<_>>(),
            )
        } else {
            (HashSet::new(), Vec::new())
        };
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let (mut active, downloads) = (HashSet::new(), Vec::new());
    active.extend(assets::active_paths());
    active.extend(crate::commands::preview::active_legacy_paths());
    tokio::task::spawn_blocking(move || {
        account.validate()?;
        let mut categories = collect(
            &data,
            &cache,
            account.owner,
            &transcodes,
            &active,
            &downloads,
        )?;
        if conversion_busy {
            if let Some(category) = categories
                .iter_mut()
                .find(|category| category.id == "converted")
            {
                category.reclaimable_bytes = 0;
            }
        }
        let free_bytes = crate::workspace::device_cache::available_bytes(&data).ok();
        account.validate()?;
        Ok(StorageSnapshot {
            owner_id,
            categories,
            free_bytes,
            limits,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_storage_limits(
    app: tauri::AppHandle,
    owner_id: String,
    limits: StorageLimits,
) -> Result<(), String> {
    if !(256 * MIB..=50 * 1024 * MIB).contains(&limits.previews)
        || !(32 * MIB..=2048 * MIB).contains(&limits.thumbnails)
        || !(256 * MIB..=100 * 1024 * MIB).contains(&limits.converted)
    {
        return Err("Invalid storage limit".into());
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&data, Some(&owner_id))?;
    Store::open(&data, account.owner)?.put_record("storage", "limits", &limits)?;
    account.validate()?;
    apply_limits(&app, &limits).await;
    Ok(())
}

#[tauri::command]
pub async fn cmd_storage_clear(
    app: tauri::AppHandle,
    owner_id: String,
    category: String,
) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&data, Some(&owner_id))?;
    if category == "converted" {
        crate::transcode::cmd_clear_transcode_cache(
            None,
            None,
            app.state::<Arc<crate::transcode::TranscodeManager>>(),
        )
        .await?;
        account.validate()?;
        return Ok(());
    }
    if matches!(category.as_str(), "previews" | "thumbnails" | "staging") {
        assets::clear_owner(&app, account.owner, category.as_str()).await?;
    }
    tokio::task::spawn_blocking(move || {
        account.validate()?;
        match category.as_str() {
            "previews" => {
                clear_legacy_previews(&cache)?;
            }
            "thumbnails" => {
                let mutation = crate::commands::preview::legacy_preview_mutation();
                remove_files(
                    inventory(&private_subdir(&data, "thumbnails")?, true)?
                        .into_iter()
                        .filter(|entry| {
                            !is_temporary(&entry.path) && !mutation.is_active(&entry.path)
                        })
                        .collect(),
                )?;
            }
            "nativePreviews" => {
                crate::workspace::device_cache::clear(&data, &cache)?;
            }
            "staging" => {}
            _ => return Err("Only disposable cache categories can be cleared".into()),
        }
        account.validate()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn write(root: &Path, name: &str, bytes: &[u8]) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    #[test]
    fn clearing_legacy_cache_preserves_pins_partials_and_private_subtrees() {
        let root = fixture();
        write(&root, "previews/a.mp4", b"kept");
        write(&root, "previews/a.pin", b"pin");
        write(&root, "previews/b.pdf", b"preview");
        write(&root, "previews/active.part", b"part");
        write(&root, "previews/workspace/1/private", b"private");
        assert_eq!(clear_legacy_previews(&root).unwrap(), 7);
        assert!(root.join("previews/a.mp4").is_file());
        assert!(root.join("previews/a.pin").is_file());
        assert!(root.join("previews/active.part").is_file());
        assert!(root.join("previews/workspace/1/private").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn accounting_separates_kept_previews_downloads_and_resumable_staging() {
        let root = fixture();
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        write(&cache, "previews/a.pdf", b"123");
        write(&root, "workspace/1/offline/pack/a.mp4", b"12345");
        write(&root, "camera-staging/1/a.ready", b"1234");
        write(&root, "download.pdf", b"12");
        let categories = collect(
            &root,
            &cache,
            1,
            &root.join("transcodes"),
            &HashSet::new(),
            &[root.join("download.pdf"), root.join("download.pdf")],
        )
        .unwrap();
        let lookup = |id: &str| categories.iter().find(|c| c.id == id).unwrap();
        assert_eq!(lookup("kept").bytes, 5);
        assert_eq!(lookup("kept").reclaimable_bytes, 0);
        assert_eq!(lookup("previews").bytes, 3);
        assert_eq!(lookup("staging").bytes, 4);
        assert_eq!(lookup("staging").reclaimable_bytes, 0);
        assert_eq!(lookup("downloads").bytes, 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_redirect_cleanup_to_kept_data() {
        let root = fixture();
        write(&root, "kept/a", b"safe");
        std::os::unix::fs::symlink(root.join("kept"), root.join("previews")).unwrap();
        assert!(clear_legacy_previews(&root).is_err());
        assert_eq!(fs::read(root.join("kept/a")).unwrap(), b"safe");
        fs::remove_dir_all(root).unwrap();
    }
}
