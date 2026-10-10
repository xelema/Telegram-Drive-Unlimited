use crate::{
    commands::{fs::InventoryMetadataReader, TelegramState},
    crypto::state::CryptoState,
    local_search::{self, Query, Reply, Snapshot, Source},
    workspace::{
        store::{SavedSearch, Store, WorkspaceFile},
        AccountGuard,
    },
};
use tauri::Manager;
pub(crate) struct LiveSource(pub(crate) tauri::AppHandle);
fn requested_folder(folder: Option<&str>) -> Result<Option<Option<i64>>, String> {
    match folder {
        None => Ok(None),
        Some("saved") => Ok(Some(None)),
        Some(id) => id
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0)
            .map(|id| Some(Some(id)))
            .ok_or_else(|| "INVALID_SEARCH: Invalid folder".into()),
    }
}

fn folder_key(requested: Option<Option<i64>>) -> Option<String> {
    requested.map(|id| {
        id.map(|id| id.to_string())
            .unwrap_or_else(|| "saved".into())
    })
}

pub(crate) fn verified_folders(account: &AccountGuard, folders: &[i64]) -> Result<(), String> {
    account.validate()?;
    let store = Store::open(&account.root, account.owner)?;
    let mut folders = folders.to_vec();
    folders.sort_unstable();
    folders.dedup();
    if store
        .record::<Vec<i64>>("search-folders-v1", "verified")?
        .as_deref()
        != Some(folders.as_slice())
    {
        store.put_record("search-folders-v1", "verified", &folders)?;
        let generation = local_search::inventory_generation(account, Some(i64::MIN));
        local_search::inventory_changed(account, Some(i64::MIN), &generation);
    }
    account.validate()
}

type CatalogSignature = std::collections::HashMap<(std::path::PathBuf, i64), Vec<(i64, String)>>;
static CATALOG_SIGNATURES: std::sync::LazyLock<std::sync::Mutex<CatalogSignature>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
pub(crate) fn verified_catalog(
    account: &AccountGuard,
    folders: &[crate::models::FolderMetadata],
) -> Result<(), String> {
    let ids = folders.iter().map(|folder| folder.id).collect::<Vec<_>>();
    verified_folders(account, &ids)?;
    let key = (
        account.root.canonicalize().map_err(|e| e.to_string())?,
        account.owner,
    );
    let mut signature = folders
        .iter()
        .map(|folder| (folder.id, folder.name.clone()))
        .collect::<Vec<_>>();
    signature.sort();
    let mut signatures = CATALOG_SIGNATURES.lock().unwrap_or_else(|e| e.into_inner());
    if signatures.get(&key) != Some(&signature) {
        signatures.insert(key, signature);
        let generation = local_search::inventory_generation(account, Some(i64::MIN));
        local_search::inventory_changed(account, Some(i64::MIN), &generation);
    }
    account.validate()
}

/// Assemble one discovered folder using the same bounded overlay path in both
/// production and native child-process journeys.
pub(crate) fn append_search_folder(
    rows: &mut Vec<WorkspaceFile>,
    candidates: Vec<WorkspaceFile>,
    store: &Store,
    text_bytes: &mut usize,
) -> Result<bool, String> {
    let mut complete = true;
    for chunk in candidates.chunks(256) {
        let keys = chunk.iter().map(|row| row.key.clone()).collect::<Vec<_>>();
        let mut overlays = store.search_overlays(&keys)?;
        for candidate in chunk {
            let mut row = candidate.clone();
            if let Some(overlay) = overlays.remove(&row.key) {
                if overlay.hidden {
                    continue;
                }
                row.file.is_favorite = overlay.favorite;
                row.file.is_pinned = overlay.pinned;
                row.tags = overlay.tags;
                row.collection_ids = overlay.collections;
            }
            let next_bytes = text_bytes.saturating_add(local_search::row_bytes(&row));
            if rows.len() >= 100_000 || next_bytes > 32 * 1024 * 1024 {
                complete = false;
                return Ok(complete);
            }
            *text_bytes = next_bytes;
            rows.push(row);
        }
    }
    Ok(complete)
}

