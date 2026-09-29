use crate::bandwidth::BandwidthManager;
use grammers_client::types::{Media, Peer};
use grammers_client::Client;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;

/// Resolve a folder_id to a Telegram Peer, using the cache for O(1) lookups.
///
/// - `folder_id == None` → returns the user's own peer (Saved Messages)
/// - Cache hit → returns immediately without any network call
/// - Cache miss → scans all dialogs, populates the cache, and returns
pub async fn resolve_peer(
    client: &Client,
    folder_id: Option<i64>,
    peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>,
) -> Result<Peer, String> {
    if let Some(fid) = folder_id {
        // Fast path: check cache
        {
            let cache = peer_cache.read().await;
            if let Some(peer) = cache.get(&fid) {
                return Ok(peer.clone());
            }
        }

        // Slow path: take the write lock for the duration of discovery. This
        // intentionally single-flights cache population so startup folder
        // discovery and a file request cannot walk every dialog concurrently.
        let mut cache = peer_cache.write().await;
        if let Some(peer) = cache.get(&fid) {
            return Ok(peer.clone());
        }
        log::debug!("Peer cache miss for folder_id={}, scanning dialogs...", fid);
        let mut dialogs = client.iter_dialogs();
        while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
            let peer_id = match &dialog.peer {
                Peer::Channel(c) => Some(c.raw.id),
                Peer::User(u) => Some(u.raw.id()),
                _ => None,
            };
            if let Some(id) = peer_id {
                cache.insert(id, dialog.peer.clone());
                if id == fid {
                    // A targeted file open should not wait for the rest of the
                    // account merely to warm an optional in-memory cache.
                    return Ok(dialog.peer);
                }
            }
        }
        Err(format!("Folder/Chat {} not found", fid))
    } else {
        match client.get_me().await {
            Ok(me) => Ok(Peer::User(me)),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Clear the peer cache (called on logout)
pub async fn clear_peer_cache(peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>) {
    peer_cache.write().await.clear();
}

#[tauri::command]
pub fn cmd_get_bandwidth(
    bw_state: State<'_, Arc<BandwidthManager>>,
) -> crate::bandwidth::BandwidthStats {
    bw_state.get_stats()
}

pub fn map_error(e: impl std::fmt::Display) -> String {
    let err_str = e.to_string();
    if err_str.contains("FLOOD_WAIT") {
        // Expected format: ... (value: 1234)
        if let Some(start) = err_str.find("(value: ") {
            let rest = &err_str[start + 8..];
            if let Some(end) = rest.find(')') {
                if let Ok(seconds) = rest[..end].parse::<i64>() {
                    return format!("FLOOD_WAIT_{}", seconds);
                }
            }
        }
        // Fallback if parsing fails but we know it's a flood wait
        return "FLOOD_WAIT_60".to_string();
    }
    err_str
}

/// Parse the numeric part of Telegram's normalized FLOOD_WAIT marker.
/// Callers retain their own case normalization, delay bounds, and retry policy.
pub(crate) fn flood_wait_seconds(error: &str) -> Option<u64> {
    const MARKER: &str = "FLOOD_WAIT_";
    let start = error.find(MARKER)? + MARKER.len();
    let digits: String = error[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// Return Telegram's declared byte size for downloadable media.
///
/// Photos do not expose a document-level size. Grammers derives their size
/// from the largest available photo representation, which is the same media
/// variant downloaded when the original photo is requested.
pub fn media_size(media: &Media) -> u64 {
    let size = match media {
        Media::Document(document) => document.size(),
        Media::Photo(photo) => photo.size(),
        _ => 0,
    };

    nonnegative_size(size)
}

fn nonnegative_size(size: i64) -> u64 {
    u64::try_from(size).unwrap_or(0)
}
