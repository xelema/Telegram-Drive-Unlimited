use crate::{
    db::DbConnection,
    sync_engine::{
        config::{self, SyncPair, SyncSettings},
        restart_sync_engine, SyncEngine, SyncStatus,
    },
};
use serde::Serialize;
use sqlite::State as SqliteState;
use std::path::Path;
use tauri::{Manager, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLogEntry {
    pub id: i64,
    pub pair_id: Option<i64>,
    pub action: String,
    pub relative_path: Option<String>,
    pub detail: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub pair_id: i64,
    pub relative_path: String,
    pub local_path: String,
    pub label: Option<String>,
}

fn sync_paths_overlap(left: &Path, right: &Path) -> bool {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let components = |path: &Path| {
            path.components()
                .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
                .collect::<Vec<_>>()
        };
        let left = components(left);
        let right = components(right);
        left.starts_with(&right) || right.starts_with(&left)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        left.starts_with(right) || right.starts_with(left)
    }
}

#[tauri::command]
pub async fn cmd_get_sync_settings(db: State<'_, DbConnection>) -> Result<SyncSettings, String> {
    config::load_settings(db.inner().clone()).await
}

#[tauri::command]
pub async fn cmd_toggle_sync(
    app: tauri::AppHandle,
    db: State<'_, DbConnection>,
    enabled: bool,
) -> Result<SyncSettings, String> {
    config::set_setting(
        db.inner().clone(),
        "sync_enabled".to_string(),
        if enabled { "true" } else { "false" }.to_string(),
    )
    .await?;
    restart_sync_engine(&app).await?;
    config::load_settings(db.inner().clone()).await
}

