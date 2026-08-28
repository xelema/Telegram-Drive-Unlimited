use crate::commands::utils::{media_size, resolve_peer};
use crate::commands::TelegramState;
use crate::transcode::TranscodeManager;
use actix_cors::Cors;
use actix_web::{get, web, App, HttpResponse, HttpServer, Responder};
use grammers_client::types::Media;

use std::net::TcpListener;
use std::sync::Arc;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_ads {
    use super::*;
    use std::net::{IpAddr, SocketAddr};
    use std::time::{Duration, Instant};

    const AD_SCRIPT_HOST: &str = "www.highperformanceformat.com";
    const AD_SCRIPT_URL: &str =
        "https://www.highperformanceformat.com/9cf449272b7e1c83054b82b7639c6029/invoke.js";
    const AD_SCRIPT_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
    const AD_SCRIPT_MAX_BYTES: usize = 512 * 1024;
    const AD_SCRIPT_FALLBACK_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    const AD_DOH_URL: &str =
        "https://cloudflare-dns.com/dns-query?name=www.highperformanceformat.com&type=A";
    const AD_BANNER_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' http://localhost:14201/ad-script https:; style-src 'unsafe-inline'; img-src data: https:; media-src https:; connect-src https:; frame-src 'self' https: data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

    #[derive(Clone)]
    struct CachedAdScript {
        body: bytes::Bytes,
        fetched_at: Instant,
    }

    #[derive(Default)]
    pub(super) struct AdScriptCache {
        value: tokio::sync::RwLock<Option<CachedAdScript>>,
    }

    #[derive(serde::Deserialize)]
    struct DnsJsonResponse {
        #[serde(rename = "Answer", default)]
        answers: Vec<DnsJsonAnswer>,
    }

    #[derive(serde::Deserialize)]
    struct DnsJsonAnswer {
        #[serde(rename = "type")]
        record_type: u16,
        data: String,
    }

    const AD_BANNER_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ad Banner</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 300px; height: 250px; overflow: hidden; background: transparent; }
    iframe, img { display: block; border: 0; }
  </style>
</head>
<body>
  <script>
    window.atOptions = {
      key: '9cf449272b7e1c83054b82b7639c6029',
      format: 'iframe',
      height: 250,
      width: 300,
      params: {}
    };

    (function () {
      var statusType = 'telegram-drive:ad-banner-status';
      var settled = false;

      function report(status) {
        if (settled && status !== 'loaded') return;
        if (status === 'loaded') settled = true;
        window.parent.postMessage({ type: statusType, status: status }, '*');
      }

      function hasRenderableCreative(frame) {
        var frameDocument;

        try {
          frameDocument = frame.contentDocument;
        } catch (_) {
          return frame.src && frame.src !== 'about:blank';
        }

        if (!frameDocument || !frameDocument.body) return false;

        var media = frameDocument.querySelector(
          'a[href], img[src], video, canvas, svg, object[data], embed[src], iframe[src]:not([src="about:blank"])'
        );
        if (media) return true;

        var elements = frameDocument.body.querySelectorAll('*');
        for (var index = 0; index < elements.length; index += 1) {
          var element = elements[index];
          var bounds = element.getBoundingClientRect();
          if (bounds.width < 10 || bounds.height < 10) continue;
          if (frame.contentWindow.getComputedStyle(element).backgroundImage !== 'none') return true;
        }

        return false;
      }

      function inspectCreative() {
        var attempts = 0;
        var check = window.setInterval(function () {
          attempts += 1;
          var creativeFrame = document.querySelector('iframe');

          if (creativeFrame && hasRenderableCreative(creativeFrame)) {
            window.clearInterval(check);
            report('loaded');
          } else if (attempts >= 40) {
            window.clearInterval(check);
            report('failed');
          }
        }, 250);
      }

      window.telegramDriveAdLoaderReady = inspectCreative;
      window.telegramDriveAdLoaderFailed = function () { report('failed'); };
    })();
  </script>
  <script
    src="/ad-script"
    referrerpolicy="no-referrer"
    onload="window.telegramDriveAdLoaderReady()"
    onerror="window.telegramDriveAdLoaderFailed()">
  </script>
