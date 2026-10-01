use crate::commands::utils::{media_size, resolve_peer};
use crate::commands::TelegramState;
use crate::transcode::TranscodeManager;
use actix_cors::Cors;
use actix_web::{get, web, App, HttpResponse, HttpServer, Responder};
use grammers_client::types::Media;

use std::net::TcpListener;
use std::sync::Arc;

/// Holds the per-session streaming token for Actix validation
pub struct StreamTokenData {
    pub token: String,
}

#[derive(serde::Deserialize)]
struct StreamQuery {
    token: Option<String>,
    credential: Option<u64>,
}

struct EncryptedStreamRecord {
    header: Vec<u8>,
    plaintext_size: u64,
}

const ENCRYPTED_STREAM_RESPONSE_LIMIT: u64 = 4 * 1024 * 1024;

async fn encrypted_stream_record(
    account: &crate::workspace::AccountGuard,
    client: &grammers_client::Client,
    folder_id: Option<i64>,
    message_id: i32,
    media: &Media,
    caption: &str,
) -> Result<Option<EncryptedStreamRecord>, String> {
    let record = crate::commands::fs::resolve_remote_envelope(
        account, client, folder_id, message_id, media, caption,
    )
    .await?;
    record
        .map(|record| {
            Ok(EncryptedStreamRecord {
                header: record
                    .header_blob
                    .ok_or_else(|| "Encrypted media header is unavailable".to_string())?,
                plaintext_size: record
                    .plaintext_size
                    .ok_or_else(|| "Encrypted media length is unavailable".to_string())?,
            })
        })
        .transpose()
}

pub fn parse_range_header(header_val: &str, total_size: u64) -> Option<(u64, u64)> {
    if !header_val.starts_with("bytes=") {
        return None;
    }
    let s = &header_val["bytes=".len()..];
    let parts: Vec<&str> = s.split('-').collect();
    if parts.is_empty() {
        return None;
    }
    let start = parts[0].trim().parse::<u64>().ok()?;
    let end = if parts.len() > 1 && !parts[1].trim().is_empty() {
        let parsed_end = parts[1].trim().parse::<u64>().ok()?;
        std::cmp::min(parsed_end, total_size - 1)
    } else {
        total_size - 1
    };
    if start <= end {
        Some((start, end))
    } else {
        None
    }
}

/// Reject both new reads and already-awaited chunks after an account switch.
/// The same wrapper is exercised without Telegram in account-race tests.
fn guard_media_chunks<S>(
    stream: S,
    account: Option<crate::workspace::AccountGuard>,
) -> impl futures::Stream<Item = Result<web::Bytes, actix_web::Error>>
where
    S: futures::Stream<Item = Result<web::Bytes, actix_web::Error>>,
{
    use futures::StreamExt;
    async_stream::stream! {
        futures::pin_mut!(stream);
        loop {
            if account.as_ref().is_some_and(|account| account.validate().is_err()) {
                yield Err(actix_web::error::ErrorNotFound("The sharing account is no longer active"));
                break;
            }
            let Some(chunk) = stream.next().await else { break; };
            if account.as_ref().is_some_and(|account| account.validate().is_err()) {
                yield Err(actix_web::error::ErrorNotFound("The sharing account is no longer active"));
                break;
            }
            yield chunk;
        }
    }
}

