use crate::commands::utils::{media_size, resolve_peer};
use crate::commands::TelegramState;
use crate::transcode::TranscodeManager;
use actix_cors::Cors;
use actix_web::{get, web, App, HttpResponse, HttpServer, Responder};
use grammers_client::types::Media;

use std::net::TcpListener;
use std::sync::Arc;

struct MediaResolutionEntry<T> {
    account: crate::workspace::AccountGuard,
    created: std::time::Instant,
    value: tokio::sync::Mutex<Option<T>>,
}

type MediaResolutionEntries<T> =
    std::collections::HashMap<(Option<i64>, i32), Arc<MediaResolutionEntry<T>>>;

/// Small, expiring, session-scoped snapshots of resolved messages and their
/// peer maps. No plaintext, wrapping keys or authorization results are cached.
/// Only callers of the same entry serialize; the registry is never held over
/// network I/O. Failed or cancelled lookups remain retryable.
pub(crate) struct MediaResolutionCache<T> {
    entries: tokio::sync::Mutex<MediaResolutionEntries<T>>,
    limit: usize,
    ttl: std::time::Duration,
}

impl<T: Clone> MediaResolutionCache<T> {
    pub(crate) fn new(limit: usize, ttl: std::time::Duration) -> Self {
        assert!(limit > 0);
        Self {
            entries: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            limit,
            ttl,
        }
    }

    pub(crate) async fn resolve<F, Fut>(
        &self,
        account: &crate::workspace::AccountGuard,
        key: (Option<i64>, i32),
        load: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        account.validate()?;
        let entry = {
            let mut entries = self.entries.lock().await;
            entries.retain(|_, entry| {
                entry.created.elapsed() < self.ttl && entry.account.same_session(account)
            });
            if !entries.contains_key(&key) {
                if entries.len() >= self.limit {
                    if let Some(oldest) = entries
                        .iter()
                        .min_by_key(|(_, entry)| entry.created)
                        .map(|(key, _)| *key)
                    {
                        entries.remove(&oldest);
                    }
                }
                entries.insert(
                    key,
                    Arc::new(MediaResolutionEntry {
                        account: account.clone(),
                        created: std::time::Instant::now(),
                        value: tokio::sync::Mutex::new(None),
                    }),
                );
            }
            entries[&key].clone()
        };
        let mut value = entry.value.lock().await;
        account.validate()?;
        if let Some(value) = value.as_ref() {
            return Ok(value.clone());
        }
        let loaded = load().await?;
        account.validate()?;
        *value = Some(loaded.clone());
        Ok(loaded)
    }
}

/// Holds the per-session streaming token for Actix validation
pub struct StreamTokenData {
    pub token: String,
    media_cache: MediaResolutionCache<grammers_client::types::Message>,
}

#[derive(serde::Deserialize)]
struct StreamQuery {
    token: Option<String>,
    credential: Option<u64>,
}

pub(crate) struct EncryptedStreamRecord {
    pub header: Vec<u8>,
    pub plaintext_size: u64,
}

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

#[derive(Clone, Copy)]
enum RangeSelection {
    Full,
    Partial(u64, u64),
    Unsatisfiable,
}

fn decimal(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(value.bytes().fold(0u64, |number, digit| {
        number
            .saturating_mul(10)
            .saturating_add(u64::from(digit - b'0'))
    }))
}

/// A single byte range. Unsupported/malformed or multipart fields are ignored;
/// syntactically valid ranges that select no bytes produce RFC 9110's 416.
fn select_range(req: &actix_web::HttpRequest, size: u64) -> RangeSelection {
    let Some(value) = req
        .headers()
        .get(actix_web::http::header::RANGE)
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("bytes="))
    else {
        return RangeSelection::Full;
    };
    let Some((first, last)) = value.split_once('-') else {
        return RangeSelection::Full;
    };
    let first = first.trim();
    let last = last.trim();
    if first.is_empty() {
        let Some(suffix) = decimal(last) else {
            return RangeSelection::Full;
        };
        if suffix == 0 || size == 0 {
            return RangeSelection::Unsatisfiable;
        }
        return RangeSelection::Partial(size.saturating_sub(suffix), size - 1);
    }
    let Some(start) = decimal(first) else {
        return RangeSelection::Full;
    };
    let end = if last.is_empty() {
        u64::MAX
    } else {
        let Some(end) = decimal(last) else {
            return RangeSelection::Full;
        };
        end
    };
    if start > end {
        return RangeSelection::Full;
    }
    if size == 0 || start >= size {
        return RangeSelection::Unsatisfiable;
    }
    RangeSelection::Partial(start, end.min(size - 1))
}

