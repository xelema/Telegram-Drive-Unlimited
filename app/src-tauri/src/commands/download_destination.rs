//! Collision decisions stay attached to the durable transfer. Publication never
//! unlinks a destination, and only an explicit Replace may overwrite one.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static PUBLICATION: Mutex<()> = Mutex::new(());
const MAX_NAMES: usize = 10_000;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadCollisionPolicy {
    #[default]
    KeepBoth,
    Skip,
    Replace,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadOutcome {
    Saved,
    Skipped,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPublication {
    pub outcome: DownloadOutcome,
    pub save_path: String,
}

impl DownloadPublication {
    fn new(outcome: DownloadOutcome, path: &Path) -> Self {
        Self {
            outcome,
            save_path: path.to_string_lossy().into_owned(),
        }
    }

    pub fn response(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|error| error.to_string())
    }
}

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

/// Canonicalize only the parent: a destination symlink is a collision, never a
/// request to overwrite its target. Case folding also protects case-sensitive
/// disks from two visually identical names queued by this application.
pub fn destination_key(path: &Path) -> Result<String, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "Download destination has no filename".to_string())?;
    let directory = parent(path)
        .canonicalize()
        .map_err(|error| format!("Download directory is unavailable: {error}"))?;
    Ok(format!(
        "{}\0{}",
        directory.to_string_lossy().to_lowercase(),
        name.to_lowercase()
    ))
}

fn sibling(path: &Path, index: usize) -> PathBuf {
    if index == 0 {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let extension = path
        .extension()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty());
    let suffix = extension
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    parent(path).join(format!("{stem} ({index}){suffix}"))
}

fn existing_names(path: &Path) -> Result<HashSet<String>, String> {
    std::fs::read_dir(parent(path))
        .map_err(|error| format!("Cannot inspect download directory: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
                .map_err(|error| format!("Cannot inspect download filename: {error}"))
        })
        .collect()
}

/// Reservations are logical queue records, not empty files left in Downloads.
/// Every policy reserves a distinct name among queued items. Skip/Replace only
/// apply to external files, so duplicate entries in one batch cannot erase one
/// another or change outcome depending on transfer completion order.
pub fn reserve_destination(
    path: &Path,
    policy: DownloadCollisionPolicy,
    reserved: &mut HashSet<String>,
) -> Result<PathBuf, String> {
    let names = if policy == DownloadCollisionPolicy::KeepBoth {
        existing_names(path)?
    } else {
        HashSet::new()
    };
    for index in 0..MAX_NAMES {
        let candidate = sibling(path, index);
        let key = destination_key(&candidate)?;
        let name = candidate
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        if !reserved.contains(&key) && !names.contains(&name) {
            reserved.insert(key);
            return Ok(candidate);
        }
    }
    Err("Could not reserve a unique download filename".into())
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
))]
fn rename_without_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let destination = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
    // Both paths are NUL-terminated and remain live for the syscall. These
    // flags perform the existence test and rename in one filesystem operation.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn move_file(source: &Path, destination: &Path, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut flags = windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;
    if replace {
        flags |= windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
    }
    let result = unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            flags,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn rename_without_replace(source: &Path, destination: &Path) -> io::Result<()> {
    move_file(source, destination, false)
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android",
    target_os = "windows"
)))]
fn rename_without_replace(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::hard_link(source, destination)?;
    // Publication succeeded; a source cleanup error must not re-run the download.
    let _ = std::fs::remove_file(source);
    Ok(())
}

pub(crate) fn replace_download_file(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        move_file(source, destination, true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::fs::rename(source, destination)
    }
}

fn sync_parent(_path: &Path) {
    #[cfg(unix)]
    if let Err(error) =
        std::fs::File::open(parent(_path)).and_then(|directory| directory.sync_all())
    {
        // The atomic publication succeeded. Do not schedule another download.
        log::warn!("Download published but directory sync failed: {error}");
    }
}

pub fn publish(
    source: &Path,
    destination: &Path,
    policy: DownloadCollisionPolicy,
    account: Option<&crate::workspace::AccountGuard>,
) -> Result<DownloadPublication, String> {
    publish_with_move(
        source,
        destination,
        policy,
        account,
        |source, destination, policy| {
            if policy == DownloadCollisionPolicy::Replace {
                replace_download_file(source, destination)
            } else {
                rename_without_replace(source, destination)
            }
        },
    )
}

