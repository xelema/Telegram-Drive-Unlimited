mod account;
pub mod assets;
pub mod cleanup;
pub mod device_cache;
pub mod envelope_cache;
pub mod packs;
pub mod playback;
pub(crate) mod remote_changes;
pub mod storage;
pub mod store;
use crate::{commands::TelegramState, models::FileMetadata};
pub use account::{current_owner, resume, suspend, AccountGuard};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) use account::{open_session, register_session, AuthenticationSession};
pub(crate) use account::{operation_account, with_operation_account};
use grammers_client::types::Peer;
use serde::Deserialize;
use store::{Collection, SavedSearch, Snapshot, Store};
use tauri::Manager;

pub fn start_background(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut configured_owner = None;
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            let Ok(root) = app.path().app_data_dir() else {
                continue;
            };
            let Ok(owner) = current_owner(&root) else {
                continue;
            };
            if configured_owner != Some(owner) {
                if let Ok(store) = Store::open(&root, owner) {
                    if let Ok(Some(limits)) =
                        store.record::<storage::StorageLimits>("storage", "limits")
                    {
                        storage::apply_limits(&app, &limits).await;
                    }
                }
                configured_owner = Some(owner);
            }
            let owner = owner.to_string();
            if let Err(error) = packs::resume_pending(app.clone(), owner.clone()) {
                log::debug!("Offline packs are waiting: {error}");
            }
            if let Err(error) = cleanup::cmd_cleanup_process(app.clone(), owner).await {
                log::debug!("Scheduled cleanup is waiting: {error}");
            }
        }
    });
}

pub async fn record_chunk(
    account: &AccountGuard,
    files: &[FileMetadata],
    peer: &Peer,
    scan: &str,
) -> Result<(), String> {
    account.validate()?;
    let account = account.clone();
    let files = files.to_vec();
    let scan = scan.to_string();
    let name = match peer {
        Peer::Channel(channel) => channel.title().replace(" [TD]", ""),
        _ => "Saved Messages".into(),
    };
    tokio::task::spawn_blocking(move || {
        account.validate()?;
        let store=Store::open(&account.root,account.owner)?;
        store.remember_files(&files,&name,&scan)?;
        if let Some(file)=files.first() {
            let key=file.folder_id.map(|id| id.to_string()).unwrap_or_else(|| "saved".into());
            store.put_record("scan",&key,&serde_json::json!({"folderId":file.folder_id,"folderName":name,"complete":false,"updatedAt":chrono::Utc::now().timestamp_millis()}))?;
        }
        account.validate()
    }).await.map_err(|e| e.to_string())?
}

pub async fn complete_scan(
    account: &AccountGuard,
    folder: Option<i64>,
    scan: &str,
) -> Result<(), String> {
    let account = account.clone();
    let scan = scan.to_string();
    tokio::task::spawn_blocking(move || {
        account.validate()?;
        let store=Store::open(&account.root,account.owner)?;
        store.transaction(|| {
            store.complete_scan(folder,&scan)?;
            let key=folder.map(|id| id.to_string()).unwrap_or_else(|| "saved".into());
            let old=store.record::<serde_json::Value>("scan",&key)?.unwrap_or_default();
            store.put_record("scan",&key,&serde_json::json!({"folderId":folder,"folderName":old.get("folderName").and_then(|v|v.as_str()).unwrap_or("Saved Messages"),"complete":true,"updatedAt":chrono::Utc::now().timestamp_millis()}))?;
            account.validate()
        })
    }).await.map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Mutation {
    SaveCollection {
        collection: Collection,
    },
    RemoveCollection {
        id: String,
    },
    Assign {
        keys: Vec<String>,
        collection: String,
        add: bool,
    },
    Tag {
        keys: Vec<String>,
        tag: String,
        add: bool,
    },
    SaveSearch {
        search: SavedSearch,
    },
    RemoveSearch {
        id: String,
    },
    Favorite {
        key: String,
        value: bool,
    },
}

#[tauri::command]
pub async fn cmd_workspace_account(app: tauri::AppHandle) -> Result<String, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || current_owner(&root).map(|id| id.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_workspace_read(
    app: tauri::AppHandle,
    owner_id: String,
) -> Result<Snapshot, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let account = AccountGuard::open(&root, Some(&owner_id))?;
        let result = Store::open(&root, account.owner)?.snapshot()?;
        account.validate()?;
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_workspace_mutate(
    app: tauri::AppHandle,
    owner_id: String,
    mutation: Mutation,
) -> Result<Snapshot, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let account = AccountGuard::open(&root, Some(&owner_id))?;
        let store = Store::open(&root, account.owner)?;
        match mutation {
            Mutation::SaveCollection { collection } => store.save_collection(&collection)?,
            Mutation::RemoveCollection { id } => store.remove_collection(&id)?,
            Mutation::Assign {
                keys,
                collection,
                add,
            } => store.assign(&keys, &collection, add)?,
            Mutation::Tag { keys, tag, add } => store.tag(&keys, &tag, add)?,
            Mutation::SaveSearch { search } => store.save_search(&search)?,
            Mutation::RemoveSearch { id } => store.remove_record("search", &id)?,
            Mutation::Favorite { key, value } => store.put_record("favorite", &key, &value)?,
        }
        account.validate()?;
        store.snapshot()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_workspace_index(
    app: tauri::AppHandle,
    owner_id: String,
    folder_ids: Vec<Option<i64>>,
) -> Result<Snapshot, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, Some(&owner_id))?;
    if folder_ids.len() > 1000 {
        return Err("Select fewer than 1,000 folders per scan".into());
    }
    for folder in folder_ids {
        account.validate()?;
        let scan = crate::commands::cmd_get_files(
            folder,
            Some(format!("workspace-{}", uuid::Uuid::new_v4())),
            Some(owner_id.clone()),
            app.clone(),
            app.state::<TelegramState>(),
            app.state::<crate::db::DbConnection>(),
            app.state::<crate::crypto::state::CryptoState>(),
        )
        .await?;
        if !scan.complete {
            return Err("The folder scan was interrupted before it completed; try again".into());
        }
    }
    cmd_workspace_read(app, owner_id).await
}
