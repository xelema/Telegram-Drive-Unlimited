#![cfg(not(any(target_os = "android", target_os = "ios")))]

use actix_web::{web, Either, HttpResponse};
use bytes::{Buf, Bytes};
use dav_server::actix::{DavRequest, DavResponse};
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavFileSystem, DavMetaData, FsError, FsFuture, FsResult, FsStream,
    OpenOptions, ReadDirMeta,
};
use dav_server::memls::MemLs;
use dav_server::DavHandler;
use futures::stream;
use grammers_client::types::{Media, Peer};
use grammers_client::InputMessage;
use grammers_tl_types as tl;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::bandwidth::{BandwidthManager, BandwidthReservation};
use crate::commands::utils::{map_error, media_size, resolve_peer};
use crate::commands::{
    create_folder_inner, delete_folder_inner, rename_folder_inner, TelegramState,
};
use crate::db::DbConnection;
use crate::vpn_optimizer::NetworkConfig;

const INDEX_TTL: Duration = Duration::from_secs(15);
const MAX_LISTED_FILES: usize = 50_000;
const READ_CHUNK_SIZE: i32 = 524_288;
const CDN_ALIGNMENT: u64 = 524_288;

#[derive(Clone)]
pub struct WebDavAuth {
    token_hash: String,
}

#[derive(Clone, Debug)]
enum DavNode {
    Root,
    Folder {
        folder_id: Option<i64>,
        modified: SystemTime,
    },
    File {
        folder_id: Option<i64>,
        message_id: i32,
        size: u64,
        modified: SystemTime,
        encrypted: bool,
    },
}

impl DavNode {
    fn metadata(&self) -> DavMetadata {
        match self {
            Self::Root => DavMetadata::directory(UNIX_EPOCH),
            Self::Folder { modified, .. } => DavMetadata::directory(*modified),
            Self::File {
                message_id,
                size,
                modified,
                ..
            } => DavMetadata {
                len: *size,
                modified: *modified,
                is_dir: false,
                etag: Some(format!("td-{}-{}", message_id, size)),
            },
        }
    }
}

#[derive(Default)]
struct DavIndex {
    nodes: HashMap<String, DavNode>,
    children: HashMap<String, Vec<String>>,
    refreshed: HashMap<String, Instant>,
}

#[derive(Clone)]
pub struct TelegramDavFs {
    state: Arc<TelegramState>,
    bandwidth: Arc<BandwidthManager>,
    network: Arc<NetworkConfig>,
    db: DbConnection,
    write_enabled: bool,
    staging_dir: PathBuf,
    index: Arc<tokio::sync::RwLock<DavIndex>>,
}

impl TelegramDavFs {
    pub fn new(
        state: Arc<TelegramState>,
        bandwidth: Arc<BandwidthManager>,
        network: Arc<NetworkConfig>,
        db: DbConnection,
        write_enabled: bool,
        staging_dir: PathBuf,
    ) -> Self {
        Self {
            state,
            bandwidth,
            network,
            db,
            write_enabled,
            staging_dir,
            index: Arc::new(tokio::sync::RwLock::new(DavIndex::default())),
        }
    }

    async fn client(&self) -> FsResult<grammers_client::Client> {
        self.state
            .client
            .lock()
            .await
            .clone()
            .ok_or(FsError::GeneralFailure)
    }

    async fn should_refresh(&self, path: &str) -> bool {
        self.index
            .read()
            .await
            .refreshed
            .get(path)
            .map(|when| when.elapsed() >= INDEX_TTL)
            .unwrap_or(true)
    }