/// Extra headers to inject into streaming responses (e.g. Cache-Control, Content-Disposition).
pub struct StreamingExtras {
    pub extra_headers: Vec<(&'static str, String)>,
    pub log_label: &'static str,
}

/// Build a streaming HTTP response for a Telegram media file with optional byte-range support.
/// This is the single shared implementation used by the streaming server, REST API, and share routes.
pub fn build_media_response_guarded(
    client: &grammers_client::Client,
    media: &Media,
    req: &actix_web::HttpRequest,
    mime: &str,
    filename: Option<&str>,
    extras: StreamingExtras,
    account: Option<crate::workspace::AccountGuard>,
) -> HttpResponse {
    if account
        .as_ref()
        .is_some_and(|account| account.validate().is_err())
    {
        return HttpResponse::NotFound().body("The sharing account is no longer active");
    }
    let size = media_size(media);

    // Parse Range header
    let mut start_byte = 0u64;
    let mut end_byte = if size > 0 { size - 1 } else { 0 };
    let mut is_range = false;

    if size > 0 {
        if let Some(range_header) = req.headers().get(actix_web::http::header::RANGE) {
            if let Ok(range_str) = range_header.to_str() {
                if let Some((start, end)) = parse_range_header(range_str, size) {
                    start_byte = start;
                    end_byte = end;
                    is_range = true;
                }
            }
        }
    }

    let content_length = if is_range {
        end_byte - start_byte + 1
    } else {
        size
    };

    // Chunk alignment for Telegram's upload.getFile offset requirement.
    //
    // CRITICAL: Without the `precise` flag (which grammers-client does not
    // expose), Telegram may route the request through a CDN that rounds the
    // offset down to a CDN chunk boundary (commonly 512 KB = 524288 bytes).
    // If our requested offset is not aligned to this boundary, the CDN
    // silently returns data starting from the rounded-down position.
    //
    // Example: requesting offset 111935488 (213.48 × 512 KB) gets rounded
    // to 111673344 (213 × 512 KB), introducing a 262 KB shift. This
    // misalignment accumulates across successive Range requests and
    // eventually corrupts the MP4 box parsing (triggering the "ORrI" error).
    //
    // Fix: always align to 512 KB boundaries, then slice off the leading
    // bytes to serve the exact byte range the client requested.
    let mut download_iter = client.iter_download(media);
    let mut bytes_to_skip: usize = 0;

    if start_byte > 0 {
        /// MTProto chunk size (must be divisible by grammers' MIN_CHUNK_SIZE).
        /// 65536 is safe — it is the default and widely tested.
        const CHUNK_SIZE: i32 = 65536;
        /// Telegram CDN alignment boundary. 512 KB is the largest observed
        /// CDN chunk size; aligning to this boundary prevents ANY rounding.
        const CDN_ALIGNMENT: u64 = 524288; // 512 KB

        // 1) Round the requested start down to a CDN-safe boundary.
        let cdn_aligned_start = (start_byte / CDN_ALIGNMENT) * CDN_ALIGNMENT;

        // 2) Compute how many 64 KB chunks to skip to reach that boundary.
        let chunk_index = (cdn_aligned_start / CHUNK_SIZE as u64) as i32;

        // Always set chunk size for predictable download behaviour.
        download_iter = download_iter.chunk_size(CHUNK_SIZE);
        if chunk_index > 0 {
            download_iter = download_iter.skip_chunks(chunk_index);
        }

        // 3) Leading bytes between the CDN-aligned offset and the client's
        //    actual requested start must be discarded.
        bytes_to_skip = (start_byte - cdn_aligned_start) as usize;

        // Safety: cdn_aligned_start ≤ start_byte by construction.
        debug_assert!(
            cdn_aligned_start <= start_byte,
            "CDN alignment invariant violated: aligned {} > requested {}",
            cdn_aligned_start,
            start_byte
        );

        log::debug!(
            "Range alignment: requested={}, cdn_aligned={}, chunk_index={}, bytes_to_skip={}",
            start_byte,
            cdn_aligned_start,
            chunk_index,
            bytes_to_skip,
        );
    }

    let label = extras.log_label;
    let stream = async_stream::stream! {
        let mut skipped: usize = 0;
        let mut total_yielded: u64 = 0;

        while let Some(chunk) = download_iter.next().await.transpose() {
            match chunk {
                Ok(data) => {
                    let mut data_slice = data;

                    if skipped < bytes_to_skip {
                        let to_skip = bytes_to_skip - skipped;
                        if data_slice.len() <= to_skip {
                            skipped += data_slice.len();
                            continue;
                        } else {
                            data_slice = data_slice[to_skip..].to_vec();
                            skipped = bytes_to_skip;
                        }
                    }

                    if total_yielded + data_slice.len() as u64 > content_length {
                        let allowed = (content_length - total_yielded) as usize;
                        if allowed > 0 {
                            yield Ok::<_, actix_web::Error>(web::Bytes::from(data_slice[..allowed].to_vec()));
                            total_yielded += allowed as u64;
                        }
                        break;
                    } else {
                        let len = data_slice.len() as u64;
                        yield Ok::<_, actix_web::Error>(web::Bytes::from(data_slice));
                        total_yielded += len;
                        if total_yielded >= content_length {
                            break;
                        }
                    }
                }
                Err(e) => {
                    log::error!("{} stream error: {}", label, e);
                    break;
                }
            }
        }
        log::debug!("{} stream completed (yielded: {})", label, total_yielded);
    };

    let stream = guard_media_chunks(stream, account);

    let mut resp = if is_range {
        let mut r = HttpResponse::PartialContent();
        r.insert_header((
            "Content-Range",
            format!("bytes {}-{}/{}", start_byte, end_byte, size),
        ));
        r.insert_header(("Content-Length", content_length.to_string()));
        r
    } else {
        let mut r = HttpResponse::Ok();
        r.insert_header(("Content-Length", size.to_string()));
        r
    };

    resp.insert_header(("Content-Type", mime.to_owned()));
    resp.insert_header(("Accept-Ranges", "bytes"));

    if let Some(fname) = filename {
        resp.insert_header((
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", fname),
        ));
    }

    for (key, val) in &extras.extra_headers {
        resp.insert_header((*key, val.clone()));
    }

    resp.streaming(stream)
}

async fn fetch_media_range(
    client: &grammers_client::Client,
    media: &Media,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    const CHUNK_SIZE: i32 = 65_536;
    const CDN_ALIGNMENT: u64 = 524_288;
    let aligned_start = (start / CDN_ALIGNMENT) * CDN_ALIGNMENT;
    let mut iterator = client
        .iter_download(media)
        .chunk_size(CHUNK_SIZE)
        .skip_chunks((aligned_start / CHUNK_SIZE as u64) as i32);
    let leading = (start - aligned_start) as usize;
    let required = end
        .checked_sub(start)
        .and_then(|length| length.checked_add(1))
        .ok_or_else(|| "Encrypted media range overflow".to_string())? as usize;
    let mut skipped = 0usize;
    let mut output = Vec::with_capacity(required);
    while output.len() < required {
        let Some(chunk) = iterator.next().await.transpose() else {
            break;
        };
        let chunk = chunk.map_err(|error| format!("Encrypted stream download failed: {error}"))?;
        let mut slice = chunk.as_slice();
        if skipped < leading {
            let skip = (leading - skipped).min(slice.len());
            skipped += skip;
            slice = &slice[skip..];
        }
        let take = (required - output.len()).min(slice.len());
        output.extend_from_slice(&slice[..take]);
    }
    if output.len() != required {
        return Err("Encrypted media range was truncated by Telegram".to_string());
    }
    Ok(output)
}

#[derive(serde::Deserialize)]
struct EncryptedStreamMetadata {
    mime_type: String,
}

async fn build_encrypted_media_response(
    client: &grammers_client::Client,
    media: &Media,
    req: &actix_web::HttpRequest,
    record: EncryptedStreamRecord,
    wrapping_key: &crate::crypto::secret::SecretKey,
    account: &crate::workspace::AccountGuard,
) -> HttpResponse {
    use crate::crypto::envelope::header::EnvelopeHeader;
    use crate::crypto::envelope::range::{
        chunk_ciphertext_offset, plaintext_range_to_ciphertext_records,
    };
    use crate::crypto::policy;

    if account.validate().is_err() {
        return HttpResponse::NotFound().finish();
    }
    if record.plaintext_size == 0 {
        return HttpResponse::UnprocessableEntity().body("Encrypted media is empty");
    }
    let requested = req
        .headers()
        .get(actix_web::http::header::RANGE)
        .and_then(|header| header.to_str().ok())
        .and_then(|header| parse_range_header(header, record.plaintext_size));
    let start = requested.map(|range| range.0).unwrap_or(0);
    let requested_end = requested
        .map(|range| range.1)
        .unwrap_or(record.plaintext_size - 1);
    let end = requested_end
        .min(start.saturating_add(ENCRYPTED_STREAM_RESPONSE_LIMIT - 1))
        .min(record.plaintext_size - 1);

    let header = match EnvelopeHeader::parse(&record.header) {
        Ok(header) => header,
        Err(error) => {
            return HttpResponse::UnprocessableEntity()
                .body(format!("Encrypted media header is invalid: {error}"));
        }
    };
    if header.core.total_plaintext_length != record.plaintext_size {
        return HttpResponse::UnprocessableEntity()
            .body("Encrypted media length does not match its authenticated header");
    }
    let decryptor = match crate::commands::fs::initialize_tdenc2_decryptor(
        &record.header,
        Some(wrapping_key),
        None,
    ) {
        Ok(decryptor) => decryptor,
        Err(error) => return HttpResponse::Locked().body(error),
    };
    let (first_chunk, last_chunk) = match plaintext_range_to_ciphertext_records(
        start,
        end,
        header.core.chunk_size,
        record.plaintext_size,
    ) {
        Ok(range) => range,
        Err(error) => return HttpResponse::RangeNotSatisfiable().body(error.to_string()),
    };
    let body_start =
        match chunk_ciphertext_offset(first_chunk, header.core.chunk_size, record.plaintext_size) {
            Ok(offset) => u64::from(header.core.header_length) + offset,
            Err(error) => return HttpResponse::UnprocessableEntity().body(error.to_string()),
        };
    let last_plaintext_offset = u64::from(last_chunk) * u64::from(header.core.chunk_size);
    let last_plaintext_length = record
        .plaintext_size
        .saturating_sub(last_plaintext_offset)
        .min(u64::from(header.core.chunk_size));
    let body_end =
        match chunk_ciphertext_offset(last_chunk, header.core.chunk_size, record.plaintext_size) {
            Ok(offset) => {
                u64::from(header.core.header_length)
                    + offset
                    + last_plaintext_length
                    + policy::AEAD_TAG_LENGTH as u64
                    - 1
            }
            Err(error) => return HttpResponse::UnprocessableEntity().body(error.to_string()),
        };
    let ciphertext = match fetch_media_range(client, media, body_start, body_end).await {
        Ok(ciphertext) => ciphertext,
        Err(error) => return HttpResponse::BadGateway().body(error),
    };

    if account.validate().is_err() {
        return HttpResponse::NotFound().finish();
    }
    let mut cursor = 0usize;
    let mut plaintext = Vec::new();
    for chunk_index in first_chunk..=last_chunk {
        let plaintext_offset = u64::from(chunk_index) * u64::from(header.core.chunk_size);
        let plaintext_length = record
            .plaintext_size
            .saturating_sub(plaintext_offset)
            .min(u64::from(header.core.chunk_size)) as usize;
        let ciphertext_length = plaintext_length + policy::AEAD_TAG_LENGTH;
        let next = cursor.saturating_add(ciphertext_length);
        if next > ciphertext.len() {
            return HttpResponse::BadGateway().body("Encrypted media record was truncated");
        }
        match decryptor.decrypt_chunk_at(chunk_index, &ciphertext[cursor..next]) {
            Ok(chunk) => plaintext.extend_from_slice(&chunk),
            Err(error) => {
                return HttpResponse::UnprocessableEntity().body(format!(
                    "Encrypted media record authentication failed: {error}"
                ));
            }
        }
        cursor = next;
    }

    let combined_start = u64::from(first_chunk) * u64::from(header.core.chunk_size);
    let slice_start = (start - combined_start) as usize;
    let slice_length = (end - start + 1) as usize;
    if slice_start.saturating_add(slice_length) > plaintext.len() {
        return HttpResponse::BadGateway().body("Decrypted media range was incomplete");
    }
    let body = plaintext[slice_start..slice_start + slice_length].to_vec();
    let mime = serde_json::from_slice::<EncryptedStreamMetadata>(decryptor.metadata_plaintext())
        .ok()
        .map(|metadata| metadata.mime_type)
        .filter(|mime| !mime.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    if account.validate().is_err() {
        return HttpResponse::NotFound().finish();
    }
    HttpResponse::PartialContent()
        .insert_header(("Content-Type", mime))
        .insert_header(("Accept-Ranges", "bytes"))
        .insert_header((
            "Content-Range",
            format!("bytes {start}-{end}/{}", record.plaintext_size),
        ))
        .insert_header(("Content-Length", body.len().to_string()))
        .insert_header(("Cache-Control", "no-store"))
        .body(body)
}

#[get("/stream/{folder_id}/{message_id}")]
async fn stream_media(
    req: actix_web::HttpRequest,
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    account_root: web::Data<crate::share_routes::ShareAccountRoot>,
    crypto_state: web::Data<crate::crypto::state::CryptoState>,
) -> impl Responder {
    if query.token.as_deref() != Some(token_data.token.as_str()) {
        return HttpResponse::Forbidden().body("Invalid or missing stream token");
    }
    let (folder_id_str, message_id) = path.into_inner();
    let folder_id = match folder_id_str.as_str() {
        "me" | "home" | "null" => None,
        value => match value.parse::<i64>() {
            Ok(id) => Some(id),
            Err(_) => return HttpResponse::BadRequest().body("Invalid folder ID"),
        },
    };
    let account = match crate::workspace::AccountGuard::open(&account_root.get_ref().0, None) {
        Ok(account) => account,
        Err(_) => return HttpResponse::NotFound().body("The streaming account is unavailable"),
    };
    let Some(client) = data.client.lock().await.clone() else {
        return HttpResponse::ServiceUnavailable().body("Telegram client not connected");
    };
    if account.validate_client(&client).await.is_err() {
        return HttpResponse::NotFound().finish();
    }
    let peer = match resolve_peer(&client, folder_id, &data.peer_cache).await {
        Ok(peer) => peer,
        Err(error) => {
            return HttpResponse::BadRequest().body(format!("Peer resolution failed: {error}"))
        }
    };
    if account.validate().is_err() {
        return HttpResponse::NotFound().finish();
    }
    let messages = match client.get_messages_by_id(&peer, &[message_id]).await {
        Ok(messages) => messages,
        Err(error) => {
            return HttpResponse::BadGateway().body(format!("Failed to fetch message: {error}"))
        }
    };
    if account.validate().is_err() {
        return HttpResponse::NotFound().finish();
    }
    let Some(message) = messages.into_iter().flatten().next() else {
        return HttpResponse::NotFound().body("Message not found");
    };
    let Some(media) = message.media() else {
        return HttpResponse::NotFound().body("Media not found");
    };
    let record = match encrypted_stream_record(
        &account,
        &client,
        folder_id,
        message_id,
        &media,
        message.text(),
    )
    .await
    {
        Ok(record) => record,
        Err(error) => return HttpResponse::Conflict().body(error),
    };
    if let Some(record) = record {
        let Some(credential) = query.credential else {
            return HttpResponse::Locked()
                .body("Unlock the vault before streaming protected media");
        };
        let key = match crypto_state.operation_wrapping_key(
            credential,
            crate::crypto::state::OperationClass::MediaStream,
        ) {
            Ok(key) => key,
            Err(_) => {
                return HttpResponse::Locked()
                    .body("The protected-media credential expired; unlock and retry")
            }
        };
        return build_encrypted_media_response(&client, &media, &req, record, &key, &account).await;
    }
    let mime = mime_type_from_media(&media);
    build_media_response_guarded(
        &client,
        &media,
        &req,
        &mime,
        None,
        StreamingExtras {
            extra_headers: vec![("Cache-Control", "private, max-age=120".into())],
            log_label: "Stream",
        },
        Some(account),
    )
}

fn mime_type_from_media(media: &Media) -> String {
    match media {
        Media::Document(d) => d
            .mime_type()
            .unwrap_or("application/octet-stream")
            .to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

pub async fn start_server(
    state: Arc<TelegramState>,
    port: u16,
    token: String,
    db_pool: crate::db::DbConnection,
    transcode_manager: Arc<TranscodeManager>,
    crypto_state: crate::crypto::state::CryptoState,
    account_root: std::path::PathBuf,
) -> std::io::Result<actix_web::dev::Server> {
    let listener = bind_stream_listener(port)?;
    start_server_with_listener(
        state,
        token,
        db_pool,
        transcode_manager,
        crypto_state,
        account_root,
        listener,
    )
}

fn bind_stream_listener(port: u16) -> std::io::Result<TcpListener> {
    // Bind the listener to 127.0.0.1 explicitly. The streaming server is only
    // accessed from the local frontend; exposing it on all interfaces is both
    // unnecessary and liable to trigger desktop firewall prompts.
    let ipv4_addr = format!("127.0.0.1:{port}");
    match TcpListener::bind(&ipv4_addr) {
        Ok(listener) => {
            log::info!("Streaming Server listening on {} (IPv4)", ipv4_addr);
            Ok(listener)
        }
        Err(error) => {
            log::warn!(
                "IPv4 loopback bind failed ({}), falling back to IPv6 loopback",
                error
            );
            let ipv6_addr = format!("[::1]:{port}");
            let listener = TcpListener::bind(&ipv6_addr)?;
            log::info!(
                "Streaming Server listening on {} (IPv6 loopback)",
                ipv6_addr
            );
            Ok(listener)
        }
    }
}

pub(crate) fn start_server_with_listener(
    state: Arc<TelegramState>,
    token: String,
    db_pool: crate::db::DbConnection,
    transcode_manager: Arc<TranscodeManager>,
    crypto_state: crate::crypto::state::CryptoState,
    account_root: std::path::PathBuf,
    listener: TcpListener,
) -> std::io::Result<actix_web::dev::Server> {
    let state_data = web::Data::new(state);
    let token_data = web::Data::new(StreamTokenData { token });
    let db_data = web::Data::new(db_pool);
    let transcode_data = web::Data::new(transcode_manager);
    let crypto_data = web::Data::new(crypto_state);
    let share_root = web::Data::new(crate::share_routes::ShareAccountRoot(account_root));
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let local_addr = listener.local_addr()?;
    log::info!("Starting Streaming Server on {}", local_addr);

    let server = HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin_fn(|origin, _req_head| {
                crate::local_cors::is_allowed_origin_header(origin)
            })
            .allow_any_method()
            .allow_any_header();

        let app = App::new()
            .wrap(cors)
            .app_data(state_data.clone())
            .app_data(token_data.clone())
            .app_data(db_data.clone())
            .app_data(transcode_data.clone())
            .app_data(crypto_data.clone())
            .app_data(share_root.clone());

        app.service(stream_media)
            .configure(crate::share_routes::configure_share_routes)
            .configure(crate::transcode::configure_hls_routes)
            .configure(crate::fmp4_remux::configure_fmp4_routes)
    })
    .listen(listener)?
    .run();

    log::info!("Streaming Server started successfully on {}", local_addr);

    Ok(server)
}
