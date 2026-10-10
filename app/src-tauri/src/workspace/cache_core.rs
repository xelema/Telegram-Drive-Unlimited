//! Synchronous cache policy shared by asynchronous assets and native preview callers.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime},
};
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static PREVIEWS: AtomicU64 = AtomicU64::new(512 * 1024 * 1024);
static THUMBNAILS: AtomicU64 = AtomicU64::new(64 * 1024 * 1024);
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Pool {
    root: PathBuf,
    thumbnail: bool,
}
#[derive(Default)]
pub(crate) struct State {
    pub paths: HashMap<PathBuf, String>,
    pub reservations: HashMap<String, (Pool, u64)>,
    pub clearing: HashMap<PathBuf, usize>,
    epochs: HashMap<Pool, u64>,
    roots: HashSet<PathBuf>,
    legacy_thumbnails: HashMap<PathBuf, PathBuf>,
}
pub(crate) fn state() -> std::sync::MutexGuard<'static, State> {
    STATE
        .get_or_init(|| Mutex::new(State::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
fn normalize(path: &Path) -> PathBuf {
    if let Ok(path) = path.canonicalize() {
        return path;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        return normalize(parent).join(name);
    }
    path.into()
}
pub(crate) fn register(cache: &Path, data: Option<&Path>) -> Result<(), String> {
    let validate = |path: &Path| -> Result<(), String> {
        match std::fs::symlink_metadata(path) {
            Ok(m) if m.file_type().is_dir() => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err("STORAGE_UNAVAILABLE: Unexpected cache directory".into()),
            Err(e) => Err(e.to_string()),
        }
    };
    let previews = cache.join("previews");
    validate(&previews)?;
    let root = normalize(&previews);
    let legacy = data.map(|data| data.join("thumbnails"));
    if let Some(path) = &legacy {
        validate(path)?;
    }
    let mut state = state();
    state.roots.insert(root.clone());
    if let Some(path) = legacy {
        state.legacy_thumbnails.insert(normalize(&path), root);
    }
    Ok(())
}
fn pool_in(state: &State, directory: &Path) -> Pool {
    let directory = normalize(directory);
    if let Some((_, root)) = state
        .legacy_thumbnails
        .iter()
        .filter(|(p, _)| directory.starts_with(p))
        .max_by_key(|(p, _)| p.components().count())
    {
        return Pool {
            root: root.clone(),
            thumbnail: true,
        };
    }
    let root = state
        .roots
        .iter()
        .filter(|root| directory.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
        .unwrap_or_else(|| directory.clone());
    let parts: Vec<_> = directory
        .strip_prefix(&root)
        .unwrap_or(Path::new(""))
        .components()
        .map(|c| c.as_os_str())
        .collect();
    let thumbnail = parts.len() >= 3 && parts[0] == "workspace" && parts[2] == "thumbnails";
    Pool { root, thumbnail }
}
pub(crate) fn configure(previews: u64, thumbnails: u64) {
    PREVIEWS.store(previews.max(1), Ordering::Relaxed);
    THUMBNAILS.store(thumbnails.max(1), Ordering::Relaxed);
}
pub(crate) fn limits() -> (u64, u64) {
    (
        PREVIEWS.load(Ordering::Relaxed),
        THUMBNAILS.load(Ordering::Relaxed),
    )
}
fn limit(pool: &Pool) -> u64 {
    if pool.thumbnail {
        limits().1
    } else {
        limits().0
    }
}
pub(crate) fn kept(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "pin") || path.with_extension("pin").is_file()
}
pub(crate) fn entries(directory: &Path) -> Result<Vec<(PathBuf, std::fs::Metadata)>, String> {
    match std::fs::symlink_metadata(directory) {
        Ok(m) if m.file_type().is_dir() => {}
        Ok(_) => return Err("STORAGE_UNAVAILABLE: Unexpected cache directory".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    }
    let mut result = Vec::new();
    for entry in walkdir::WalkDir::new(directory).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file() {
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            result.push((entry.into_path(), meta));
        }
    }
    Ok(result)
}
impl State {
    pub(crate) fn epoch(&self, directory: &Path) -> u64 {
        *self.epochs.get(&pool_in(self, directory)).unwrap_or(&0)
    }
    pub(crate) fn valid(&self, directory: &Path, epoch: u64) -> bool {
        self.epoch(directory) == epoch && !self.clearing.keys().any(|p| directory.starts_with(p))
    }
    fn reserved(&self, pool: &Pool) -> u64 {
        self.reservations
            .values()
            .filter(|(p, _)| p == pool)
            .map(|(_, n)| *n)
            .sum()
    }
    pub(crate) fn check(&self, directory: &Path, token: &str, epoch: u64) -> Result<(), String> {
        let p = pool_in(self, directory);
        if !self.valid(directory, epoch) || !self.reservations.contains_key(token) {
            return Err("CANCELLED: The preview cache was cleared".into());
        }
        if self.reserved(&p) > limit(&p) {
            return Err("CACHE_BUSY: The cache limit changed".into());
        }
        Ok(())
    }
    pub(crate) fn prune(
        &self,
        directory: &Path,
        cap: u64,
        incoming: u64,
        preserve: Option<&Path>,
    ) -> Result<u64, String> {
        let p = pool_in(self, directory);
        let mut files = entries(&p.root)?;
        if p.thumbnail {
            for (legacy, root) in &self.legacy_thumbnails {
                if root == &p.root {
                    files.extend(entries(legacy)?);
                }
            }
        }
        files.retain(|(path, _)| pool_in(self, path) == p);
        let mut used = self.reserved(&p).saturating_add(
            files
                .iter()
                .filter(|(path, _)| {
                    !kept(path)
                        && !self
                            .paths
                            .get(path)
                            .is_some_and(|t| self.reservations.contains_key(t))
                })
                .map(|(_, m)| m.len())
                .sum::<u64>(),
        );
        files.sort_by_key(|(_, m)| m.modified().unwrap_or(SystemTime::UNIX_EPOCH));
        for (path, meta) in files {
            if used.saturating_add(incoming) <= cap {
                break;
            }
            let partial = path
                .extension()
                .is_some_and(|e| e == "part" || e == "source");
            let old = meta
                .modified()
                .ok()
                .and_then(|m| m.elapsed().ok())
                .is_some_and(|age| age >= Duration::from_secs(7 * 24 * 60 * 60));
            if kept(&path)
                || Some(path.as_path()) == preserve
                || self.paths.contains_key(&path)
                || (partial && !old)
            {
                continue;
            }
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            used = used.saturating_sub(meta.len());
        }
        if used.saturating_add(incoming) > cap {
            return Err(
                "CACHE_BUSY: Wait for current previews or clear disposable cache files".into(),
            );
        }
        Ok(used)
    }
    pub(crate) fn reserve(
        &mut self,
        directory: &Path,
        token: &str,
        bytes: u64,
    ) -> Result<u64, String> {
        let p = pool_in(self, directory);
        if self.clearing.keys().any(|d| directory.starts_with(d)) {
            return Err("CANCELLED".into());
        }
        if bytes > limit(&p) {
            return Err(
                "PREVIEW_TOO_LARGE: Increase the cache limit or keep the file offline".into(),
            );
        }
        self.prune(directory, limit(&p), bytes, None)?;
        let epoch = self.epoch(directory);
        self.reservations.insert(token.into(), (p, bytes));
        Ok(epoch)
    }
}
pub(crate) struct Clearing(PathBuf);
impl Clearing {
    pub(crate) fn new(directory: &Path) -> Self {
        let mut s = state();
        let pool = pool_in(&s, directory);
        *s.epochs.entry(pool).or_default() += 1;
        *s.clearing.entry(directory.into()).or_default() += 1;
        Self(directory.into())
    }
}
impl Drop for Clearing {
    fn drop(&mut self) {
        let mut s = state();
        if let Some(n) = s.clearing.get_mut(&self.0) {
            *n -= 1;
            if *n == 0 {
                s.clearing.remove(&self.0);
            }
        }
    }
}
pub(crate) fn active_paths() -> HashSet<PathBuf> {
    state().paths.keys().cloned().collect()
}

#[cfg(feature = "native-e2e")]
pub(crate) fn busy() -> bool {
    STATE
        .get_or_init(|| Mutex::new(State::default()))
        .try_lock()
        .is_err()
}