fn publish_with_move<F>(
    source: &Path,
    destination: &Path,
    policy: DownloadCollisionPolicy,
    account: Option<&crate::workspace::AccountGuard>,
    mut move_file: F,
) -> Result<DownloadPublication, String>
where
    F: FnMut(&Path, &Path, DownloadCollisionPolicy) -> io::Result<()>,
{
    let _publication = PUBLICATION
        .lock()
        .map_err(|_| "Download publication lock unavailable")?;
    if let Some(account) = account {
        account.validate()?;
    }
    let names = existing_names(destination)?;
    for index in 0..MAX_NAMES {
        let candidate = sibling(destination, index);
        let collision = names.contains(
            &candidate
                .file_name()
                .ok_or("Download destination has no filename")?
                .to_string_lossy()
                .to_lowercase(),
        );
        if policy != DownloadCollisionPolicy::Replace && collision {
            if policy == DownloadCollisionPolicy::Skip {
                return Ok(DownloadPublication::new(
                    DownloadOutcome::Skipped,
                    destination,
                ));
            }
            continue;
        }
        if let Some(account) = account {
            account.validate()?;
        }
        let result = move_file(source, &candidate, policy);
        match result {
            Ok(()) => {
                sync_parent(&candidate);
                return Ok(DownloadPublication::new(DownloadOutcome::Saved, &candidate));
            }
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists
                    && policy != DownloadCollisionPolicy::Replace =>
            {
                if policy == DownloadCollisionPolicy::Skip {
                    return Ok(DownloadPublication::new(
                        DownloadOutcome::Skipped,
                        destination,
                    ));
                }
            }
            Err(error) => return Err(format!("Failed to publish verified download: {error}")),
        }
    }
    Err("Could not publish a unique download filename".into())
}

/// Skip an existing name before fetching Telegram data. Publication repeats the
/// collision decision atomically because a new file may appear during transfer.
pub async fn skip_existing_download(
    destination: PathBuf,
    policy: DownloadCollisionPolicy,
    account: Option<crate::workspace::AccountGuard>,
) -> Result<Option<DownloadPublication>, String> {
    if policy != DownloadCollisionPolicy::Skip {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || {
        let _publication = PUBLICATION
            .lock()
            .map_err(|_| "Download publication lock unavailable")?;
        if let Some(account) = account.as_ref() {
            account.validate()?;
        }
        let names = existing_names(&destination)?;
        let name = destination
            .file_name()
            .ok_or("Download destination has no filename")?
            .to_string_lossy()
            .to_lowercase();
        Ok(names
            .contains(&name)
            .then(|| DownloadPublication::new(DownloadOutcome::Skipped, &destination)))
    })
    .await
    .map_err(|error| format!("Download collision check failed: {error}"))?
}