    async fn refresh_root(&self) -> FsResult<()> {
        if !self.should_refresh("/").await {
            return Ok(());
        }
        let mut raw_folders = vec![(None, "Saved Messages".to_string(), UNIX_EPOCH)];
        let mut discovered = HashMap::new();
        if let Ok(client) = self.client().await {
            let mut dialogs = client.iter_dialogs();
            loop {
                match dialogs.next().await {
                    Ok(Some(dialog)) => {
                        if let Peer::Channel(channel) = &dialog.peer {
                            discovered.insert(channel.raw.id, dialog.peer.clone());
                            if channel.raw.title.to_ascii_lowercase().contains("[td]") {
                                let name = channel
                                    .raw
                                    .title
                                    .replace(" [TD]", "")
                                    .replace(" [td]", "")
                                    .replace("[TD]", "")
                                    .replace("[td]", "")
                                    .trim()
                                    .to_string();
                                raw_folders.push((Some(channel.raw.id), name, UNIX_EPOCH));
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        log::warn!("WebDAV root dialog scan failed; using cached folders: {error}");
                        break;
                    }
                }
            }
            self.state.peer_cache.write().await.extend(discovered);
        }

        // The desktop app persists the folder/channel index locally. Use it as a
        // fallback so the WebDAV root remains useful during a delayed Telegram
        // dialog refresh or when a channel's legacy title lacks the [TD] marker.
        let cached_folders = crate::db::with_connection(self.db.clone(), |connection| {
            let mut folders = Vec::new();
            if let Ok(mut statement) = connection
                .prepare("SELECT channel_id, name FROM folder_metadata ORDER BY display_order ASC")
            {
                while let Ok(sqlite::State::Row) = statement.next() {
                    let Ok(channel_id) = statement.read::<i64, _>(0) else {
                        continue;
                    };
                    let Ok(name) = statement.read::<String, _>(1) else {
                        continue;
                    };
                    folders.push((channel_id, name));
                }
            }
            Ok(folders)
        })
        .await
        .unwrap_or_default();
        for (channel_id, name) in cached_folders {
            if !raw_folders
                .iter()
                .any(|(folder_id, _, _)| *folder_id == Some(channel_id))
            {
                raw_folders.push((Some(channel_id), name, UNIX_EPOCH));
            }
        }

        raw_folders.sort_by(|left, right| left.1.to_lowercase().cmp(&right.1.to_lowercase()));
        let aliases = unique_aliases(
            raw_folders
                .iter()
                .map(|(id, name, _)| (id.unwrap_or(0), name.as_str())),
        );

        let mut index = self.index.write().await;
        let previous = index.children.remove("/").unwrap_or_default();
        for path in previous {
            index.nodes.remove(&path);
            index.children.remove(&path);
            index.refreshed.remove(&path);
        }
        index.nodes.insert("/".to_string(), DavNode::Root);
        let mut children = Vec::new();
        for ((folder_id, _name, modified), alias) in raw_folders.into_iter().zip(aliases) {
            let path = format!("/{}", alias);
            index.nodes.insert(
                path.clone(),
                DavNode::Folder {
                    folder_id,
                    modified,
                },
            );
            children.push(path);
        }
        index.children.insert("/".to_string(), children);
        index.refreshed.insert("/".to_string(), Instant::now());
        Ok(())
    }

    async fn encrypted_message_ids(&self, folder_id: Option<i64>) -> HashSet<i32> {
        let folder_key = folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "home".to_string());
        crate::db::with_connection(self.db.clone(), move |connection| {
            let mut statement = connection.prepare(
                "SELECT message_id FROM encrypted_files WHERE folder_key = ? AND record_state = 'active'",
            ).map_err(|error| error.to_string())?;
            statement.bind((1, folder_key.as_str())).map_err(|error| error.to_string())?;
            let mut ids = HashSet::new();
            while matches!(statement.next(), Ok(sqlite::State::Row)) {
                if let Ok(id) = statement.read::<i64, _>(0) {
                    ids.insert(id as i32);
                }
            }
            Ok(ids)
        }).await.unwrap_or_default()
    }

    async fn refresh_folder(&self, folder_path: &str) -> FsResult<()> {
        if !self.should_refresh(folder_path).await {
            return Ok(());
        }
        self.refresh_root().await?;
        let folder = self
            .index
            .read()
            .await
            .nodes
            .get(folder_path)
            .cloned()
            .ok_or(FsError::NotFound)?;
        let DavNode::Folder { folder_id, .. } = folder else {
            return Err(FsError::Forbidden);
        };

        let client = self.client().await?;
        let peer = resolve_peer(&client, folder_id, &self.state.peer_cache)
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        let encrypted_ids = self.encrypted_message_ids(folder_id).await;
        let mut messages = client.iter_messages(&peer);
        let mut raw_files = Vec::new();
        while raw_files.len() < MAX_LISTED_FILES {
            let Some(message) = messages.next().await.map_err(|_| FsError::GeneralFailure)? else {
                break;
            };
            let Some(media) = message.media() else {
                continue;
            };
            let size = media_size(&media);
            let remote_name = match media {
                Media::Document(document) => document.name().to_string(),
                Media::Photo(_) => "Photo.jpg".to_string(),
                _ => continue,
            };
            let caption = message.text();
            let name = if caption.is_empty() {
                remote_name
            } else {
                caption.to_string()
            };
            let timestamp = message.date().timestamp().max(0) as u64;
            raw_files.push((
                message.id(),
                name,
                size,
                UNIX_EPOCH + Duration::from_secs(timestamp),
                encrypted_ids.contains(&message.id()),
            ));
        }
        raw_files.sort_by_key(|entry| entry.0);
        let aliases = unique_aliases(
            raw_files
                .iter()
                .map(|(id, name, ..)| (i64::from(*id), name.as_str())),
        );

        let mut index = self.index.write().await;
        let previous = index.children.remove(folder_path).unwrap_or_default();
        for path in previous {
            index.nodes.remove(&path);
        }
        let mut children = Vec::new();
        for ((message_id, _name, size, modified, encrypted), alias) in
            raw_files.into_iter().zip(aliases)
        {
            let path = format!("{}/{}", folder_path, alias);
            index.nodes.insert(
                path.clone(),
                DavNode::File {
                    folder_id,
                    message_id,
                    size,
                    modified,
                    encrypted,
                },
            );
            children.push(path);
        }
        index.children.insert(folder_path.to_string(), children);
        index
            .refreshed
            .insert(folder_path.to_string(), Instant::now());
        Ok(())
    }

    async fn refresh_for_path(&self, path: &str) -> FsResult<()> {
        self.refresh_root().await?;
        let segments = path_segments(path);
        if segments.len() >= 2 {
            self.refresh_folder(&format!("/{}", segments[0])).await?;
        }
        Ok(())
    }

    async fn node(&self, path: &str) -> FsResult<DavNode> {
        self.refresh_for_path(path).await?;
        self.index
            .read()
            .await
            .nodes
            .get(path)
            .cloned()
            .ok_or(FsError::NotFound)
    }

    async fn invalidate(&self, folder_path: &str) {
        let mut index = self.index.write().await;
        index.refreshed.remove(folder_path);
        if folder_path == "/" {
            index.refreshed.clear();
        }
    }

    async fn folder_for_path(&self, path: &str) -> FsResult<(String, Option<i64>)> {
        let segments = path_segments(path);
        let Some(folder_name) = segments.first() else {
            return Err(FsError::Forbidden);
        };
        let folder_path = format!("/{folder_name}");
        let node = self.node(&folder_path).await?;
        match node {
            DavNode::Folder { folder_id, .. } => Ok((folder_path, folder_id)),
            _ => Err(FsError::Forbidden),
        }
    }

    async fn fetch_media(
        &self,
        folder_id: Option<i64>,
        message_id: i32,
    ) -> FsResult<(grammers_client::Client, Media)> {
        let client = self.client().await?;
        let peer = resolve_peer(&client, folder_id, &self.state.peer_cache)
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        let messages = client
            .get_messages_by_id(&peer, &[message_id])
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        let message = messages
            .into_iter()
            .flatten()
            .next()
            .ok_or(FsError::NotFound)?;
        let media = message.media().ok_or(FsError::NotFound)?;
        Ok((client, media))
    }

    async fn upload_temp_file(&self, target_path: &str, temp_path: &Path) -> FsResult<DavMetadata> {
        if !self.write_enabled {
            return Err(FsError::Forbidden);
        }
        let segments = path_segments(target_path);
        if segments.len() != 2 {
            return Err(FsError::Forbidden);
        }
        let filename = validate_portable_name(segments[1])?;
        if is_system_metadata(&filename) {
            return Err(FsError::Forbidden);
        }
        let (folder_path, folder_id) = self.folder_for_path(target_path).await?;
        let existing = self.node(target_path).await.ok();
        if matches!(
            existing,
            Some(DavNode::File {
                encrypted: true,
                ..
            })
        ) {
            return Err(FsError::Forbidden);
        }

        let size = tokio::fs::metadata(temp_path)
            .await
            .map_err(|_| FsError::GeneralFailure)?
            .len();
        let mut reservation = BandwidthReservation::upload(self.bandwidth.clone(), size)
            .map_err(|_| FsError::InsufficientStorage)?;
        let client = self.client().await?;
        let peer = resolve_peer(&client, folder_id, &self.state.peer_cache)
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        let mut file = tokio::fs::File::open(temp_path)
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        let uploaded = client
            .upload_stream(&mut file, size as usize, filename.clone())
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        let outgoing = InputMessage::new().text("").file(uploaded);

        let mut sent = None;
        let mut last_error = String::new();
        for attempt in 0..=self.network.retry_attempts() {
            match client.send_message(&peer, outgoing.clone()).await {
                Ok(message) => {
                    sent = Some(message);
                    break;
                }
                Err(error) => {
                    last_error = map_error(error);
                    if self.network.should_respect_flood_wait()
                        && last_error.starts_with("FLOOD_WAIT_")
                    {
                        if let Ok(seconds) =
                            last_error.trim_start_matches("FLOOD_WAIT_").parse::<u64>()
                        {
                            tokio::time::sleep(Duration::from_secs(seconds.min(300))).await;
                            continue;
                        }
                    }
                    if attempt < self.network.retry_attempts() {
                        let wait = crate::vpn_optimizer::backoff_ms(
                            attempt,
                            self.network.retry_base_backoff_ms(),
                            self.network.retry_max_backoff_ms(),
                        );
                        tokio::time::sleep(Duration::from_millis(wait)).await;
                    }
                }
            }
        }
        let sent = sent.ok_or_else(|| {
            log::error!("WebDAV upload failed: {last_error}");
            FsError::GeneralFailure
        })?;
        reservation.commit();

        if let Some(DavNode::File {
            folder_id: old_folder,
            message_id: old_message,
            ..
        }) = existing
        {
            if let Ok(old_peer) = resolve_peer(&client, old_folder, &self.state.peer_cache).await {
                if let Err(error) = client.delete_messages(&old_peer, &[old_message]).await {
                    log::error!(
                        "WebDAV replacement uploaded as message {} but old message {} could not be deleted: {}",
                        sent.id(),
                        old_message,
                        error
                    );
                    return Err(FsError::GeneralFailure);
                }
            }
        }
        self.invalidate(&folder_path).await;
        Ok(DavMetadata {
            len: size,
            modified: SystemTime::now(),
            is_dir: false,
            etag: Some(format!("td-{}-{}", sent.id(), size)),
        })
    }

    async fn delete_file_node(&self, node: &DavNode) -> FsResult<()> {
        let DavNode::File {
            folder_id,
            message_id,
            encrypted,
            ..
        } = node
        else {
            return Err(FsError::Forbidden);
        };
        if *encrypted {
            return Err(FsError::Forbidden);
        }
        let client = self.client().await?;
        let peer = resolve_peer(&client, *folder_id, &self.state.peer_cache)
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        client
            .delete_messages(&peer, &[*message_id])
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        Ok(())
    }

    async fn edit_message_name(
        &self,
        client: &grammers_client::Client,
        peer: &Peer,
        message_id: i32,
        new_name: String,
    ) -> FsResult<()> {
        let input_peer = peer_to_input_peer(peer)?;
        client
            .invoke(&tl::functions::messages::EditMessage {
                peer: input_peer,
                id: message_id,
                no_webpage: false,
                invert_media: false,
                message: Some(new_name),
                media: None,
                reply_markup: None,
                entities: None,
                schedule_date: None,
                quick_reply_shortcut_id: None,
                schedule_repeat_period: None,
            })
            .await
            .map_err(|_| FsError::GeneralFailure)?;
        Ok(())
    }

    async fn copy_or_move_file(&self, from: &str, to: &str, move_file: bool) -> FsResult<()> {
        if !self.write_enabled {
            return Err(FsError::Forbidden);
        }
        let source = self.node(from).await?;
        let DavNode::File {
            folder_id: source_folder_id,
            message_id,
            encrypted,
            ..
        } = source.clone()
        else {
            return Err(FsError::Forbidden);
        };
        if encrypted {
            return Err(FsError::Forbidden);
        }
        let to_segments = path_segments(to);
        if to_segments.len() != 2 {
            return Err(FsError::Forbidden);
        }
        let new_name = validate_portable_name(to_segments[1])?;
        let (source_folder_path, _) = self.folder_for_path(from).await?;
        let (target_folder_path, target_folder_id) = self.folder_for_path(to).await?;
        let client = self.client().await?;
        let source_peer = resolve_peer(&client, source_folder_id, &self.state.peer_cache)
            .await
            .map_err(|_| FsError::GeneralFailure)?;

        if move_file && source_folder_id == target_folder_id {
            self.edit_message_name(&client, &source_peer, message_id, new_name)
                .await?;
        } else {
            let target_peer = resolve_peer(&client, target_folder_id, &self.state.peer_cache)
                .await
                .map_err(|_| FsError::GeneralFailure)?;
            let forwarded = client
                .forward_messages(&target_peer, &[message_id], &source_peer)
                .await
                .map_err(|_| FsError::GeneralFailure)?;
            let new_message_id = forwarded
                .into_iter()
                .flatten()
                .next()
                .map(|message| message.id())
                .ok_or(FsError::GeneralFailure)?;
            self.edit_message_name(&client, &target_peer, new_message_id, new_name)
                .await?;
            if move_file {
                client
                    .delete_messages(&source_peer, &[message_id])
                    .await
                    .map_err(|_| FsError::GeneralFailure)?;
            }
        }
        self.invalidate(&source_folder_path).await;
        self.invalidate(&target_folder_path).await;
        Ok(())
    }
}

impl DavFileSystem for TelegramDavFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        Box::pin(async move {
            let path = dav_path_string(path)?;
            if options.write {
                if !self.write_enabled || !supports_staged_write(&options) {
                    return Err(FsError::Forbidden);
                }
                if options.create_new && self.node(&path).await.is_ok() {
                    return Err(FsError::Exists);
                }
                tokio::fs::create_dir_all(&self.staging_dir)
                    .await
                    .map_err(|_| FsError::GeneralFailure)?;
                let temp_path = self.staging_dir.join(format!(
                    "webdav-{}-{}",
                    std::process::id(),
                    rand::random::<u64>()
                ));
                let mut file_options = tokio::fs::OpenOptions::new();
                file_options.create_new(true).write(true);
                #[cfg(unix)]
                {
                    file_options.mode(0o600);
                }
                let file = file_options
                    .open(&temp_path)
                    .await
                    .map_err(|_| FsError::GeneralFailure)?;
                let metadata = DavMetadata {
                    len: options.size.unwrap_or(0),
                    modified: SystemTime::now(),
                    is_dir: false,
                    etag: None,
                };
                return Ok(Box::new(TelegramDavFile::Write {
                    fs: self.clone(),
                    target_path: path,
                    temp_path,
                    file,
                    metadata,
                    committed: false,
                }) as Box<dyn DavFile>);
            }

            let node = self.node(&path).await?;
            let DavNode::File {
                folder_id,
                message_id,
                encrypted,
                ..
            } = node.clone()
            else {
                return Err(FsError::Forbidden);
            };
            if encrypted {
                return Err(FsError::Forbidden);
            }
            let (client, media) = self.fetch_media(folder_id, message_id).await?;
            Ok(Box::new(TelegramDavFile::Read {
                client,
                media,
                position: 0,
                metadata: node.metadata(),
                bandwidth: self.bandwidth.clone(),
                download_limit: self.network.download_limit_bytes_per_sec(),
            }) as Box<dyn DavFile>)
        })
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        _meta: ReadDirMeta,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        Box::pin(async move {
            let path = dav_path_string(path)?;
            let node = self.node(&path).await?;
            if !matches!(node, DavNode::Root | DavNode::Folder { .. }) {
                return Err(FsError::Forbidden);
            }
            if matches!(node, DavNode::Folder { .. }) {
                self.refresh_folder(&path).await?;
            }
            let index = self.index.read().await;
            let entries: Vec<FsResult<Box<dyn DavDirEntry>>> = index
                .children
                .get(&path)
                .into_iter()
                .flatten()
                .filter_map(|child_path| {
                    let child = index.nodes.get(child_path)?.clone();
                    let name = child_path.rsplit('/').next()?.as_bytes().to_vec();
                    Some(Ok(Box::new(TelegramDavDirEntry {
                        name,
                        metadata: child.metadata(),
                    }) as Box<dyn DavDirEntry>))
                })
                .collect();
            Ok(Box::pin(stream::iter(entries)) as FsStream<Box<dyn DavDirEntry>>)
        })
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let path = dav_path_string(path)?;
            let node = self.node(&path).await?;
            Ok(Box::new(node.metadata()) as Box<dyn DavMetaData>)
        })
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            if !self.write_enabled {
                return Err(FsError::Forbidden);
            }
            let path = dav_path_string(path)?;
            let segments = path_segments(&path);
            if segments.len() != 1 || segments[0].eq_ignore_ascii_case("Saved Messages") {
                return Err(FsError::Forbidden);
            }
            if self.node(&path).await.is_ok() {
                return Err(FsError::Exists);
            }
            let name = validate_portable_name(segments[0])?;
            let client = self.client().await?;
            create_folder_inner(&name, &client, &self.state.peer_cache)
                .await
                .map_err(|_| FsError::GeneralFailure)?;
            self.invalidate("/").await;
            Ok(())
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            if !self.write_enabled {
                return Err(FsError::Forbidden);
            }
            let path = dav_path_string(path)?;
            let node = self.node(&path).await?;
            let DavNode::Folder { folder_id, .. } = node else {
                return Err(FsError::Forbidden);
            };
            let Some(folder_id) = folder_id else {
                return Err(FsError::Forbidden);
            };
            self.refresh_folder(&path).await?;
            if self
                .index
                .read()
                .await
                .children
                .get(&path)
                .is_some_and(|children| !children.is_empty())
            {
                return Err(FsError::Exists);
            }
            let client = self.client().await?;
            delete_folder_inner(folder_id, &client, &self.state.peer_cache)
                .await
                .map_err(|_| FsError::GeneralFailure)?;
            self.invalidate("/").await;
            Ok(())
        })
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            if !self.write_enabled {
                return Err(FsError::Forbidden);
            }
            let path = dav_path_string(path)?;
            let node = self.node(&path).await?;
            let (folder_path, _) = self.folder_for_path(&path).await?;
            self.delete_file_node(&node).await?;
            self.invalidate(&folder_path).await;
            Ok(())
        })
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            if !self.write_enabled {
                return Err(FsError::Forbidden);
            }
            let from = dav_path_string(from)?;
            let to = dav_path_string(to)?;
            let source = self.node(&from).await?;
            if matches!(source, DavNode::File { .. }) {
                return self.copy_or_move_file(&from, &to, true).await;
            }
            let DavNode::Folder { folder_id, .. } = source else {
                return Err(FsError::Forbidden);
            };
            let Some(folder_id) = folder_id else {
                return Err(FsError::Forbidden);
            };
            let segments = path_segments(&to);
            if segments.len() != 1 || self.node(&to).await.is_ok() {
                return Err(FsError::Exists);
            }
            let new_name = validate_portable_name(segments[0])?;
            let client = self.client().await?;
            rename_folder_inner(folder_id, &new_name, &client, &self.state.peer_cache)
                .await
                .map_err(|_| FsError::GeneralFailure)?;
            self.invalidate("/").await;
            Ok(())
        })
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from = dav_path_string(from)?;
            let to = dav_path_string(to)?;
            if !matches!(self.node(&from).await?, DavNode::File { .. }) {
                return Err(FsError::Forbidden);
            }
            self.copy_or_move_file(&from, &to, false).await
        })
    }
}

