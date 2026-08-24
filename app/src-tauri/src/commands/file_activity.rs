use serde::Serialize;
use tauri::State;

use crate::db::DbConnection;

#[derive(Debug, Clone, Serialize)]
pub struct LocalFileActivity {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub name: String,
    pub size: u64,
    pub mime_type: Option<String>,
    pub file_ext: Option<String>,
    pub created_at: String,
    pub icon_type: String,
    pub encryption_state: String,
    pub is_favorite: bool,
    pub is_pinned: bool,
    pub last_opened_at: i64,
}

fn folder_key(folder_id: Option<i64>) -> String {
    folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cmd_record_file_opened(
    db_pool: State<'_, DbConnection>,
    folder_id: Option<i64>,
    message_id: i64,
    file_name: String,
    file_size: u64,
    mime_type: Option<String>,
    file_ext: Option<String>,
    created_at: Option<String>,
    encryption_state: Option<String>,
) -> Result<(), String> {
    let database = db_pool.inner().clone();
    crate::db::with_connection(database, move |connection| {
        let now = chrono::Utc::now().timestamp();
        let key = folder_key(folder_id);
        let mut statement = connection
            .prepare(
                "INSERT INTO file_activity (
            folder_key, folder_id, message_id, file_name, file_size, mime_type,
            file_ext, created_at, encryption_state, last_opened_at, open_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(folder_key, message_id) DO UPDATE SET
            folder_id = excluded.folder_id,
            file_name = excluded.file_name,
            file_size = excluded.file_size,
            mime_type = excluded.mime_type,
            file_ext = excluded.file_ext,
            created_at = excluded.created_at,
            encryption_state = excluded.encryption_state,
            last_opened_at = excluded.last_opened_at,
            open_count = file_activity.open_count + 1",
            )
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, key.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, folder_id))
            .map_err(|error| error.to_string())?;
        statement
            .bind((3, message_id))
            .map_err(|error| error.to_string())?;
        statement
            .bind((4, file_name.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((5, i64::try_from(file_size).unwrap_or(i64::MAX)))
            .map_err(|error| error.to_string())?;
        statement
            .bind((6, mime_type.as_deref()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((7, file_ext.as_deref()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((8, created_at.as_deref().unwrap_or("")))
            .map_err(|error| error.to_string())?;
        statement
            .bind((9, encryption_state.as_deref().unwrap_or("plain")))
            .map_err(|error| error.to_string())?;
        statement
            .bind((10, now))
            .map_err(|error| error.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cmd_set_file_activity_flag(
    db_pool: State<'_, DbConnection>,
    folder_id: Option<i64>,
    message_id: i64,
    file_name: String,
    file_size: u64,
    mime_type: Option<String>,
    file_ext: Option<String>,
    created_at: Option<String>,
    encryption_state: Option<String>,
    flag: String,
    value: bool,
) -> Result<(), String> {
    let column = match flag.as_str() {
        "favorite" => "is_favorite",
        "pinned" => "is_pinned",
        _ => return Err("Unknown file activity flag".to_string()),
    };
    let database = db_pool.inner().clone();
    crate::db::with_connection(database, move |connection| {
        let now = chrono::Utc::now().timestamp();
        let key = folder_key(folder_id);
        let sql = format!(
            "INSERT INTO file_activity (
            folder_key, folder_id, message_id, file_name, file_size, mime_type,
            file_ext, created_at, encryption_state, last_opened_at, open_count, {column}
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(folder_key, message_id) DO UPDATE SET
            folder_id = excluded.folder_id,
            file_name = excluded.file_name,
            file_size = excluded.file_size,
            mime_type = excluded.mime_type,
            file_ext = excluded.file_ext,
            created_at = excluded.created_at,
            encryption_state = excluded.encryption_state,
            {column} = excluded.{column}"
        );
        let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
        statement
            .bind((1, key.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, folder_id))
            .map_err(|error| error.to_string())?;
        statement
            .bind((3, message_id))
            .map_err(|error| error.to_string())?;
        statement
            .bind((4, file_name.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((5, i64::try_from(file_size).unwrap_or(i64::MAX)))
            .map_err(|error| error.to_string())?;
        statement
            .bind((6, mime_type.as_deref()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((7, file_ext.as_deref()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((8, created_at.as_deref().unwrap_or("")))
            .map_err(|error| error.to_string())?;
        statement
            .bind((9, encryption_state.as_deref().unwrap_or("plain")))
            .map_err(|error| error.to_string())?;
        statement
            .bind((10, now))
            .map_err(|error| error.to_string())?;
        statement
            .bind((11, if value { 1 } else { 0 }))
            .map_err(|error| error.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn cmd_get_file_activity(
    db_pool: State<'_, DbConnection>,
    view: String,
    limit: Option<i64>,
) -> Result<Vec<LocalFileActivity>, String> {
    let predicate = match view.as_str() {
        "favorites" => "is_favorite = 1",
        "pinned" => "is_pinned = 1",
        "recents" => "open_count > 0",
        _ => return Err("Unknown smart view".to_string()),
    };
    let order = if view == "pinned" {
        "is_pinned DESC, last_opened_at DESC"
    } else {
        "last_opened_at DESC"
    };
    let sql = format!(
        "SELECT message_id, folder_id, file_name, file_size, mime_type, file_ext,
                created_at, encryption_state, is_favorite, is_pinned, last_opened_at
         FROM file_activity WHERE {predicate} ORDER BY {order} LIMIT ?"
    );
    let database = db_pool.inner().clone();
    crate::db::with_connection(database, move |connection| {
        let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
        statement
            .bind((1, limit.unwrap_or(200).clamp(1, 1_000)))
            .map_err(|error| error.to_string())?;
        let mut rows = Vec::new();
        while let sqlite::State::Row = statement.next().map_err(|error| error.to_string())? {
            rows.push(LocalFileActivity {
                id: statement
                    .read::<i64, _>(0)
                    .map_err(|error| error.to_string())?,
                folder_id: statement
                    .read::<Option<i64>, _>(1)
                    .map_err(|error| error.to_string())?,
                name: statement
                    .read::<String, _>(2)
                    .map_err(|error| error.to_string())?,
                size: statement.read::<i64, _>(3).unwrap_or(0).max(0) as u64,
                mime_type: statement.read::<Option<String>, _>(4).ok().flatten(),
                file_ext: statement.read::<Option<String>, _>(5).ok().flatten(),
                created_at: statement.read::<String, _>(6).unwrap_or_default(),
                icon_type: "file".to_string(),
                encryption_state: statement
                    .read::<String, _>(7)
                    .unwrap_or_else(|_| "plain".to_string()),
                is_favorite: statement.read::<i64, _>(8).unwrap_or(0) != 0,
                is_pinned: statement.read::<i64, _>(9).unwrap_or(0) != 0,
                last_opened_at: statement.read::<i64, _>(10).unwrap_or(0),
            });
        }
        Ok(rows)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::folder_key;

    #[test]
    fn saved_messages_uses_stable_folder_key() {
        assert_eq!(folder_key(None), "home");
        assert_eq!(folder_key(Some(42)), "42");
    }
}
