use crate::bandwidth::BandwidthManager;
use crate::commands::utils::{media_size, resolve_peer};
use crate::db::DbConnection;
use crate::vpn_optimizer::NetworkConfig;
use crate::TelegramState;
use grammers_client::types::{Media, Peer};
use image::codecs::jpeg::JpegEncoder;
use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime};
use tauri::{Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

/// Supported image file extensions for thumbnails.
/// Shared between Tauri commands and the REST API cache cleanup.
pub const THUMBNAIL_EXTS: &[&str] = &["thumb.jpg", "jpg", "jpeg", "png", "gif", "webp", "bmp"];

const PREVIEW_CACHE_MAX_FILES: usize = 30;
const PREVIEW_CACHE_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
static PREVIEW_CACHE_LIMIT_BYTES: AtomicU64 = AtomicU64::new(PREVIEW_CACHE_MAX_TOTAL_BYTES);
const THUMBNAIL_CACHE_MAX_FILES: usize = 500;
const THUMBNAIL_CACHE_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const THUMBNAIL_MAX_DIMENSION: u32 = 1024;

type DownloadLock = tokio::sync::Mutex<()>;
static DOWNLOAD_LOCKS: LazyLock<Mutex<HashMap<String, Weak<DownloadLock>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn is_registered_encrypted(
    db_pool: DbConnection,
    folder_id: Option<i64>,
    message_id: i32,
) -> Result<bool, String> {
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    crate::db::with_connection(db_pool, move |connection| {
        let mut statement = connection
            .prepare("SELECT 1 FROM encrypted_files WHERE folder_key = ? AND message_id = ? AND record_state = 'active'")
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, folder_key.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, i64::from(message_id)))
            .map_err(|error| error.to_string())?;
        Ok(matches!(statement.next(), Ok(sqlite::State::Row)))
    }).await
}

fn download_lock(key: String) -> Arc<DownloadLock> {
    let mut locks = DOWNLOAD_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(existing) = locks.get(&key).and_then(Weak::upgrade) {
        return existing;
    }

    let lock = Arc::new(DownloadLock::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

fn cache_stem(folder_id: Option<i64>, message_id: i32) -> String {
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    format!("{}_{}", folder_key, message_id)
}

async fn is_nonempty_file(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

async fn find_cached_file(cache_dir: &Path, stem: &str) -> Option<PathBuf> {
    let prefix = format!("{}.", stem);
    let mut entries = tokio::fs::read_dir(cache_dir).await.ok()?;
    let mut newest: Option<(PathBuf, SystemTime)> = None;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name,
            None => continue,
        };
        if !name.starts_with(&prefix) || name.ends_with(".part") || name.ends_with(".pin") {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(meta) if meta.is_file() && meta.len() > 0 => meta,
            _ => continue,
        };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if newest
            .as_ref()
            .is_none_or(|(_, current)| modified > *current)
        {
            newest = Some((path, modified));
        }
    }

    newest.map(|(path, _)| path)
}

async fn mark_cache_file_used(path: PathBuf) {
    let _ = tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new().write(true).open(path)?;
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()))
    })
    .await;
}

fn media_extension(media: &Media) -> String {
    let extension = match media {
        Media::Document(document) => {
            let from_name = Path::new(document.name())
                .extension()
                .map(|value| value.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !from_name.is_empty() {
                from_name
            } else {
                match document.mime_type().unwrap_or("") {
                    "image/jpeg" => "jpg".to_string(),
                    "image/png" => "png".to_string(),
                    "image/gif" => "gif".to_string(),
                    "image/webp" => "webp".to_string(),
                    "image/bmp" => "bmp".to_string(),
                    "application/pdf" => "pdf".to_string(),
                    "video/mp4" => "mp4".to_string(),
                    _ => "bin".to_string(),
                }
            }
        }
        Media::Photo(_) => "jpg".to_string(),
        _ => "bin".to_string(),
    };

    if extension.len() <= 12
        && extension
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        extension
    } else {
        "bin".to_string()
    }
}

#[derive(Clone)]
struct PreviewProgressContext {
    app_handle: tauri::AppHandle,
    message_id: i32,
    folder_id: Option<i64>,
    total_bytes: u64,
}

#[derive(Clone, Serialize)]
struct PreviewProgressPayload {
    message_id: i32,
    folder_id: Option<i64>,
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
}

fn emit_preview_progress(context: &PreviewProgressContext, downloaded_bytes: u64, complete: bool) {
    let percent = if complete {
        100
    } else if context.total_bytes > 0 {
        ((downloaded_bytes as f64 / context.total_bytes as f64) * 100.0).min(99.0) as u8
    } else {
        0
    };
    let _ = context.app_handle.emit(
        "preview-progress",
        PreviewProgressPayload {
            message_id: context.message_id,
            folder_id: context.folder_id,
            downloaded_bytes,
            total_bytes: context.total_bytes,
            percent,
        },
    );
}