</body>
</html>"#;

    #[get("/ad-banner")]
    async fn ad_banner() -> impl Responder {
        HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .insert_header(("Cache-Control", "no-cache"))
            .insert_header(("X-Content-Type-Options", "nosniff"))
            .insert_header(("Referrer-Policy", "no-referrer"))
            .insert_header(("Content-Security-Policy", AD_BANNER_CSP))
            .body(AD_BANNER_HTML)
    }

    fn is_public_ad_ip(ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(address) => {
                !address.is_private()
                    && !address.is_loopback()
                    && !address.is_link_local()
                    && !address.is_broadcast()
                    && !address.is_unspecified()
                    && !address.is_multicast()
            }
            IpAddr::V6(address) => {
                !address.is_loopback()
                    && !address.is_unspecified()
                    && !address.is_multicast()
                    && !address.is_unique_local()
                    && !address.is_unicast_link_local()
            }
        }
    }

    fn is_valid_ad_script(content_type: &str, body: &[u8]) -> bool {
        let content_type = content_type.to_ascii_lowercase();
        let contains_marker =
            |marker: &[u8]| body.windows(marker.len()).any(|window| window == marker);

        content_type.contains("javascript")
            && (1024..=AD_SCRIPT_MAX_BYTES).contains(&body.len())
            && contains_marker(b"atOptions")
            && contains_marker(b"currentScript")
    }

    async fn request_ad_script(
        client: &reqwest::Client,
        user_agent: &str,
    ) -> Result<bytes::Bytes, String> {
        let response = client
            .get(AD_SCRIPT_URL)
            .header(reqwest::header::ACCEPT, "*/*")
            .header(reqwest::header::USER_AGENT, user_agent)
            .send()
            .await
            .map_err(|error| error.to_string())?;

        if !response.status().is_success() {
            return Err(format!("loader returned HTTP {}", response.status()));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = response.bytes().await.map_err(|error| error.to_string())?;

        if !is_valid_ad_script(&content_type, &body) {
            return Err(format!(
                "loader response failed validation (content-type: {}, bytes: {})",
                content_type,
                body.len()
            ));
        }

        Ok(body)
    }

    async fn resolve_ad_script_addresses() -> Result<Vec<SocketAddr>, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get(AD_DOH_URL)
            .header(reqwest::header::ACCEPT, "application/dns-json")
            .send()
            .await
            .map_err(|error| error.to_string())?;

        if !response.status().is_success() {
            return Err(format!("DNS resolver returned HTTP {}", response.status()));
        }

        let response_body = response.text().await.map_err(|error| error.to_string())?;
        let dns: DnsJsonResponse =
            serde_json::from_str(&response_body).map_err(|error| error.to_string())?;
        let addresses: Vec<SocketAddr> = dns
            .answers
            .into_iter()
            .filter(|answer| answer.record_type == 1)
            .filter_map(|answer| answer.data.parse::<IpAddr>().ok())
            .filter(|address| is_public_ad_ip(*address))
            .map(|address| SocketAddr::new(address, 443))
            .collect();

        if addresses.is_empty() {
            Err("DNS resolver returned no public addresses".to_string())
        } else {
            Ok(addresses)
        }
    }

    async fn fetch_ad_script(user_agent: &str) -> Result<bytes::Bytes, String> {
        let normal_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| error.to_string())?;

        match request_ad_script(&normal_client, user_agent).await {
            Ok(body) => return Ok(body),
            Err(error) => log::warn!(
                "Ad loader request using system DNS failed validation: {}. Retrying with public DNS.",
                error
            ),
        }

        let addresses = resolve_ad_script_addresses().await?;
        let resolved_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(10))
            .resolve_to_addrs(AD_SCRIPT_HOST, &addresses)
            .build()
            .map_err(|error| error.to_string())?;

        request_ad_script(&resolved_client, user_agent).await
    }

    fn ad_script_response(body: bytes::Bytes, cache_state: &'static str) -> HttpResponse {
        HttpResponse::Ok()
            .content_type("application/javascript; charset=utf-8")
            .insert_header(("Cache-Control", "private, max-age=1800"))
            .insert_header(("X-Content-Type-Options", "nosniff"))
            .insert_header(("X-Telegram-Drive-Ad-Cache", cache_state))
            .body(body)
    }

    #[get("/ad-script")]
    async fn ad_script(
        req: actix_web::HttpRequest,
        cache: web::Data<AdScriptCache>,
    ) -> impl Responder {
        {
            let cached = cache.value.read().await;
            if let Some(script) = cached.as_ref() {
                if script.fetched_at.elapsed() < AD_SCRIPT_CACHE_TTL {
                    return ad_script_response(script.body.clone(), "fresh");
                }
            }
        }

        let user_agent = req
            .headers()
            .get("user-agent")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(AD_SCRIPT_FALLBACK_USER_AGENT);

        match fetch_ad_script(user_agent).await {
            Ok(body) => {
                *cache.value.write().await = Some(CachedAdScript {
                    body: body.clone(),
                    fetched_at: Instant::now(),
                });
                ad_script_response(body, "refreshed")
            }
            Err(error) => {
                log::warn!("Ad loader relay unavailable: {}", error);
                let cached = cache.value.read().await;
                if let Some(script) = cached.as_ref() {
                    return ad_script_response(script.body.clone(), "stale");
                }

                HttpResponse::ServiceUnavailable()
                    .content_type("application/javascript; charset=utf-8")
                    .insert_header(("Cache-Control", "no-store"))
                    .body("/* Advertisement loader temporarily unavailable. */")
            }
        }
    }

    pub(super) fn configure(config: &mut web::ServiceConfig) {
        config.service(ad_banner).service(ad_script);
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use actix_web::{http::StatusCode, test as actix_test};
        use std::net::{Ipv4Addr, Ipv6Addr};

        #[actix_web::test]
        async fn banner_route_serves_the_isolated_creative_host() {
            let app = actix_test::init_service(App::new().configure(configure)).await;
            let request = actix_test::TestRequest::get()
                .uri("/ad-banner")
                .to_request();
            let response = actix_test::call_service(&app, request).await;

            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get("x-content-type-options").unwrap(),
                "nosniff"
            );
            assert!(response.headers().contains_key("content-security-policy"));
            let body = actix_test::read_body(response).await;
            assert!(body
                .windows(b"/ad-script".len())
                .any(|part| part == b"/ad-script"));
        }

        #[test]
        fn banner_reports_when_the_provider_inserts_a_creative() {
            assert!(AD_BANNER_HTML.contains("telegram-drive:ad-banner-status"));
            assert!(AD_BANNER_HTML.contains("src=\"/ad-script\""));
            assert!(AD_BANNER_HTML.contains("hasRenderableCreative(creativeFrame)"));
            assert!(AD_BANNER_HTML.contains("iframe[src]:not([src=\"about:blank\"])"));
            assert!(AD_BANNER_HTML.contains("backgroundImage !== 'none'"));
            assert!(AD_BANNER_HTML.contains("report('loaded')"));
            assert!(!AD_BANNER_HTML.contains("replaceChildren"));
            assert!(!AD_BANNER_HTML.contains(AD_SCRIPT_HOST));
        }

        #[test]
        fn provider_loader_is_fixed_and_sandbox_compatible() {
            let parsed = reqwest::Url::parse(AD_SCRIPT_URL).expect("ad loader URL should be valid");
            assert_eq!(parsed.scheme(), "https");
            assert_eq!(parsed.host_str(), Some(AD_SCRIPT_HOST));
            assert_eq!(parsed.path(), "/9cf449272b7e1c83054b82b7639c6029/invoke.js");
            assert!(!AD_BANNER_CSP.contains("'unsafe-eval'"));
            assert!(AD_BANNER_CSP
                .contains("script-src 'unsafe-inline' http://localhost:14201/ad-script https:"));
            assert!(AD_BANNER_CSP.contains("object-src 'none'"));
        }

        #[test]
        fn script_validation_rejects_empty_or_unexpected_responses() {
            let valid = format!("/* atOptions currentScript */{}", "x".repeat(1100));
            assert!(is_valid_ad_script(
                "application/javascript",
                valid.as_bytes()
            ));
            assert!(!is_valid_ad_script("text/html", valid.as_bytes()));
            assert!(!is_valid_ad_script(
                "application/javascript",
                b"atOptions currentScript"
            ));
        }

        #[test]
        fn dns_recovery_accepts_only_public_addresses() {
            assert!(is_public_ad_ip(IpAddr::V4(Ipv4Addr::new(
                172, 240, 108, 76
            ))));
            assert!(!is_public_ad_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 4, 1))));
            assert!(!is_public_ad_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
            assert!(!is_public_ad_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        }
    }
}

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
    db_pool: crate::db::DbConnection,
    folder_key: String,
    message_id: i32,
) -> Result<Option<EncryptedStreamRecord>, String> {
    crate::db::with_connection(db_pool, move |connection| {
        let mut statement = connection
            .prepare(
                "SELECT header_blob, plaintext_size FROM encrypted_files \
                 WHERE folder_key = ? AND message_id = ? AND record_state = 'active'",
            )
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, folder_key.as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, i64::from(message_id)))
            .map_err(|error| error.to_string())?;
        if !matches!(statement.next(), Ok(sqlite::State::Row)) {
            return Ok(None);
        }
        let header = statement
            .read::<Option<Vec<u8>>, _>(0)
            .ok()
            .flatten()
            .ok_or_else(|| "Encrypted media header is not cached locally".to_string())?;
        let plaintext_size = statement
            .read::<Option<i64>, _>(1)
            .ok()
            .flatten()
            .and_then(|value| u64::try_from(value).ok())
            .ok_or_else(|| "Encrypted media plaintext length is unavailable".to_string())?;
        Ok(Some(EncryptedStreamRecord {
            header,
            plaintext_size,
        }))
    })
    .await
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

