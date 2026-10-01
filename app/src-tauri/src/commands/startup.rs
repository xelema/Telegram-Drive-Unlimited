use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::streaming::StreamConfig;
use crate::db::DbConnection;

#[derive(Debug, Serialize)]
pub struct StartupHealth {
    database_ready: bool,
    app_data_ready: bool,
    streaming_runtime_ready: bool,
}

/// Returns only after the core Rust-managed services required by the desktop UI
/// can be reached. The warm-up screen uses this response as real progress rather
/// than showing an indeterminate blank window.
#[tauri::command]
pub async fn cmd_get_startup_health(
    app: AppHandle,
    db_pool: State<'_, DbConnection>,
    stream_config: State<'_, StreamConfig>,
) -> Result<StartupHealth, String> {
    let database_ready = crate::db::with_connection(db_pool.inner().clone(), |connection| {
        let mut statement = connection
            .prepare("SELECT 1")
            .map_err(|error| error.to_string())?;
        Ok(matches!(statement.next(), Ok(sqlite::State::Row)))
    })
    .await?;
    let app_data_ready = app
        .path()
        .app_data_dir()
        .map(|path| path.exists())
        .unwrap_or(false);
    let streaming_runtime_ready = stream_config.port > 0 && !stream_config.token.is_empty();

    if !database_ready || !app_data_ready || !streaming_runtime_ready {
        return Err("One or more local services did not initialize correctly".to_string());
    }

    Ok(StartupHealth {
        database_ready,
        app_data_ready,
        streaming_runtime_ready,
    })
}
