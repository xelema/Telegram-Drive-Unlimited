use tauri::State;
use grammers_client::types::Media;
use crate::TelegramState;
use crate::commands::utils::resolve_peer;

#[derive(serde::Serialize)]
pub struct VideoMetadata {
    pub duration_secs: Option<f64>,
    pub video_codec: Option<String>,
    pub has_audio: bool,
    pub track_count: usize,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(serde::Deserialize)]
pub struct BatchMetadataRequest {
    pub message_id: i32,
    pub file_name: String,
}

#[derive(serde::Serialize)]
pub struct BatchMetadataEntry {
    pub message_id: i32,
    pub duration_secs: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[tauri::command]
pub async fn cmd_get_video_metadata(
    message_id: i32,
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<VideoMetadata, String> {
    let client = {
        state.client.lock().await.clone()
    };
    let client = client.ok_or_else(|| "Not connected to Telegram".to_string())?;

    let buffer = download_moov_chunk(&client, message_id, folder_id, &state).await?;
    let meta = parse_mp4_metadata(&buffer)?;
    let (width, height) = scan_video_tkhd_dimensions(&buffer);

    Ok(VideoMetadata {
        duration_secs: meta.duration_secs,
        video_codec: meta.video_codec,
        has_audio: meta.has_audio,
        track_count: meta.track_count,
        width,
        height,
    })
}

#[tauri::command]
pub async fn cmd_get_video_metadata_batch(
    requests: Vec<BatchMetadataRequest>,
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<Vec<BatchMetadataEntry>, String> {
    let client = {
        state.client.lock().await.clone()
    };
    let client = client.ok_or_else(|| "Not connected to Telegram".to_string())?;
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    let mut results: Vec<BatchMetadataEntry> = Vec::with_capacity(requests.len());

    for req in &requests {
        if !req.file_name.to_lowercase().ends_with(".mp4") {
            continue;
        }
        match download_and_process(&client, &peer, req).await {
            Ok(e) => results.push(e),
            Err(_) => results.push(BatchMetadataEntry {
                message_id: req.message_id,
                duration_secs: None,
                width: None,
                height: None,
            }),
        }
    }

    Ok(results)
}

// ── Internal helpers ─────────────────────────────────────────────────

struct ParsedMetadata {
    duration_secs: Option<f64>,
    video_codec: Option<String>,
    has_audio: bool,
    track_count: usize,
}

/// Download the first 2 MB of a file and parse metadata + scan tkhd.
async fn download_and_process(
    client: &grammers_client::Client,
    peer: &grammers_client::types::Peer,
    req: &BatchMetadataRequest,
) -> Result<BatchMetadataEntry, String> {
    let messages = client
        .get_messages_by_id(peer, &[req.message_id])
        .await
        .map_err(|e| e.to_string())?;
    let msg = messages.into_iter().flatten().next()
        .ok_or_else(|| format!("Message {} not found", req.message_id))?;
    let media = msg.media().ok_or_else(|| "No media".to_string())?;

    let size = match &media {
        Media::Document(d) => d.size() as u64,
        _ => return Err("Not a document".to_string()),
    };

    let buffer = download_bytes(client, &media, size).await?;
    let meta = parse_mp4_metadata(&buffer)?;
    let (width, height) = scan_video_tkhd_dimensions(&buffer);

    Ok(BatchMetadataEntry {
        message_id: req.message_id,
        duration_secs: meta.duration_secs,
        width,
        height,
    })
}

async fn download_moov_chunk(
    client: &grammers_client::Client,
    message_id: i32,
    folder_id: Option<i64>,
    state: &TelegramState,
) -> Result<Vec<u8>, String> {
    let peer = resolve_peer(client, folder_id, &state.peer_cache).await?;
    let messages = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|e| e.to_string())?;
    let msg = messages.into_iter().flatten().next()
        .ok_or_else(|| format!("Message {message_id} not found"))?;
    let media = msg.media().ok_or_else(|| "No media".to_string())?;
    let size = match &media {
        Media::Document(d) => d.size() as u64,
        _ => return Err("Not a document".to_string()),
    };
    download_bytes(client, &media, size).await
}

/// Download at most the first 2 MB from a Telegram document.
async fn download_bytes(
    client: &grammers_client::Client,
    media: &Media,
    file_size: u64,
) -> Result<Vec<u8>, String> {
    let max_bytes = std::cmp::min(2 * 1024 * 1024, file_size) as usize;
    let mut buffer: Vec<u8> = Vec::with_capacity(max_bytes);
    let mut download_iter = client.iter_download(media);
    download_iter = download_iter.chunk_size(65536);

    while buffer.len() < max_bytes {
        match download_iter.next().await {
            Ok(Some(chunk)) => {
                let remaining = max_bytes.saturating_sub(buffer.len());
                let take = std::cmp::min(chunk.len(), remaining);
                buffer.extend_from_slice(&chunk[..take]);
            }
            Ok(None) => break,
            Err(e) => return Err(format!("Download error: {e}")),
        }
    }
    if buffer.is_empty() {
        return Err("Downloaded zero bytes".to_string());
    }
    Ok(buffer)
}

fn parse_mp4_metadata(buffer: &[u8]) -> Result<ParsedMetadata, String> {
    let mut cursor = std::io::Cursor::new(buffer);
    let context = mp4parse::read_mp4(&mut cursor)
        .map_err(|e| format!("MP4 parse error: {e}"))?;

    let video_track = context.tracks.iter()
        .find(|t| t.track_type == mp4parse::TrackType::Video);

    let has_audio = context.tracks.iter()
        .any(|t| t.track_type == mp4parse::TrackType::Audio);

    let duration_secs = video_track.and_then(|t| {
        let d = t.duration.as_ref()?;
        let ts = t.timescale.as_ref()?;
        Some((d.0 as f64) / (ts.0 as f64))
    });

    Ok(ParsedMetadata {
        duration_secs,
        video_codec: None,
        has_audio,
        track_count: context.tracks.len(),
    })
}

// ── MP4 box scanner ──────────────────────────────────────────────────

fn read_u32_be(data: &[u8], offset: usize) -> Option<u32> {
    let b = data.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// Box type comparison helper
fn box_is(data: &[u8], offset: usize, fourcc: &[u8; 4]) -> bool {
    data.get(offset..offset + 4).map(|b| b == fourcc).unwrap_or(false)
}

/// Walk the moov box tree to find a video-track tkhd and extract display
/// dimensions. Verifies the trak is video by checking for vmhd inside.
fn scan_video_tkhd_dimensions(buffer: &[u8]) -> (Option<u32>, Option<u32>) {
    // Find the 'moov' box by searching from buffer start
    let moov_end = match find_box(buffer, 0, b"moov") {
        Some(e) => e,
        None => return (None, None),
    };
    let moov_start = moov_end.saturating_sub(
        box_size_at(buffer, moov_end).unwrap_or(0)
    );

    // moov_start is the moov box start; its data begins at moov_start + 8
    let moov_data_end = moov_end;

    // Walk moov children looking for 'trak' boxes
    let mut pos = moov_start + 8;
    while pos + 8 < moov_data_end {
        let box_sz = match read_u32_be(buffer, pos) {
            Some(0) | None => break,
            Some(s) if s < 8 => break,
            Some(s) => s as usize,
        };

        if box_is(buffer, pos + 4, b"trak") {
            let trak_data_start = pos + 8;
            let trak_data_end = pos + box_sz;

            if trak_contains_vmhd(buffer, trak_data_start, trak_data_end) {
                // Video track — scan linearly inside for tkhd
                let mut tpos = trak_data_start;
                while tpos + 8 < trak_data_end {
                    let tsz = match read_u32_be(buffer, tpos) {
                        Some(0) => break,
                        Some(s) if s < 8 => break,
                        Some(s) => s as usize,
                        None => break,
                    };

                    if box_is(buffer, tpos + 4, b"tkhd") {
                        // tkhd found at tpos; extract dimensions
                        let version = buffer.get(tpos + 8).copied().unwrap_or(0);

                        // Width/height are 16.16 fixed-point at the end of tkhd.
                        // Version 0: +76(width) +80(height) from box data start.
                        // Version 1 adds 12 bytes (creation_time +8, mod_time +8,
                        // duration +4 = +12 extra after version/flags).
                        let (w_off, h_off) = if version == 1 {
                            (tpos + 8 + 88, tpos + 8 + 92)
                        } else {
                            (tpos + 8 + 76, tpos + 8 + 80)
                        };

                        let width = read_u32_be(buffer, w_off).map(|w| w >> 16);
                        let height = read_u32_be(buffer, h_off).map(|h| h >> 16);
                        return (width, height);
                    }

                    tpos += tsz;
                }
            }
        }

        pos += box_sz;
    }

    (None, None)
}

/// Check whether a trak box contains `vmhd` (walk trak → mdia → minf → vmhd).
fn trak_contains_vmhd(buffer: &[u8], trak_data_start: usize, trak_data_end: usize) -> bool {
    let mdia_end = match find_box_in_range(buffer, trak_data_start, trak_data_end, b"mdia") {
        Some(e) => e,
        None => return false,
    };
    let mdia_data_start = mdia_end.saturating_sub(
        box_size_at(buffer, mdia_end).unwrap_or(8)
    ) + 8;

    let minf_end = match find_box_in_range(buffer, mdia_data_start, mdia_end, b"minf") {
        Some(e) => e,
        None => return false,
    };
    let minf_data_start = minf_end.saturating_sub(
        box_size_at(buffer, minf_end).unwrap_or(8)
    ) + 8;

    find_box_in_range(buffer, minf_data_start, minf_end, b"vmhd").is_some()
}

/// Read the size of the box whose end is at `box_end`.
fn box_size_at(buffer: &[u8], box_end: usize) -> Option<usize> {
    let sz = read_u32_be(buffer, box_end.saturating_sub(8))?;
    if sz < 8 { None } else { Some(sz as usize) }
}

/// Find a box by fourcc, returning its end offset (start + size).
fn find_box(buffer: &[u8], start_offset: usize, fourcc: &[u8; 4]) -> Option<usize> {
    find_box_in_range(buffer, start_offset, buffer.len(), fourcc)
}

fn find_box_in_range(
    buffer: &[u8],
    start_offset: usize,
    range_end: usize,
    fourcc: &[u8; 4],
) -> Option<usize> {
    let mut offset = start_offset;
    while offset + 8 <= range_end {
        let size = match read_u32_be(buffer, offset) {
            Some(0) => break,
            Some(s) if s < 8 => break,
            Some(s) => s as usize,
            None => break,
        };
        if &buffer[offset + 4..offset + 8] == fourcc {
            return Some(offset + size);
        }
        offset += size;
    }
    None
}
