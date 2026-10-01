use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub relative_path: String,
    pub hash: String,
    pub file_size: u64,
    pub modified_at: Option<i64>,
    pub message_id: Option<i32>,
}

pub type FileTree = BTreeMap<String, TreeEntry>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncedEntry {
    pub relative_path: String,
    pub local_hash: Option<String>,
    pub remote_hash: Option<String>,
    pub file_size: u64,
    pub local_mtime: Option<i64>,
    pub remote_date: Option<i64>,
    pub message_id: Option<i32>,
    pub sync_status: String,
}

pub type SyncedTree = BTreeMap<String, SyncedEntry>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum SyncOperation {
    Upload {
        relative_path: String,
        local: TreeEntry,
    },
    Download {
        relative_path: String,
        remote: TreeEntry,
        keep_both: bool,
        expected_local_hash: Option<String>,
    },
    DeleteLocal {
        relative_path: String,
        expected_local_hash: String,
    },
    DeleteRemote {
        relative_path: String,
        message_id: i32,
        expected_remote_hash: String,
    },
    Conflict {
        relative_path: String,
    },
    Skip {
        relative_path: String,
    },
}

impl SyncOperation {
    pub fn path(&self) -> &str {
        match self {
            Self::Upload { relative_path, .. }
            | Self::Download { relative_path, .. }
            | Self::DeleteLocal { relative_path, .. }
            | Self::DeleteRemote { relative_path, .. }
            | Self::Conflict { relative_path }
            | Self::Skip { relative_path } => relative_path,
        }
    }

