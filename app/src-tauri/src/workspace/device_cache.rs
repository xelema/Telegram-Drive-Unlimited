//! Shared device capacity and disposable preview storage. Offline files are never part of
//! this tree, even during migration or an explicit cache clear.
use super::cache_core::{self, state, Clearing, State};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

type Result<T> = std::result::Result<T, String>;
pub const SPACE_RESERVE: u64 = 128 * 1024 * 1024;
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    pub file_count: usize,
    pub total_bytes: u64,
    pub partial_bytes: u64,
    pub legacy_bytes: u64,
    pub limit_bytes: u64,
    pub kept_bytes: u64,
}

pub fn set_limit_bytes(bytes: u64) {
    cache_core::configure(bytes, cache_core::limits().1);
}
pub fn limit_bytes() -> u64 {
    cache_core::limits().0
}
pub fn root(app_cache_dir: &Path) -> PathBuf {
    app_cache_dir.join("previews").join("android-library")
}

/// Create only real directories underneath the trusted application directory.
/// A symlink in a disposable subtree must never turn cleanup into deletion of
/// the deliberately kept files that live next to the legacy preview directory.
fn subdir(base: &Path, names: &[&str], create: bool) -> Result<PathBuf> {
    let mut path = base.to_path_buf();
    for name in names {
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_dir() => {}
            Ok(_) => return Err("The preview cache directory is not a private directory".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if create {
                    fs::create_dir(&path).map_err(|e| e.to_string())?;
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(path)
}

#[derive(Debug)]
struct Entry {
    path: PathBuf,
    bytes: u64,
}

fn files(path: &Path, output: &mut Vec<Entry>) -> Result<()> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.file_type().is_dir() {
            files(&entry.path(), output)?;
        } else if meta.file_type().is_file() {
            output.push(Entry {
                path: entry.path(),
                bytes: meta.len(),
            });
        }
        // Symlinks are neither followed nor treated as verified cache files.
    }
    Ok(())
}

fn legacy_directories(data_dir: &Path) -> Result<Vec<(String, PathBuf)>> {
    let base = subdir(data_dir, &["files", "android-offline"], false)?;
    let entries = match fs::read_dir(&base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let owner = entry.file_name().to_string_lossy().to_string();
        if owner.parse::<i64>().is_ok_and(|v| v > 0) {
            let path = subdir(&base, &[&owner, "previews"], false)?;
            if path.exists() {
                out.push((owner, path));
            }
        }
    }
    Ok(out)
}

fn category(app_cache_dir: &Path, create: bool) -> Result<PathBuf> {
    if create {
        fs::create_dir_all(app_cache_dir).map_err(|e| e.to_string())?;
    }
    let cache = app_cache_dir
        .canonicalize()
        .unwrap_or_else(|_| app_cache_dir.to_path_buf());
    subdir(&cache, &["previews", "android-library"], create)
}

fn migrate(data_dir: &Path, app_cache_dir: &Path) -> Result<()> {
    let base = category(app_cache_dir, true)?;
    for (owner, legacy) in legacy_directories(data_dir)? {
        let target = subdir(&base, &[&owner], true)?;
        for entry in fs::read_dir(&legacy).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let source = entry.path();
            let meta = fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
            if !meta.file_type().is_file() {
                continue;
            }
            if source.extension().and_then(|e| e.to_str()) == Some("part") {
                fs::remove_file(source).map_err(|e| e.to_string())?;
                continue;
            }
            let destination = target.join(entry.file_name());
            if fs::symlink_metadata(&destination).is_ok() {
                // Both versions are disposable; the current cache wins.
                fs::remove_file(source).map_err(|e| e.to_string())?;
            } else {
                fs::rename(source, destination)
                    .map_err(|e| format!("Unable to move the legacy preview cache: {e}"))?;
            }
        }
        // Leave nonempty/unrecognized directories intact for an explicit clear.
        let _ = fs::remove_dir(legacy);
    }
    Ok(())
}

