//! Exact files produced by the application, bound to their account and identity.
use crate::workspace::{store::Store, AccountGuard};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct StableId {
    volume: u64,
    id: [u8; 16],
}
impl StableId {
    fn usable(&self) -> bool {
        self.volume != 0 && self.id.iter().any(|byte| *byte != 0)
    }
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct Identity {
    length: u64,
    modified_nanos: u128,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[serde(default)]
    changed_nanos: Option<i128>,
    #[serde(default)]
    stable: Option<StableId>,
}
impl Identity {
    fn usable(&self) -> bool {
        self.length != 0
            && self.modified_nanos != 0
            && self.changed_nanos.is_some_and(|value| value != 0)
            && self.stable.as_ref().is_some_and(StableId::usable)
    }
    // Old records still participate in strict content verification.
    fn strict_matches(&self, current: &Self) -> bool {
        self.length == current.length
            && self.modified_nanos == current.modified_nanos
            && {
                #[cfg(unix)]
                {
                    self.device == current.device && self.inode == current.inode
                }
                #[cfg(not(unix))]
                {
                    true
                }
            }
            && self
                .changed_nanos
                .is_none_or(|value| Some(value) == current.changed_nanos)
            && self
                .stable
                .as_ref()
                .is_none_or(|value| Some(value) == current.stable.as_ref())
    }
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct ReuseContext {
    epoch: String,
    session: StableId,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct Access {
    cache: PathBuf,
    proof: crate::legacy_external::Proof,
}
impl Access {
    fn check(&self, account: &AccountGuard, path: &Path) -> Result<(), String> {
        if !self.proof.check(account, &self.cache, path)? {
            return Err("FILE_OPEN_REFUSED: Cache record changed".into());
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct ProducedFile {
    canonical: PathBuf,
    identity: Identity,
    digest: String,
    #[serde(default)]
    reuse: Option<ReuseContext>,
    #[serde(default)]
    access: Option<Access>,
}
static REUSE_DISABLED: AtomicBool = AtomicBool::new(false);
const EPOCH_KIND: &str = "external-open-reuse-epoch-v1";
fn context(account: &AccountGuard, store: &Store) -> Result<Option<ReuseContext>, String> {
    if REUSE_DISABLED.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let Some(epoch) = store.record::<String>(EPOCH_KIND, "identity")? else {
        return Ok(None);
    };
    let session = File::open(account.root.join("telegram.session")).map_err(|e| e.to_string())?;
    Ok(file_identity(&session)?
        .stable
        .filter(StableId::usable)
        .map(|session| ReuseContext { epoch, session }))
}
fn ensure_context(account: &AccountGuard, store: &Store) -> Result<Option<ReuseContext>, String> {
    store.transaction(|| {
        if store.record::<String>(EPOCH_KIND, "identity")?.is_none() {
            store.put_record(EPOCH_KIND, "identity", &uuid::Uuid::new_v4().to_string())?;
        }
        account.validate()
    })?;
    context(account, store)
}
/// Fence even pinned survivors, without walking or rewriting produced-file records.
pub(crate) fn invalidate_account(root: &Path, owner: i64) -> Result<(), String> {
    let result = Store::open(root, owner).and_then(|store| {
        store.put_record(EPOCH_KIND, "identity", &uuid::Uuid::new_v4().to_string())
    });
    if result.is_err() {
        REUSE_DISABLED.store(true, Ordering::SeqCst);
    }
    result
}
pub(crate) fn invalidate_all_accounts(root: &Path) -> Result<(), String> {
    let directory = root.join("workspace");
    if !directory.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let Some(owner) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i64>().ok())
            .filter(|owner| *owner > 0)
        else {
            continue;
        };
        if entry.path().join("workspace.db").is_file() {
            invalidate_account(root, owner)?;
        }
    }
    Ok(())
}
fn location(path: &Path) -> Result<(PathBuf, PathBuf, Identity), String> {
    let (absolute, canonical, file, identity) = opened_location(path)?;
    drop(file);
    Ok((absolute, canonical, identity))
}
fn opened_location(path: &Path) -> Result<(PathBuf, PathBuf, File, Identity), String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    if absolute
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("FILE_OPEN_REFUSED: Parent traversal".into());
    }
    let metadata = std::fs::symlink_metadata(&absolute).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("FILE_OPEN_REFUSED: File is not a regular produced file".into());
    }
    let canonical = absolute.canonicalize().map_err(|e| e.to_string())?;
    let file = File::open(&canonical).map_err(|e| e.to_string())?;
    let identity = file_identity(&file)?;
    verify_location(&absolute, &canonical, &file, &identity)?;
    Ok((absolute, canonical, file, identity))
}
fn verify_location(
    path: &Path,
    canonical: &Path,
    file: &File,
    identity: &Identity,
) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file()
        || path.canonicalize().map_err(|e| e.to_string())? != canonical
        || file_identity(file)? != *identity
    {
        return Err("FILE_OPEN_REFUSED: File changed before opening".into());
    }
    let current = File::open(path).map_err(|e| e.to_string())?;
    if file_identity(&current)? != *identity {
        return Err("FILE_OPEN_REFUSED: Path no longer names the authenticated file".into());
    }
    Ok(())
}
fn file_identity(file: &File) -> Result<Identity, String> {
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("FILE_OPEN_REFUSED: Opened file is not regular".into());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    let mut identity = Identity {
        length: metadata.len(),
        modified_nanos: metadata
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        changed_nanos: None,
        stable: None,
    };
    #[cfg(unix)]
    {
        let mut id = [0u8; 16];
        id[..8].copy_from_slice(&metadata.ino().to_le_bytes());
        identity.stable = Some(StableId {
            volume: metadata.dev(),
            id,
        });
        identity.changed_nanos =
            Some(i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec()));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::*;
        let handle = file.as_raw_handle();
        let mut info = std::mem::MaybeUninit::<FILE_ID_INFO>::uninit();
        // Output structures are read only after the live handle's API succeeds.
        if unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } != 0
        {
            let info = unsafe { info.assume_init() };
            identity.stable = Some(StableId {
                volume: info.VolumeSerialNumber,
                id: info.FileId.Identifier,
            });
        } else {
            let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
            if unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) } != 0 {
                let info = unsafe { info.assume_init() };
                let mut id = [0u8; 16];
                id[..8].copy_from_slice(
                    &((u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow))
                        .to_le_bytes(),
                );
                identity.stable = Some(StableId {
                    volume: info.dwVolumeSerialNumber.into(),
                    id,
                });
            }
        }
        let mut basic = std::mem::MaybeUninit::<FILE_BASIC_INFO>::uninit();
        if unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                basic.as_mut_ptr().cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } != 0
        {
            let basic = unsafe { basic.assume_init() };
            identity.changed_nanos = Some(i128::from(basic.ChangeTime) * 100);
            identity.modified_nanos =
                u128::try_from((i128::from(basic.LastWriteTime) - 116_444_736_000_000_000) * 100)
                    .unwrap_or(0);
        }
    }
    Ok(identity)
}
fn reusable_filesystem(file: &File, path: &Path) -> bool {
    #[cfg(feature = "native-e2e")]
    if NO_REUSE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&path.to_path_buf())
    {
        return false;
    }
    let _ = path;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // fstatfs inspects the same retained file, without following a new path.
        if unsafe { libc::fstatfs(file.as_raw_fd(), info.as_mut_ptr()) } != 0 {
            return false;
        }
        let info = unsafe { info.assume_init() };
        info.f_fstypename[..5] == [97, 112, 102, 115, 0]
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::*;
        let mut name = [0u16; 32];
        // Unknown/remote volumes and failed capability queries always hash.
        if unsafe {
            GetVolumeInformationByHandleW(
                file.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                name.as_mut_ptr(),
                name.len() as u32,
            )
        } == 0
        {
            return false;
        }
        let name = String::from_utf16_lossy(
            &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
        );
        name == "NTFS" || name == "ReFS"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = file;
        false
    }
}
fn key(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))
}
fn digest(file: &mut File) -> Result<String, String> {
    #[cfg(feature = "native-e2e")]
    wait_gate(&FILE_GATE)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        #[cfg(feature = "native-e2e")]
        HASHED_BYTES.fetch_add(count as u64, Ordering::SeqCst);
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// Call only after successful production/publication and existing protection checks.
pub(crate) fn register(account: &AccountGuard, path: &Path) -> Result<(), String> {
    register_checked(account, path, || Ok(()), false, None)
}
fn register_checked(
    account: &AccountGuard,
    path: &Path,
    check: impl Fn() -> Result<(), String>,
    legacy: bool,
    access: Option<Access>,
) -> Result<(), String> {
    account.validate()?;
    check()?;
    let (absolute, canonical, mut file, identity) = opened_location(path)?;
    let store = Store::open(&account.root, account.owner)?;
    let record_key = key(&absolute);
    let reuse = ensure_context(account, &store)?;
    if store
        .record::<ProducedFile>("external-produced-v1", &record_key)?
        .is_some_and(|saved| {
            saved.canonical == canonical
                && saved.identity == identity
                && saved.reuse == reuse
                && saved.access == access
        })
    {
        return account.validate();
    }
    let digest = digest(&mut file)?;
    verify_location(&absolute, &canonical, &file, &identity)?;
    store.transaction(|| {
        account.validate()?;
        check()?;
        if context(account, &store)? != reuse {
            return Err("FILE_OPEN_REFUSED: Cache invalidated".into());
        }
        if let Some(access) = &access {
            access.check(account, &canonical)?;
        }
        store.put_record(
            "external-produced-v1",
            &record_key,
            &ProducedFile {
                canonical,
                identity,
                digest,
                reuse,
                access,
            },
        )?;
        if legacy {
            store.put_record("external-cache-migration-v1", &record_key, &true)?;
        }
        account.validate()
    })
}
pub(crate) fn validate_lease(account: &AccountGuard, path: &Path) -> Result<ValidatedFile, String> {
    validate_file(account, path, None, false)
}
fn managed_path(account: &AccountGuard, cache: &Path, path: &Path) -> Result<bool, String> {
    let root = account.root.canonicalize().map_err(|e| e.to_string())?;
    let in_cache = match cache.canonicalize() {
        Ok(base) => path.starts_with(base),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    Ok(in_cache
        || path.starts_with(root.join("workspace"))
        || path.starts_with(root.join("thumbnails")))
}
fn validate_file(
    account: &AccountGuard,
    path: &Path,
    external_cache: Option<&Path>,
    reuse_identity: bool,
) -> Result<ValidatedFile, String> {
    account.validate()?;
    let (absolute, canonical, mut file, identity) = opened_location(path)?;
    let store = Store::open(&account.root, account.owner)?;
    let record_key = key(&absolute);
    let original = store
        .record::<ProducedFile>("external-produced-v1", &record_key)?
        .ok_or("FILE_OPEN_REFUSED: File was not produced by this application")?;
    if original.canonical != canonical {
        return Err("FILE_OPEN_REFUSED: Produced file was replaced".into());
    }
    let mut record = original.clone();
    if let Some(cache) = external_cache {
        if record.access.is_none() {
            record.access = crate::legacy_external::identify_registered(
                account, cache, &canonical,
            )?
            .map(|proof| Access {
                cache: cache.into(),
                proof,
            });
            if record.access.is_none() && managed_path(account, cache, &canonical)? {
                return Err("FILE_OPEN_REFUSED: Cache record is no longer eligible".into());
            }
        }
        if let Some(access) = &record.access {
            access.check(account, &canonical)?;
        }
    }
    if !reuse_identity && !original.identity.strict_matches(&identity) {
        return Err("FILE_OPEN_REFUSED: Produced file was replaced or modified".into());
    }
    let reuse = ensure_context(account, &store)?;
    let skip = reuse_identity
        && external_cache.is_some()
        && identity.usable()
        && reusable_filesystem(&file, &canonical)
        && original.identity == identity
        && original.reuse.is_some()
        && original.reuse == reuse
        && original.access == record.access;
    if !skip && record.digest != digest(&mut file)? {
        return Err("FILE_OPEN_REFUSED: Produced file was replaced or modified".into());
    }
    verify_location(&absolute, &canonical, &file, &identity)?;
    store.transaction(|| {
        account.validate()?;
        if store
            .record::<ProducedFile>("external-produced-v1", &record_key)?
            .as_ref()
            != Some(&original)
            || context(account, &store)? != reuse
        {
            return Err("FILE_OPEN_REFUSED: Registration or cache changed".into());
        }
        if external_cache.is_some() {
            if let Some(access) = &record.access {
                access.check(account, &canonical)?;
            }
            record.identity = identity.clone();
            record.reuse = reuse.clone();
            if record != original {
                store.put_record("external-produced-v1", &record_key, &record)?;
            }
        }
        verify_location(&absolute, &canonical, &file, &identity)?;
        account.validate()
    })?;
    #[cfg(feature = "native-e2e")]
    wait_gate(&VALIDATED_GATE)?;
    Ok(ValidatedFile {
        path: canonical,
        identity,
        fingerprint: record.digest,
        file,
        reuse,
        access: external_cache.and(record.access),
    })
}
static FILE_IO_SLOTS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = FILE_IO_SLOTS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "File workers stopped")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) async fn register_async(account: AccountGuard, path: PathBuf) -> Result<(), String> {
    blocking(move || register(&account, &path)).await
}
pub(crate) async fn register_cache_async(
    account: AccountGuard,
    path: PathBuf,
    cache: PathBuf,
    key: String,
    media_identity: String,
) -> Result<(), String> {
    blocking(move || {
        register_checked(
            &account,
            &path,
            || Ok(()),
            false,
            Some(Access {
                cache,
                proof: crate::legacy_external::Proof::produced_cache(
                    key,
                    &path,
                    std::fs::metadata(&path).map_err(|e| e.to_string())?.len(),
                    media_identity,
                )?,
            }),
        )
    })
    .await
}
pub(crate) struct ValidatedFile {
    pub(crate) fingerprint: String,
    path: PathBuf,
    identity: Identity,
    file: File,
    reuse: Option<ReuseContext>,
    access: Option<Access>,
}
impl ValidatedFile {
    pub(crate) fn checked(&self, account: &AccountGuard) -> Result<PathBuf, String> {
        account.validate()?;
        verify_location(&self.path, &self.path, &self.file, &self.identity)?;
        if let Some(access) = &self.access {
            access.check(account, &self.path)?;
        }
        if context(account, &Store::open(&account.root, account.owner)?)? != self.reuse {
            return Err("FILE_OPEN_REFUSED: Cache invalidated before launch".into());
        }
        account.validate()?;
        Ok(self.path.clone())
    }
}
static MIGRATIONS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, std::sync::Weak<std::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
fn migration_lock(path: &Path) -> std::sync::Arc<std::sync::Mutex<()>> {
    let mut locks = MIGRATIONS.lock().unwrap_or_else(|e| e.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(std::sync::Weak::upgrade) {
        return lock;
    }
    let lock = std::sync::Arc::new(std::sync::Mutex::new(()));
    locks.insert(path.to_path_buf(), std::sync::Arc::downgrade(&lock));
    lock
}
/// Lazily adopt only recorded private legacy cache files; recheck proofs on every open.
pub(crate) async fn open_async(
    account: AccountGuard,
    cache: PathBuf,
    path: PathBuf,
) -> Result<ValidatedFile, String> {
    resolve_retained(account, cache, path, (), || Ok(()), true).await
}
pub(crate) async fn verify_retained(
    account: AccountGuard,
    cache: PathBuf,
    path: PathBuf,
    lease: impl Send + 'static,
    preflight: impl Fn() -> Result<(), String> + Send + 'static,
) -> Result<ValidatedFile, String> {
    resolve_retained(account, cache, path, lease, preflight, false).await
}
async fn resolve_retained(
    account: AccountGuard,
    cache: PathBuf,
    path: PathBuf,
    lease: impl Send + 'static,
    preflight: impl Fn() -> Result<(), String> + Send + 'static,
    reuse_identity: bool,
) -> Result<ValidatedFile, String> {
    blocking(move || {
        let _lease = lease;
        preflight()?;
        let (absolute, _, _) = location(&path)?;
        let record_key = key(&absolute);
        let store = Store::open(&account.root, account.owner)?;
        if store
            .record::<ProducedFile>("external-produced-v1", &record_key)?
            .is_none()
        {
            let lock = migration_lock(&absolute);
            let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            if store
                .record::<ProducedFile>("external-produced-v1", &record_key)?
                .is_none()
            {
                if store
                    .record::<bool>("external-cache-migration-v1", &record_key)?
                    .is_some()
                {
                    return Err(
                        "FILE_OPEN_REFUSED: Previously migrated registration is missing".into(),
                    );
                }
                let proof = crate::legacy_external::identify(&account, &cache, &absolute)?
                    .ok_or("FILE_OPEN_REFUSED: File has no eligible private cache record")?;
                let access = Access {
                    cache: cache.clone(),
                    proof,
                };
                register_checked(
                    &account,
                    &absolute,
                    || access.check(&account, &absolute),
                    true,
                    Some(access.clone()),
                )?;
            }
        }
        let validated = validate_file(&account, &absolute, Some(&cache), reuse_identity)?;
        preflight()?;
        Ok(validated)
    })
    .await
}
#[cfg(feature = "native-e2e")]
pub(crate) async fn validate_async(
    account: AccountGuard,
    path: PathBuf,
) -> Result<ValidatedFile, String> {
    blocking(move || validate_lease(&account, &path)).await
}
/// Cache/HEIC verification remains strict. LRU touches invalidate external reuse.
pub(crate) async fn reuse_cached(account: AccountGuard, path: PathBuf) -> Result<bool, String> {
    reuse_cached_retained(account, path, ()).await
}
pub(crate) async fn reuse_cached_retained(
    account: AccountGuard,
    path: PathBuf,
    lease: impl Send + 'static,
) -> Result<bool, String> {
    blocking(move || {
        let _lease = lease;
        let (absolute, _, _) = location(&path)?;
        let store = Store::open(&account.root, account.owner)?;
        let record_key = key(&absolute);
        if store
            .record::<ProducedFile>("external-produced-v1", &record_key)?
            .is_none()
        {
            account.validate()?;
            return Ok(false);
        }
        let authenticated = validate_lease(&account, &path)?;
        let (absolute, canonical, before) = location(&path)?;
        if canonical != authenticated.path || before != authenticated.identity {
            return Err("FILE_OPEN_REFUSED: Cache changed after validation".into());
        }
        let mut record = store
            .record::<ProducedFile>("external-produced-v1", &record_key)?
            .ok_or("FILE_OPEN_REFUSED")?;
        let handle = std::fs::OpenOptions::new()
            .write(true)
            .open(&canonical)
            .map_err(|e| e.to_string())?;
        if file_identity(&handle)? != authenticated.identity {
            return Err("FILE_OPEN_REFUSED: Opened cache changed".into());
        }
        handle
            .set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()))
            .map_err(|e| e.to_string())?;
        let (_, after_path, after) = location(&path)?;
        let touched = file_identity(&handle)?;
        if after_path != canonical || after != touched || after.length != before.length {
            return Err("FILE_OPEN_REFUSED: Cache changed".into());
        }
        record.identity = after;
        record.reuse = None;
        store.transaction(|| {
            account.validate()?;
            if context(&account, &store)? != authenticated.reuse {
                return Err("FILE_OPEN_REFUSED: Cache invalidated".into());
            }
            store.put_record("external-produced-v1", &key(&absolute), &record)?;
            account.validate()
        })?;
        Ok(true)
    })
    .await
}
#[cfg(feature = "native-e2e")]
type FileGate = Option<(PathBuf, PathBuf)>;
#[cfg(feature = "native-e2e")]
static FILE_GATE: std::sync::Mutex<FileGate> = std::sync::Mutex::new(None);
#[cfg(feature = "native-e2e")]
static HASHED_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "native-e2e")]
pub(crate) fn test_hold(started: PathBuf, release: PathBuf) {
    *FILE_GATE.lock().unwrap_or_else(|e| e.into_inner()) = Some((started, release));
}
#[cfg(feature = "native-e2e")]
pub(crate) fn test_status() -> (usize, u64) {
    (
        FILE_IO_SLOTS.available_permits(),
        HASHED_BYTES.load(std::sync::atomic::Ordering::SeqCst),
    )
}