pub async fn publish_download_file(
    source: PathBuf,
    destination: PathBuf,
    policy: DownloadCollisionPolicy,
    account: Option<crate::workspace::AccountGuard>,
) -> Result<DownloadPublication, String> {
    tokio::task::spawn_blocking(move || publish(&source, &destination, policy, account.as_ref()))
        .await
        .map_err(|error| format!("Download publish task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("download-collision-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn default_and_invalid_policies_are_safe() {
        assert_eq!(
            DownloadCollisionPolicy::default(),
            DownloadCollisionPolicy::KeepBoth
        );
        let request: crate::commands::fs::DownloadFileRequest = serde_json::from_value(serde_json::json!({"message_id":1,"save_path":"file","folder_id":null,"transfer_id":null,"prompt_token":null})).unwrap();
        assert_eq!(request.collision_policy, DownloadCollisionPolicy::KeepBoth);
        assert!(serde_json::from_str::<DownloadCollisionPolicy>("\"overwrite\"").is_err());
    }

    #[test]
    fn keeps_both_and_skips_without_changing_existing_bytes() {
        let directory = Directory::new();
        let destination = directory.file("report.txt", b"original");
        let source = directory.file("verified.part", b"downloaded");
        let saved = publish(
            &source,
            &destination,
            DownloadCollisionPolicy::KeepBoth,
            None,
        )
        .unwrap();
        assert_eq!(saved.outcome, DownloadOutcome::Saved);
        assert_eq!(
            Path::new(&saved.save_path),
            directory.0.join("report (1).txt")
        );
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        assert_eq!(std::fs::read(saved.save_path).unwrap(), b"downloaded");
        let source = directory.file("second.part", b"second");
        let skipped = publish(&source, &destination, DownloadCollisionPolicy::Skip, None).unwrap();
        assert_eq!(skipped.outcome, DownloadOutcome::Skipped);
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        assert_eq!(std::fs::read(&source).unwrap(), b"second");
    }

    #[test]
    fn replacement_is_explicit_and_failed_publication_preserves_both_files() {
        let directory = Directory::new();
        let destination = directory.file("report.txt", b"original");
        assert!(publish(
            &directory.0.join("missing.part"),
            &destination,
            DownloadCollisionPolicy::Replace,
            None
        )
        .is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        let source = directory.file("verified.part", b"replacement");
        let directory_destination = directory.0.join("not-a-file");
        std::fs::create_dir(&directory_destination).unwrap();
        assert!(publish(
            &source,
            &directory_destination,
            DownloadCollisionPolicy::Replace,
            None
        )
        .is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"replacement");
        assert!(directory_destination.is_dir());
        publish(
            &source,
            &destination,
            DownloadCollisionPolicy::Replace,
            None,
        )
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"replacement");
        assert!(!source.exists());
    }

    #[test]
    fn atomic_no_replace_cannot_clobber_a_file_created_after_reservation() {
        let directory = Directory::new();
        let desired = directory.0.join("report.txt");
        let reserved = reserve_destination(
            &desired,
            DownloadCollisionPolicy::KeepBoth,
            &mut HashSet::new(),
        )
        .unwrap();
        let source = directory.file("verified.part", b"downloaded");
        std::fs::write(&reserved, b"appeared later").unwrap();
        assert_eq!(
            rename_without_replace(&source, &reserved)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&reserved).unwrap(), b"appeared later");
        assert_eq!(std::fs::read(&source).unwrap(), b"downloaded");
        let saved = publish(&source, &reserved, DownloadCollisionPolicy::KeepBoth, None).unwrap();
        assert_eq!(std::fs::read(saved.save_path).unwrap(), b"downloaded");
        assert_eq!(std::fs::read(reserved).unwrap(), b"appeared later");
    }

    #[test]
    fn batch_names_include_case_collisions_and_existing_numbered_names() {
        let directory = Directory::new();
        directory.file("report.txt", b"original");
        directory.file("REPORT (1).TXT", b"another");
        let mut reservations = HashSet::new();
        let a = reserve_destination(
            &directory.0.join("report.txt"),
            DownloadCollisionPolicy::KeepBoth,
            &mut reservations,
        )
        .unwrap();
        let b = reserve_destination(
            &directory.0.join("REPORT.txt"),
            DownloadCollisionPolicy::KeepBoth,
            &mut reservations,
        )
        .unwrap();
        assert_eq!(a.file_name().unwrap(), "report (2).txt");
        assert_eq!(b.file_name().unwrap(), "REPORT (3).txt");
        assert!(!a.exists());
        assert!(!b.exists());
        for policy in [
            DownloadCollisionPolicy::Skip,
            DownloadCollisionPolicy::Replace,
        ] {
            let mut reservations = HashSet::new();
            let a = reserve_destination(&directory.0.join("same.txt"), policy, &mut reservations)
                .unwrap();
            let b = reserve_destination(&directory.0.join("SAME.txt"), policy, &mut reservations)
                .unwrap();
            assert_ne!(destination_key(&a).unwrap(), destination_key(&b).unwrap());
        }
    }

    #[test]
    fn concurrent_verified_downloads_publish_distinct_complete_files() {
        let directory = Directory::new();
        let destination = directory.file("same.txt", b"external");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let source = directory.file(
                    &format!("source-{index}.part"),
                    format!("download-{index}").as_bytes(),
                );
                let destination = destination.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    publish(
                        &source,
                        &destination,
                        DownloadCollisionPolicy::KeepBoth,
                        None,
                    )
                    .unwrap()
                })
            })
            .collect();
        let paths: HashSet<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().save_path)
            .collect();
        assert_eq!(paths.len(), 8);
        let contents: HashSet<_> = paths
            .iter()
            .map(|path| std::fs::read_to_string(path).unwrap())
            .collect();
        assert_eq!(
            contents,
            (0..8).map(|index| format!("download-{index}")).collect()
        );
        assert_eq!(std::fs::read(destination).unwrap(), b"external");
    }

    #[cfg(unix)]
    #[test]
    fn parent_aliases_share_reservations_and_destination_symlinks_are_never_followed() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let alias = directory.0.join("alias");
        symlink(&directory.0, &alias).unwrap();
        let mut reserved = HashSet::new();
        let a = reserve_destination(
            &directory.0.join("same.txt"),
            DownloadCollisionPolicy::KeepBoth,
            &mut reserved,
        )
        .unwrap();
        let b = reserve_destination(
            &alias.join("SAME.txt"),
            DownloadCollisionPolicy::KeepBoth,
            &mut reserved,
        )
        .unwrap();
        assert_ne!(destination_key(&a).unwrap(), destination_key(&b).unwrap());
        let target = directory.file("target.txt", b"target");
        let link = directory.0.join("link.txt");
        symlink(&target, &link).unwrap();
        let source = directory.file("source.part", b"downloaded");
        publish(&source, &link, DownloadCollisionPolicy::KeepBoth, None).unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let source = directory.file("source.part", b"replacement");
        publish(&source, &link, DownloadCollisionPolicy::Replace, None).unwrap();
        assert!(!std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"target");
        assert_eq!(std::fs::read(&link).unwrap(), b"replacement");
    }
    #[test]
    fn disk_full_publication_failure_preserves_existing_and_verified_contents() {
        let directory = Directory::new();
        let destination = directory.file("existing.txt", b"original");
        let source = directory.file("verified.part", b"verified bytes");
        for policy in [
            DownloadCollisionPolicy::KeepBoth,
            DownloadCollisionPolicy::Replace,
        ] {
            let result = publish_with_move(&source, &destination, policy, None, |_, _, _| {
                Err(io::Error::from_raw_os_error(libc::ENOSPC))
            });
            assert!(result.is_err());
            assert_eq!(std::fs::read(&destination).unwrap(), b"original");
            assert_eq!(std::fs::read(&source).unwrap(), b"verified bytes");
        }
    }
    #[tokio::test]
    async fn skip_existing_finishes_without_a_downloaded_source() {
        let directory = Directory::new();
        let destination = directory.file("original.txt", b"existing");
        let skipped =
            skip_existing_download(destination.clone(), DownloadCollisionPolicy::Skip, None)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(skipped.outcome, DownloadOutcome::Skipped);
        assert_eq!(std::fs::read(destination).unwrap(), b"existing");
        assert!(skip_existing_download(
            directory.0.join("new.txt"),
            DownloadCollisionPolicy::Skip,
            None
        )
        .await
        .unwrap()
        .is_none());
    }
    #[tokio::test]
    async fn account_change_before_publication_preserves_existing_file_and_staging() {
        use grammers_session::{storages::SqliteSession, types::PeerInfo, Session};
        let directory = Directory::new();
        let sign_in = |owner| {
            for file in [
                "telegram.session",
                "telegram.session-wal",
                "telegram.session-shm",
            ] {
                let _ = std::fs::remove_file(directory.0.join(file));
            }
            let session = SqliteSession::open(directory.0.join("telegram.session")).unwrap();
            session.cache_peer(&PeerInfo::User {
                id: owner,
                auth: None,
                bot: Some(false),
                is_self: Some(true),
            });
        };
        sign_in(101);
        let account = crate::workspace::AccountGuard::open(&directory.0, Some("101")).unwrap();
        let destination = directory.file("original.txt", b"original");
        let source = directory.file("verified.part", b"downloaded");
        sign_in(202);
        assert!(publish(
            &source,
            &destination,
            DownloadCollisionPolicy::Replace,
            Some(&account)
        )
        .unwrap_err()
        .contains("ACCOUNT_CHANGED"));
        assert!(skip_existing_download(
            destination.clone(),
            DownloadCollisionPolicy::Skip,
            Some(account)
        )
        .await
        .unwrap_err()
        .contains("ACCOUNT_CHANGED"));
        assert_eq!(std::fs::read(destination).unwrap(), b"original");
        assert_eq!(std::fs::read(source).unwrap(), b"downloaded");
    }
}
