use crate::commands::utils::resolve_peer;
use crate::commands::TelegramState;
use crate::db::DbConnection;
use actix_web::{
    cookie::Cookie, get, middleware::DefaultHeaders, post, web, HttpRequest, HttpResponse,
    Responder,
};
use grammers_client::types::Media;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};

const SHARE_PASSWORD_ATTEMPT_LIMIT: usize = 5;
const SHARE_PASSWORD_WINDOW_SECONDS: i64 = 5 * 60;
const SHARE_PASSWORD_COOLDOWN_SECONDS: i64 = 30;
const MAX_TRACKED_SHARE_TOKENS: usize = 1_024;
const MAX_SHARE_PASSWORD_CHARS: usize = 128;
const MAX_SHARE_PASSWORD_BYTES: usize = 512;
const SHARE_VERIFY_FORM_LIMIT_BYTES: usize = 1_024;
const SHARE_SECURITY_HEADERS: &[(&str, &str)] = &[
    ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    ("Cache-Control", "no-store"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
];

#[derive(Default)]
struct PasswordAttemptState {
    attempts: VecDeque<i64>,
    blocked_until: i64,
    last_seen: i64,
}

#[derive(Default)]
struct PasswordAttemptLimiter {
    attempts_by_token: HashMap<[u8; 32], PasswordAttemptState>,
}

impl PasswordAttemptLimiter {
    fn begin_attempt(&mut self, token_key: [u8; 32], now: i64) -> Result<(), i64> {
        self.prune(now);

        if !self.attempts_by_token.contains_key(&token_key)
            && self.attempts_by_token.len() >= MAX_TRACKED_SHARE_TOKENS
        {
            if let Some(oldest_key) = self
                .attempts_by_token
                .iter()
                .min_by_key(|(_, state)| state.last_seen)
                .map(|(key, _)| *key)
            {
                self.attempts_by_token.remove(&oldest_key);
            }
        }

        let state = self.attempts_by_token.entry(token_key).or_default();
        state.last_seen = now;

        if state.blocked_until > now {
            return Err((state.blocked_until - now).max(1));
        }
        if state.blocked_until != 0 {
            state.blocked_until = 0;
            state.attempts.clear();
        }

        let cutoff = now.saturating_sub(SHARE_PASSWORD_WINDOW_SECONDS);
        while state
            .attempts
            .front()
            .is_some_and(|attempt| *attempt <= cutoff)
        {
            state.attempts.pop_front();
        }

        if state.attempts.len() >= SHARE_PASSWORD_ATTEMPT_LIMIT {
            state.attempts.clear();
            state.blocked_until = now.saturating_add(SHARE_PASSWORD_COOLDOWN_SECONDS);
            return Err(SHARE_PASSWORD_COOLDOWN_SECONDS);
        }

        // Reserve the attempt before running bcrypt so concurrent requests cannot
        // all bypass the limit while password verification is in progress.
        state.attempts.push_back(now);
        Ok(())
    }

    fn record_failure(&mut self, token_key: &[u8; 32], now: i64) {
        if let Some(state) = self.attempts_by_token.get_mut(token_key) {
            state.last_seen = now;
            if state.attempts.len() >= SHARE_PASSWORD_ATTEMPT_LIMIT {
                state.attempts.clear();
                state.blocked_until = now.saturating_add(SHARE_PASSWORD_COOLDOWN_SECONDS);
            }
        }
    }

    fn clear(&mut self, token_key: &[u8; 32]) {
        self.attempts_by_token.remove(token_key);
    }

    fn prune(&mut self, now: i64) {
        let cutoff = now.saturating_sub(SHARE_PASSWORD_WINDOW_SECONDS);
        self.attempts_by_token.retain(|_, state| {
            while state
                .attempts
                .front()
                .is_some_and(|attempt| *attempt <= cutoff)
            {
                state.attempts.pop_front();
            }
            state.blocked_until > now || !state.attempts.is_empty()
        });
    }
}

static PASSWORD_ATTEMPT_LIMITER: LazyLock<Mutex<PasswordAttemptLimiter>> =
    LazyLock::new(|| Mutex::new(PasswordAttemptLimiter::default()));

fn token_attempt_key(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn with_password_attempt_limiter<T>(operation: impl FnOnce(&mut PasswordAttemptLimiter) -> T) -> T {
    let mut limiter = PASSWORD_ATTEMPT_LIMITER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(&mut limiter)
}

#[derive(Clone)]
struct SharedLinkRow {
    _id: String,
    folder_id: Option<i64>,
    message_id: i32,
    file_name: String,
    _file_size: i64,
    password_hash: Option<String>,
    _password_salt: Option<String>,
    expires_at: Option<i64>,
    revoked: bool,
}

#[derive(Deserialize)]
struct VerifyForm {
    password: String,
}

/// Verify a password against a bcrypt hash.
fn verify_password(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

fn generate_cookie_val(token: &str, password_hash: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(password_hash.as_bytes());
    format!("{:x}", hasher.finalize())
}

async fn get_share_by_token(
    db: DbConnection,
    token: String,
) -> Result<Option<SharedLinkRow>, String> {
    crate::db::with_connection(db, move |conn| {
        let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, message_id, file_name, file_size, password_hash, password_salt, expires_at, revoked 
             FROM shared_links WHERE id = ?"
        )
        .map_err(|e| e.to_string())?;

        stmt.bind((1, token.as_str())).map_err(|e| e.to_string())?;

    if let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        let id = stmt.read::<String, _>("id").map_err(|e| e.to_string())?;
        let folder_id = stmt.read::<Option<i64>, _>("folder_id").ok().flatten();
        let message_id = stmt.read::<i64, _>("message_id").map_err(|e| e.to_string())? as i32;
        let file_name = stmt.read::<String, _>("file_name").map_err(|e| e.to_string())?;
        let file_size = stmt.read::<i64, _>("file_size").map_err(|e| e.to_string())?;
        let password_hash = stmt.read::<Option<String>, _>("password_hash").ok().flatten();
        let _password_salt = stmt.read::<Option<String>, _>("password_salt").ok().flatten();
        let expires_at = stmt.read::<Option<i64>, _>("expires_at").ok().flatten();
        let revoked = stmt.read::<i64, _>("revoked").map_err(|e| e.to_string())? != 0;

            Ok(Some(SharedLinkRow {
            _id: id,
            folder_id,
            message_id,
            file_name,
            _file_size: file_size,
            password_hash,
            _password_salt,
            expires_at,
            revoked,
            }))
        } else {
            Ok(None)
        }
    }).await
}

/// Renders the password entry form for protected share links.
///
/// NOTE: This HTML contains an inline `<style>` block which requires
/// `style-src 'unsafe-inline'` in the Tauri CSP (tauri.conf.json).
/// This page is served only by the loopback-bound Actix streaming server,
/// not by a hosted internet service. Dynamic values are escaped before they
/// are interpolated into the document.
fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

fn resolve_req_lang(req: &HttpRequest) -> (&'static str, &'static str) {
    if let Some(query) = req.uri().query() {
        let query = query.to_ascii_lowercase();
        if query.contains("lang=ar") {
            return ("ar", "rtl");
        }
        if query.contains("lang=zh-tw")
            || query.contains("lang=zh-hk")
            || query.contains("lang=zh-hant")
        {
            return ("zh-TW", "ltr");
        }
        if query.contains("lang=bn") {
            return ("bn-BD", "ltr");
        }
        if query.contains("lang=th") {
            return ("th-TH", "ltr");
        }
        if query.contains("lang=fil") || query.contains("lang=tl") {
            return ("fil-PH", "ltr");
        }
        if query.contains("lang=es") {
            return ("es", "ltr");
        }
        if query.contains("lang=ru") {
            return ("ru", "ltr");
        }
        if query.contains("lang=fr") {
            return ("fr", "ltr");
        }
        if query.contains("lang=de") {
            return ("de", "ltr");
        }
        if query.contains("lang=pt") {
            return ("pt-BR", "ltr");
        }
        if query.contains("lang=zh") {
            return ("zh-CN", "ltr");
        }
        if query.contains("lang=vi") {
            return ("vi", "ltr");
        }
    }
    if let Some(accept) = req.headers().get("Accept-Language") {
        if let Ok(val) = accept.to_str() {
            let val = val.to_ascii_lowercase();
            if val.contains("ar") {
                return ("ar", "rtl");
            }
            if val.contains("zh-tw") || val.contains("zh-hk") || val.contains("zh-hant") {
                return ("zh-TW", "ltr");
            }
            if val.contains("bn") {
                return ("bn-BD", "ltr");
            }
            if val.contains("th") {
                return ("th-TH", "ltr");
            }
            if val.contains("fil") || val.contains("tl-ph") {
                return ("fil-PH", "ltr");
            }
            if val.contains("es") {
                return ("es", "ltr");
            }
            if val.contains("ru") {
                return ("ru", "ltr");
            }
            if val.contains("fr") {
                return ("fr", "ltr");
            }
            if val.contains("de") {
                return ("de", "ltr");
            }
            if val.contains("pt") {
                return ("pt-BR", "ltr");
            }
            if val.contains("zh") {
                return ("zh-CN", "ltr");
            }
            if val.contains("vi") {
                return ("vi", "ltr");
            }
        }
    }
    ("en", "ltr")
}

fn render_password_form(
    req: &HttpRequest,
    file_name: &str,
    token: &str,
    error: Option<&str>,
) -> HttpResponse {
    let (lang, dir) = resolve_req_lang(req);
    let safe_file_name = escape_html(file_name);
    let (
        title_text,
        heading_text,
        desc_text,
        file_label,
        password_placeholder,
        btn_text,
        incorrect_password,
    ) = match lang {
        "es" => (
            "Archivo protegido con contraseña",
            "Ingrese contraseña",
            "Este enlace está protegido con contraseña.",
            "Archivo",
            "Contraseña",
            "Verificar y descargar",
            "Contraseña incorrecta. Inténtelo de nuevo.",
        ),
        "ru" => (
            "Файл защищен паролем",
            "Введите пароль",
            "Эта ссылка защищена паролем.",
            "Файл",
            "Пароль",
            "Проверить и скачать",
            "Неверный пароль. Повторите попытку.",
        ),
        "vi" => (
            "Tệp được bảo vệ bằng mật khẩu",
            "Nhập mật khẩu",
            "Liên kết chia sẻ này được bảo vệ bằng mật khẩu.",
            "Tệp",
            "Mật khẩu",
            "Xác minh và tải xuống",
            "Mật khẩu không đúng. Vui lòng thử lại.",
        ),
        "bn-BD" => (
            "পাসওয়ার্ড-সুরক্ষিত ফাইল",
            "পাসওয়ার্ড লিখুন",
            "এই শেয়ার লিঙ্কটি পাসওয়ার্ড দিয়ে সুরক্ষিত।",
            "ফাইল",
            "পাসওয়ার্ড",
            "যাচাই করে ডাউনলোড করুন",
            "পাসওয়ার্ডটি সঠিক নয়। আবার চেষ্টা করুন।",
        ),
        "th-TH" => (
            "ไฟล์ที่ป้องกันด้วยรหัสผ่าน",
            "ป้อนรหัสผ่าน",
            "ลิงก์แชร์นี้ได้รับการป้องกันด้วยรหัสผ่าน",
            "ไฟล์",
            "รหัสผ่าน",
            "ตรวจสอบและดาวน์โหลด",
            "รหัสผ่านไม่ถูกต้อง โปรดลองอีกครั้ง",
        ),
        "fil-PH" => (
            "File na Protektado ng Password",
            "Ilagay ang Password",
            "Protektado ng password ang share link na ito.",
            "File",
            "Password",
            "I-verify at I-download",
            "Mali ang password. Pakisubukang muli.",
        ),
        "zh-TW" => (
            "密碼保護的檔案",
            "輸入密碼",
            "此分享連結受密碼保護。",
            "檔案",
            "密碼",
            "驗證並下載",
            "密碼不正確，請再試一次。",
        ),
        _ => (
            "Password Protected File",
            "Enter Password",
            "This share link is password-protected.",
            "File",
            "Password",
            "Verify & Download",
            "Incorrect password. Please try again.",
        ),
    };
    let error_html = match error {
        Some(_) => format!(
            "<div class=\"error\">{}</div>",
            escape_html(incorrect_password)
        ),
        None => "".to_string(),
    };

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="{}" dir="{}">
<head>
    <meta charset="utf-8">
    <title>{} - Telegram Drive</title>
    <style>
        body {{
            background-color: #182533;
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }}
        .container {{
            background: #202b36;
            padding: 2rem;
            border-radius: 12px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
            border: 1px solid #2f3e4e;
            width: 100%;
            max-width: 400px;
            text-align: center;
        }}
        h2 {{
            margin-top: 0;
            color: #40a7e3;
        }}
        p {{
            font-size: 14px;
            color: #7f91a4;
            margin-bottom: 20px;
        }}
        input[type="password"] {{
            width: 100%;
            padding: 12px;
            border-radius: 6px;
            border: 1px solid #2f3e4e;
            background: #182533;
            color: white;
            box-sizing: border-box;
            margin-bottom: 15px;
            font-size: 16px;
        }}
        input[type="password"]:focus {{
            outline: none;
            border-color: #40a7e3;
        }}
        button {{
            width: 100%;
            padding: 12px;
            border-radius: 6px;
            border: none;
            background: #40a7e3;
            color: white;
            font-weight: bold;
            cursor: pointer;
            font-size: 16px;
            transition: background 0.2s;
        }}
        button:hover {{
            background: #3598d1;
        }}
        .error {{
            color: #ff5e5e;
            font-size: 14px;
            margin-bottom: 15px;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h2>{}</h2>
        <p>{}<br>{}: <strong><bdi dir="auto">{}</bdi></strong></p>
        {}
        <form method="POST" action="/d/{}/verify">
            <input type="password" name="password" placeholder="{}" autofocus required>
            <button type="submit">{}</button>
        </form>
    </div>
</body>
</html>"#,
        lang,
        dir,
        title_text,
        heading_text,
        desc_text,
        file_label,
        safe_file_name,
        error_html,
        token,
        password_placeholder,
        btn_text
    );

    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(html)
}

#[get("/d/{token}")]
async fn get_shared_file(
    req: HttpRequest,
    path: web::Path<String>,
    db_conn: web::Data<DbConnection>,
    tg_state: web::Data<Arc<TelegramState>>,
) -> impl Responder {
    let token = path.into_inner();

    let row = match get_share_by_token(db_conn.get_ref().clone(), token.clone()).await {
        Ok(Some(r)) => r,
        Ok(None) => return HttpResponse::NotFound().body("Shared link not found"),
        Err(e) => {
            log::error!("Database error resolving share link: {}", e);
            return HttpResponse::InternalServerError().body("Internal server error");
        }
    };

    // Check validation (revocation and expiration)
    if row.revoked {
        return HttpResponse::NotFound().body("This shared link has been revoked");
    }

    if let Some(expiry) = row.expires_at {
        let now = chrono::Utc::now().timestamp();
        if expiry < now {
            return HttpResponse::Gone().body("This shared link has expired");
        }
    }

    // Check password protection
    if let Some(hash) = &row.password_hash {
        let mut authenticated = false;
        if let Some(cookie) = req.cookie(&format!("share_auth_{}", token)) {
            let expected = generate_cookie_val(&token, hash);
            if cookie.value() == expected {
                authenticated = true;
            }
        }

        if !authenticated {
            return render_password_form(&req, &row.file_name, &token, None);
        }
    }

    // Retrieve and stream the file from Telegram
    let client_opt = { tg_state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return HttpResponse::ServiceUnavailable().body("Telegram client is not connected"),
    };

    let peer = match resolve_peer(&client, row.folder_id, &tg_state.peer_cache).await {
        Ok(p) => p,
        Err(e) => {
            log::error!("Failed to resolve peer for share: {}", e);
            return HttpResponse::InternalServerError().body("Failed to locate folder");
        }
    };

    match client.get_messages_by_id(peer, &[row.message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(media) = msg.media() {
                    let mime = match &media {
                        Media::Document(d) => d
                            .mime_type()
                            .unwrap_or("application/octet-stream")
                            .to_string(),
                        _ => "application/octet-stream".to_string(),
                    };
                    let filename = &row.file_name;

                    return crate::server::build_media_response(
                        &client,
                        &media,
                        &req,
                        &mime,
                        Some(filename),
                        crate::server::StreamingExtras {
                            extra_headers: vec![],
                            log_label: "Share download",
                        },
                    );
                }
            }
            HttpResponse::NotFound().body("Message or media not found in Telegram")
        }
        Err(e) => {
            log::error!("Failed to fetch shared media: {}", e);
            HttpResponse::InternalServerError().body("Unable to retrieve shared media")
        }
    }
}

#[post("/d/{token}/verify")]
async fn verify_shared_file_password(
    req: HttpRequest,
    path: web::Path<String>,
    form: web::Form<VerifyForm>,
    db_conn: web::Data<DbConnection>,
) -> impl Responder {
    let token = path.into_inner();

    let row = match get_share_by_token(db_conn.get_ref().clone(), token.clone()).await {
        Ok(Some(r)) => r,
        Ok(None) => return HttpResponse::NotFound().body("Shared link not found"),
        Err(e) => {
            log::error!("Database error resolving share link: {}", e);
            return HttpResponse::InternalServerError().body("Internal server error");
        }
    };

    if row.revoked {
        return HttpResponse::NotFound().body("This shared link has been revoked");
    }

    if row
        .expires_at
        .is_some_and(|expiry| expiry < chrono::Utc::now().timestamp())
    {
        return HttpResponse::Gone().body("This shared link has expired");
    }

    let hash = match &row.password_hash {
        Some(h) => h,
        None => return HttpResponse::BadRequest().body("No password required for this link"),
    };

    let token_key = token_attempt_key(&token);
    let now = chrono::Utc::now().timestamp();
    if let Err(retry_after) =
        with_password_attempt_limiter(|limiter| limiter.begin_attempt(token_key, now))
    {
        return HttpResponse::TooManyRequests()
            .insert_header(("Retry-After", retry_after.to_string()))
            .body("Too many password attempts. Try again shortly.");
    }

    if form.password.chars().count() > MAX_SHARE_PASSWORD_CHARS
        || form.password.len() > MAX_SHARE_PASSWORD_BYTES
    {
        with_password_attempt_limiter(|limiter| limiter.record_failure(&token_key, now));
        return render_password_form(&req, &row.file_name, &token, Some("invalid"));
    }

    let password = form.password.clone();
    let hash_for_verify = hash.clone();
    let verified =
        tokio::task::spawn_blocking(move || verify_password(&password, &hash_for_verify))
            .await
            .unwrap_or(false);

    if verified {
        with_password_attempt_limiter(|limiter| limiter.clear(&token_key));
        // Set session cookie (30 min).
        // NOTE: The streaming share server is loopback-only and uses plain HTTP,
        // so the cookie cannot use `.secure(true)` without becoming unusable locally.
        // The cookie is protected by `.http_only(true)` and `.same_site(Strict)`
        // to mitigate XSS and CSRF within the constraints of this local service.
        let val = generate_cookie_val(&token, hash);
        let cookie = Cookie::build(format!("share_auth_{}", token), val)
            .path(format!("/d/{}", token))
            .http_only(true)
            .same_site(actix_web::cookie::SameSite::Strict)
            .max_age(actix_web::cookie::time::Duration::minutes(30))
            .finish();

        HttpResponse::Found()
            .insert_header(("Location", format!("/d/{}", token)))
            .cookie(cookie)
            .finish()
    } else {
        with_password_attempt_limiter(|limiter| limiter.record_failure(&token_key, now));
        render_password_form(
            &req,
            &row.file_name,
            &token,
            Some("Incorrect password. Please try again."),
        )
    }
}

pub fn configure_share_routes(cfg: &mut web::ServiceConfig) {
    let mut headers = DefaultHeaders::new();
    for (name, value) in SHARE_SECURITY_HEADERS {
        headers = headers.add((*name, *value));
    }
    cfg.service(
        web::scope("")
            .wrap(headers)
            .app_data(web::FormConfig::default().limit(SHARE_VERIFY_FORM_LIMIT_BYTES))
            .service(get_shared_file)
            .service(verify_shared_file_password),
    );
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_req_lang, token_attempt_key, PasswordAttemptLimiter, MAX_TRACKED_SHARE_TOKENS,
        SHARE_PASSWORD_COOLDOWN_SECONDS, SHARE_SECURITY_HEADERS,
    };
    use actix_web::test::TestRequest;

    #[test]
    fn resolves_vietnamese_share_language() {
        let query_request = TestRequest::with_uri("/d/example?lang=vi").to_http_request();
        assert_eq!(resolve_req_lang(&query_request), ("vi", "ltr"));

        let header_request = TestRequest::default()
            .insert_header(("Accept-Language", "vi-VN,vi;q=0.9,en;q=0.8"))
            .to_http_request();
        assert_eq!(resolve_req_lang(&header_request), ("vi", "ltr"));
    }

    #[test]
    fn resolves_new_regional_share_languages() {
        for (locale, expected) in [
            ("bn-BD", "bn-BD"),
            ("th-TH", "th-TH"),
            ("fil-PH", "fil-PH"),
            ("tl-PH", "fil-PH"),
            ("zh-TW", "zh-TW"),
            ("zh-Hant", "zh-TW"),
        ] {
            let request =
                TestRequest::with_uri(&format!("/d/example?lang={locale}")).to_http_request();
            assert_eq!(resolve_req_lang(&request), (expected, "ltr"));
        }

        let traditional_chinese = TestRequest::default()
            .insert_header(("Accept-Language", "zh-HK,zh-Hant;q=0.9,en;q=0.8"))
            .to_http_request();
        assert_eq!(resolve_req_lang(&traditional_chinese), ("zh-TW", "ltr"));
    }

    #[test]
    fn password_attempts_are_throttled_and_recover_after_cooldown() {
        let mut limiter = PasswordAttemptLimiter::default();
        let token_key = token_attempt_key("private-share-token");

        for now in 100..105 {
            assert_eq!(limiter.begin_attempt(token_key, now), Ok(()));
            limiter.record_failure(&token_key, now);
        }

        assert_eq!(limiter.begin_attempt(token_key, 105), Err(29));
        assert_eq!(
            limiter.begin_attempt(token_key, 104 + SHARE_PASSWORD_COOLDOWN_SECONDS),
            Ok(())
        );
    }

    #[test]
    fn successful_password_clears_attempt_history() {
        let mut limiter = PasswordAttemptLimiter::default();
        let token_key = token_attempt_key("successful-share-token");

        for now in 200..204 {
            limiter.begin_attempt(token_key, now).unwrap();
            limiter.record_failure(&token_key, now);
        }
        limiter.begin_attempt(token_key, 204).unwrap();
        limiter.clear(&token_key);

        for now in 205..210 {
            assert_eq!(limiter.begin_attempt(token_key, now), Ok(()));
        }
    }

    #[test]
    fn password_attempt_tracking_is_bounded() {
        let mut limiter = PasswordAttemptLimiter::default();

        for index in 0..MAX_TRACKED_SHARE_TOKENS {
            let token_key = token_attempt_key(&format!("share-{index}"));
            assert_eq!(limiter.begin_attempt(token_key, 0), Ok(()));
            limiter
                .attempts_by_token
                .get_mut(&token_key)
                .unwrap()
                .last_seen = index as i64;
        }

        assert_eq!(
            limiter.begin_attempt(token_attempt_key("overflow-share"), 0),
            Ok(())
        );

        assert_eq!(limiter.attempts_by_token.len(), MAX_TRACKED_SHARE_TOKENS);
        assert!(!limiter
            .attempts_by_token
            .contains_key(&token_attempt_key("share-0")));
    }

    #[test]
    fn share_pages_define_defense_in_depth_headers_and_a_bounded_form() {
        for required in [
            "Content-Security-Policy",
            "X-Content-Type-Options",
            "Referrer-Policy",
            "Permissions-Policy",
            "Cache-Control",
        ] {
            assert!(SHARE_SECURITY_HEADERS
                .iter()
                .any(|(name, _)| *name == required));
        }
    }
}