/// Extra headers to inject into streaming responses (e.g. Cache-Control, Content-Disposition).
pub struct StreamingExtras {
    pub extra_headers: Vec<(&'static str, String)>,
    pub log_label: &'static str,
}

/// Build a streaming HTTP response for a Telegram media file with optional byte-range support.
/// This is the single shared implementation used by the streaming server, REST API, and share routes.
pub fn build_media_response(
    client: &grammers_client::Client,
    media: &Media,
    req: &actix_web::HttpRequest,
    mime: &str,
    filename: Option<&str>,
    extras: StreamingExtras,
) -> HttpResponse {
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
) -> HttpResponse {
    use crate::crypto::envelope::header::EnvelopeHeader;
    use crate::crypto::envelope::range::{
        chunk_ciphertext_offset, plaintext_range_to_ciphertext_records,
    };
    use crate::crypto::policy;

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
            .body("Encrypted media registry length does not match its authenticated header");
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
    db_pool: web::Data<crate::db::DbConnection>,
    crypto_state: web::Data<crate::crypto::state::CryptoState>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    // Validate session token
    match &query.token {
        Some(t) if t == &token_data.token => {
            log::debug!(
                "Stream request: Token validated successfully for msg {}",
                message_id
            );
        }
        _ => {
            log::error!(
                "Stream request failed: Invalid or missing stream token for msg {}",
                message_id
            );
            return HttpResponse::Forbidden().body("Invalid or missing stream token");
        }
    }

    // Parse folder ID
    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        log::debug!("Stream request: Using root folder for msg {}", message_id);
        None
    } else {
        match folder_id_str.parse::<i64>() {
            Ok(id) => {
                log::debug!(
                    "Stream request: Parsed folder ID {} for msg {}",
                    id,
                    message_id
                );
                Some(id)
            }
            Err(_) => {
                log::error!(
                    "Stream request failed: Invalid folder ID format '{}' for msg {}",
                    folder_id_str,
                    message_id
                );
                return HttpResponse::BadRequest().body("Invalid folder ID");
            }
        }
    };

    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());
    let encrypted_record =
        match encrypted_stream_record(db_pool.get_ref().clone(), folder_key, message_id).await {
            Ok(record) => record,
            Err(error) => return HttpResponse::Conflict().body(error),
        };
    let wrapping_key = if encrypted_record.is_some() {
        let Some(credential) = query.credential else {
            return HttpResponse::Locked()
                .body("Unlock the vault before streaming protected media");
        };
        match crypto_state.operation_wrapping_key(
            credential,
            crate::crypto::state::OperationClass::MediaStream,
        ) {
            Ok(key) => Some(key),
            Err(_) => {
                return HttpResponse::Locked()
                    .body("The protected-media credential expired; unlock and retry")
            }
        }
    } else {
        None
    };

    let client_opt = { data.client.lock().await.clone() };

    if let Some(client) = client_opt {
        log::debug!(
            "Stream request: Client acquired, resolving peer for msg {}...",
            message_id
        );
        match resolve_peer(&client, folder_id, &data.peer_cache).await {
            Ok(peer) => {
                log::debug!(
                    "Stream request: Peer resolved, fetching message {}...",
                    message_id
                );
                // Try to fetch message efficiently
                match client.get_messages_by_id(peer, &[message_id]).await {
                    Ok(messages) => {
                        if let Some(Some(msg)) = messages.first() {
                            if encrypted_record.is_none()
                                && (msg.text() == "TDENC2"
                                    || matches!(
                                        msg.media(),
                                        Some(Media::Document(document))
                                            if document.name().to_ascii_lowercase().ends_with(".tdenc")
                                    ))
                            {
                                return HttpResponse::Conflict().body(
                                    "Protected media must be indexed locally before it can be streamed",
                                );
                            }
                            if let Some(media) = msg.media() {
                                log::debug!(
                                    "Stream request: Message and media found for msg {}",
                                    message_id
                                );
                                if let (Some(record), Some(key)) =
                                    (encrypted_record, wrapping_key.as_ref())
                                {
                                    return build_encrypted_media_response(
                                        &client, &media, &req, record, key,
                                    )
                                    .await;
                                }
                                let mime = mime_type_from_media(&media);
                                return build_media_response(
                                    &client,
                                    &media,
                                    &req,
                                    &mime,
                                    None,
                                    StreamingExtras {
                                        extra_headers: vec![(
                                            "Cache-Control",
                                            "private, max-age=120".to_string(),
                                        )],
                                        log_label: "Stream",
                                    },
                                );
                            } else {
                                log::error!(
                                    "Stream request failed: Media not found in message {}",
                                    message_id
                                );
                            }
                        } else {
                            log::error!("Stream request failed: Message {} not found", message_id);
                        }
                        HttpResponse::NotFound().body("Message or media not found")
                    }
                    Err(e) => {
                        log::error!(
                            "Stream request failed: Error fetching message {}: {}",
                            message_id,
                            e
                        );
                        HttpResponse::InternalServerError()
                            .body(format!("Failed to fetch message: {}", e))
                    }
                }
            }
            Err(e) => {
                log::error!(
                    "Stream request failed: Peer resolution error for msg {}: {}",
                    message_id,
                    e
                );
                HttpResponse::BadRequest().body(format!("Peer resolution failed: {}", e))
            }
        }
    } else {
        log::error!(
            "Stream request failed: Telegram client not connected for msg {}",
            message_id
        );
        HttpResponse::ServiceUnavailable().body("Telegram client not connected")
    }
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
) -> std::io::Result<actix_web::dev::Server> {
    let listener = bind_stream_listener(port)?;
    start_server_with_listener(
        state,
        token,
        db_pool,
        transcode_manager,
        crypto_state,
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

fn start_server_with_listener(
    state: Arc<TelegramState>,
    token: String,
    db_pool: crate::db::DbConnection,
    transcode_manager: Arc<TranscodeManager>,
    crypto_state: crate::crypto::state::CryptoState,
    listener: TcpListener,
) -> std::io::Result<actix_web::dev::Server> {
    let state_data = web::Data::new(state);
    let token_data = web::Data::new(StreamTokenData { token });
    let db_data = web::Data::new(db_pool);
    let transcode_data = web::Data::new(transcode_manager);
    let crypto_data = web::Data::new(crypto_state);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let ad_script_cache = web::Data::new(desktop_ads::AdScriptCache::default());

    let local_addr = listener.local_addr()?;
    log::info!("Starting Streaming Server on {}", local_addr);

    let server = HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin_fn(|origin, _req_head| {
                let origin_bytes = origin.as_bytes();
                origin_bytes.starts_with(b"tauri://")
                    || origin_bytes.starts_with(b"http://tauri.localhost")
                    || origin_bytes.starts_with(b"https://tauri.localhost")
                    || origin_bytes.starts_with(b"http://localhost")
                    || origin_bytes.starts_with(b"http://127.0.0.1")
                    || origin_bytes.starts_with(b"https://asset.localhost")
                    || origin_bytes.starts_with(b"http://asset.localhost")
                    || origin_bytes == b"null"
            })
            .allow_any_method()
            .allow_any_header();

        let app = App::new()
            .wrap(cors)
            .app_data(state_data.clone())
            .app_data(token_data.clone())
            .app_data(db_data.clone())
            .app_data(transcode_data.clone())
            .app_data(crypto_data.clone());

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let app = app
            .app_data(ad_script_cache.clone())
            .configure(desktop_ads::configure);

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

#[cfg(test)]
mod streaming_runtime_tests {
    use super::*;
    use crate::commands::TelegramState;
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicU32, AtomicU64};
    use tokio::sync::{Mutex, RwLock};

    fn disconnected_telegram_state() -> Arc<TelegramState> {
        Arc::new(TelegramState {
            client: Arc::new(Mutex::new(None)),
            session: Arc::new(Mutex::new(None)),
            phone_login: Arc::new(Mutex::new(None)),
            password_token: Arc::new(Mutex::new(None)),
            api_id: Arc::new(Mutex::new(None)),
            auth_attempt_counter: Arc::new(AtomicU64::new(0)),
            runner_shutdown: Arc::new(std::sync::Mutex::new(None)),
            runner_count: Arc::new(AtomicU32::new(0)),
            peer_cache: Arc::new(RwLock::new(HashMap::new())),
            active_file_loads: Arc::new(RwLock::new(HashMap::new())),
            cancelled_transfers: Arc::new(RwLock::new(HashSet::new())),
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn streaming_server_runs_on_existing_tokio_runtime_and_stops_gracefully() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let database = Arc::new(std::sync::Mutex::new(sqlite::open(":memory:").unwrap()));
        let cache_root = std::env::temp_dir().join(format!(
            "telegram-drive-stream-runtime-{}-{}",
            std::process::id(),
            address.port()
        ));
        let transcode_manager = Arc::new(TranscodeManager::new(cache_root.clone()));
        let crypto_state = crate::crypto::state::CryptoState::new(Box::new(
            crate::crypto::vault::memory::MemoryVault::new(),
        ));

        // This deliberately uses Tokio directly, without actix_rt::System. It
        // exercises the same runtime arrangement used by Tauri on Android.
        let server = start_server_with_listener(
            disconnected_telegram_state(),
            "runtime-test-token".to_string(),
            database,
            transcode_manager,
            crypto_state,
            listener,
        )
        .unwrap();
        let handle = server.handle();
        let server_task = tokio::spawn(server);

        let client = reqwest::Client::new();
        let endpoint = format!("http://{address}/stream/home/1");
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match client.get(&endpoint).send().await {
                    Ok(response) => break response,
                    Err(_) => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
                }
            }
        })
        .await
        .expect("streaming server did not accept loopback connections");

        assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
        assert_eq!(
            response.text().await.unwrap(),
            "Invalid or missing stream token"
        );

        handle.stop(true).await;
        server_task
            .await
            .expect("streaming server task panicked")
            .expect("streaming server stopped with an error");
        let _ = std::fs::remove_dir_all(cache_root);
    }
}
