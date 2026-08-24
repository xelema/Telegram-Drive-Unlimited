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
