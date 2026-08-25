use crate::db::{self, DbConnection};
use crate::models::FileMetadata;
use tauri::State;

pub fn folder_key(folder_id: Option<i64>) -> String {
    folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string())
}

pub async fn upsert_inventory_chunk(
    database: DbConnection,
    folder_key: String,
    scan_id: String,
    files: Vec<FileMetadata>,
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let updated_at = chrono::Utc::now().timestamp();
    db::with_connection(database, move |connection| {
        connection
            .execute("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| {
            for file in files {
                let mut statement = connection
                    .prepare(
                        "INSERT INTO file_inventory (
                            folder_key, folder_id, message_id, file_name, file_size,
                            mime_type, file_ext, created_at, icon_type, encryption_state,
                            last_seen_scan, updated_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(folder_key, message_id) DO UPDATE SET
                            folder_id = excluded.folder_id,
                            file_name = excluded.file_name,
                            file_size = excluded.file_size,
                            mime_type = excluded.mime_type,
                            file_ext = excluded.file_ext,
                            created_at = excluded.created_at,
                            icon_type = excluded.icon_type,
                            encryption_state = excluded.encryption_state,
                            last_seen_scan = excluded.last_seen_scan,
                            updated_at = excluded.updated_at",
                    )
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((1, folder_key.as_str()))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((2, file.folder_id))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((3, file.id))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((4, file.name.as_str()))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((5, i64::try_from(file.size).unwrap_or(i64::MAX)))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((6, file.mime_type.as_deref()))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((7, file.file_ext.as_deref()))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((8, file.created_at.as_str()))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((9, file.icon_type.as_str()))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((10, file.encryption_state.as_str()))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((11, scan_id.as_str()))
                    .map_err(|error| error.to_string())?;
                statement
                    .bind((12, updated_at))
                    .map_err(|error| error.to_string())?;
                statement.next().map_err(|error| error.to_string())?;
            }
            Ok::<(), String>(())
        })();
        match result {
            Ok(()) => connection
                .execute("COMMIT")
                .map_err(|error| error.to_string()),
            Err(error) => {
                let _ = connection.execute("ROLLBACK");
                Err(error)
            }
        }
    })
    .await
}

