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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, hash: &str) -> TreeEntry {
        TreeEntry {
            relative_path: path.into(),
            hash: hash.into(),
            file_size: 1,
            modified_at: None,
            message_id: Some(1),
        }
    }
    fn synced(path: &str, local: &str, remote: &str) -> SyncedEntry {
        SyncedEntry {
            relative_path: path.into(),
            local_hash: Some(local.into()),
            remote_hash: Some(remote.into()),
            file_size: 1,
            local_mtime: None,
            remote_date: None,
            message_id: Some(1),
            sync_status: "synced".into(),
        }
    }

    #[test]
    fn three_tree_changes_are_directional() {
        let local = FileTree::from([
            ("a".into(), entry("a", "local-new")),
            ("b".into(), entry("b", "same")),
        ]);
        let remote = FileTree::from([
            ("a".into(), entry("a", "remote-old")),
            ("b".into(), entry("b", "remote-new")),
        ]);
        let old = SyncedTree::from([
            ("a".into(), synced("a", "local-old", "remote-old")),
            ("b".into(), synced("b", "same", "remote-old")),
        ]);
        let result = plan(&local, &remote, &old).unwrap();
        assert!(matches!(result[0], SyncOperation::Upload { .. }));
        assert!(matches!(result[1], SyncOperation::Download { .. }));
    }

    #[test]
    fn edit_versus_delete_preserves_both_sides_for_resolution() {
        let baseline = SyncedTree::from([
            ("a".into(), synced("a", "old-local", "old-remote")),
            ("b".into(), synced("b", "old-local", "old-remote")),
        ]);
        let local = FileTree::from([
            ("a".into(), entry("a", "new-local")),
            ("b".into(), entry("b", "old-local")),
        ]);
        let remote = FileTree::from([("b".into(), entry("b", "old-remote"))]);
        assert!(matches!(
            plan(&local, &remote, &baseline).unwrap()[0],
            SyncOperation::Conflict { .. }
        ));
        let local = FileTree::from([("b".into(), entry("b", "old-local"))]);
        let remote = FileTree::from([
            ("a".into(), entry("a", "new-remote")),
            ("b".into(), entry("b", "old-remote")),
        ]);
        assert!(matches!(
            plan(&local, &remote, &baseline).unwrap()[0],
            SyncOperation::Conflict { .. }
        ));
    }

    #[test]
    fn explicit_conflict_resolution_restores_an_edited_survivor_in_either_direction() {
        let local = FileTree::from([("a".into(), entry("a", "new-local"))]);
        let mut previous = synced("a", "old-local", "old-remote");
        previous.sync_status = "keep_local".into();
        let baseline = SyncedTree::from([("a".into(), previous.clone())]);
        assert!(matches!(
            plan_for_policy(&local, &FileTree::new(), &baseline, "download_only", false).unwrap()
                [0],
            SyncOperation::Upload { .. }
        ));
        previous.sync_status = "keep_remote".into();
        let baseline = SyncedTree::from([("a".into(), previous)]);
        assert!(matches!(
            plan_for_policy(&FileTree::new(), &local, &baseline, "upload_only", false).unwrap()[0],
            SyncOperation::Download { .. }
        ));
    }

    #[test]
    fn backup_policy_never_propagates_source_deletions_without_opt_in() {
        let previous = SyncedTree::from([
            ("a".into(), synced("a", "local", "remote")),
            ("b".into(), synced("b", "local", "remote")),
        ]);
        let local = FileTree::from([("b".into(), entry("b", "local"))]);
        let remote = FileTree::from([
            ("a".into(), entry("a", "remote")),
            ("b".into(), entry("b", "remote")),
        ]);
        assert!(
            plan_for_policy(&local, &remote, &previous, "upload_only", false)
                .unwrap()
                .iter()
                .all(|operation| !operation.is_delete())
        );
        assert!(matches!(
            plan_for_policy(&local, &remote, &previous, "upload_only", true).unwrap()[0],
            SyncOperation::DeleteRemote { .. }
        ));
        assert!(
            plan_for_policy(&remote, &local, &previous, "download_only", false)
                .unwrap()
                .iter()
                .all(|operation| !operation.is_delete())
        );
    }

    #[test]
    fn aborts_when_more_than_half_the_baseline_would_be_deleted() {
        let synced = SyncedTree::from([
            ("a".into(), synced("a", "1", "1")),
            ("b".into(), synced("b", "2", "2")),
            ("c".into(), synced("c", "3", "3")),
        ]);
        let local = FileTree::from([("a".into(), entry("a", "1")), ("b".into(), entry("b", "2"))]);
        assert!(matches!(
            plan(&local, &FileTree::new(), &synced),
            Err(SyncError::MassDeletionProtection { .. })
        ));
    }

    #[test]
    fn permanently_skipped_unchanged_upload_is_not_retried_or_treated_as_a_deletion() {
        let local = FileTree::from([("large.bin".into(), entry("large.bin", "local"))]);
        let previous = SyncedTree::from([(
            "large.bin".into(),
            SyncedEntry {
                relative_path: "large.bin".into(),
                local_hash: Some("local".into()),
                remote_hash: None,
                file_size: 3_000_000_000,
                local_mtime: None,
                remote_date: None,
                message_id: None,
                sync_status: "skipped".into(),
            },
        )]);
        assert!(matches!(
            plan(&local, &FileTree::new(), &previous).unwrap()[0],
            SyncOperation::Skip { .. }
        ));
    }

    #[test]
    fn transient_failed_initial_transfer_is_retried() {
        let local = FileTree::from([("retry.bin".into(), entry("retry.bin", "local"))]);
        let previous = SyncedTree::from([(
            "retry.bin".into(),
            SyncedEntry {
                relative_path: "retry.bin".into(),
                local_hash: Some("local".into()),
                remote_hash: None,
                file_size: 1,
                local_mtime: None,
                remote_date: None,
                message_id: None,
                sync_status: "error".into(),
            },
        )]);
        assert!(matches!(
            plan(&local, &FileTree::new(), &previous).unwrap()[0],
            SyncOperation::Upload { .. }
        ));
    }

    #[test]
    fn one_way_modes_restore_from_the_authoritative_tree() {
        let local = FileTree::from([("remote-deleted".into(), entry("remote-deleted", "local"))]);
        let remote = FileTree::from([("local-deleted".into(), entry("local-deleted", "remote"))]);
        let previous = SyncedTree::from([
            (
                "remote-deleted".into(),
                synced("remote-deleted", "local", "old-remote"),
            ),
            (
                "local-deleted".into(),
                synced("local-deleted", "old-local", "remote"),
            ),
        ]);

        let upload_only = plan_for_direction(&local, &remote, &previous, "upload_only").unwrap();
        assert!(upload_only.iter().any(|operation| matches!(
            operation,
            SyncOperation::Upload { relative_path, .. } if relative_path == "remote-deleted"
        )));

        let download_only =
            plan_for_direction(&local, &remote, &previous, "download_only").unwrap();
        assert!(download_only.iter().any(|operation| matches!(
            operation,
            SyncOperation::Download { relative_path, .. } if relative_path == "local-deleted"
        )));
    }

    #[test]
    fn one_hundred_remote_deletions_are_blocked() {
        let local = (0..100)
            .map(|index| {
                let path = format!("file-{index}.txt");
                (path.clone(), entry(&path, "local"))
            })
            .collect();
        let previous = (0..100)
            .map(|index| {
                let path = format!("file-{index}.txt");
                (path.clone(), synced(&path, "local", "remote"))
            })
            .collect();
        assert!(matches!(
            plan(&local, &FileTree::new(), &previous),
            Err(SyncError::MassDeletionProtection {
                deletes: 100,
                synced_files: 100
            })
        ));
    }
}