async fn prune_preview_cache(
    cache_dir: std::path::PathBuf,
    preserve_path: Option<std::path::PathBuf>,
) {
    let _ = tokio::task::spawn_blocking(move || {
        let mut read_dir = match std::fs::read_dir(&cache_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        // Desktop partials are disposable. Android retains recent partials so
        // process death or a network handoff can resume at a Telegram chunk boundary.
        for entry in read_dir.by_ref().flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if fname.ends_with(".part") {
                #[cfg(target_os = "android")]
                {
                    let stale = entry
                        .metadata()
                        .ok()
                        .and_then(|metadata| metadata.modified().ok())
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age >= Duration::from_secs(24 * 60 * 60));
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    }
                }
                #[cfg(not(target_os = "android"))]
                let _ = std::fs::remove_file(&path);
            }
        }

        // Second pass: gather remaining files for size-based pruning.
        // Re-read the directory to get a fresh iterator after the first pass
        // may have modified it.
        let read_dir = match std::fs::read_dir(&cache_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut files: Vec<(std::path::PathBuf, std::time::SystemTime, u64, bool)> = Vec::new();
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|extension| extension.to_str()) == Some("pin") {
                continue;
            }
            #[cfg(target_os = "android")]
            if path.extension().and_then(|extension| extension.to_str()) == Some("part") {
                continue;
            }
            let pin_marker = path.with_extension("pin");
            let preserved = pin_marker.is_file()
                || preserve_path
                    .as_ref()
                    .is_some_and(|preserve| preserve == &path);
            if let Ok(meta) = entry.metadata() {
                let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                files.push((path, modified, meta.len(), preserved));
            }
        }
        files.sort_by_key(|(_, modified, _, _)| *modified);
        let mut total_bytes: u64 = files.iter().map(|(_, _, len, _)| *len).sum();
        let max_bytes = PREVIEW_CACHE_LIMIT_BYTES.load(Ordering::Relaxed);
        while files.len() > PREVIEW_CACHE_MAX_FILES || total_bytes > max_bytes {
            if let Some(index) = files.iter().position(|(_, _, _, preserved)| !preserved) {
                let (path, _, len, _) = files.remove(index);
                let _ = std::fs::remove_file(&path);
                total_bytes = total_bytes.saturating_sub(len);
            } else {
                break;
            }
        }
    })
    .await;
}

#[derive(Debug, Clone, Serialize)]
pub struct OfflineFile {
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
    pub offline_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OfflineCacheStatus {
    pub file_count: usize,
    pub total_bytes: u64,
    pub max_files: usize,
    pub max_bytes: u64,
}

async fn preview_cache_status(cache_dir: &Path) -> OfflineCacheStatus {
    let mut status = OfflineCacheStatus {
        file_count: 0,
        total_bytes: 0,
        max_files: PREVIEW_CACHE_MAX_FILES,
        max_bytes: PREVIEW_CACHE_LIMIT_BYTES.load(Ordering::Relaxed),
    };
    let Ok(mut entries) = tokio::fs::read_dir(cache_dir).await else {
        return status;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("part" | "pin")
        ) {
            continue;
        }
        if let Ok(metadata) = entry.metadata().await {
            if metadata.is_file() && metadata.len() > 0 {
                status.file_count += 1;
                status.total_bytes = status.total_bytes.saturating_add(metadata.len());
            }
        }
    }
    status
}

#[tauri::command]
pub async fn cmd_set_preview_cache_limit(max_gb: f64) -> Result<(), String> {
    if !max_gb.is_finite() {
        return Err("Offline media cache limit must be finite".into());
    }
    let clamped = max_gb.clamp(0.25, 50.0);
    PREVIEW_CACHE_LIMIT_BYTES.store(
        (clamped * 1024.0 * 1024.0 * 1024.0) as u64,
        Ordering::Relaxed,
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_set_preview_pinned(
    message_id: i32,
    folder_id: Option<i64>,
    pinned: bool,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error: tauri::Error| error.to_string())?
        .join("previews");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("Unable to prepare the offline media cache: {error}"))?;
    let marker = cache_dir.join(format!("{}.pin", cache_stem(folder_id, message_id)));
    if pinned {
        if find_cached_file(&cache_dir, &cache_stem(folder_id, message_id))
            .await
            .is_none()
        {
            return Err("Download this file before marking it for offline use".into());
        }
        tokio::fs::write(marker, b"pinned")
            .await
            .map_err(|error| format!("Unable to preserve this offline file: {error}"))?;
    } else if let Err(error) = tokio::fs::remove_file(marker).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("Unable to unpin this offline file: {error}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_offline_cache_status(
    app_handle: tauri::AppHandle,
) -> Result<OfflineCacheStatus, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error: tauri::Error| error.to_string())?
        .join("previews");
    Ok(preview_cache_status(&cache_dir).await)
}

