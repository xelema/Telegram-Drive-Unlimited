use std::collections::HashMap;

use grammers_client::types::{Media, Peer};
use serde::Serialize;
use tauri::State;

use crate::commands::utils::{media_size, resolve_peer};
use crate::commands::TelegramState;
use crate::db::DbConnection;
use crate::models::FileMetadata;

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

#[derive(Clone)]
struct ProtectedInsight {
    plaintext_size: Option<u64>,
    protection_mode: String,
    metadata_protected: bool,
}

fn duplicate_key(file: &FileMetadata) -> (String, u64) {
    (file.name.trim().to_lowercase(), file.size)
}

fn load_protected_files(
    db_pool: &DbConnection,
) -> Result<HashMap<(String, i32), ProtectedInsight>, String> {
    let connection = db_pool
        .lock()
        .map_err(|_| "Database lock is unavailable".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT folder_key, message_id, plaintext_size, protection_mode, metadata_protected
             FROM encrypted_files WHERE record_state = 'active'",
        )
        .map_err(|error| error.to_string())?;
    let mut protected = HashMap::new();
    while let sqlite::State::Row = statement.next().map_err(|error| error.to_string())? {
        let folder_key = statement
            .read::<String, _>(0)
            .map_err(|error| error.to_string())?;
        let message_id = statement
            .read::<i64, _>(1)
            .map_err(|error| error.to_string())? as i32;
        protected.insert(
            (folder_key, message_id),
            ProtectedInsight {
                plaintext_size: statement
                    .read::<Option<i64>, _>(2)
                    .ok()
                    .flatten()
                    .and_then(|size| u64::try_from(size).ok()),
                protection_mode: statement
                    .read::<String, _>(3)
                    .unwrap_or_else(|_| "vault".to_string()),
                metadata_protected: statement.read::<i64, _>(4).unwrap_or(1) != 0,
            },
        );
    }
    Ok(protected)
}

async fn scan_drive_files(
    state: &TelegramState,
    protected_files: &HashMap<(String, i32), ProtectedInsight>,
    vault_unlocked: bool,
) -> Result<Vec<IndexedFile>, String> {
    let client = state
        .client
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Telegram client is not connected".to_string())?;
    let mut peers = Vec::new();
    if let Ok(peer) = resolve_peer(&client, None, &state.peer_cache).await {
        peers.push((None, peer));
    }

    let mut dialogs = client.iter_dialogs();
    while let Some(dialog) = dialogs.next().await.map_err(|error| error.to_string())? {
        if let Peer::Channel(ref channel) = dialog.peer {
            if channel.raw.title.to_lowercase().contains("[td]") {
                peers.push((Some(channel.raw.id), dialog.peer.clone()));
            }
        }
    }

    let mut files = Vec::new();
    for (folder_id, peer) in peers {
        let mut messages = client.iter_messages(peer).limit(FILES_PER_FOLDER_LIMIT);
        while let Some(message) = messages.next().await.map_err(|error| error.to_string())? {
            let Some(media) = message.media() else {
                continue;
            };
            let size = media_size(&media);
            let (document_name, mut mime_type) = match media {
                Media::Document(document) => (
                    document.name().to_string(),
                    document.mime_type().map(str::to_string),
                ),
                Media::Photo(_) => ("Photo.jpg".to_string(), Some("image/jpeg".to_string())),
                _ => continue,
            };
            let caption = message.text();
            let mut name = if caption.is_empty() {
                document_name
            } else {
                caption.to_string()
            };
            let folder_key = folder_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "home".to_string());
            let protected = protected_files.get(&(folder_key, message.id()));
            let suspected_protected =
                name == "TDENC2" || name.to_ascii_lowercase().ends_with(".tdenc");
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
    Ok(files)
}

#[tauri::command]
pub async fn cmd_get_storage_insight(
    state: State<'_, TelegramState>,
    db_pool: State<'_, DbConnection>,
    crypto_state: State<'_, crate::crypto::state::CryptoState>,
    view: String,
    large_threshold_bytes: Option<u64>,
    old_file_days: Option<i64>,
) -> Result<StorageInsightResult, String> {
    let protected_files = load_protected_files(&db_pool)?;
    let vault_unlocked = crypto_state.get_current_wrapping_key().is_ok();
    let indexed = scan_drive_files(&state, &protected_files, vault_unlocked).await?;
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
            matches.sort_by(|left, right| right.size.cmp(&left.size));
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
            matches.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
            matches
        }
        _ => return Err("Unknown storage insight".to_string()),
    };

    files.truncate(1_000);
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