// Both variants own substantial async state. Boxing the media would add indirection to every
// read, while the enum itself is already heap-owned behind DavFile trait objects.
#[allow(clippy::large_enum_variant)]
enum TelegramDavFile {
    Read {
        client: grammers_client::Client,
        media: Media,
        position: u64,
        metadata: DavMetadata,
        bandwidth: Arc<BandwidthManager>,
        download_limit: u64,
    },
    Write {
        fs: TelegramDavFs,
        target_path: String,
        temp_path: PathBuf,
        file: tokio::fs::File,
        metadata: DavMetadata,
        committed: bool,
    },
}

impl fmt::Debug for TelegramDavFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { position, .. } => formatter
                .debug_struct("TelegramDavFile::Read")
                .field("position", position)
                .finish(),
            Self::Write {
                target_path,
                committed,
                ..
            } => formatter
                .debug_struct("TelegramDavFile::Write")
                .field("target_path", target_path)
                .field("committed", committed)
                .finish(),
        }
    }
}

impl Drop for TelegramDavFile {
    fn drop(&mut self) {
        if let Self::Write { temp_path, .. } = self {
            let path = temp_path.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = tokio::fs::remove_file(path).await;
                });
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

impl DavFile for TelegramDavFile {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let metadata = match self {
                Self::Read { metadata, .. } | Self::Write { metadata, .. } => metadata.clone(),
            };
            Ok(Box::new(metadata) as Box<dyn DavMetaData>)
        })
    }

    fn write_buf(&mut self, mut buffer: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        let bytes = buffer.copy_to_bytes(buffer.remaining());
        self.write_bytes(bytes)
    }

    fn write_bytes(&mut self, bytes: Bytes) -> FsFuture<'_, ()> {
        Box::pin(async move {
            let Self::Write { file, metadata, .. } = self else {
                return Err(FsError::Forbidden);
            };
            file.write_all(&bytes)
                .await
                .map_err(|_| FsError::GeneralFailure)?;
            metadata.len = metadata.len.max(
                file.stream_position()
                    .await
                    .map_err(|_| FsError::GeneralFailure)?,
            );
            Ok(())
        })
    }

    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        Box::pin(async move {
            let Self::Read {
                client,
                media,
                position,
                metadata,
                bandwidth,
                download_limit,
            } = self
            else {
                return Err(FsError::Forbidden);
            };
            if *position >= metadata.len || count == 0 {
                return Ok(Bytes::new());
            }
            let remaining = metadata.len.saturating_sub(*position);
            let wanted = remaining.min(count as u64) as usize;
            let mut reservation = BandwidthReservation::download(bandwidth.clone(), wanted as u64)
                .map_err(|_| FsError::InsufficientStorage)?;
            let started = Instant::now();
            let bytes = read_media_range(client, media, *position, wanted).await?;
            if *download_limit > 0 {
                let expected = Duration::from_secs_f64(bytes.len() as f64 / *download_limit as f64);
                if let Some(delay) = expected.checked_sub(started.elapsed()) {
                    tokio::time::sleep(delay).await;
                }
            }
            *position += bytes.len() as u64;
            reservation.commit();
            Ok(bytes)
        })
    }

    fn seek(&mut self, seek: SeekFrom) -> FsFuture<'_, u64> {
        Box::pin(async move {
            match self {
                Self::Read {
                    position, metadata, ..
                } => {
                    *position = checked_seek(*position, metadata.len, seek)?;
                    Ok(*position)
                }
                // Telegram uploads are replaced atomically after a complete PUT. Reject
                // ranged/partial writes so a client cannot accidentally replace a remote
                // file with a sparse staging file.
                Self::Write { .. } => Err(FsError::Forbidden),
            }
        })
    }

    fn flush(&mut self) -> FsFuture<'_, ()> {
        Box::pin(async move {
            let Self::Write {
                fs,
                target_path,
                temp_path,
                file,
                metadata,
                committed,
            } = self
            else {
                return Ok(());
            };
            if *committed {
                return Ok(());
            }
            file.flush().await.map_err(|_| FsError::GeneralFailure)?;
            *metadata = fs.upload_temp_file(target_path, temp_path).await?;
            *committed = true;
            Ok(())
        })
    }
}