#[tauri::command]
pub async fn cmd_get_offline_files(
    app_handle: tauri::AppHandle,
    db_pool: State<'_, DbConnection>,
    limit: Option<i64>,
) -> Result<Vec<OfflineFile>, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error: tauri::Error| error.to_string())?
        .join("previews");
    let rows = crate::db::with_connection(db_pool.inner().clone(), move |connection| {
        let mut statement = connection
            .prepare(
                "SELECT message_id, folder_id, file_name, file_size, mime_type, file_ext,
                        created_at, encryption_state, is_favorite, is_pinned, last_opened_at
                 FROM file_activity
                 WHERE open_count > 0 AND encryption_state = 'plain'
                   AND NOT EXISTS (
                       SELECT 1 FROM encrypted_files
                       WHERE encrypted_files.folder_key = file_activity.folder_key
                         AND encrypted_files.message_id = file_activity.message_id
                         AND encrypted_files.record_state = 'active'
                   )
                 ORDER BY last_opened_at DESC LIMIT ?",
            )
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, limit.unwrap_or(250).clamp(1, 1_000)))
            .map_err(|error| error.to_string())?;
        let mut rows = Vec::new();
        while let sqlite::State::Row = statement.next().map_err(|error| error.to_string())? {
            rows.push((
                statement
                    .read::<i64, _>(0)
                    .map_err(|error| error.to_string())?,
                statement.read::<Option<i64>, _>(1).ok().flatten(),
                statement
                    .read::<String, _>(2)
                    .map_err(|error| error.to_string())?,
                statement.read::<i64, _>(3).unwrap_or(0).max(0) as u64,
                statement.read::<Option<String>, _>(4).ok().flatten(),
                statement.read::<Option<String>, _>(5).ok().flatten(),
                statement.read::<String, _>(6).unwrap_or_default(),
                statement
                    .read::<String, _>(7)
                    .unwrap_or_else(|_| "plain".to_string()),
                statement.read::<i64, _>(8).unwrap_or(0) != 0,
                statement.read::<i64, _>(9).unwrap_or(0) != 0,
                statement.read::<i64, _>(10).unwrap_or(0),
            ));
        }
        Ok(rows)
    })
    .await?;

    let mut files = Vec::new();
    for (
        id,
        folder_id,
        name,
        recorded_size,
        mime_type,
        file_ext,
        created_at,
        encryption_state,
        is_favorite,
        is_pinned,
        last_opened_at,
    ) in rows
    {
        let Ok(message_id) = i32::try_from(id) else {
            continue;
        };
        let stem = cache_stem(folder_id, message_id);
        let Some(path) = find_cached_file(&cache_dir, &stem).await else {
            continue;
        };
        let cached_size = tokio::fs::metadata(path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let size = if recorded_size > 0 {
            recorded_size
        } else {
            cached_size
        };
        files.push(OfflineFile {
            id,
            folder_id,
            name,
            size,
            mime_type,
            file_ext,
            created_at,
            icon_type: "file".to_string(),
            encryption_state,
            is_favorite,
            is_pinned,
            last_opened_at,
            offline_available: true,
        });
    }
    Ok(files)
}

async fn prune_thumbnail_cache(cache_dir: PathBuf, preserve_path: Option<PathBuf>) {
    let _ = tokio::task::spawn_blocking(move || {
        let entries = match std::fs::read_dir(&cache_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut files: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if name.ends_with(".part") {
                let _ = std::fs::remove_file(path);
                continue;
            }
            if preserve_path
                .as_ref()
                .is_some_and(|preserve| preserve == &path)
            {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                files.push((
                    path,
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    meta.len(),
                ));
            }
        }
        files.sort_by_key(|(_, modified, _)| *modified);
        let mut total_bytes: u64 = files.iter().map(|(_, _, len)| *len).sum();
        while files.len() > THUMBNAIL_CACHE_MAX_FILES
            || total_bytes > THUMBNAIL_CACHE_MAX_TOTAL_BYTES
        {
            if let Some((path, _, len)) = files.first().cloned() {
                let _ = std::fs::remove_file(path);
                total_bytes = total_bytes.saturating_sub(len);
                files.remove(0);
            } else {
                break;
            }
        }
    })
    .await;
}