async fn offline_snapshot(
    account: &AccountGuard,
    folder: Option<&str>,
    credential: Option<crate::crypto::state::UnlockSessionId>,
) -> Result<Snapshot, String> {
    let scope = account.clone();
    let requested = requested_folder(folder)?;
    tokio::task::spawn_blocking(move || {
        scope.validate()?;
        let store = Store::open(&scope.root, scope.owner)?;
        let folders = store
            .record::<Vec<i64>>("search-folders-v1", "verified")?
            .unwrap_or_default();
        if requested.flatten().is_some_and(|id| !folders.contains(&id)) {
            return Err("NOT_DRIVE_FOLDER: Search is limited to Telegram Drive folders".into());
        }
        let (rows, _) = store.search_rows(&folders, folder_key(requested).as_deref())?;
        scope.validate()?;
        Ok(Snapshot {
            rows,
            folders,
            credential,
            complete: false,
            offline: true,
            inventory: Vec::new(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

impl Source for LiveSource {
    fn snapshot<'a>(
        &'a self,
        account: &'a AccountGuard,
        folder: Option<&'a str>,
    ) -> futures::future::BoxFuture<'a, Result<Snapshot, String>> {
        Box::pin(async move {
            let state = self.0.state::<TelegramState>();
            let crypto = self.0.state::<CryptoState>();
            let client = state.client.lock().await.clone();
            let Some(client) = client else {
                return offline_snapshot(
                    account,
                    folder,
                    crypto.current_credential().ok().map(|(id, _)| id),
                )
                .await;
            };
            if let Err(error) = account.validate_client(&client).await {
                account.validate()?;
                if error.contains("ACCOUNT_CHANGED") {
                    return Err(error);
                }
                return offline_snapshot(
                    account,
                    folder,
                    crypto.current_credential().ok().map(|(id, _)| id),
                )
                .await;
            }
            let discovered =
                match crate::api_catalog::discover_folders(account, &client, state.inner()).await {
                    Ok(folders) => folders,
                    Err(error) => {
                        account.validate()?;
                        if matches!(error, crate::api_catalog::CatalogError::Account(_)) {
                            return Err(format!("ACCOUNT_CHANGED: {error:?}"));
                        }
                        return offline_snapshot(
                            account,
                            folder,
                            crypto.current_credential().ok().map(|(id, _)| id),
                        )
                        .await;
                    }
                };
            let folder_ids: Vec<_> = discovered.iter().map(|folder| folder.id).collect();
            let scope = account.clone();
            let catalog = discovered.clone();
            tokio::task::spawn_blocking(move || verified_catalog(&scope, &catalog))
                .await
                .map_err(|e| e.to_string())??;
            let requested = requested_folder(folder)?;
            if requested
                .flatten()
                .is_some_and(|id| !folder_ids.contains(&id))
            {
                return Err("NOT_DRIVE_FOLDER: Search is limited to Telegram Drive folders".into());
            }
            let credential = crypto.current_credential().ok();
            let session = credential.as_ref().map(|(id, _)| *id);
            let key = credential.as_ref().map(|(_, key)| key);
            let folders = std::iter::once((None, "Saved Messages".to_string()))
                .chain(
                    discovered
                        .into_iter()
                        .map(|folder| (Some(folder.id), folder.name)),
                )
                .filter(|(id, _)| requested.is_none_or(|folder| *id == folder));
            let mut rows = Vec::new();
            let mut inventory = vec![local_search::InventoryStamp::capture(
                &local_search::inventory_generation(account, Some(i64::MIN)),
            )];
            let mut text_bytes = 0usize;
            let mut complete = true;
            for (folder, name) in folders {
                if rows.len() >= 100_000 || text_bytes >= 32 * 1024 * 1024 {
                    complete = false;
                    break;
                }
                let listing =
                    match crate::file_inventory::messages(account, state.inner(), folder).await {
                        Ok(listing) => listing,
                        Err(error) if error.starts_with("INVENTORY_BUSY:") => {
                            complete = false;
                            break;
                        }
                        Err(error) => return Err(error),
                    };
                if !listing.cached {
                    complete = false;
                    break;
                }
                complete &= listing.complete;
                let mut reader = InventoryMetadataReader::new(account, &client, folder, key);
                let mut folder_rows = Vec::new();
                let mut candidate_bytes = 0usize;
                for message in listing.rows.iter() {
                    account.validate()?;
                    if let Some(session) = session {
                        crypto
                            .with_current_session(session, || ())
                            .map_err(|_| "VAULT_LOCKED: Search credential changed")?;
                    }
                    let file_key =
                        crate::workspace::store::file_key(folder, i64::from(message.id()));
                    if let Some(file) = reader.read(message, (false, false)).await? {
                        let row = WorkspaceFile {
                            key: file_key,
                            folder_name: name.clone(),
                            tags: Vec::new(),
                            collection_ids: Vec::new(),
                            file,
                        };
                        candidate_bytes =
                            candidate_bytes.saturating_add(local_search::row_bytes(&row));
                        folder_rows.push(row);
                        if rows.len() + folder_rows.len() > 100_000
                            || text_bytes.saturating_add(candidate_bytes) > 32 * 1024 * 1024
                        {
                            complete = false;
                            break;
                        }
                    }
                }
                let scope = account.clone();
                let assembled = tokio::task::spawn_blocking(move || {
                    scope.validate()?;
                    let store = Store::open(&scope.root, scope.owner)?;
                    let folder_complete =
                        append_search_folder(&mut rows, folder_rows, &store, &mut text_bytes)?;
                    Ok::<_, String>((rows, text_bytes, folder_complete))
                })
                .await
                .map_err(|error| error.to_string())??;
                rows = assembled.0;
                text_bytes = assembled.1;
                complete &= assembled.2;
                listing.ticket.validate(account)?;
                inventory.push(listing.generation);
            }
            account.validate()?;
            if let Some(session) = session {
                crypto
                    .with_current_session(session, || ())
                    .map_err(|_| "VAULT_LOCKED: Search credential changed")?;
            }
            Ok(Snapshot {
                rows,
                folders: folder_ids,
                credential: session,
                complete,
                offline: false,
                inventory,
            })
        })
    }
}

pub(crate) async fn with_app(
    app: tauri::AppHandle,
    owner: Option<&str>,
    query: Query,
) -> Result<Reply, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, owner)?;
    let crypto = app.state::<CryptoState>().inner().clone();
    local_search::search(account, crypto, query, &LiveSource(app)).await
}
#[tauri::command]
pub(crate) async fn cmd_search_local(
    app: tauri::AppHandle,
    owner_id: String,
    query: Query,
) -> Result<Reply, String> {
    with_app(app, Some(&owner_id), query).await
}
#[tauri::command]
pub(crate) async fn cmd_search_saved(
    app: tauri::AppHandle,
    owner_id: String,
    id: String,
    offset: Option<usize>,
    index_id: Option<String>,
) -> Result<Reply, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, Some(&owner_id))?;
    let value: SavedSearch = tokio::task::spawn_blocking(move || {
        account.validate()?;
        Store::open(&account.root, account.owner)?
            .record("search", &id)?
            .ok_or_else(|| "SEARCH_NOT_FOUND".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut query = Query::saved(&value)?;
    query.offset = offset.unwrap_or(0);
    query.index_id = index_id;
    with_app(app, Some(&owner_id), query).await
}