fn prune(
    base: &Path,
    state: &State,
    limit: u64,
    incoming: u64,
    preserve: Option<&Path>,
) -> Result<()> {
    state.prune(base, limit, incoming, preserve).map(|_| ())
}

fn status_inner(data_dir: &Path, app_cache_dir: &Path) -> Result<CacheStatus> {
    let base = category(app_cache_dir, false)?;
    let mut current = Vec::new();
    files(&base, &mut current)?;
    let mut legacy = Vec::new();
    for (_, path) in legacy_directories(data_dir)? {
        files(&path, &mut legacy)?;
    }
    let mut status = CacheStatus {
        limit_bytes: limit_bytes(),
        ..Default::default()
    };
    status.legacy_bytes = legacy.iter().map(|entry| entry.bytes).sum();
    for entry in current.into_iter().chain(legacy) {
        if cache_core::kept(&entry.path) {
            status.kept_bytes = status.kept_bytes.saturating_add(entry.bytes);
            continue;
        }
        status.total_bytes = status.total_bytes.saturating_add(entry.bytes);
        if entry.path.extension().and_then(|e| e.to_str()) == Some("part") {
            status.partial_bytes = status.partial_bytes.saturating_add(entry.bytes);
        } else {
            status.file_count += 1;
        }
    }
    Ok(status)
}

pub fn status(data_dir: &Path, app_cache_dir: &Path) -> Result<CacheStatus> {
    cache_core::register(app_cache_dir, Some(data_dir))?;
    let _state = state();
    status_inner(data_dir, app_cache_dir)
}

pub fn maintain(data_dir: &Path, app_cache_dir: &Path) -> Result<CacheStatus> {
    cache_core::register(app_cache_dir, Some(data_dir))?;
    let state = state();
    migrate(data_dir, app_cache_dir)?;
    prune(&root(app_cache_dir), &state, limit_bytes(), 0, None)?;
    status_inner(data_dir, app_cache_dir)
}

pub fn clear(data_dir: &Path, app_cache_dir: &Path) -> Result<u64> {
    crate::external_files::invalidate_all_accounts(data_dir)?;
    cache_core::register(app_cache_dir, Some(data_dir))?;
    let base = category(app_cache_dir, false)?;
    let _clearing = Clearing::new(&base);
    let _state = state();
    let mut removed = 0u64;
    let mut current = Vec::new();
    files(&base, &mut current)?;
    for (_, legacy) in legacy_directories(data_dir)? {
        files(&legacy, &mut current)?;
    }
    for entry in current {
        if cache_core::kept(&entry.path) {
            continue;
        }
        fs::remove_file(&entry.path).map_err(|e| e.to_string())?;
        removed = removed.saturating_add(entry.bytes);
    }
    Ok(removed)
}

pub enum Prepared {
    Cached(PathBuf),
    Download(Reservation),
}

pub struct Reservation {
    root: PathBuf,
    token: String,
    pub target: PathBuf,
    pub partial: PathBuf,
    expected: u64,
    epoch: u64,
}

/// Reserving the full size before opening the stream prevents concurrent
/// previews from each independently consuming the entire configured budget.
pub fn prepare(
    data_dir: &Path,
    app_cache_dir: &Path,
    owner: i64,
    filename: &str,
    expected: u64,
) -> Result<Prepared> {
    prepare_with_space(
        data_dir,
        app_cache_dir,
        owner,
        filename,
        expected,
        limit_bytes(),
        available_bytes,
    )
}

