use super::*;
use actix_web::{test, App};
use grammers_session::{storages::SqliteSession, types::PeerInfo, Session};

struct Fixture {
    root: ShareAccountRoot,
    database: DbConnection,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("share-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let connection = sqlite::open(":memory:").unwrap();
        connection.execute("CREATE TABLE shared_links(id TEXT PRIMARY KEY,owner_id INTEGER,folder_id INTEGER,message_id INTEGER,file_name TEXT,file_size INTEGER,password_hash TEXT,password_salt TEXT,expires_at INTEGER,revoked INTEGER,created_at INTEGER); INSERT INTO shared_links VALUES('a',101,NULL,42,'A-private.pdf',10,'test-hash',NULL,NULL,0,1),('b',202,NULL,42,'B-private.pdf',10,NULL,NULL,NULL,0,1),('legacy',NULL,NULL,42,'legacy-private.pdf',10,'test-hash',NULL,NULL,0,1)").unwrap();
        let fixture = Self {
            root: ShareAccountRoot(root),
            database: Arc::new(Mutex::new(connection)),
        };
        fixture.sign_in(101);
        fixture
    }
    fn sign_in(&self, owner: i64) {
        for name in [
            "telegram.session",
            "telegram.session-wal",
            "telegram.session-shm",
        ] {
            let _ = std::fs::remove_file(self.root.0.join(name));
        }
        let session = SqliteSession::open(self.root.0.join("telegram.session")).unwrap();
        session.cache_peer(&PeerInfo::User {
            id: owner,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root.0);
    }
}

fn disconnected() -> Arc<TelegramState> {
    Arc::new(TelegramState {
        client: Arc::new(tokio::sync::Mutex::new(None)),
        session: Arc::new(tokio::sync::Mutex::new(None)),
        phone_login: Arc::new(tokio::sync::Mutex::new(None)),
        password_token: Arc::new(tokio::sync::Mutex::new(None)),
        api_id: Arc::new(tokio::sync::Mutex::new(None)),
        auth_attempt_counter: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        runner_shutdown: Arc::new(Mutex::new(None)),
        runner_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        peer_cache: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
        active_file_loads: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
        cancelled_transfers: Arc::new(tokio::sync::RwLock::new(std::collections::HashSet::new())),
    })
}

#[actix_web::test]
async fn share_rows_require_the_original_account_and_never_adopt_legacy_links() {
    let fixture = Fixture::new();
    let row = get_share_by_token(fixture.database.clone(), "a".into())
        .await
        .unwrap()
        .unwrap();
    let original = share_account(&fixture.root, &row).unwrap();
    let legacy = get_share_by_token(fixture.database.clone(), "legacy".into())
        .await
        .unwrap()
        .unwrap();
    assert!(share_account(&fixture.root, &legacy).is_err());
    fixture.sign_in(202);
    assert!(share_account(&fixture.root, &row).is_err());
    assert!(original.validate().is_err());
    fixture.sign_in(101);
    assert_eq!(share_account(&fixture.root, &row).unwrap().owner, 101);
    assert!(share_account(&fixture.root, &legacy).is_err());
}

#[actix_web::test]
async fn share_http_routes_hide_other_account_and_legacy_metadata_before_password_or_telegram_access(
) {
    let fixture = Fixture::new();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(fixture.database.clone()))
            .app_data(web::Data::new(fixture.root.clone()))
            .app_data(web::Data::new(disconnected()))
            .configure(configure_share_routes),
    )
    .await;
    let response =
        test::call_service(&app, test::TestRequest::get().uri("/d/a").to_request()).await;
    assert_eq!(response.status(), actix_web::http::StatusCode::OK);
    assert!(String::from_utf8(test::read_body(response).await.to_vec())
        .unwrap()
        .contains("A-private.pdf"));
    fixture.sign_in(202);
    for token in ["a", "legacy"] {
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/d/{token}"))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), actix_web::http::StatusCode::NOT_FOUND);
        assert!(!String::from_utf8(test::read_body(response).await.to_vec())
            .unwrap()
            .contains("private.pdf"));
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/d/{token}/verify"))
                .set_form([("password", "test")])
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), actix_web::http::StatusCode::NOT_FOUND);
        assert!(!response
            .headers()
            .contains_key(actix_web::http::header::SET_COOKIE));
    }
    let response =
        test::call_service(&app, test::TestRequest::get().uri("/d/b").to_request()).await;
    assert_eq!(
        response.status(),
        actix_web::http::StatusCode::SERVICE_UNAVAILABLE
    );
}