fn unsatisfiable_range(size: u64) -> HttpResponse {
    HttpResponse::RangeNotSatisfiable()
        .insert_header(("Content-Range", format!("bytes */{size}")))
        .insert_header(("Accept-Ranges", "bytes"))
        .insert_header(("Cache-Control", "no-store"))
        .finish()
}

fn attachment_disposition(filename: &str) -> String {
    let clean: String = filename
        .chars()
        .filter(|ch| !ch.is_control())
        .map(|ch| if ch == '/' || ch == '\\' { '_' } else { ch })
        .collect();
    let fallback: String = clean
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{}",
        urlencoding::encode(&clean)
    )
}

/// Slice a CDN-aligned source without copying its chunks. A failed source or
/// premature EOF aborts the HTTP body instead of signalling normal completion.
fn slice_media_chunks<S>(
    download: S,
    leading: usize,
    length: u64,
    label: &'static str,
) -> impl futures::Stream<Item = Result<web::Bytes, actix_web::Error>>
where
    S: futures::Stream<Item = Result<web::Bytes, actix_web::Error>>,
{
    async_stream::stream! {
        use futures::StreamExt;
        futures::pin_mut!(download);
        let mut skipped = 0usize;
        let mut remaining = length;
        while remaining > 0 {
            let bytes = match download.next().await {
                Some(Ok(bytes)) => bytes,
                Some(Err(error)) => {
                    log::error!("{} stream failed with {} bytes remaining: {}", label, remaining, error);
                    yield Err(error); return;
                }
                None => {
                    log::error!("{} stream ended with {} bytes remaining", label, remaining);
                    yield Err(actix_web::error::ErrorBadGateway("Media source ended before the declared length")); return;
                }
            };
            let skip = (leading - skipped).min(bytes.len());
            skipped += skip;
            let bytes = bytes.slice(skip..);
            let take = remaining.min(bytes.len() as u64) as usize;
            if take > 0 {
                remaining -= take as u64;
                yield Ok(bytes.slice(..take));
            }
        }
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

fn quota_media_chunks<S>(
    stream: S,
    mut reservation: crate::bandwidth::BandwidthReservation,
    expected: u64,
) -> impl futures::Stream<Item = Result<web::Bytes, actix_web::Error>>
where
    S: futures::Stream<Item = Result<web::Bytes, actix_web::Error>>,
{
    use futures::StreamExt;
    async_stream::stream! {
        futures::pin_mut!(stream);let mut count=0u64;
        while let Some(chunk)=stream.next().await {
            match &chunk {Ok(bytes)=>{count=count.saturating_add(bytes.len() as u64);},Err(_)=>{yield chunk;return;}}
            yield chunk;
        }
        if count==expected {reservation.commit();}
    }
}

fn pace_media_chunks<S>(
    stream: S,
    network: Arc<crate::vpn_optimizer::NetworkConfig>,
    account: Option<crate::workspace::AccountGuard>,
) -> impl futures::Stream<Item = Result<web::Bytes, actix_web::Error>>
where
    S: futures::Stream<Item = Result<web::Bytes, actix_web::Error>>,
{
    use futures::StreamExt;
    async_stream::stream! {
        futures::pin_mut!(stream);
        while let Some(chunk)=stream.next().await {
            if let Ok(bytes)=&chunk {
                if let Err(error)=network.pacer.wait(&network,crate::traffic::Direction::Download,bytes.len(),|| account.as_ref().map_or(Ok(()),|account|account.validate())).await {
                    yield Err(actix_web::error::ErrorNotFound(error));return;
                }
            }
            yield chunk;
        }
    }
}

/// Extra headers to inject into streaming responses (e.g. Cache-Control, Content-Disposition).
pub struct StreamingExtras {
    pub bandwidth: Arc<crate::bandwidth::BandwidthManager>,
    pub network: Arc<crate::vpn_optimizer::NetworkConfig>,
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
    build_media_response_from_source(
        media_size(media),
        req,
        mime,
        filename,
        extras,
        account,
        |start| telegram_media_chunks(client, media, start),
    )
}

fn telegram_media_chunks(
    client: &grammers_client::Client,
    media: &Media,
    start: u64,
) -> impl futures::Stream<Item = Result<web::Bytes, actix_web::Error>> + use<> {
    const CHUNK_SIZE: i32 = 65_536;
    const CDN_ALIGNMENT: u64 = 524_288;
    let aligned_start = (start / CDN_ALIGNMENT) * CDN_ALIGNMENT;
    let mut iterator = client
        .iter_download(media)
        .chunk_size(CHUNK_SIZE)
        .skip_chunks((aligned_start / CHUNK_SIZE as u64) as i32);
    async_stream::stream! {
        while let Some(chunk) = iterator.next().await.transpose() {
            yield chunk.map(web::Bytes::from).map_err(actix_web::error::ErrorBadGateway);
        }
    }
}

/// The shared HTTP contract; the source starts at the preceding CDN boundary.
/// Native journeys supply a disk-backed source in place of Telegram downloads.
pub(crate) fn build_media_response_from_source<S, F>(
    size: u64,
    req: &actix_web::HttpRequest,
    mime: &str,
    filename: Option<&str>,
    extras: StreamingExtras,
    account: Option<crate::workspace::AccountGuard>,
    source: F,
) -> HttpResponse
where
    S: futures::Stream<Item = Result<web::Bytes, actix_web::Error>> + 'static,
    F: FnOnce(u64) -> S,
{
    if account
        .as_ref()
        .is_some_and(|account| account.validate().is_err())
    {
        return HttpResponse::NotFound().body("The sharing account is no longer active");
    }

    let (start_byte, end_byte, is_range) = match select_range(req, size) {
        RangeSelection::Full => (0, size.saturating_sub(1), false),
        RangeSelection::Partial(start, end) => (start, end, true),
        RangeSelection::Unsatisfiable => return unsatisfiable_range(size),
    };
    let content_length = if is_range {
        end_byte - start_byte + 1
    } else {
        size
    };
    let reservation = match crate::bandwidth::BandwidthReservation::download(
        extras.bandwidth.clone(),
        content_length,
    ) {
        Ok(hold) => hold,
        Err(error) => return HttpResponse::TooManyRequests().body(error),
    };
    let stream = slice_media_chunks(
        source(start_byte),
        (start_byte % 524_288) as usize,
        content_length,
        extras.log_label,
    );

    let stream = pace_media_chunks(stream, extras.network, account.clone());
    let stream = guard_media_chunks(stream, account);
    let stream = quota_media_chunks(stream, reservation, content_length);

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
        resp.insert_header(("Content-Disposition", attachment_disposition(fname)));
    }

    for (key, val) in &extras.extra_headers {
        resp.insert_header((*key, val.clone()));
    }

    resp.streaming(stream)
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
    access: ProtectedStreamAccess,
) -> HttpResponse {
    build_encrypted_media_response_from_source(
        req,
        record,
        wrapping_key,
        account,
        access,
        |start| telegram_media_chunks(client, media, start),
    )
    .await
}

pub(crate) async fn build_encrypted_media_response_from_source<S, F>(
    req: &actix_web::HttpRequest,
    record: EncryptedStreamRecord,
    wrapping_key: &crate::crypto::secret::SecretKey,
    account: &crate::workspace::AccountGuard,
    access: ProtectedStreamAccess,
    source: F,
) -> HttpResponse
where
    S: futures::Stream<Item = Result<web::Bytes, actix_web::Error>> + 'static,
    F: FnOnce(u64) -> S,
{
    use crate::crypto::envelope::header::EnvelopeHeader;
    use crate::crypto::envelope::range::{
        chunk_ciphertext_offset, plaintext_range_to_ciphertext_records,
    };
    use crate::crypto::policy;

    if account.validate().is_err() {
        return HttpResponse::NotFound().finish();
    }
    let (start, end, is_range) = match select_range(req, record.plaintext_size) {
        RangeSelection::Full => (0, record.plaintext_size.saturating_sub(1), false),
        RangeSelection::Partial(start, end) => (start, end, true),
        RangeSelection::Unsatisfiable => return unsatisfiable_range(record.plaintext_size),
    };
    if record.plaintext_size == 0 {
        return HttpResponse::UnprocessableEntity().body("Encrypted media is empty");
    }

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
    let mut decryptor = match crate::commands::fs::initialize_tdenc2_decryptor(
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
    let mime = serde_json::from_slice::<EncryptedStreamMetadata>(decryptor.metadata_plaintext())
        .ok()
        .map(|metadata| metadata.mime_type)
        .filter(|mime| !mime.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    // Whole-file reads also authenticate the final digest. Hold the last record
    // until verification so a client cannot observe a complete body too early.
    let whole_file = start == 0 && end == record.plaintext_size - 1;
    let ciphertext_length = body_end - body_start
        + 1
        + if whole_file {
            policy::FINAL_RECORD_CIPHERTEXT_SIZE as u64
        } else {
            0
        };
    let download = slice_media_chunks(
        source(body_start),
        (body_start % 524_288) as usize,
        ciphertext_length,
        "Encrypted media",
    );
    let chunk_size = header.core.chunk_size;
    let plaintext_size = record.plaintext_size;
    let stream = async_stream::stream! {
        use futures::StreamExt;
        futures::pin_mut!(download);
        // At most one authenticated record plus one 64 KiB download fragment.
        // The TDENC2 format's existing maximum record size stays unchanged.
        let mut buffer = bytes::BytesMut::new();
        for chunk_index in first_chunk..=last_chunk {
            let plaintext_offset = u64::from(chunk_index) * u64::from(chunk_size);
            let plaintext_length = (plaintext_size - plaintext_offset).min(u64::from(chunk_size)) as usize;
            let required = plaintext_length + policy::AEAD_TAG_LENGTH;
            while buffer.len() < required {
                match download.next().await {
                    Some(Ok(bytes)) => buffer.extend_from_slice(&bytes),
                    Some(Err(error)) => { yield Err(error); return; }
                    None => { yield Err(actix_web::error::ErrorBadGateway("Encrypted media record was truncated")); return; }
                }
            }
            let ciphertext = buffer.split_to(required);
            let plaintext = if whole_file { decryptor.feed(&ciphertext) }
                else { decryptor.decrypt_chunk_at(chunk_index, &ciphertext) };
            let plaintext = match plaintext {
                Ok(plaintext) => plaintext,
                Err(error) => {
                    log::error!("Encrypted media record authentication failed: {}", error);
                    yield Err(actix_web::error::ErrorUnprocessableEntity("Encrypted media record authentication failed")); return;
                }
            };
            if whole_file && chunk_index == last_chunk {
                while buffer.len() < policy::FINAL_RECORD_CIPHERTEXT_SIZE {
                    match download.next().await {
                        Some(Ok(bytes)) => buffer.extend_from_slice(&bytes),
                        Some(Err(error)) => { yield Err(error); return; }
                        None => { yield Err(actix_web::error::ErrorBadGateway("Encrypted media final record was truncated")); return; }
                    }
                }
                if let Err(error) = decryptor.feed(&buffer).and_then(|_| decryptor.finish()) {
                    log::error!("Encrypted media final record authentication failed: {}", error);
                    yield Err(actix_web::error::ErrorUnprocessableEntity("Encrypted media final record authentication failed")); return;
                }
            }
            let from = start.saturating_sub(plaintext_offset) as usize;
            let to = (end - plaintext_offset + 1).min(plaintext_length as u64) as usize;
            yield Ok(web::Bytes::from(plaintext).slice(from..to));
        }
    };
    let reservation = match crate::bandwidth::BandwidthReservation::download(
        access.bandwidth.clone(),
        end - start + 1,
    ) {
        Ok(hold) => hold,
        Err(error) => return HttpResponse::TooManyRequests().body(error),
    };
    let stream = guard_protected_chunks(guard_media_chunks(stream, Some(account.clone())), access);
    let stream = quota_media_chunks(stream, reservation, end - start + 1);
    let mut response = if is_range {
        HttpResponse::PartialContent()
    } else {
        HttpResponse::Ok()
    };
    if is_range {
        response.insert_header((
            "Content-Range",
            format!("bytes {start}-{end}/{plaintext_size}"),
        ));
    }
    response
        .insert_header(("Content-Type", mime))
        .insert_header(("Accept-Ranges", "bytes"))
        .insert_header(("Content-Length", (end - start + 1).to_string()))
        .insert_header(("Cache-Control", "no-store"))
        .streaming(stream)
}

pub(crate) struct ProtectedStreamAccess {
    pub bandwidth: Arc<crate::bandwidth::BandwidthManager>,
    pub network: Arc<crate::vpn_optimizer::NetworkConfig>,
    pub account: crate::workspace::AccountGuard,
    pub state: crate::crypto::state::CryptoState,
    pub credential: u64,
}

fn guard_protected_chunks<S>(
    stream: S,
    access: ProtectedStreamAccess,
) -> impl futures::Stream<Item = Result<web::Bytes, actix_web::Error>>
where
    S: futures::Stream<Item = Result<web::Bytes, actix_web::Error>>,
{
    use futures::StreamExt;
    async_stream::stream! {
        futures::pin_mut!(stream);
        let authorized = || access.state.validate_operation(access.credential,crate::crypto::state::OperationClass::MediaStream).is_ok();
        loop {
            if !authorized() { yield Err(actix_web::error::ErrorLocked("Protected-media credential expired")); return; }
            let Some(chunk) = stream.next().await else { break; };
            match chunk {
                Err(error)=>{yield Err(error);return;}
                Ok(bytes)=>{
                    let mut offset=0;
                    while offset<bytes.len() {
                        let end=(offset+65536).min(bytes.len());
                        let result=access.network.pacer.wait(&access.network,crate::traffic::Direction::Download,end-offset,||{access.account.validate()?;access.state.validate_operation(access.credential,crate::crypto::state::OperationClass::MediaStream).map_err(|error|error.to_string())}).await;
                        if let Err(error)=result{yield Err(actix_web::error::ErrorLocked(error));return;}
                        // Actual delivered media remains activity, as before;
                        // scheduled/rate waits use only non-renewing validation.
                        if access.state.operation_wrapping_key(access.credential,crate::crypto::state::OperationClass::MediaStream).is_err(){yield Err(actix_web::error::ErrorLocked("Protected-media credential expired"));return;}
                        yield Ok(bytes.slice(offset..end));offset=end;
                    }
                }
            }
        }
    }
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
    let message = match token_data
        .media_cache
        .resolve(&account, (folder_id, message_id), || async {
            let peer = resolve_peer(&client, folder_id, &data.peer_cache)
                .await
                .map_err(|error| format!("Peer resolution failed: {error}"))?;
            account.validate()?;
            let messages = client
                .get_messages_by_id(&peer, &[message_id])
                .await
                .map_err(|error| format!("Failed to fetch message: {error}"))?;
            account.validate()?;
            messages
                .into_iter()
                .flatten()
                .next()
                .ok_or_else(|| "Message not found".into())
        })
        .await
    {
        Ok(message) => message,
        Err(error) if error.starts_with("ACCOUNT_") || error == "Message not found" => {
            return HttpResponse::NotFound().finish()
        }
        Err(error) if error.starts_with("Peer resolution failed:") => {
            return HttpResponse::BadRequest().body(error)
        }
        Err(error) => return HttpResponse::BadGateway().body(error),
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
        return build_encrypted_media_response(
            &client,
            &media,
            &req,
            record,
            &key,
            &account,
            ProtectedStreamAccess {
                bandwidth: req
                    .app_data::<web::Data<Arc<crate::bandwidth::BandwidthManager>>>()
                    .expect("Shared bandwidth accounting")
                    .get_ref()
                    .clone(),
                network: req
                    .app_data::<web::Data<Arc<crate::vpn_optimizer::NetworkConfig>>>()
                    .expect("Shared network state")
                    .get_ref()
                    .clone(),
                account: account.clone(),
                state: crypto_state.get_ref().clone(),
                credential,
            },
        )
        .await;
    }
    let mime = mime_type_from_media(&media);
    build_media_response_guarded(
        &client,
        &media,
        &req,
        &mime,
        None,
        StreamingExtras {
            bandwidth: req
                .app_data::<web::Data<Arc<crate::bandwidth::BandwidthManager>>>()
                .expect("Shared bandwidth accounting")
                .get_ref()
                .clone(),
            network: req
                .app_data::<web::Data<Arc<crate::vpn_optimizer::NetworkConfig>>>()
                .expect("Shared network state")
                .get_ref()
                .clone(),
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

#[allow(clippy::too_many_arguments)] // Explicit shared server state; no independently constructed network policy.
pub async fn start_server(
    state: Arc<TelegramState>,
    port: u16,
    token: String,
    db_pool: crate::db::DbConnection,
    transcode_manager: Arc<TranscodeManager>,
    crypto_state: crate::crypto::state::CryptoState,
    account_root: std::path::PathBuf,
    network: Arc<crate::vpn_optimizer::NetworkConfig>,
    bandwidth: Arc<crate::bandwidth::BandwidthManager>,
) -> std::io::Result<actix_web::dev::Server> {
    let listener = bind_stream_listener(port)?;
    start_server_with_listener(
        state,
        token,
        db_pool,
        transcode_manager,
        crypto_state,
        account_root,
        network,
        bandwidth,
        listener,
    )
}

/// Binds the loopback media server. The preferred port keeps existing share
/// links valid; when another process holds it, an operating-system-assigned
/// port is used instead so streaming, previews and share pages stay available.
pub fn bind_stream_listener(port: u16) -> std::io::Result<TcpListener> {
    // Bind the listener to 127.0.0.1 explicitly. The streaming server is only
    // accessed from the local frontend; exposing it on all interfaces is both
    // unnecessary and liable to trigger desktop firewall prompts.
    let listener = bind_loopback(port).or_else(|preferred_error| {
        if port == 0 {
            return Err(preferred_error);
        }
        log::warn!(
            "Preferred loopback port {} is unavailable ({}); using an automatically assigned port",
            port,
            preferred_error
        );
        bind_loopback(0)
    })?;
    crate::set_stream_port(listener.local_addr()?.port());
    Ok(listener)
}

fn bind_loopback(port: u16) -> std::io::Result<TcpListener> {
    let ipv4_addr = format!("127.0.0.1:{port}");
    match TcpListener::bind(&ipv4_addr) {
        Ok(listener) => {
            log::info!(
                "Streaming Server listening on {} (IPv4)",
                listener.local_addr()?
            );
            Ok(listener)
        }
        // Another process owns this port. Binding the same number on IPv6
        // would leave `localhost` requests reaching that other process.
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Err(error),
        Err(error) => {
            log::warn!(
                "IPv4 loopback bind failed ({}), falling back to IPv6 loopback",
                error
            );
            let ipv6_addr = format!("[::1]:{port}");
            let listener = TcpListener::bind(&ipv6_addr)?;
            log::info!(
                "Streaming Server listening on {} (IPv6 loopback)",
                listener.local_addr()?
            );
            Ok(listener)
        }
    }
}

#[allow(clippy::too_many_arguments)] // Explicit shared server state and pre-bound listener.
pub(crate) fn start_server_with_listener(
    state: Arc<TelegramState>,
    token: String,
    db_pool: crate::db::DbConnection,
    transcode_manager: Arc<TranscodeManager>,
    crypto_state: crate::crypto::state::CryptoState,
    account_root: std::path::PathBuf,
    network: Arc<crate::vpn_optimizer::NetworkConfig>,
    bandwidth: Arc<crate::bandwidth::BandwidthManager>,
    listener: TcpListener,
) -> std::io::Result<actix_web::dev::Server> {
    let bandwidth_data = web::Data::new(bandwidth);
    let network_data = web::Data::new(network);
    let state_data = web::Data::new(state);
    let token_data = web::Data::new(StreamTokenData {
        token,
        media_cache: MediaResolutionCache::new(64, std::time::Duration::from_secs(120)),
    });
    let db_data = web::Data::new(db_pool);
    let transcode_data = web::Data::new(transcode_manager);
    let crypto_data = web::Data::new(crypto_state);
    let share_root = web::Data::new(crate::share_routes::ShareAccountRoot(account_root));
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
            .app_data(bandwidth_data.clone())
            .app_data(network_data.clone())
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