#[derive(Clone, Debug)]
struct DavMetadata {
    len: u64,
    modified: SystemTime,
    is_dir: bool,
    etag: Option<String>,
}

impl DavMetadata {
    fn directory(modified: SystemTime) -> Self {
        Self {
            len: 0,
            modified,
            is_dir: true,
            etag: None,
        }
    }
}

impl DavMetaData for DavMetadata {
    fn len(&self) -> u64 {
        self.len
    }

    fn modified(&self) -> FsResult<SystemTime> {
        Ok(self.modified)
    }

    fn is_dir(&self) -> bool {
        self.is_dir
    }

    fn etag(&self) -> Option<String> {
        self.etag.clone().or_else(|| {
            self.modified
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|duration| format!("td-dir-{}", duration.as_secs()))
        })
    }
}

struct TelegramDavDirEntry {
    name: Vec<u8>,
    metadata: DavMetadata,
}

impl DavDirEntry for TelegramDavDirEntry {
    fn name(&self) -> Vec<u8> {
        self.name.clone()
    }

    fn metadata(&self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let metadata = self.metadata.clone();
        Box::pin(async move { Ok(Box::new(metadata) as Box<dyn DavMetaData>) })
    }
}

pub fn build_handler(fs: TelegramDavFs, token_hash: String) -> (DavHandler, WebDavAuth) {
    let handler = DavHandler::builder()
        .filesystem(Box::new(fs))
        .locksystem(MemLs::new())
        .principal("telegram-drive-webdav")
        .read_buf_size(READ_CHUNK_SIZE as usize)
        .build_handler();
    (handler, WebDavAuth { token_hash })
}