#[cfg(feature = "native-e2e")]
static VALIDATED_GATE: std::sync::Mutex<FileGate> = std::sync::Mutex::new(None);
#[cfg(feature = "native-e2e")]
fn wait_gate(slot: &std::sync::Mutex<FileGate>) -> Result<(), String> {
    let gate = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((started, release)) = gate {
        std::fs::write(started, b"ready").map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !release.is_file() {
            if std::time::Instant::now() >= deadline {
                return Err("File gate deadline".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    Ok(())
}
#[cfg(feature = "native-e2e")]
pub(crate) fn test_hold_validated(started: PathBuf, release: PathBuf) {
    *VALIDATED_GATE.lock().unwrap_or_else(|e| e.into_inner()) = Some((started, release));
}

#[cfg(feature = "native-e2e")]
static NO_REUSE: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
#[cfg(feature = "native-e2e")]
pub(crate) fn test_unstable_identity(path: PathBuf, unstable: bool) {
    let mut paths = NO_REUSE.lock().unwrap_or_else(|e| e.into_inner());
    paths.retain(|saved| saved != &path);
    if unstable {
        paths.push(path);
    }
}

#[cfg(feature = "native-e2e")]
pub(crate) fn test_reuse_supported(path: &Path) -> Result<bool, String> {
    let (_, canonical, file, identity) = opened_location(path)?;
    Ok(identity.usable() && reusable_filesystem(&file, &canonical))
}
