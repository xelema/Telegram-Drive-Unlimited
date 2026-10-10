//! Registry for temporary files that may be deleted through frontend commands.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

fn registry() -> &'static Mutex<HashSet<PathBuf>> {
    static REGISTRY: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn register(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Unable to register temporary artifact: {error}"))?;
    registry()
        .lock()
        .map_err(|_| "Temporary artifact registry is unavailable".to_string())?
        .insert(canonical.clone());
    Ok(canonical)
}

pub fn is_registered(path: &Path) -> Result<bool, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Unable to resolve temporary artifact: {error}"))?;
    Ok(registry()
        .lock()
        .map_err(|_| "Temporary artifact registry is unavailable".to_string())?
        .contains(&canonical))
}

pub fn delete_registered(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Unable to resolve temporary artifact: {error}"))?;
    let mut artifacts = registry()
        .lock()
        .map_err(|_| "Temporary artifact registry is unavailable".to_string())?;
    if !artifacts.remove(&canonical) {
        return Err("Refusing to delete an unregistered temporary artifact".to_string());
    }
    drop(artifacts);
    if let Err(error) = std::fs::remove_file(&canonical) {
        let _ = registry()
            .lock()
            .map(|mut entries| entries.insert(canonical.clone()));
        return Err(format!("Unable to delete temporary artifact: {error}"));
    }
    Ok(canonical)
}

/// Name of the application's private staging directory inside the system
/// temporary directory.
const STAGING_DIRECTORY: &str = "telegram-drive-staging";
/// Staging files older than this are leftovers from a crash or a cancelled
/// transfer that will not be resumed.
const STALE_STAGING_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// Directory for staging files (remote uploads, REST uploads, archive
/// previews). The shared system temporary directory is writable by every
/// local user, so files are staged in a directory only the current user can
/// enter: nobody else can pre-create a file or a symbolic link at a name the
/// application is about to write. Fails rather than fall back to the shared
/// directory when that guarantee cannot be established.
pub fn staging_root() -> std::io::Result<PathBuf> {
    staging_root_in(&std::env::temp_dir())
}

/// [`staging_root`] for an explicit parent, so the same checks can be
/// exercised against a fixture directory.
pub fn staging_root_in(parent: &Path) -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    let directory = {
        // SAFETY: `geteuid` has no preconditions and cannot fail.
        let user = unsafe { libc::geteuid() };
        parent.join(format!("{STAGING_DIRECTORY}-{user}"))
    };
    #[cfg(not(unix))]
    let directory = parent.join(STAGING_DIRECTORY);

    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    match builder.create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }

    // Never follow a link someone else may have planted at this name.
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.file_type().is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "The staging location is not a directory owned by this application",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: `geteuid` has no preconditions and cannot fail.
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "The staging directory belongs to another user",
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(directory)
}

/// Remove staging leftovers that are too old to belong to a resumable
/// transfer. Best effort: anything that cannot be inspected is left alone.
pub fn sweep_stale_staging() {
    let Ok(root) = staging_root() else {
        return;
    };
    sweep_stale_staging_in(&root, STALE_STAGING_AGE);
}

pub fn sweep_stale_staging_in(root: &Path, max_age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= max_age);
        if !stale {
            continue;
        }
        let _ = if metadata.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}
