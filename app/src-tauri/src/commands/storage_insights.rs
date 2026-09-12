use std::collections::HashMap;

use grammers_client::types::{Media, Peer};
use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::utils::{media_size, resolve_peer};
use crate::commands::TelegramState;
use crate::models::FileMetadata;
use crate::workspace::AccountGuard;

const DEFAULT_LARGE_FILE_BYTES: u64 = 100 * 1024 * 1024;
const DEFAULT_OLD_FILE_DAYS: i64 = 365;
const FILES_PER_FOLDER_LIMIT: usize = 400;

#[derive(Debug, Serialize)]
pub struct StorageInsightResult {
    files: Vec<FileMetadata>,
    scanned_count: usize,
    duplicate_groups: usize,
}

#[derive(Clone)]
struct IndexedFile {
    metadata: FileMetadata,
    created_at_unix: i64,
}

fn duplicate_key(file: &FileMetadata) -> (String, u64) {
    (file.name.trim().to_lowercase(), file.size)
}

async fn scan_drive_files(
    state: &TelegramState,
    account: &AccountGuard,
    vault_unlocked: bool,
) -> Result<Vec<IndexedFile>, String> {
    account.validate()?;
    let client = state
        .client
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Telegram client is not connected".to_string())?;
    account.validate_client(&client).await?;
    let mut peers = Vec::new();
    if let Ok(peer) = resolve_peer(&client, None, &state.peer_cache).await {
        peers.push((None, peer));
    }
    account.validate()?;

    let mut dialogs = client.iter_dialogs();
    while let Some(dialog) = dialogs.next().await.map_err(|error| error.to_string())? {
        account.validate()?;
        if let Peer::Channel(ref channel) = dialog.peer {
            if channel.raw.title.to_lowercase().contains("[td]") {
                peers.push((Some(channel.raw.id), dialog.peer.clone()));
            }
        }
    }

    let mut files = Vec::new();
    for (folder_id, peer) in peers {
        account.validate()?;
        let mut messages = client.iter_messages(peer).limit(FILES_PER_FOLDER_LIMIT);
        while let Some(message) = messages.next().await.map_err(|error| error.to_string())? {
            account.validate()?;
            let Some(media) = message.media() else {
                continue;
            };
            let size = media_size(&media);
            let (document_name, mut mime_type) = match &media {
                Media::Document(document) => (
                    document.name().to_string(),
                    document.mime_type().map(str::to_string),
                ),
                Media::Photo(_) => ("Photo.jpg".to_string(), Some("image/jpeg".to_string())),
                _ => continue,
            };
            let caption = message.text();
            let mut name = if caption.is_empty() {
                document_name.clone()
            } else {
                caption.to_string()
            };
            let suspected_protected =
                crate::workspace::envelope_cache::suspected_envelope(&document_name, caption);
            let protected = match crate::commands::fs::resolve_remote_envelope(
                account,
                &client,
                folder_id,
                message.id(),
                &media,
                caption,
            )
            .await
            {
                Ok(record) => record,
                Err(error) => {
                    account.validate()?;
                    log::debug!("Storage insight could not inspect encrypted header: {error}");
                    None
                }
            };
            let (size, encryption_state) = if let Some(info) = protected {
                if info.metadata_protected {
                    name = "Encrypted file".to_string();
                    mime_type = Some("application/octet-stream".to_string());
                }
                let state = if vault_unlocked
                    && matches!(
                        info.protection_mode.as_str(),
                        "vault" | "vault_and_passphrase"
                    ) {
                    "encrypted_unlocked"
                } else {
                    "encrypted_locked"
                };
                (info.plaintext_size.unwrap_or(size), state)
            } else if suspected_protected {
                name = "Encrypted file".to_string();
                mime_type = Some("application/octet-stream".to_string());
                (size, "encrypted_key_missing")
            } else {
                (size, "plain")
            };
            let file_ext = std::path::Path::new(&name)
                .extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_string);
            files.push(IndexedFile {
                metadata: FileMetadata {
                    id: i64::from(message.id()),
                    folder_id,
                    name,
                    size,
                    mime_type,
                    file_ext,
                    created_at: message.date().to_string(),
                    icon_type: "file".to_string(),
                    encryption_state: encryption_state.to_string(),
                    is_favorite: false,
                    is_pinned: false,
                },
                created_at_unix: message.date().timestamp(),
            });
        }
    }
    account.validate()?;
    Ok(files)
}

#[tauri::command]
pub async fn cmd_get_storage_insight(
    app: tauri::AppHandle,
    owner_id: Option<String>,
    state: State<'_, TelegramState>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    view: String,
    large_threshold_bytes: Option<u64>,
    old_file_days: Option<i64>,
) -> Result<StorageInsightResult, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, owner_id.as_deref())?;
    let vault_unlocked = crypto_state.get_current_wrapping_key().is_ok();
    let indexed = scan_drive_files(&state, &account, vault_unlocked).await?;
    let scanned_count = indexed.len();
    let mut duplicate_groups = 0;

    let mut files = match view.as_str() {
        "large" => {
            let threshold = large_threshold_bytes
                .unwrap_or(DEFAULT_LARGE_FILE_BYTES)
                .max(1);
            let mut matches: Vec<_> = indexed
                .into_iter()
                .filter(|file| file.metadata.size >= threshold)
                .map(|file| file.metadata)
                .collect();
            matches.sort_by_key(|file| std::cmp::Reverse(file.size));
            matches
        }
        "old" => {
            let days = old_file_days
                .unwrap_or(DEFAULT_OLD_FILE_DAYS)
                .clamp(1, 36500);
            let cutoff = chrono::Utc::now().timestamp() - days * 86_400;
            let mut matches: Vec<_> = indexed
                .into_iter()
                .filter(|file| file.created_at_unix <= cutoff)
                .collect();
            matches.sort_by_key(|file| file.created_at_unix);
            matches.into_iter().map(|file| file.metadata).collect()
        }
        "duplicates" => {
            let mut groups: HashMap<(String, u64), Vec<FileMetadata>> = HashMap::new();
            for file in indexed {
                groups
                    .entry(duplicate_key(&file.metadata))
                    .or_default()
                    .push(file.metadata);
            }
            let mut matches = Vec::new();
            for mut group in groups.into_values().filter(|group| group.len() > 1) {
                duplicate_groups += 1;
                group.sort_by_key(|file| (file.folder_id, file.id));
                matches.extend(group);
            }
            matches.sort_by_cached_key(|file| file.name.to_lowercase());
            matches
        }
        _ => return Err("Unknown storage insight".to_string()),
    };

    files.truncate(1_000);
    account.validate()?;
    Ok(StorageInsightResult {
        files,
        scanned_count,
        duplicate_groups,
    })
}

#[cfg(test)]
mod tests {
    use super::duplicate_key;
    use crate::models::FileMetadata;

    fn file(name: &str, size: u64) -> FileMetadata {
        FileMetadata {
            id: 1,
            folder_id: None,
            name: name.to_string(),
            size,
            mime_type: None,
            file_ext: None,
            created_at: String::new(),
            icon_type: "file".to_string(),
            encryption_state: "plain".to_string(),
            is_favorite: false,
            is_pinned: false,
        }
    }

    #[test]
    fn duplicate_matching_is_case_insensitive_but_size_sensitive() {
        assert_eq!(
            duplicate_key(&file(" Report.PDF ", 10)),
            duplicate_key(&file("report.pdf", 10))
        );
        assert_ne!(
            duplicate_key(&file("report.pdf", 10)),
            duplicate_key(&file("report.pdf", 11))
        );
    }
}