#[tauri::command]
pub async fn cmd_add_sync_pair(
    app: tauri::AppHandle,
    db: State<'_, DbConnection>,
    local_path: String,
    channel_id: i64,
    label: Option<String>,
    sync_direction: Option<String>,
) -> Result<SyncPair, String> {
    let canonical = Path::new(&local_path)
        .canonicalize()
        .map_err(|error| format!("Folder is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err("Sync path must be an existing directory".to_string());
    }
    let direction = sync_direction.unwrap_or_else(|| "bidirectional".to_string());
    if !matches!(
        direction.as_str(),
        "bidirectional" | "upload_only" | "download_only"
    ) {
        return Err("Invalid sync direction".to_string());
    }
    let local_path = canonical.to_string_lossy().into_owned();
    let created_at = chrono::Utc::now().timestamp();
    let folder_key = channel_id.to_string();
    let canonical_for_check = canonical.clone();
    let local_path_for_db = local_path.clone();
    let folder_key_for_db = folder_key.clone();
    let label_for_db = label.clone();
    let direction_for_db = direction.clone();
    let (id, fallback_label) = crate::db::with_connection(db.inner().clone(), move |connection| {
        let mut existing_pairs = connection
            .prepare("SELECT local_path, channel_id FROM sync_pairs")
            .map_err(|error| error.to_string())?;
        while existing_pairs.next().map_err(|error| error.to_string())? == SqliteState::Row {
            let existing_path: String =
                existing_pairs.read(0).map_err(|error| error.to_string())?;
            let existing_channel: i64 =
                existing_pairs.read(1).map_err(|error| error.to_string())?;
            if existing_channel == channel_id {
                return Err("A Telegram channel can be mapped to only one local folder".to_string());
            }
            if sync_paths_overlap(&canonical_for_check, Path::new(&existing_path)) {
                return Err(
                    "Sync folders cannot be identical, nested, or contain another sync folder"
                        .to_string(),
                );
            }
        }
        drop(existing_pairs);
        let mut channel = connection
            .prepare("SELECT name FROM folder_metadata WHERE channel_id = ?")
            .map_err(|error| error.to_string())?;
        channel
            .bind((1, channel_id))
            .map_err(|error| error.to_string())?;
        if channel.next().map_err(|error| error.to_string())? != SqliteState::Row {
            return Err("Selected Telegram channel is not in the folder list".to_string());
        }
        let fallback_label = channel.read::<String, _>(0).ok();
        drop(channel);
        let mut statement = connection.prepare(
            "INSERT INTO sync_pairs (local_path, channel_id, folder_key, label, sync_direction, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
        ).map_err(|error| error.to_string())?;
        statement
            .bind((1, local_path_for_db.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, channel_id))
            .map_err(|error| error.to_string())?;
        statement
            .bind((3, folder_key_for_db.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind::<(usize, Option<&str>)>((4, label_for_db.as_deref().or(fallback_label.as_deref())))
            .map_err(|error| error.to_string())?;
        statement
            .bind((5, direction_for_db.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((6, created_at))
            .map_err(|error| error.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        drop(statement);
        let mut id_statement = connection
            .prepare("SELECT last_insert_rowid()")
            .map_err(|error| error.to_string())?;
        id_statement.next().map_err(|error| error.to_string())?;
        let id = id_statement
            .read::<i64, _>(0)
            .map_err(|error| error.to_string())?;
        Ok((id, fallback_label))
    }).await?;
    restart_sync_engine(&app).await?;
    Ok(SyncPair {
        id,
        local_path,
        channel_id,
        folder_key,
        label: label.or(fallback_label),
        sync_direction: direction,
        is_active: true,
        created_at,
    })
}

#[cfg(test)]
mod tests {
    use super::sync_paths_overlap;
    use std::path::Path;

    #[test]
    fn rejects_nested_sync_roots_without_rejecting_siblings() {
        let root = Path::new("/sync/root");
        assert!(sync_paths_overlap(root, Path::new("/sync/root/nested")));
        assert!(sync_paths_overlap(root, root));
        assert!(!sync_paths_overlap(root, Path::new("/sync/root-two")));
    }
}

#[tauri::command]
pub async fn cmd_get_sync_pairs(db: State<'_, DbConnection>) -> Result<Vec<SyncPair>, String> {
    config::load_pairs(db.inner().clone(), false).await
}

#[tauri::command]
pub async fn cmd_remove_sync_pair(
    app: tauri::AppHandle,
    db: State<'_, DbConnection>,
    pair_id: i64,
) -> Result<(), String> {
    app.state::<SyncEngine>().shutdown_and_wait().await?;
    crate::db::with_connection(db.inner().clone(), move |connection| {
        connection
            .execute("BEGIN IMMEDIATE TRANSACTION")
            .map_err(|error| error.to_string())?;
        let deletion = (|| {
            let mut statement = connection
                .prepare("DELETE FROM sync_state WHERE pair_id = ?")
                .map_err(|error| error.to_string())?;
            statement
                .bind((1, pair_id))
                .map_err(|error| error.to_string())?;
            statement.next().map_err(|error| error.to_string())?;
            drop(statement);
            let mut statement = connection
                .prepare("DELETE FROM sync_pairs WHERE id = ?")
                .map_err(|error| error.to_string())?;
            statement
                .bind((1, pair_id))
                .map_err(|error| error.to_string())?;
            statement.next().map_err(|error| error.to_string())?;
            Ok::<(), String>(())
        })();
        match deletion {
            Ok(()) => connection
                .execute("COMMIT")
                .map_err(|error| error.to_string())?,
            Err(error) => {
                let _ = connection.execute("ROLLBACK");
                return Err(error);
            }
        }
        Ok(())
    })
    .await?;
    app.state::<SyncEngine>().start().await
}

#[tauri::command]
pub async fn cmd_get_sync_status(engine: State<'_, SyncEngine>) -> Result<SyncStatus, String> {
    Ok(engine.status.read().await.clone())
}

#[tauri::command]
pub async fn cmd_get_sync_conflicts(
    db: State<'_, DbConnection>,
) -> Result<Vec<SyncConflict>, String> {
    crate::db::with_connection(db.inner().clone(), |connection| {
    let mut statement = connection.prepare(
        "SELECT s.pair_id, s.relative_path, p.local_path, p.label FROM sync_state s JOIN sync_pairs p ON p.id = s.pair_id WHERE s.sync_status = 'conflict' ORDER BY s.pair_id, s.relative_path",
    ).map_err(|error| error.to_string())?;
    let mut conflicts = Vec::new();
    while statement.next().map_err(|error| error.to_string())? == SqliteState::Row {
        conflicts.push(SyncConflict {
            pair_id: statement.read(0).map_err(|error| error.to_string())?,
            relative_path: statement.read(1).map_err(|error| error.to_string())?,
            local_path: statement.read(2).map_err(|error| error.to_string())?,
            label: statement.read::<Option<String>, _>(3).ok().flatten(),
        });
    }
    Ok(conflicts)
    }).await
}

#[tauri::command]
pub async fn cmd_get_sync_log(
    db: State<'_, DbConnection>,
    limit: Option<i64>,
) -> Result<Vec<SyncLogEntry>, String> {
    crate::db::with_connection(db.inner().clone(), move |connection| {
    let mut statement = connection.prepare(
        "SELECT id, pair_id, action, relative_path, detail, created_at FROM sync_log ORDER BY id DESC LIMIT ?",
    ).map_err(|error| error.to_string())?;
    statement
        .bind((1, limit.unwrap_or(100).clamp(1, 500)))
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    while statement.next().map_err(|error| error.to_string())? == SqliteState::Row {
        entries.push(SyncLogEntry {
            id: statement.read(0).map_err(|error| error.to_string())?,
            pair_id: statement.read::<Option<i64>, _>(1).ok().flatten(),
            action: statement.read(2).map_err(|error| error.to_string())?,
            relative_path: statement.read::<Option<String>, _>(3).ok().flatten(),
            detail: statement.read::<Option<String>, _>(4).ok().flatten(),
            created_at: statement.read(5).map_err(|error| error.to_string())?,
        });
    }
    Ok(entries)
    }).await
}

#[tauri::command]
pub async fn cmd_resolve_conflict(
    app: tauri::AppHandle,
    db: State<'_, DbConnection>,
    pair_id: i64,
    path: String,
    resolution: String,
) -> Result<(), String> {
    if !matches!(
        resolution.as_str(),
        "keep_local" | "keep_remote" | "keep_both"
    ) {
        return Err("Unknown conflict resolution".to_string());
    }
    app.state::<SyncEngine>().shutdown_and_wait().await?;
    let path_for_db = path.clone();
    let resolution_for_db = resolution.clone();
    crate::db::with_connection(db.inner().clone(), move |connection| {
        let mut statement = connection.prepare(
            "UPDATE sync_state SET sync_status = ? WHERE pair_id = ? AND relative_path = ? AND sync_status = 'conflict'",
        ).map_err(|error| error.to_string())?;
        statement
            .bind((1, resolution_for_db.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, pair_id))
            .map_err(|error| error.to_string())?;
        statement
            .bind((3, path_for_db.as_str()))
            .map_err(|error| error.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        Ok(())
    }).await?;
    config::log_sync(
        db.inner().clone(),
        Some(pair_id),
        "resolve_conflict".to_string(),
        Some(path),
        Some(resolution),
    )
    .await;
    app.state::<SyncEngine>().start().await
}