pub async fn webdav_handler(
    request: DavRequest,
    handler: web::Data<DavHandler>,
    auth: web::Data<WebDavAuth>,
) -> Either<DavResponse, HttpResponse> {
    let original_path = request.request.uri().path().to_string();
    let Some((token, _relative_path)) = split_authenticated_path(&original_path) else {
        return Either::Right(HttpResponse::NotFound().finish());
    };
    if !crate::commands::webdav_settings::verify_token(token, &auth.token_hash) {
        return Either::Right(HttpResponse::NotFound().finish());
    }

    if let Some(destination) = request.request.headers().get("destination") {
        if let Ok(destination) = destination.to_str() {
            if let Some(path_start) = destination_path(destination) {
                let valid_destination =
                    split_authenticated_path(path_start).is_some_and(|(destination_token, _)| {
                        crate::commands::webdav_settings::verify_token(
                            destination_token,
                            &auth.token_hash,
                        )
                    });
                if !valid_destination {
                    return Either::Right(HttpResponse::NotFound().finish());
                }
            } else {
                return Either::Right(HttpResponse::BadRequest().finish());
            }
        } else {
            return Either::Right(HttpResponse::BadRequest().finish());
        }
    }

    // Keep the authenticated prefix in the request and let dav-server strip it.
    // This makes every href in PROPFIND/LOCK responses include /dav/<token>/,
    // which Finder and Explorer require when following child resources.
    let prefix = format!("/dav/{token}");
    let config = DavHandler::builder().strip_prefix(prefix);
    Either::Left(handler.handle_with(config, request.request).await.into())
}