async fn create_resized_thumbnail(
    source_path: PathBuf,
    destination_path: PathBuf,
) -> Result<PathBuf, String> {
    tokio::task::spawn_blocking(move || {
        let reader = image::ImageReader::open(&source_path)
            .map_err(|error| format!("Failed to open image for thumbnail: {}", error))?
            .with_guessed_format()
            .map_err(|error| format!("Failed to identify thumbnail image: {}", error))?;
        let decoded = reader
            .decode()
            .map_err(|error| format!("Failed to decode thumbnail image: {}", error))?;
        let resized = decoded.thumbnail(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION);
        let rgba = resized.to_rgba8();
        let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());

        for (source, destination) in rgba.pixels().zip(rgb.pixels_mut()) {
            let alpha = source[3] as u16;
            let inverse_alpha = 255 - alpha;
            *destination = image::Rgb([
                ((source[0] as u16 * alpha + 248 * inverse_alpha) / 255) as u8,
                ((source[1] as u16 * alpha + 248 * inverse_alpha) / 255) as u8,
                ((source[2] as u16 * alpha + 248 * inverse_alpha) / 255) as u8,
            ]);
        }

        let unique_id = rand::rng().random::<u64>();
        let temporary_path = destination_path.with_extension(format!("thumb_{}.part", unique_id));
        let file = std::fs::File::create(&temporary_path)
            .map_err(|error| format!("Failed to create thumbnail: {}", error))?;
        let mut encoder = JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 84);
        encoder
            .encode_image(&image::DynamicImage::ImageRgb8(rgb))
            .map_err(|error| format!("Failed to encode thumbnail: {}", error))?;

        if destination_path.exists() {
            let _ = std::fs::remove_file(&destination_path);
        }
        std::fs::rename(&temporary_path, &destination_path)
            .map_err(|error| format!("Failed to save thumbnail: {}", error))?;
        Ok(destination_path)
    })
    .await
    .map_err(|error| format!("Thumbnail task failed: {}", error))?
}

