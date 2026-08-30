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

#[cfg(test)]
mod tests {
    use super::is_allowed_origin;

    #[test]
    fn accepts_only_the_application_and_fixed_development_origins() {
        for origin in [
            "null",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://asset.localhost",
            "https://asset.localhost",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
        ] {
            assert!(is_allowed_origin(origin), "expected {origin} to be allowed");
        }
    }

    #[test]
    fn rejects_lookalike_hosts_paths_and_unapproved_ports() {
        for origin in [
            "http://localhost.attacker.example",
            "http://localhost.attacker.example:1420",
            "http://127.0.0.1.attacker.example:1420",
            "http://tauri.localhost.attacker.example",
            "tauri://attacker.example",
            "http://localhost",
            "https://localhost:1420",
            "http://localhost:1421",
            "http://localhost:1420/path",
            "http://localhost:1420?query=1",
            "not an origin",
        ] {
            assert!(
                !is_allowed_origin(origin),
                "expected {origin} to be rejected"
            );
        }
    }
}
