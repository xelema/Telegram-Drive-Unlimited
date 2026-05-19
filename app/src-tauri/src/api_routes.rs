use actix_web::{get, web, HttpRequest, HttpResponse, Responder};
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use grammers_client::types::Media;
use serde::Serialize;
use std::sync::Arc;

/// Shared state for the API server — holds the key hash for auth checks
pub struct ApiState {
    pub key_hash: Option<String>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: String,
    message: String,
}

fn json_error(code: &str, message: &str, status: u16) -> HttpResponse {
    let body = ErrorBody {
        error: ErrorDetail {
            code: code.to_string(),
            message: message.to_string(),
        },
    };
    HttpResponse::build(actix_web::http::StatusCode::from_u16(status).unwrap())
        .json(body)
}

/// Validate X-API-Key header against stored hash
fn check_auth(req: &HttpRequest, api_state: &web::Data<ApiState>) -> Result<(), HttpResponse> {
    let key_hash = match &api_state.key_hash {
        Some(h) => h,
        None => return Err(json_error("NO_KEY_CONFIGURED", "No API key has been configured. Generate one in Settings.", 401)),
    };

    let provided = req
        .headers()
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok());

    match provided {
        Some(key) if crate::commands::api_settings::verify_key(key, key_hash) => Ok(()),
        Some(_) => Err(json_error("UNAUTHORIZED", "Invalid API key", 401)),
        None => Err(json_error("UNAUTHORIZED", "Missing X-API-Key header", 401)),
    }
}

// ──────────────────────────────── Endpoints ────────────────────────────────

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
}

#[get("/api/v1/health")]
async fn api_health() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[derive(serde::Deserialize)]
struct FilesQuery {
    folder_id: Option<i64>,
    page: Option<u32>,
    limit: Option<u32>,
    search: Option<String>,
    offset_id: Option<i32>,
}

#[derive(Serialize)]
struct FilesResponse {
    files: Vec<ApiFile>,
    page: u32,
    limit: u32,
    total: usize,
}

#[derive(Serialize)]
struct ApiFile {
    id: i64,
    folder_id: Option<i64>,
    name: String,
    size: u64,
    mime_type: Option<String>,
    created_at: String,
}

#[get("/api/v1/files")]
async fn api_list_files(
    req: HttpRequest,
    query: web::Query<FilesQuery>,
    tg_state: web::Data<Arc<TelegramState>>,
    api_state: web::Data<ApiState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &api_state) {
        return e;
    }

    let client_opt = { tg_state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &tg_state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(50).min(200).max(1);

    let mut msgs = client.iter_messages(&peer);
    if let Some(offset_id) = query.offset_id {
        msgs = msgs.offset_id(offset_id);
    }

    // Apply API-level limit to prevent fetching the entire history.
    if query.search.is_none() {
        if query.offset_id.is_some() {
            // With offset_id, we only need to fetch enough messages to get `limit` files.
            msgs = msgs.limit(limit as usize * 2);
        } else {
            // Traditional page-based offset.
            msgs = msgs.limit(page as usize * limit as usize * 2);
        }
    } else {
        // If there's a search, we cap it at a reasonable maximum to avoid infinite loops.
        msgs = msgs.limit(2000);
    }

    let mut all_files: Vec<ApiFile> = Vec::new();
    while let Some(msg) = msgs.next().await.ok().flatten() {
        if let Some(doc) = msg.media() {
            let (name, size, mime) = match doc {
                Media::Document(d) => {
                    (d.name().to_string(), d.size(), d.mime_type().map(|s| s.to_string()))
                }
                Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".into())),
                _ => ("Unknown".to_string(), 0, None),
            };

            // Apply search filter if provided
            if let Some(ref search) = query.search {
                if !name.to_lowercase().contains(&search.to_lowercase()) {
                    continue;
                }
            }

            all_files.push(ApiFile {
                id: msg.id() as i64,
                folder_id: query.folder_id,
                name,
                size: size as u64,
                mime_type: mime,
                created_at: msg.date().to_string(),
            });
        }
    }

    let total = all_files.len();
    let paginated: Vec<ApiFile> = if query.offset_id.is_some() {
        all_files.into_iter().take(limit as usize).collect()
    } else {
        let start = ((page - 1) * limit) as usize;
        all_files.into_iter().skip(start).take(limit as usize).collect()
    };

    HttpResponse::Ok().json(FilesResponse {
        files: paginated,
        page,
        limit,
        total,
    })
}

#[derive(serde::Deserialize)]
struct FolderQuery {
    folder_id: Option<i64>,
}