fn prepare_with_space(
    data_dir: &Path,
    app_cache_dir: &Path,
    owner: i64,
    filename: &str,
    expected: u64,
    limit: u64,
    available: impl Fn(&Path) -> Result<u64>,
) -> Result<Prepared> {
    cache_core::register(app_cache_dir, Some(data_dir))?;
    if owner <= 0
        || filename.is_empty()
        || Path::new(filename)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(filename)
        || filename.contains('\\')
    {
        return Err("Invalid preview identity".into());
    }
    let mut state = state();
    migrate(data_dir, app_cache_dir)?;
    let base = category(app_cache_dir, true)?;
    let directory = subdir(&base, &[&owner.to_string()], true)?;
    let target = directory.join(filename);
    if expected > limit {
        return Err(
            "This file exceeds the media cache limit; increase the limit or keep the file offline"
                .into(),
        );
    }
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_file() && meta.len() == expected => {
            prune(&base, &state, limit, 0, Some(&target))?;
            let file = fs::OpenOptions::new()
                .write(true)
                .open(&target)
                .map_err(|e| e.to_string())?;
            file.set_times(fs::FileTimes::new().set_modified(SystemTime::now()))
                .map_err(|e| e.to_string())?;
            return Ok(Prepared::Cached(target));
        }
        Ok(meta) if meta.file_type().is_file() => {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
        Ok(_) => return Err("Invalid preview cache file".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    check_space(available(&directory)?, expected)?;
    let partial = target.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    let token = uuid::Uuid::new_v4().to_string();
    let epoch = state.reserve(&base, &token, expected)?;
    state.paths.insert(partial.clone(), token.clone());
    Ok(Prepared::Download(Reservation {
        root: base,
        token,
        target,
        partial,
        expected,
        epoch,
    }))
}

impl Reservation {
    pub fn check(&self) -> Result<()> {
        let state = state();
        self.check_locked(&state)
    }
    fn check_locked(&self, state: &State) -> Result<()> {
        state.check(&self.root, &self.token, self.epoch)
    }
    pub fn check_free_space(&self, incoming: u64) -> Result<()> {
        self.check()?;
        check_space(
            available_bytes(
                self.partial
                    .parent()
                    .ok_or("Preview directory unavailable")?,
            )?,
            incoming,
        )
    }
    pub fn finish(&self) -> Result<PathBuf> {
        let mut state = state();
        self.check_locked(&state)?;
        let metadata = fs::symlink_metadata(&self.partial).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file() || metadata.len() != self.expected {
            return Err("The preview download is incomplete".into());
        }
        fs::rename(&self.partial, &self.target).map_err(|e| e.to_string())?;
        state.paths.remove(&self.partial);
        state.reservations.remove(&self.token);
        Ok(self.target.clone())
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut state = state();
        if state.paths.get(&self.partial) == Some(&self.token) {
            state.paths.remove(&self.partial);
        }
        state.reservations.remove(&self.token);
        drop(state);
        let _ = fs::remove_file(&self.partial);
    }
}

fn check_space(available: u64, incoming: u64) -> Result<()> {
    if available < incoming.saturating_add(SPACE_RESERVE) {
        Err("Free up device storage before downloading this preview".into())
    } else {
        Ok(())
    }
}

pub fn ensure_free_space(directory: &Path, incoming: u64) -> Result<()> {
    check_space(available_bytes(directory)?, incoming)
}

#[cfg(target_os = "android")]
pub fn available_bytes(directory: &Path) -> Result<u64> {
    let context = ndk_context::android_context();
    let vm = unsafe { ::jni::JavaVM::from_raw(context.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let path = env
        .new_string(directory.to_string_lossy())
        .map_err(|e| e.to_string())?;
    let file = env
        .new_object(
            "java/io/File",
            "(Ljava/lang/String;)V",
            &[jni::objects::JValue::from(&path)],
        )
        .map_err(|e| e.to_string())?;
    let available = env
        .call_method(file, "getUsableSpace", "()J", &[])
        .map_err(|e| e.to_string())?
        .j()
        .map_err(|e| e.to_string())?;
    u64::try_from(available).map_err(|_| "Unable to read available device storage".into())
}

#[cfg(not(target_os = "android"))]
pub fn available_bytes(directory: &Path) -> Result<u64> {
    let path = directory.canonicalize().map_err(|e| e.to_string())?;
    sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .filter_map(|disk| {
            let mount = disk.mount_point().canonicalize().ok()?;
            path.starts_with(&mount)
                .then(|| (mount.as_os_str().len(), disk.available_space()))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(_, available)| available)
        .ok_or_else(|| "Unable to read available device storage".into())
}