/// Download media to a file using `iter_download` with manual chunk writing.
/// Returns the number of bytes written.
///
/// Unlike `grammers_client::Client::download_media`, this returns an explicit
/// error when the download produces zero bytes (e.g. stale file references or
/// Telegram CDN stream drops).
#[allow(clippy::too_many_arguments)] // The transfer policy inputs are independent and explicit.
async fn download_to_file<D: grammers_client::types::Downloadable>(
    client: &grammers_client::Client,
    media: &D,
    part_path: &std::path::Path,
    chunk_size: usize,
    download_limit_bytes_per_sec: u64,
    progress: Option<&PreviewProgressContext>,
    expected_size: u64,
    allow_resume: bool,
) -> Result<u64, String> {
    let valid_chunk_size = chunk_size.clamp(4 * 1024, 512 * 1024) / (4 * 1024) * (4 * 1024);
    let existing_size = if allow_resume {
        tokio::fs::metadata(part_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    } else {
        0
    };
    if allow_resume && expected_size > 0 && existing_size == expected_size {
        if let Some(context) = progress {
            emit_preview_progress(context, existing_size, true);
        }
        return Ok(existing_size);
    }
    let resume_offset =
        aligned_resume_offset(existing_size, valid_chunk_size as u64, expected_size);
    let mut file = if allow_resume {
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(part_path)
            .await
            .map_err(|error| format!("Failed to open resumable .part file: {error}"))?;
        file.set_len(resume_offset)
            .await
            .map_err(|error| format!("Failed to align resumable .part file: {error}"))?;
        file
    } else {
        tokio::fs::File::create(part_path)
            .await
            .map_err(|error| format!("Failed to create .part file: {error}"))?
    };

    let mut download_iter = client.iter_download(media);
    download_iter = download_iter.chunk_size(valid_chunk_size as i32);
    if resume_offset > 0 {
        let chunk_count = i32::try_from(resume_offset / valid_chunk_size as u64)
            .map_err(|_| "Resumable preview offset is too large".to_string())?;
        download_iter = download_iter.skip_chunks(chunk_count);
    }
    let mut written = resume_offset;
    let mut written_this_attempt = 0_u64;
    let started_at = Instant::now();
    let mut last_progress_emit = Instant::now();

    loop {
        match download_iter.next().await {
            Ok(Some(chunk)) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("Write error: {}", e))?;
                written += chunk.len() as u64;
                written_this_attempt += chunk.len() as u64;

                if let Some(context) = progress {
                    if last_progress_emit.elapsed() >= Duration::from_millis(200) {
                        emit_preview_progress(context, written, false);
                        last_progress_emit = Instant::now();
                    }
                }

                if download_limit_bytes_per_sec > 0 {
                    let expected_elapsed = Duration::from_secs_f64(
                        written_this_attempt as f64 / download_limit_bytes_per_sec as f64,
                    );
                    let actual_elapsed = started_at.elapsed();
                    if expected_elapsed > actual_elapsed {
                        tokio::time::sleep(expected_elapsed - actual_elapsed).await;
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                let _ = file.flush().await;
                drop(file);
                if !allow_resume {
                    let _ = tokio::fs::remove_file(part_path).await;
                }
                return Err(format!("Download error: {}", e));
            }
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {}", e))?;
    drop(file);

    if written == 0 || (expected_size > 0 && written != expected_size) {
        if !allow_resume {
            let _ = tokio::fs::remove_file(part_path).await;
        }
        return Err(if written == 0 {
            "Download produced zero bytes (stale file reference or stream drop)".to_string()
        } else {
            format!("Download stopped at {written} of {expected_size} bytes")
        });
    }

    if let Some(context) = progress {
        emit_preview_progress(context, written, true);
    }

    Ok(written)
}

fn aligned_resume_offset(existing_size: u64, chunk_size: u64, expected_size: u64) -> u64 {
    if chunk_size == 0 || (expected_size > 0 && existing_size > expected_size) {
        return 0;
    }
    existing_size / chunk_size * chunk_size
}

struct DownloadOptions<'a> {
    client: &'a grammers_client::Client,
    peer: &'a Peer,
    media: &'a Media,
    message_id: i32,
    folder_id: Option<i64>,
    save_path: &'a Path,
    expected_size: u64,
    chunk_size: usize,
    download_limit_bytes_per_sec: u64,
    app_handle: &'a tauri::AppHandle,
    bandwidth: &'a BandwidthManager,
    report_progress: bool,
}

async fn download_media_with_retry(options: DownloadOptions<'_>) -> Result<(), String> {
    if is_nonempty_file(options.save_path).await {
        return Ok(());
    }

    options.bandwidth.try_reserve_down(options.expected_size)?;
    let extension = options
        .save_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("bin");
    let unique_id = rand::rng().random::<u64>();
    let allow_resume = cfg!(target_os = "android");
    let part_path = if allow_resume {
        options
            .save_path
            .with_extension(format!("{}.part", extension))
    } else {
        options
            .save_path
            .with_extension(format!("{}_{}.part", extension, unique_id))
    };
    let progress = options.report_progress.then(|| PreviewProgressContext {
        app_handle: options.app_handle.clone(),
        message_id: options.message_id,
        folder_id: options.folder_id,
        total_bytes: options.expected_size,
    });
    let validated_size = if allow_resume {
        options.expected_size
    } else {
        0
    };

    let mut last_error = String::new();
    let mut download_complete = false;
    if !allow_resume {
        let _ = tokio::fs::remove_file(&part_path).await;
    }
    match download_to_file(
        options.client,
        options.media,
        &part_path,
        options.chunk_size,
        options.download_limit_bytes_per_sec,
        progress.as_ref(),
        validated_size,
        allow_resume,
    )
    .await
    {
        Ok(_) => download_complete = true,
        Err(error) => last_error = error,
    }

    if !download_complete {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let fresh_media = options
            .client
            .get_messages_by_id(options.peer, &[options.message_id])
            .await
            .ok()
            .and_then(|messages| messages.into_iter().flatten().next())
            .and_then(|message| message.media());

        if let Some(fresh_media) = fresh_media {
            if !allow_resume {
                let _ = tokio::fs::remove_file(&part_path).await;
            }
            if let Err(error) = download_to_file(
                options.client,
                &fresh_media,
                &part_path,
                options.chunk_size,
                options.download_limit_bytes_per_sec,
                progress.as_ref(),
                validated_size,
                allow_resume,
            )
            .await
            {
                last_error = error;
            } else {
                download_complete = true;
            }
        }
    }

    if !download_complete || !is_nonempty_file(&part_path).await {
        options.bandwidth.release_down(options.expected_size);
        if !allow_resume {
            let _ = tokio::fs::remove_file(&part_path).await;
        }
        return Err(if last_error.is_empty() {
            "Preview download failed".to_string()
        } else {
            last_error
        });
    }

    if is_nonempty_file(options.save_path).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        options.bandwidth.release_down(options.expected_size);
        return Ok(());
    }

    if let Err(error) = tokio::fs::rename(&part_path, options.save_path).await {
        if is_nonempty_file(options.save_path).await {
            let _ = tokio::fs::remove_file(&part_path).await;
            options.bandwidth.release_down(options.expected_size);
            return Ok(());
        }
        options.bandwidth.release_down(options.expected_size);
        if !allow_resume {
            let _ = tokio::fs::remove_file(&part_path).await;
        }
        return Err(format!("Failed to save preview: {}", error));
    }

    Ok(())
}

#[tauri::command]
pub async fn cmd_get_preview(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    net_config: State<'_, Arc<NetworkConfig>>,
    db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    if is_registered_encrypted(db_pool.inner().clone(), folder_id, message_id).await? {
        return Err("[ENCRYPTED_PREVIEW_UNAVAILABLE] Download and authenticate the encrypted file before opening it".to_string());
    }
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error: tauri::Error| error.to_string())?
        .join("previews");
    if tokio::fs::metadata(&cache_dir).await.is_err() {
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|error| error.to_string())?;
    }

    let stem = cache_stem(folder_id, message_id);
    if let Some(path) = find_cached_file(&cache_dir, &stem).await {
        log::debug!("Preview cache hit before Telegram lookup: {:?}", path);
        mark_cache_file_used(path.clone()).await;
        return Ok(path.to_string_lossy().to_string());
    }

    let lock = download_lock(format!("preview:{}", stem));
    let _guard = lock.lock().await;
    if let Some(path) = find_cached_file(&cache_dir, &stem).await {
        mark_cache_file_used(path.clone()).await;
        return Ok(path.to_string_lossy().to_string());
    }

    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        return Ok("".to_string());
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let message = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "File not found".to_string())?;
    if message.text() == "TDENC2"
        || matches!(
            message.media(),
            Some(Media::Document(document))
                if document.name().to_ascii_lowercase().ends_with(".tdenc")
        )
    {
        return Err("[ENCRYPTED_PREVIEW_UNAVAILABLE] Download and authenticate the encrypted file before opening it".to_string());
    }
    let media = message
        .media()
        .ok_or_else(|| "File has no downloadable media".to_string())?;
    let extension = media_extension(&media);
    let save_path = cache_dir.join(format!("{}.{}", stem, extension));

    download_media_with_retry(DownloadOptions {
        client: &client,
        peer: &peer,
        media: &media,
        message_id,
        folder_id,
        save_path: &save_path,
        expected_size: media_size(&media),
        chunk_size: net_config.chunk_size_bytes(),
        download_limit_bytes_per_sec: net_config.download_limit_bytes_per_sec(),
        app_handle: &app_handle,
        bandwidth: bw_state.inner().as_ref(),
        report_progress: true,
    })
    .await?;

    let prune_dir = cache_dir.clone();
    let preserve_path = save_path.clone();
    tauri::async_runtime::spawn(async move {
        prune_preview_cache(prune_dir, Some(preserve_path)).await;
    });

    Ok(save_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn cmd_clean_preview_cache(app_handle: tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");

    tokio::task::spawn_blocking(move || {
        if cache_dir.exists() {
            let entries = std::fs::read_dir(&cache_dir)
                .map_err(|error| format!("Unable to read offline cache: {error}"))?;
            for entry in entries {
                let path = entry
                    .map_err(|error| format!("Unable to inspect offline cache: {error}"))?
                    .path();
                if path.is_file() {
                    std::fs::remove_file(&path).map_err(|error| {
                        format!("Unable to remove offline file {}: {error}", path.display())
                    })?;
                }
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("Offline cache cleanup task failed: {error}"))?
}

#[tauri::command]
pub async fn cmd_clean_cache(app_handle: tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");
    let thumb_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");

    let _ = tokio::task::spawn_blocking(move || {
        if cache_dir.exists() {
            let _ = std::fs::remove_dir_all(cache_dir);
        }
        if thumb_dir.exists() {
            let _ = std::fs::remove_dir_all(thumb_dir);
        }
    })
    .await;
    Ok(())
}

/// Get a small thumbnail for inline display in file cards.
/// Returns a local asset path for images, empty string for non-image files.
#[tauri::command]
pub async fn cmd_get_thumbnail(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
    net_config: State<'_, Arc<NetworkConfig>>,
    db_pool: State<'_, DbConnection>,
) -> Result<String, String> {
    if is_registered_encrypted(db_pool.inner().clone(), folder_id, message_id).await? {
        return Ok(String::new());
    }
    let thumbnail_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error: tauri::Error| error.to_string())?
        .join("thumbnails");
    let preview_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error: tauri::Error| error.to_string())?
        .join("previews");
    for directory in [&thumbnail_dir, &preview_dir] {
        if tokio::fs::metadata(directory).await.is_err() {
            tokio::fs::create_dir_all(directory)
                .await
                .map_err(|error| error.to_string())?;
        }
    }

    let stem = cache_stem(folder_id, message_id);
    let optimized_path = thumbnail_dir.join(format!("{}.thumb.jpg", stem));
    if is_nonempty_file(&optimized_path).await {
        return Ok(optimized_path.to_string_lossy().to_string());
    }

    let lock = download_lock(format!("thumbnail:{}", stem));
    let _guard = lock.lock().await;
    if is_nonempty_file(&optimized_path).await {
        return Ok(optimized_path.to_string_lossy().to_string());
    }

    // Migrate older caches that may contain a full-size original into a real thumbnail.
    if let Some(legacy_path) = find_cached_file(&thumbnail_dir, &stem).await {
        match create_resized_thumbnail(legacy_path.clone(), optimized_path.clone()).await {
            Ok(path) => {
                if path != legacy_path {
                    let _ = tokio::fs::remove_file(legacy_path).await;
                }
                return Ok(path.to_string_lossy().to_string());
            }
            Err(error) => {
                log::warn!("Could not migrate cached thumbnail: {}", error);
                return Ok(legacy_path.to_string_lossy().to_string());
            }
        }
    }

    // If the full preview is already cached, derive the thumbnail without Telegram traffic.
    if let Some(preview_path) = find_cached_file(&preview_dir, &stem).await {
        if let Ok(path) = create_resized_thumbnail(preview_path, optimized_path.clone()).await {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        return Ok("".to_string());
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let message = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "File not found".to_string())?;
    if message.text() == "TDENC2"
        || matches!(
            message.media(),
            Some(Media::Document(document))
                if document.name().to_ascii_lowercase().ends_with(".tdenc")
        )
    {
        return Ok(String::new());
    }
    let media = message
        .media()
        .ok_or_else(|| "File has no downloadable media".to_string())?;
    let is_image = match &media {
        Media::Photo(_) => true,
        Media::Document(document) => document.mime_type().unwrap_or("").starts_with("image/"),
        _ => false,
    };
    if !is_image {
        return Ok("".to_string());
    }

    let thumbnails = match &media {
        Media::Photo(photo) => photo.thumbs(),
        Media::Document(document) => document.thumbs(),
        _ => Vec::new(),
    };

    if let Some(thumbnail) = thumbnails
        .iter()
        .filter(|thumbnail| thumbnail.size() > 0)
        .max_by_key(|thumbnail| thumbnail.size())
    {
        let unique_id = rand::rng().random::<u64>();
        let part_path = optimized_path.with_extension(format!("source_{}.part", unique_id));
        let thumbnail_size = thumbnail.size() as u64;
        bw_state.try_reserve_down(thumbnail_size)?;
        let result = download_to_file(
            &client,
            thumbnail,
            &part_path,
            net_config.chunk_size_bytes(),
            net_config.download_limit_bytes_per_sec(),
            None,
            0,
            false,
        )
        .await;
        if let Err(error) = result {
            bw_state.release_down(thumbnail_size);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(error);
        }

        let final_path =
            match create_resized_thumbnail(part_path.clone(), optimized_path.clone()).await {
                Ok(path) => {
                    let _ = tokio::fs::remove_file(part_path).await;
                    path
                }
                Err(error) => {
                    log::warn!("Could not normalize Telegram thumbnail: {}", error);
                    tokio::fs::rename(&part_path, &optimized_path)
                        .await
                        .map_err(|rename_error| rename_error.to_string())?;
                    optimized_path.clone()
                }
            };

        let prune_dir = thumbnail_dir.clone();
        let preserve_path = final_path.clone();
        tauri::async_runtime::spawn(async move {
            prune_thumbnail_cache(prune_dir, Some(preserve_path)).await;
        });
        return Ok(final_path.to_string_lossy().to_string());
    }

    // Some image documents have no Telegram thumbnail. Download the original once into
    // the preview cache, then derive the card thumbnail from that shared local file.
    let preview_lock = download_lock(format!("preview:{}", stem));
    let _preview_guard = preview_lock.lock().await;
    let preview_path = if let Some(path) = find_cached_file(&preview_dir, &stem).await {
        path
    } else {
        let extension = media_extension(&media);
        let path = preview_dir.join(format!("{}.{}", stem, extension));
        download_media_with_retry(DownloadOptions {
            client: &client,
            peer: &peer,
            media: &media,
            message_id,
            folder_id,
            save_path: &path,
            expected_size: media_size(&media),
            chunk_size: net_config.chunk_size_bytes(),
            download_limit_bytes_per_sec: net_config.download_limit_bytes_per_sec(),
            app_handle: &app_handle,
            bandwidth: bw_state.inner().as_ref(),
            report_progress: true,
        })
        .await?;
        let prune_dir = preview_dir.clone();
        let preserve_path = path.clone();
        tauri::async_runtime::spawn(async move {
            prune_preview_cache(prune_dir, Some(preserve_path)).await;
        });
        path
    };

    let final_path = create_resized_thumbnail(preview_path.clone(), optimized_path.clone())
        .await
        .unwrap_or(preview_path);
    let prune_dir = thumbnail_dir.clone();
    let preserve_path = optimized_path;
    tauri::async_runtime::spawn(async move {
        prune_thumbnail_cache(prune_dir, Some(preserve_path)).await;
    });
    Ok(final_path.to_string_lossy().to_string())
}

/// Delete stale preview cache entries for a specific message in a specific folder.
/// Preview cache files are named `{folder_key}_{message_id}.{ext}`.
/// This removes all extensions for the given folder+message_id pair.
#[tauri::command]
pub async fn cmd_delete_preview_for_message(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");

    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());

    let prefix = format!("{}_{}.", folder_key, message_id);

    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if fname.starts_with(&prefix) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    })
    .await;
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_image_thumbnail(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");

    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    let prefix = format!("{}_{}.", folder_key, message_id);

    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(entries) = std::fs::read_dir(cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if path.is_file() && name.starts_with(&prefix) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    })
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumable_preview_offsets_keep_only_complete_telegram_chunks() {
        let chunk = 512 * 1024;
        assert_eq!(aligned_resume_offset(0, chunk, 4 * chunk), 0);
        assert_eq!(
            aligned_resume_offset(chunk + 12_345, chunk, 4 * chunk),
            chunk
        );
        assert_eq!(aligned_resume_offset(5 * chunk, chunk, 4 * chunk), 0);
        assert_eq!(aligned_resume_offset(chunk, 0, 4 * chunk), 0);
    }

    #[tokio::test]
    async fn offline_cache_pruning_counts_preserved_file_and_removes_parts() {
        let test_dir = std::env::temp_dir().join(format!(
            "telegram_drive_offline_cache_test_{}",
            rand::rng().random::<u64>()
        ));
        std::fs::create_dir_all(&test_dir).unwrap();
        let preserved = test_dir.join("home_1.txt");
        std::fs::write(&preserved, b"preserve").unwrap();
        for index in 2..=31 {
            std::fs::write(test_dir.join(format!("home_{index}.txt")), b"cached").unwrap();
        }
        std::fs::write(test_dir.join("home_32.txt.part"), b"partial").unwrap();

        prune_preview_cache(test_dir.clone(), Some(preserved.clone())).await;
        let status = preview_cache_status(&test_dir).await;

        assert!(preserved.exists());
        assert!(!test_dir.join("home_32.txt.part").exists());
        assert_eq!(status.file_count, PREVIEW_CACHE_MAX_FILES);
        assert!(status.total_bytes <= PREVIEW_CACHE_MAX_TOTAL_BYTES);
        let _ = std::fs::remove_dir_all(test_dir);
    }

    #[tokio::test]
    async fn viewing_cached_file_refreshes_lru_position() {
        let test_dir = std::env::temp_dir().join(format!(
            "telegram_drive_offline_lru_test_{}",
            rand::rng().random::<u64>()
        ));
        std::fs::create_dir_all(&test_dir).unwrap();
        let recently_viewed = test_dir.join("home_1.txt");
        std::fs::write(&recently_viewed, b"recent").unwrap();
        for index in 2..=31 {
            let path = test_dir.join(format!("home_{index}.txt"));
            std::fs::write(&path, b"cached").unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
                .unwrap();
        }

        mark_cache_file_used(recently_viewed.clone()).await;
        prune_preview_cache(test_dir.clone(), None).await;

        assert!(recently_viewed.exists());
        assert_eq!(
            preview_cache_status(&test_dir).await.file_count,
            PREVIEW_CACHE_MAX_FILES
        );
        let _ = std::fs::remove_dir_all(test_dir);
    }

    #[test]
    fn cache_keys_are_stable_across_saved_messages_and_folders() {
        assert_eq!(cache_stem(None, 42), "home_42");
        assert_eq!(cache_stem(Some(-100123), 42), "-100123_42");
    }

    #[tokio::test]
    async fn generated_thumbnail_is_bounded_and_readable() {
        let test_dir = std::env::temp_dir().join(format!(
            "telegram_drive_thumbnail_test_{}",
            rand::rng().random::<u64>()
        ));
        std::fs::create_dir_all(&test_dir).unwrap();
        let source_path = test_dir.join("source.png");
        let destination_path = test_dir.join("result.thumb.jpg");
        let source = image::RgbImage::from_pixel(2048, 1024, image::Rgb([40, 120, 220]));
        source
            .save_with_format(&source_path, image::ImageFormat::Png)
            .unwrap();

        let generated = create_resized_thumbnail(source_path, destination_path.clone())
            .await
            .unwrap();
        let (width, height) = image::image_dimensions(&generated).unwrap();

        assert_eq!(generated, destination_path);
        assert!(width <= THUMBNAIL_MAX_DIMENSION);
        assert!(height <= THUMBNAIL_MAX_DIMENSION);
        assert!(std::fs::metadata(&generated).unwrap().len() > 0);
        let _ = std::fs::remove_dir_all(test_dir);
    }
}
