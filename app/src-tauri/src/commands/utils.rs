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
        resolve_cached_peer(peer_cache, fid, || async {
            let mut discovered = HashMap::new();
            let mut dialogs = client.iter_dialogs();
            while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
                let id = match &dialog.peer {
                    Peer::Channel(channel) => Some(channel.raw.id),
                    Peer::User(user) => Some(user.raw.id()),
                    _ => None,
                };
                if let Some(id) = id {
                    discovered.insert(id, dialog.peer);
                    if id == fid {
                        break;
                    }
                }
            }
            Ok(discovered)
        })
        .await
    } else {
        client
            .get_me()
            .await
            .map(Peer::User)
            .map_err(|e| e.to_string())
    }
}

#[derive(Default)]
struct PeerDiscovery {
    lock: tokio::sync::Mutex<()>,
    epoch: std::sync::atomic::AtomicU64,
}
static PEER_DISCOVERY: std::sync::LazyLock<
    std::sync::Mutex<HashMap<usize, std::sync::Weak<PeerDiscovery>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
fn discovery<P>(cache: &Arc<RwLock<HashMap<i64, P>>>) -> Arc<PeerDiscovery> {
    let key = Arc::as_ptr(cache) as usize;
    let mut flights = PEER_DISCOVERY.lock().unwrap_or_else(|e| e.into_inner());
    flights.retain(|_, flight| flight.strong_count() > 0);
    if let Some(flight) = flights.get(&key).and_then(std::sync::Weak::upgrade) {
        return flight;
    }
    let flight = Arc::new(PeerDiscovery::default());
    flights.insert(key, Arc::downgrade(&flight));
    flight
}

pub(crate) async fn resolve_cached_peer<P, F, Fut>(
    cache: &Arc<RwLock<HashMap<i64, P>>>,
    id: i64,
    discover: F,
) -> Result<P, String>
where
    P: Clone,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<HashMap<i64, P>, String>>,
{
    let discovery = discovery(cache);
    let epoch = discovery.epoch.load(std::sync::atomic::Ordering::SeqCst);
    let check = || {
        if discovery.epoch.load(std::sync::atomic::Ordering::SeqCst) != epoch {
            Err("ACCOUNT_CHANGED: Peer discovery was cleared".to_string())
        } else {
            Ok(())
        }
    };
    {
        let cached = cache.read().await;
        check()?;
        if let Some(peer) = cached.get(&id).cloned() {
            return Ok(peer);
        }
    }
    let _flight = discovery.lock.lock().await;
    check()?;
    {
        let cached = cache.read().await;
        check()?;
        if let Some(peer) = cached.get(&id).cloned() {
            return Ok(peer);
        }
    }
    let discovered = discover().await?;
    let mut published = cache.write().await;
    if discovery.epoch.load(std::sync::atomic::Ordering::SeqCst) != epoch {
        return Err("ACCOUNT_CHANGED: Peer discovery was cleared".into());
    }
    published.extend(discovered);
    published
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("Folder/Chat {id} not found"))
}

/// Walk dialogs and publish their peers. The visitor also builds the folder
/// result, while the account check binds publication to the originating session.
pub(crate) async fn scan_peer_snapshot<S, T, P, V>(
    cache: &RwLock<HashMap<i64, P>>,
    dialogs: S,
    mut visit: V,
    account: &crate::workspace::AccountGuard,
) -> Result<usize, String>
where
    S: futures::Stream<Item = Result<T, String>>,
    V: FnMut(T) -> Option<(i64, P)>,
{
    use futures::StreamExt;
    futures::pin_mut!(dialogs);
    let mut peers = HashMap::new();
    while let Some(dialog) = dialogs.next().await {
        if let Some((id, peer)) = visit(dialog?) {
            peers.insert(id, peer);
        }
    }
    let count = peers.len();
    let mut published = cache.write().await;
    account.validate()?;
    *published = peers;
    Ok(count)
}

/// Clear the peer cache (called on logout)
pub async fn clear_peer_cache(peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>) {
    clear_cached_peers(peer_cache).await;
}

pub(crate) async fn clear_cached_peers<P>(peer_cache: &Arc<RwLock<HashMap<i64, P>>>) {
    let discovery = discovery(peer_cache);
    discovery
        .epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    peer_cache.write().await.clear();
}

#[tauri::command]
pub fn cmd_get_bandwidth(
    bw_state: State<'_, Arc<BandwidthManager>>,
) -> Result<crate::bandwidth::BandwidthStats, String> {
    bw_state.checked_stats()
}

#[tauri::command]
pub fn cmd_set_weekly_quota(
    limit_bytes: u64,
    bw_state: State<'_, Arc<BandwidthManager>>,
) -> Result<crate::bandwidth::BandwidthStats, String> {
    bw_state.set_limit(limit_bytes)
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
