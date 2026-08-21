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

    fn is_delete(&self) -> bool {
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
    let operations = plan_unchecked(local, remote, synced)
        .into_iter()
        .map(|operation| match (direction, operation) {
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
            (_, operation) => operation,
        })
        .collect();
    enforce_mass_deletion(operations, synced)
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
            (None, Some(remote), Some(_)) => remote.message_id.map_or_else(
                || SyncOperation::Conflict {
                    relative_path: relative_path.clone(),
                },
                |message_id| SyncOperation::DeleteRemote {
                    relative_path: relative_path.clone(),
                    message_id,
                },
            ),
            (Some(local), Some(remote), Some(previous)) => {
                if previous.sync_status == "conflict" {
                    operations.push(SyncOperation::Conflict {
                        relative_path: relative_path.clone(),
                    });
                    continue;
                }
                if previous.sync_status == "keep_local" {
                    operations.push(SyncOperation::Upload {
                        relative_path: relative_path.clone(),
                        local: local.clone(),
                    });
                    continue;
                }
                if previous.sync_status == "keep_remote" {
                    operations.push(SyncOperation::Download {
                        relative_path: relative_path.clone(),
                        remote: remote.clone(),
                        keep_both: false,
                        expected_local_hash: Some(local.hash.clone()),
                    });
                    continue;
                }
                if previous.sync_status == "keep_both" {
                    operations.push(SyncOperation::Download {
                        relative_path: relative_path.clone(),
                        remote: remote.clone(),
                        keep_both: true,
                        expected_local_hash: None,
                    });
                    continue;
                }
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

fn enforce_mass_deletion(
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