#[get("/api/v1/files/{message_id}")]
async fn api_get_file(
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FolderQuery>,
    tg_state: web::Data<Arc<TelegramState>>,
    api_state: web::Data<ApiState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &api_state) {
        return e;
    }

    let message_id = path.into_inner() as i32;
    let client_opt = { tg_state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &tg_state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(doc) = msg.media() {
                    let (name, size, mime) = match doc {
                        Media::Document(d) => {
                            (d.name().to_string(), d.size(), d.mime_type().map(|s| s.to_string()))
                        }
                        Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".into())),
                        _ => ("Unknown".to_string(), 0, None),
                    };
                    return HttpResponse::Ok().json(ApiFile {
                        id: msg.id() as i64,
                        folder_id: query.folder_id,
                        name,
                        size: size as u64,
                        mime_type: mime,
                        created_at: msg.date().to_string(),
                    });
                }
            }
            json_error("NOT_FOUND", "File not found", 404)
        }
        Err(e) => json_error("FETCH_ERROR", &format!("Failed to fetch file: {}", e), 500),
    }
}

#[get("/api/v1/files/{message_id}/download")]
async fn api_download_file(
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FolderQuery>,
    tg_state: web::Data<Arc<TelegramState>>,
    api_state: web::Data<ApiState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &api_state) {
        return e;
    }

    let message_id = path.into_inner() as i32;
    let client_opt = { tg_state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &tg_state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(media) = msg.media() {
                    let size = match &media {
                        Media::Document(d) => d.size() as u64,
                        _ => 0,
                    };
                    let mime = match &media {
                        Media::Document(d) => d.mime_type().unwrap_or("application/octet-stream").to_string(),
                        _ => "application/octet-stream".to_string(),
                    };
                    let filename = match &media {
                        Media::Document(d) => d.name().to_string(),
                        Media::Photo(_) => "Photo.jpg".to_string(),
                        _ => "download".to_string(),
                    };

                    // Parse Range header
                    let mut start_byte = 0;
                    let mut end_byte = if size > 0 { size - 1 } else { 0 };
                    let mut is_range = false;

                    if size > 0 {
                        if let Some(range_header) = req.headers().get(actix_web::http::header::RANGE) {
                            if let Ok(range_str) = range_header.to_str() {
                                if let Some((start, end)) = crate::server::parse_range_header(range_str, size) {
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

                    let mut download_iter = client.iter_download(&media);
                    let mut bytes_to_skip = 0;

                    if start_byte > 0 {
                        const MIN_CHUNK_SIZE: i32 = 4096;
                        const MAX_CHUNK_SIZE: i32 = 512 * 1024;
                        let chunk_index = (start_byte / MIN_CHUNK_SIZE as u64) as i32;
                        download_iter = download_iter
                            .chunk_size(MIN_CHUNK_SIZE)
                            .skip_chunks(chunk_index)
                            .chunk_size(MAX_CHUNK_SIZE);
                        bytes_to_skip = (start_byte - (chunk_index as u64 * MIN_CHUNK_SIZE as u64)) as usize;
                    }

                    let stream = async_stream::stream! {
                        let mut skipped = 0;
                        let mut total_yielded = 0;

                        while let Some(chunk) = download_iter.next().await.transpose() {
                            match chunk {
                                Ok(data) => {
                                    let mut data_slice = data;
                                    
                                    // Handle skipping of bytes for unaligned start
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

                                    // Handle limit (content_length)
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
                                    log::error!("API download stream error: {}", e);
                                    break;
                                }
                            }
                        }
                        log::debug!("API download request: Stream completed for msg {} (yielded: {})", message_id, total_yielded);
                    };

                    if is_range {
                        return HttpResponse::PartialContent()
                            .insert_header(("Content-Type", mime))
                            .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)))
                            .insert_header(("Content-Length", content_length.to_string()))
                            .insert_header(("Content-Disposition", format!("attachment; filename=\"{}\"", filename)))
                            .insert_header(("Accept-Ranges", "bytes"))
                            .streaming(stream);
                    } else {
                        return HttpResponse::Ok()
                            .insert_header(("Content-Type", mime))
                            .insert_header(("Content-Length", size.to_string()))
                            .insert_header(("Content-Disposition", format!("attachment; filename=\"{}\"", filename)))
                            .insert_header(("Accept-Ranges", "bytes"))
                            .streaming(stream);
                    }
                }
            }
            json_error("NOT_FOUND", "File not found", 404)
        }
        Err(e) => json_error("FETCH_ERROR", &format!("Failed to fetch file: {}", e), 500),
    }
}

/// Register all API routes on the Actix App
pub fn configure_api(cfg: &mut web::ServiceConfig) {
    cfg.service(api_health)
       .service(api_list_files)
       .service(api_get_file)
       .service(api_download_file);
}