fn destination_path(destination: &str) -> Option<&str> {
    if destination.starts_with('/') {
        return Some(destination);
    }
    let scheme = destination.find("://")?;
    let after_host = &destination[scheme + 3..];
    let slash = after_host.find('/')?;
    Some(&after_host[slash..])
}

fn split_authenticated_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("/dav/")?;
    let (token, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let relative = if tail.is_empty() {
        "/"
    } else {
        &path[path.len() - tail.len() - 1..]
    };
    Some((token, relative))
}

fn dav_path_string(path: &DavPath) -> FsResult<String> {
    String::from_utf8(path.as_bytes().to_vec())
        .map(|value| normalize_index_path(&value))
        .map_err(|_| FsError::Forbidden)
}

fn normalize_index_path(path: &str) -> String {
    if path == "/" {
        "/".to_string()
    } else {
        format!("/{}", path.trim_matches('/'))
    }
}

fn path_segments(path: &str) -> Vec<&str> {
    path.trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect()
}

fn sanitize_name(name: &str) -> String {
    let mut sanitized: String = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect();
    while sanitized.ends_with(['.', ' ']) {
        sanitized.pop();
    }
    if sanitized.is_empty() {
        sanitized.push_str("Untitled");
    }
    if is_windows_reserved_name(&sanitized) {
        sanitized.insert(0, '_');
    }
    if sanitized.chars().count() > 240 {
        sanitized = sanitized.chars().take(240).collect();
    }
    sanitized
}

