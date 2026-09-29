use actix_web::http::{header::HeaderValue, Uri};

const DEVELOPMENT_FRONTEND_PORT: u16 = 1420;

pub(crate) fn is_allowed_origin_header(origin: &HeaderValue) -> bool {
    origin.to_str().is_ok_and(is_allowed_origin)
}

fn is_allowed_origin(origin: &str) -> bool {
    if matches!(origin, "null" | "tauri://localhost") {
        return true;
    }

    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    if authority.as_str().contains('@') || format!("{scheme}://{authority}") != origin {
        return false;
    }
    let host = authority.host();
    let port = authority.port_u16();

    matches!(
        (scheme, host, port),
        ("http", "tauri.localhost", None)
            | ("https", "tauri.localhost", None)
            | ("http", "asset.localhost", None)
            | ("https", "asset.localhost", None)
            | ("http", "localhost", Some(DEVELOPMENT_FRONTEND_PORT))
            | ("http", "127.0.0.1", Some(DEVELOPMENT_FRONTEND_PORT))
    )
}