    pub fn is_delete(&self) -> bool {
        matches!(self, Self::DeleteLocal { .. } | Self::DeleteRemote { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    MassDeletionProtection { deletes: usize, synced_files: usize },
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MassDeletionProtection { deletes, synced_files } => write!(
                formatter,
                "mass deletion protection stopped {deletes} deletes across {synced_files} synced files"
            ),
        }
    }
}

pub fn plan(
    local: &FileTree,
    remote: &FileTree,
    synced: &SyncedTree,
) -> Result<Vec<SyncOperation>, SyncError> {
    let operations = plan_unchecked(local, remote, synced);
    enforce_mass_deletion(operations, synced)
}

pub fn plan_for_direction(
    local: &FileTree,
    remote: &FileTree,
    synced: &SyncedTree,
    direction: &str,
) -> Result<Vec<SyncOperation>, SyncError> {
    plan_for_policy(local, remote, synced, direction, true)
}

pub fn plan_for_policy(
    local: &FileTree,
    remote: &FileTree,
    synced: &SyncedTree,
    direction: &str,
    propagate_deletions: bool,
) -> Result<Vec<SyncOperation>, SyncError> {
    enforce_mass_deletion(
        operations_for_policy(local, remote, synced, direction, propagate_deletions),
        synced,
    )
}

/// The preview retains every proposed operation even when the deletion guard
/// would prevent execution. No mutation is performed by planning.
pub fn operations_for_policy(
    local: &FileTree,
    remote: &FileTree,
    synced: &SyncedTree,
    direction: &str,
    propagate_deletions: bool,
) -> Vec<SyncOperation> {
    plan_unchecked(local, remote, synced)
        .into_iter()
        .map(|operation| {
            // A user-selected conflict resolution is a single explicit action,
            // even when it goes against the automatic direction of the pair.
            if synced.get(operation.path()).is_some_and(|previous| {
                matches!(
                    previous.sync_status.as_str(),
                    "keep_local" | "keep_remote" | "keep_both"
                )
            }) {
                return operation;
            }
            match (direction, operation) {
                // If the remote copy was deleted in upload-only mode, restore it
                // from local instead of deleting the source that owns this pair.
                ("upload_only", SyncOperation::DeleteLocal { relative_path, .. }) => {
                    match local.get(&relative_path) {
                        Some(local) => SyncOperation::Upload {
                            relative_path,
                            local: local.clone(),
                        },
                        None => SyncOperation::Skip { relative_path },
                    }
                }
                ("upload_only", SyncOperation::Download { relative_path, .. }) => {
                    SyncOperation::Skip { relative_path }
                }
                ("upload_only", SyncOperation::Conflict { relative_path })
                    if local.contains_key(&relative_path)
                        && !remote.contains_key(&relative_path) =>
                {
                    SyncOperation::Upload {
                        local: local[&relative_path].clone(),
                        relative_path,
                    }
                }
                // The mirror image applies in download-only mode: a local deletion
                // restores from Telegram rather than deleting Telegram's source.
                ("download_only", SyncOperation::DeleteRemote { relative_path, .. }) => {
                    match remote.get(&relative_path) {
                        Some(remote) => SyncOperation::Download {
                            relative_path,
                            remote: remote.clone(),
                            keep_both: false,
                            expected_local_hash: None,
                        },
                        None => SyncOperation::Skip { relative_path },
                    }
                }
                ("download_only", SyncOperation::Upload { relative_path, .. }) => {
                    SyncOperation::Skip { relative_path }
                }
                ("download_only", SyncOperation::Conflict { relative_path })
                    if remote.contains_key(&relative_path)
                        && !local.contains_key(&relative_path) =>
                {
                    SyncOperation::Download {
                        remote: remote[&relative_path].clone(),
                        relative_path,
                        keep_both: false,
                        expected_local_hash: None,
                    }
                }
                (_, operation) => operation,
            }
        })
        .map(|operation| {
            if !propagate_deletions && operation.is_delete() {
                SyncOperation::Skip {
                    relative_path: operation.path().to_string(),
                }
            } else {
                operation
            }
        })
        .collect()
}

fn plan_unchecked(local: &FileTree, remote: &FileTree, synced: &SyncedTree) -> Vec<SyncOperation> {
    let paths: BTreeSet<_> = local
        .keys()
        .chain(remote.keys())
        .chain(synced.keys())
        .cloned()
        .collect();
    let mut operations = Vec::new();

    for relative_path in paths {
        let local_entry = local.get(&relative_path);
        let remote_entry = remote.get(&relative_path);
        let synced_entry = synced.get(&relative_path);
        if let Some(previous) = synced_entry {
            let resolution = match previous.sync_status.as_str() {
                "keep_local" => Some(local_entry.map(|local| SyncOperation::Upload {
                    relative_path: relative_path.clone(),
                    local: local.clone(),
                })),
                "keep_remote" => Some(remote_entry.map(|remote| SyncOperation::Download {
                    relative_path: relative_path.clone(),
                    remote: remote.clone(),
                    keep_both: false,
                    expected_local_hash: local_entry.map(|local| local.hash.clone()),
                })),
                "keep_both" => Some(match (local_entry, remote_entry) {
                    (_, Some(remote)) => Some(SyncOperation::Download {
                        relative_path: relative_path.clone(),
                        remote: remote.clone(),
                        keep_both: local_entry.is_some(),
                        expected_local_hash: None,
                    }),
                    (Some(local), None) => Some(SyncOperation::Upload {
                        relative_path: relative_path.clone(),
                        local: local.clone(),
                    }),
                    (None, None) => None,
                }),
                _ => None,
            };
            if let Some(resolution) = resolution {
                if local_entry.is_some() || remote_entry.is_some() {
                    operations.push(resolution.unwrap_or_else(|| SyncOperation::Conflict {
                        relative_path: relative_path.clone(),
                    }));
                }
                continue;
            }
        }
        if synced_entry.is_some_and(|previous| previous.sync_status == "conflict")
            && (local_entry.is_some() || remote_entry.is_some())
        {
            operations.push(SyncOperation::Conflict { relative_path });
            continue;
        }
        let operation = match (local_entry, remote_entry, synced_entry) {
            (Some(local), None, None) => SyncOperation::Upload {
                relative_path: relative_path.clone(),
                local: local.clone(),
            },
            (None, Some(remote), None) => SyncOperation::Download {
                relative_path: relative_path.clone(),
                remote: remote.clone(),
                keep_both: false,
                expected_local_hash: None,
            },
            (Some(local), Some(remote), None) if local.hash == remote.hash => SyncOperation::Skip {
                relative_path: relative_path.clone(),
            },
            (Some(_), Some(_), None) => SyncOperation::Conflict {
                relative_path: relative_path.clone(),
            },
            (Some(local), None, Some(previous)) if previous.remote_hash.is_none() => {
                if previous.sync_status == "skipped"
                    && previous.local_hash.as_deref() == Some(local.hash.as_str())
                {
                    SyncOperation::Skip {
                        relative_path: relative_path.clone(),
                    }
                } else {
                    SyncOperation::Upload {
                        relative_path: relative_path.clone(),
                        local: local.clone(),
                    }
                }
            }
            (Some(local), None, Some(previous))
                if previous.local_hash.as_deref() != Some(local.hash.as_str()) =>
            {
                SyncOperation::Conflict {
                    relative_path: relative_path.clone(),
                }
            }
            (Some(local), None, Some(_)) => SyncOperation::DeleteLocal {
                relative_path: relative_path.clone(),
                expected_local_hash: local.hash.clone(),
            },
            (None, Some(remote), Some(previous)) if previous.local_hash.is_none() => {
                SyncOperation::Download {
                    relative_path: relative_path.clone(),
                    remote: remote.clone(),
                    keep_both: false,
                    expected_local_hash: None,
                }
            }
            (None, Some(remote), Some(previous))
                if previous.remote_hash.as_deref() != Some(remote.hash.as_str()) =>
            {
                SyncOperation::Conflict {
                    relative_path: relative_path.clone(),
                }
            }
            (None, Some(remote), Some(_)) => remote.message_id.map_or_else(
                || SyncOperation::Conflict {
                    relative_path: relative_path.clone(),
                },
                |message_id| SyncOperation::DeleteRemote {
                    relative_path: relative_path.clone(),
                    message_id,
                    expected_remote_hash: remote.hash.clone(),
                },
            ),
            (Some(local), Some(remote), Some(previous)) => {
                let local_changed = previous.local_hash.as_deref() != Some(local.hash.as_str());
                let remote_changed = previous.remote_hash.as_deref() != Some(remote.hash.as_str());
                match (local_changed, remote_changed) {
                    (false, false) => SyncOperation::Skip {
                        relative_path: relative_path.clone(),
                    },
                    (true, false) => SyncOperation::Upload {
                        relative_path: relative_path.clone(),
                        local: local.clone(),
                    },
                    (false, true) => SyncOperation::Download {
                        relative_path: relative_path.clone(),
                        remote: remote.clone(),
                        keep_both: false,
                        expected_local_hash: Some(local.hash.clone()),
                    },
                    (true, true) if local.hash == remote.hash => SyncOperation::Skip {
                        relative_path: relative_path.clone(),
                    },
                    (true, true) => SyncOperation::Conflict {
                        relative_path: relative_path.clone(),
                    },
                }
            }
            (None, None, Some(_)) => continue,
            (None, None, None) => continue,
        };
        operations.push(operation);
    }

    operations
}

pub fn enforce_mass_deletion(
    operations: Vec<SyncOperation>,
    synced: &SyncedTree,
) -> Result<Vec<SyncOperation>, SyncError> {
    let deletes = operations
        .iter()
        .filter(|operation| operation.is_delete())
        .count();
    if !synced.is_empty() && deletes.saturating_mul(2) > synced.len() {
        return Err(SyncError::MassDeletionProtection {
            deletes,
            synced_files: synced.len(),
        });
    }
    Ok(operations)
}