fn validate_portable_name(name: &str) -> FsResult<String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|character| character == '/' || character == '\0')
    {
        return Err(FsError::Forbidden);
    }
    let sanitized = sanitize_name(name);
    if sanitized != name {
        return Err(FsError::Forbidden);
    }
    Ok(sanitized)
}

fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .and_then(|number| number.parse::<u8>().ok())
            .is_some_and(|number| (1..=9).contains(&number))
}

fn is_system_metadata(name: &str) -> bool {
    name.eq_ignore_ascii_case(".DS_Store")
        || name.starts_with("._")
        || name.eq_ignore_ascii_case("desktop.ini")
        || name.eq_ignore_ascii_case("Thumbs.db")
}

fn unique_aliases<'a>(items: impl Iterator<Item = (i64, &'a str)>) -> Vec<String> {
    let items: Vec<(i64, String)> = items.map(|(id, name)| (id, sanitize_name(name))).collect();
    let mut totals = HashMap::<String, usize>::new();
    for (_, name) in &items {
        *totals.entry(name.to_lowercase()).or_default() += 1;
    }
    let mut used = HashSet::new();
    items
        .into_iter()
        .map(|(id, name)| {
            let key = name.to_lowercase();
            let candidate = if totals.get(&key).copied().unwrap_or(0) > 1 {
                disambiguate_name(&name, id)
            } else {
                name
            };
            let mut unique = candidate.clone();
            let mut counter = 2;
            while !used.insert(unique.to_lowercase()) {
                unique = disambiguate_name(&candidate, counter);
                counter += 1;
            }
            unique
        })
        .collect()
}

fn disambiguate_name(name: &str, id: impl fmt::Display) -> String {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) if !extension.is_empty() => format!("{stem} ({id}).{extension}"),
        _ => format!("{name} ({id})"),
    }
}

fn peer_to_input_peer(peer: &Peer) -> FsResult<tl::enums::InputPeer> {
    match peer {
        Peer::User(user) => {
            let (id, access_hash) = match &user.raw {
                tl::enums::User::User(raw) => (raw.id, raw.access_hash.unwrap_or(0)),
                tl::enums::User::Empty(raw) => (raw.id, 0),
            };
            Ok(tl::enums::InputPeer::User(tl::types::InputPeerUser {
                user_id: id,
                access_hash,
            }))
        }
        Peer::Channel(channel) => Ok(tl::enums::InputPeer::Channel(tl::types::InputPeerChannel {
            channel_id: channel.raw.id,
            access_hash: channel.raw.access_hash.ok_or(FsError::GeneralFailure)?,
        })),
        _ => Err(FsError::Forbidden),
    }
}

async fn read_media_range(
    client: &grammers_client::Client,
    media: &Media,
    start: u64,
    count: usize,
) -> FsResult<Bytes> {
    let aligned_start = (start / CDN_ALIGNMENT) * CDN_ALIGNMENT;
    let skip_chunks = (aligned_start / READ_CHUNK_SIZE as u64) as i32;
    let mut skip_bytes = (start - aligned_start) as usize;
    let mut downloader = client.iter_download(media).chunk_size(READ_CHUNK_SIZE);
    if skip_chunks > 0 {
        downloader = downloader.skip_chunks(skip_chunks);
    }
    let mut output = Vec::with_capacity(count);
    while output.len() < count {
        let Some(chunk) = downloader
            .next()
            .await
            .map_err(|_| FsError::GeneralFailure)?
        else {
            break;
        };
        let data = if skip_bytes >= chunk.len() {
            skip_bytes -= chunk.len();
            continue;
        } else if skip_bytes > 0 {
            let data = &chunk[skip_bytes..];
            skip_bytes = 0;
            data
        } else {
            &chunk
        };
        let take = (count - output.len()).min(data.len());
        output.extend_from_slice(&data[..take]);
    }
    Ok(Bytes::from(output))
}