pub async fn complete_inventory_scan(
    database: DbConnection,
    folder_key: String,
    scan_id: String,
) -> Result<(), String> {
    let completed_at = chrono::Utc::now().timestamp();
    db::with_connection(database, move |connection| {
        connection
            .execute("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| {
            let mut delete = connection
                .prepare(
                    "DELETE FROM file_inventory
                     WHERE folder_key = ? AND last_seen_scan <> ?",
                )
                .map_err(|error| error.to_string())?;
            delete
                .bind((1, folder_key.as_str()))
                .map_err(|error| error.to_string())?;
            delete
                .bind((2, scan_id.as_str()))
                .map_err(|error| error.to_string())?;
            delete.next().map_err(|error| error.to_string())?;

            let mut count_statement = connection
                .prepare("SELECT COUNT(*) FROM file_inventory WHERE folder_key = ?")
                .map_err(|error| error.to_string())?;
            count_statement
                .bind((1, folder_key.as_str()))
                .map_err(|error| error.to_string())?;
            let file_count = if count_statement.next().map_err(|error| error.to_string())?
                == sqlite::State::Row
            {
                count_statement.read::<i64, _>(0).unwrap_or(0)
            } else {
                0
            };

            let mut state = connection
                .prepare(
                    "INSERT INTO file_inventory_state (folder_key, completed_at, file_count)
                     VALUES (?, ?, ?)
                     ON CONFLICT(folder_key) DO UPDATE SET
                        completed_at = excluded.completed_at,
                        file_count = excluded.file_count",
                )
                .map_err(|error| error.to_string())?;
            state
                .bind((1, folder_key.as_str()))
                .map_err(|error| error.to_string())?;
            state
                .bind((2, completed_at))
                .map_err(|error| error.to_string())?;
            state
                .bind((3, file_count))
                .map_err(|error| error.to_string())?;
            state.next().map_err(|error| error.to_string())?;
            Ok::<(), String>(())
        })();
        match result {
            Ok(()) => connection
                .execute("COMMIT")
                .map_err(|error| error.to_string()),
            Err(error) => {
                let _ = connection.execute("ROLLBACK");
                Err(error)
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn cmd_get_cached_files(
    folder_id: Option<i64>,
    db_pool: State<'_, DbConnection>,
) -> Result<Vec<FileMetadata>, String> {
    get_cached_files(db_pool.inner().clone(), folder_id).await
}

pub async fn get_cached_files(
    database: DbConnection,
    folder_id: Option<i64>,
) -> Result<Vec<FileMetadata>, String> {
    let key = folder_key(folder_id);
    db::with_connection(database, move |connection| {
        let mut statement = connection
            .prepare(
                "SELECT i.message_id, i.folder_id, i.file_name, i.file_size,
                        i.mime_type, i.file_ext, i.created_at, i.icon_type,
                        i.encryption_state,
                        COALESCE(a.is_favorite, 0), COALESCE(a.is_pinned, 0)
                 FROM file_inventory i
                 LEFT JOIN file_activity a
                   ON a.folder_key = i.folder_key AND a.message_id = i.message_id
                 WHERE i.folder_key = ?
                 ORDER BY i.message_id DESC",
            )
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, key.as_str()))
            .map_err(|error| error.to_string())?;
        let mut files = Vec::new();
        while statement.next().map_err(|error| error.to_string())? == sqlite::State::Row {
            files.push(FileMetadata {
                id: statement
                    .read::<i64, _>(0)
                    .map_err(|error| error.to_string())?,
                folder_id: statement.read::<Option<i64>, _>(1).ok().flatten(),
                name: statement
                    .read::<String, _>(2)
                    .map_err(|error| error.to_string())?,
                size: statement.read::<i64, _>(3).unwrap_or(0).max(0) as u64,
                mime_type: statement.read::<Option<String>, _>(4).ok().flatten(),
                file_ext: statement.read::<Option<String>, _>(5).ok().flatten(),
                created_at: statement.read::<String, _>(6).unwrap_or_default(),
                icon_type: statement
                    .read::<String, _>(7)
                    .unwrap_or_else(|_| "file".to_string()),
                encryption_state: statement
                    .read::<String, _>(8)
                    .unwrap_or_else(|_| "plain".to_string()),
                is_favorite: statement.read::<i64, _>(9).unwrap_or(0) != 0,
                is_pinned: statement.read::<i64, _>(10).unwrap_or(0) != 0,
            });
        }
        Ok(files)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn database() -> DbConnection {
        let connection = sqlite::open(":memory:").unwrap();
        connection
            .execute(
                "CREATE TABLE file_inventory (
                    folder_key TEXT NOT NULL, folder_id INTEGER, message_id INTEGER NOT NULL,
                    file_name TEXT NOT NULL, file_size INTEGER NOT NULL, mime_type TEXT,
                    file_ext TEXT, created_at TEXT NOT NULL, icon_type TEXT NOT NULL,
                    encryption_state TEXT NOT NULL, last_seen_scan TEXT NOT NULL,
                    updated_at INTEGER NOT NULL, PRIMARY KEY(folder_key, message_id)
                 );
                 CREATE TABLE file_inventory_state (
                    folder_key TEXT PRIMARY KEY, completed_at INTEGER NOT NULL,
                    file_count INTEGER NOT NULL
                 );
                 CREATE TABLE file_activity (
                    folder_key TEXT NOT NULL, message_id INTEGER NOT NULL,
                    is_favorite INTEGER NOT NULL DEFAULT 0,
                    is_pinned INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(folder_key, message_id)
                 );",
            )
            .unwrap();
        Arc::new(Mutex::new(connection))
    }

    fn file(id: i64, name: &str) -> FileMetadata {
        FileMetadata {
            id,
            folder_id: Some(42),
            name: name.to_string(),
            size: 123,
            mime_type: Some("text/plain".to_string()),
            file_ext: Some("txt".to_string()),
            created_at: "2026-08-25T00:00:00Z".to_string(),
            icon_type: "file".to_string(),
            encryption_state: "plain".to_string(),
            is_favorite: false,
            is_pinned: false,
        }
    }

    #[tokio::test]
    async fn completed_scan_prunes_only_rows_missing_from_the_new_generation() {
        let database = database();
        upsert_inventory_chunk(
            database.clone(),
            "42".to_string(),
            "first".to_string(),
            vec![file(1, "old.txt"), file(2, "keep.txt")],
        )
        .await
        .unwrap();
        complete_inventory_scan(database.clone(), "42".to_string(), "first".to_string())
            .await
            .unwrap();

        upsert_inventory_chunk(
            database.clone(),
            "42".to_string(),
            "second".to_string(),
            vec![file(2, "renamed.txt"), file(3, "new.txt")],
        )
        .await
        .unwrap();
        complete_inventory_scan(database.clone(), "42".to_string(), "second".to_string())
            .await
            .unwrap();

        let cached = get_cached_files(database, Some(42)).await.unwrap();
        assert_eq!(
            cached.iter().map(|file| file.id).collect::<Vec<_>>(),
            vec![3, 2]
        );
        assert_eq!(cached[1].name, "renamed.txt");
    }
}
