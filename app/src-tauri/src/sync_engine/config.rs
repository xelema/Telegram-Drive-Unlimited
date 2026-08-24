use crate::db::DbConnection;
use serde::{Deserialize, Serialize};
use sqlite::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    pub enabled: bool,
    pub debounce_ms: u64,
    pub encryption: String,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            debounce_ms: 3_000,
            encryption: "inherit".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPair {
    pub id: i64,
    pub local_path: String,
    pub channel_id: i64,
    pub folder_key: String,
    pub label: Option<String>,
    pub sync_direction: String,
    pub is_active: bool,
    pub created_at: i64,
}

pub async fn load_settings(db: DbConnection) -> Result<SyncSettings, String> {
    crate::db::with_connection(db, |connection| {
        let mut settings = SyncSettings::default();
        let mut statement = connection
            .prepare("SELECT key, value FROM sync_settings")
            .map_err(|error| error.to_string())?;
        while statement.next().map_err(|error| error.to_string())? == State::Row {
            let key = statement
                .read::<String, _>(0)
                .map_err(|error| error.to_string())?;
            let value = statement
                .read::<String, _>(1)
                .map_err(|error| error.to_string())?;
            match key.as_str() {
                "sync_enabled" => settings.enabled = value == "true",
                "sync_debounce_ms" => {
                    settings.debounce_ms = value.parse().unwrap_or(3_000).clamp(250, 60_000)
                }
                "sync_encryption" => settings.encryption = value,
                _ => {}
            }
        }
        Ok(settings)
    })
    .await
}

pub async fn load_pairs(db: DbConnection, active_only: bool) -> Result<Vec<SyncPair>, String> {
    crate::db::with_connection(db, move |connection| {
    let query = if active_only {
        "SELECT id, local_path, channel_id, folder_key, label, sync_direction, is_active, created_at FROM sync_pairs WHERE is_active = 1 ORDER BY id"
    } else {
        "SELECT id, local_path, channel_id, folder_key, label, sync_direction, is_active, created_at FROM sync_pairs ORDER BY id"
    };
    let mut statement = connection
        .prepare(query)
        .map_err(|error| error.to_string())?;
    let mut pairs = Vec::new();
    while statement.next().map_err(|error| error.to_string())? == State::Row {
        pairs.push(SyncPair {
            id: statement.read(0).map_err(|error| error.to_string())?,
            local_path: statement.read(1).map_err(|error| error.to_string())?,
            channel_id: statement.read(2).map_err(|error| error.to_string())?,
            folder_key: statement.read(3).map_err(|error| error.to_string())?,
            label: statement.read::<Option<String>, _>(4).ok().flatten(),
            sync_direction: statement.read(5).map_err(|error| error.to_string())?,
            is_active: statement.read::<i64, _>(6).unwrap_or(0) != 0,
            created_at: statement.read(7).map_err(|error| error.to_string())?,
        });
    }
    Ok(pairs)
    }).await
}

pub async fn set_setting(db: DbConnection, key: String, value: String) -> Result<(), String> {
    crate::db::with_connection(db, move |connection| {
    let mut statement = connection
        .prepare("INSERT INTO sync_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .map_err(|error| error.to_string())?;
    statement
        .bind((1, key.as_str()))
        .map_err(|error| error.to_string())?;
    statement
        .bind((2, value.as_str()))
        .map_err(|error| error.to_string())?;
    statement.next().map_err(|error| error.to_string())?;
    Ok(())
    }).await
}

pub async fn log_sync(
    db: DbConnection,
    pair_id: Option<i64>,
    action: String,
    path: Option<String>,
    detail: Option<String>,
) {
    let _ = crate::db::with_connection(db, move |connection| {
    let mut statement = connection.prepare(
        "INSERT INTO sync_log (pair_id, action, relative_path, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    ).map_err(|error| error.to_string())?;
    statement.bind::<(usize, Option<i64>)>((1, pair_id)).map_err(|error| error.to_string())?;
    statement.bind((2, action.as_str())).map_err(|error| error.to_string())?;
    statement.bind::<(usize, Option<&str>)>((3, path.as_deref())).map_err(|error| error.to_string())?;
    statement.bind::<(usize, Option<&str>)>((4, detail.as_deref())).map_err(|error| error.to_string())?;
    statement.bind((5, chrono::Utc::now().timestamp())).map_err(|error| error.to_string())?;
    statement.next().map_err(|error| error.to_string())?;
    drop(statement);
    // Keep diagnostics useful without allowing an always-offline or otherwise
    // failing pair to grow the database forever.
    connection.execute(
        "DELETE FROM sync_log WHERE id < (SELECT COALESCE(MAX(id), 0) - 10000 FROM sync_log)",
    ).map_err(|error| error.to_string())?;
    Ok(())
    }).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn new_sync_settings_are_disabled_and_persist_when_toggled() {
        let connection = sqlite::open(":memory:").unwrap();
        connection
            .execute(
                "CREATE TABLE sync_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO sync_settings VALUES ('sync_enabled', 'false');
                 INSERT INTO sync_settings VALUES ('sync_debounce_ms', '3000');
                 INSERT INTO sync_settings VALUES ('sync_encryption', 'inherit');",
            )
            .unwrap();
        let db = Arc::new(Mutex::new(connection));
        assert!(!load_settings(db.clone()).await.unwrap().enabled);
        set_setting(db.clone(), "sync_enabled".to_string(), "true".to_string())
            .await
            .unwrap();
        assert!(load_settings(db).await.unwrap().enabled);
    }

    #[tokio::test]
    async fn enabled_toggle_survives_database_reopen() {
        let path = std::env::temp_dir().join(format!(
            "telegram-drive-sync-settings-{}.db",
            uuid::Uuid::new_v4()
        ));
        {
            let connection = sqlite::open(&path).unwrap();
            connection
                .execute(
                    "CREATE TABLE sync_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                     INSERT INTO sync_settings VALUES ('sync_enabled', 'false');
                     INSERT INTO sync_settings VALUES ('sync_debounce_ms', '3000');
                     INSERT INTO sync_settings VALUES ('sync_encryption', 'inherit');",
                )
                .unwrap();
            let db = Arc::new(Mutex::new(connection));
            set_setting(db, "sync_enabled".to_string(), "true".to_string())
                .await
                .unwrap();
        }
        {
            let reopened = Arc::new(Mutex::new(sqlite::open(&path).unwrap()));
            assert!(load_settings(reopened).await.unwrap().enabled);
        }
        std::fs::remove_file(path).unwrap();
    }
}