fn checked_seek(current: u64, len: u64, seek: SeekFrom) -> FsResult<u64> {
    let value = match seek {
        SeekFrom::Start(value) => i128::from(value),
        SeekFrom::Current(delta) => i128::from(current) + i128::from(delta),
        SeekFrom::End(delta) => i128::from(len) + i128::from(delta),
    };
    if value < 0 || value > i128::from(u64::MAX) {
        return Err(FsError::Forbidden);
    }
    Ok(value as u64)
}

fn supports_staged_write(options: &OpenOptions) -> bool {
    if options.append {
        return false;
    }

    // A normal PUT is truncated. dav-server also opens a non-existent resource
    // without truncation while creating a WebDAV lock-null resource; accepting that
    // open is required by Finder and Explorer before they send the eventual PUT.
    options.truncate || (options.create && options.size.is_none() && options.checksum.is_none())
}

#[cfg(test)]
mod tests {
    use super::{
        checked_seek, destination_path, disambiguate_name, is_windows_reserved_name, sanitize_name,
        split_authenticated_path, supports_staged_write, unique_aliases, validate_portable_name,
        webdav_handler, WebDavAuth,
    };
    use actix_web::{http::Method, test as actix_test, web, App};
    use dav_server::{fs::OpenOptions, memfs::MemFs, memls::MemLs, DavHandler};
    use sha2::{Digest, Sha256};
    use std::io::SeekFrom;

    #[test]
    fn extracts_and_validates_capability_path() {
        let token = "a".repeat(64);
        let path = format!("/dav/{token}/Saved%20Messages/file.txt");
        let (actual, relative) = split_authenticated_path(&path).expect("valid path");
        assert_eq!(actual, token);
        assert_eq!(relative, "/Saved%20Messages/file.txt");
        assert!(split_authenticated_path("/dav/short/file.txt").is_none());
    }

    #[test]
    fn extracts_destination_from_absolute_or_relative_url() {
        assert_eq!(destination_path("/dav/token/file"), Some("/dav/token/file"));
        assert_eq!(
            destination_path("http://127.0.0.1:8551/dav/token/file"),
            Some("/dav/token/file")
        );
    }

    #[test]
    fn portable_names_handle_windows_rules_and_duplicates() {
        assert_eq!(sanitize_name("report?.pdf"), "report_.pdf");
        assert_eq!(sanitize_name("CON"), "_CON");
        assert!(is_windows_reserved_name("lpt9.txt"));
        assert_eq!(disambiguate_name("report.pdf", 42), "report (42).pdf");
        assert!(validate_portable_name("report.pdf").is_ok());
        assert!(validate_portable_name("report?.pdf").is_err());
        assert!(validate_portable_name("CON").is_err());
        assert_eq!(
            unique_aliases([(1, "Report.pdf"), (2, "report.pdf")].into_iter()),
            vec!["Report (1).pdf", "report (2).pdf"]
        );
    }

    #[test]
    fn checked_seek_rejects_negative_positions() {
        assert_eq!(checked_seek(10, 100, SeekFrom::Current(-5)), Ok(5));
        assert!(checked_seek(0, 100, SeekFrom::Current(-1)).is_err());
    }

    #[test]
    fn staged_writes_accept_put_and_lock_null_but_reject_append() {
        let put = OpenOptions {
            write: true,
            create: true,
            truncate: true,
            ..Default::default()
        };
        assert!(supports_staged_write(&put));

        let lock_null = OpenOptions {
            write: true,
            create: true,
            ..Default::default()
        };
        assert!(supports_staged_write(&lock_null));

        let mut append = lock_null.clone();
        append.append = true;
        assert!(!supports_staged_write(&append));
    }

    #[actix_web::test]
    async fn capability_token_guards_the_webdav_handler() {
        let token = "a".repeat(64);
        let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
        let handler = DavHandler::builder()
            .filesystem(MemFs::new())
            .locksystem(MemLs::new())
            .build_handler();
        let service = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(handler))
                .app_data(web::Data::new(WebDavAuth { token_hash }))
                .service(web::resource("/{tail:.*}").to(webdav_handler)),
        )
        .await;

        let valid = actix_test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri(&format!("/dav/{token}/"))
            .to_request();
        assert!(actix_test::call_service(&service, valid)
            .await
            .status()
            .is_success());

        let propfind = actix_test::TestRequest::default()
            .method(Method::from_bytes(b"PROPFIND").expect("valid method"))
            .uri(&format!("/dav/{token}/"))
            .insert_header(("Depth", "1"))
            .insert_header(("Content-Type", "application/xml"))
            .set_payload(
                r#"<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>"#,
            )
            .to_request();
        let propfind_response = actix_test::call_service(&service, propfind).await;
        assert_eq!(
            propfind_response.status(),
            actix_web::http::StatusCode::MULTI_STATUS
        );
        let body = actix_test::read_body(propfind_response).await;
        let body = String::from_utf8(body.to_vec()).expect("XML response");
        assert!(body.contains(&format!("<D:href>/dav/{token}/</D:href>")));

        let invalid = actix_test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri(&format!("/dav/{}/", "b".repeat(64)))
            .to_request();
        assert_eq!(
            actix_test::call_service(&service, invalid).await.status(),
            actix_web::http::StatusCode::NOT_FOUND
        );
    }
}
