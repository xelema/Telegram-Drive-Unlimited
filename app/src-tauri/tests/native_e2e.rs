//! Native backend journeys through a separate process, persistent files and real HTTP.
//! This intentionally does not stand in for full Tauri-window or live Telegram E2E.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "telegram-drive-native-e2e-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(
            path.join(".native-e2e-fixture"),
            "telegram-drive-synthetic-e2e\n",
        )
        .unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn write(&self, name: &str, bytes: impl AsRef<[u8]>) {
        std::fs::write(self.path(name), bytes).unwrap();
    }
    fn read(&self, name: &str) -> Vec<u8> {
        std::fs::read(self.path(name)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Backend {
    child: Child,
    input: ChildStdin,
    replies: Receiver<Value>,
}
impl Backend {
    fn start(root: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_native-e2e-driver"))
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (send, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let value = serde_json::from_str(&line)
                    .unwrap_or_else(|_| json!({"unexpectedOutput":line}));
                if send.send(value).is_err() {
                    break;
                }
            }
        });
        let instance = Self {
            child,
            input,
            replies,
        };
        assert_eq!(
            instance
                .replies
                .recv_timeout(Duration::from_secs(30))
                .expect("native process did not start"),
            json!({"ready":true})
        );
        instance
    }
    fn request(&mut self, request: Value) -> Value {
        writeln!(self.input, "{request}").unwrap();
        self.input.flush().unwrap();
        self.replies
            .recv_timeout(Duration::from_secs(60))
            .expect("native process did not answer within 60s")
    }
    fn ok(&mut self, request: Value) -> Value {
        let reply = self.request(request);
        assert_eq!(reply["ok"], true, "{reply}");
        reply["value"].clone()
    }
    fn failure(&mut self, request: Value) -> String {
        let reply = self.request(request);
        assert_eq!(reply["ok"], false, "{reply}");
        reply["error"].as_str().unwrap().to_string()
    }
    fn stop(mut self) {
        writeln!(self.input, "{}", json!({"command":"shutdown"})).unwrap();
        self.input.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "backend shutdown failed: {status}");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "backend did not shut down gracefully"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn database_upgrade_preserves_legacy_rows_and_backup_across_process_restarts() {
    let fixture = Fixture::new();
    let database = sqlite::open(fixture.path("shares.db")).unwrap();
    database.execute("CREATE TABLE shared_links(id TEXT PRIMARY KEY,folder_id INTEGER,message_id INTEGER NOT NULL,file_name TEXT NOT NULL,file_size INTEGER NOT NULL DEFAULT 0,password_hash TEXT,password_salt TEXT,expires_at INTEGER,revoked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL); INSERT INTO shared_links VALUES('legacy',NULL,42,'keep-me.pdf',123,NULL,NULL,NULL,0,1)").unwrap();
    drop(database);
    let mut app = Backend::start(&fixture.0);
    assert_eq!(app.ok(json!({"command":"database"}))["version"], 4);
    app.stop();
    let backup = fixture.path("shares.db.pre-migration-v4");
    assert!(backup.is_file());
    let backup_database = sqlite::open(backup).unwrap();
    let mut query = backup_database
        .prepare("SELECT file_name,file_size FROM shared_links WHERE id='legacy'")
        .unwrap();
    assert_eq!(query.next().unwrap(), sqlite::State::Row);
    assert_eq!(query.read::<String, _>(0).unwrap(), "keep-me.pdf");
    assert_eq!(query.read::<i64, _>(1).unwrap(), 123);
    drop(query);
    let mut integrity = backup_database.prepare("PRAGMA integrity_check").unwrap();
    assert_eq!(integrity.next().unwrap(), sqlite::State::Row);
    assert_eq!(integrity.read::<String, _>(0).unwrap(), "ok");
    drop(integrity);
    drop(backup_database);
    let mut app = Backend::start(&fixture.0);
    assert_eq!(app.ok(json!({"command":"database"}))["version"], 4);
    app.stop();
    let database = sqlite::open(fixture.path("shares.db")).unwrap();
    let mut query = database
        .prepare("SELECT file_name,file_size,owner_id FROM shared_links WHERE id='legacy'")
        .unwrap();
    assert_eq!(query.next().unwrap(), sqlite::State::Row);
    assert_eq!(query.read::<String, _>(0).unwrap(), "keep-me.pdf");
    assert_eq!(query.read::<i64, _>(1).unwrap(), 123);
    assert_eq!(query.read::<Option<i64>, _>(2).unwrap(), None);
    drop(query);
    database
        .execute("INSERT INTO app_schema_migrations VALUES(999,'future','future',1,'future')")
        .unwrap();
    drop(database);
    let before = fixture.read("shares.db");
    let mut app = Backend::start(&fixture.0);
    assert!(app
        .failure(json!({"command":"database"}))
        .contains("supports up to"));
    app.stop();
    assert_eq!(fixture.read("shares.db"), before);
}

#[test]
fn account_isolation_survives_restart_contention_and_account_switch() {
    let fixture = Fixture::new();
    let mut app = Backend::start(&fixture.0);
    app.ok(json!({"command":"seed_account","owner":101}));
    app.ok(json!({"command":"capture_account","owner":"101"}));
    app.ok(json!({"command":"save_collection","owner":"101","collection":{"id":"private","name":"Account A private collection","color":"blue","icon":"folder"}}));
    app.stop();
    let mut app = Backend::start(&fixture.0);
    assert_eq!(
        app.ok(json!({"command":"workspace","owner":"101"}))["collections"][0]["name"],
        "Account A private collection"
    );
    app.ok(json!({"command":"capture_account","owner":"101"}));
    // Hold the writer until the reader reports its bounded failure; no sleeps decide ordering.
    let writer = sqlite::open(fixture.path("telegram.session")).unwrap();
    writer
        .execute("BEGIN EXCLUSIVE; UPDATE peer_info SET peer_id=202 WHERE subtype=1")
        .unwrap();
    assert!(app
        .failure(json!({"command":"validate_account"}))
        .starts_with("ACCOUNT_UNAVAILABLE:"));
    writer.execute("COMMIT").unwrap();
    drop(writer);
    assert!(app
        .failure(json!({"command":"validate_account"}))
        .starts_with("ACCOUNT_CHANGED:"));
    assert!(app
        .failure(json!({"command":"workspace","owner":"101"}))
        .starts_with("ACCOUNT_CHANGED:"));
    assert!(
        app.ok(json!({"command":"workspace","owner":"202"}))["collections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    app.stop();
}

#[test]
fn vault_and_envelope_survive_restart_corruption_recovery_and_passphrase_change() {
    let fixture = Fixture::new();
    let plaintext: Vec<u8> = (0..2_100_019).map(|index| (index % 251) as u8).collect();
    fixture.write("original.bin", &plaintext);
    let mut app = Backend::start(&fixture.0);
    app.ok(json!({"command":"vault_create","passphrase":"synthetic initial vault passphrase"}));
    app.ok(json!({"command":"fixture_encrypt","source":"original.bin","destination":"protected.tdenc"}));
    app.ok(json!({"command":"vault_export","passphrase":"synthetic recovery passphrase"}));
    app.stop();
    let ciphertext = fixture.read("protected.tdenc");
    assert!(!ciphertext
        .windows(23)
        .any(|window| window == b"private-e2e-document.bin"));
    let mut app = Backend::start(&fixture.0);
    app.failure(json!({"command":"vault_unlock","passphrase":"incorrect passphrase"}));
    app.ok(json!({"command":"vault_unlock","passphrase":"synthetic initial vault passphrase"}));
    app.ok(
        json!({"command":"read_envelope","source":"protected.tdenc","destination":"restored.bin"}),
    );
    assert_eq!(fixture.read("restored.bin"), plaintext);
    let mut damaged = ciphertext.clone();
    let index = damaged.len() / 2;
    damaged[index] ^= 1;
    fixture.write("damaged.tdenc", damaged);
    app.failure(
        json!({"command":"read_envelope","source":"damaged.tdenc","destination":"unverified-envelope.bin"}),
    );
    fixture.write("truncated.tdenc", &ciphertext[..ciphertext.len() - 1]);
    app.failure(
        json!({"command":"read_envelope","source":"truncated.tdenc","destination":"unverified-envelope.bin"}),
    );
    app.stop();
    let mut vault = fixture.read("crypto.vault");
    let last = vault.len() - 1;
    vault[last] ^= 1;
    fixture.write("crypto.vault", &vault);
    let mut app = Backend::start(&fixture.0);
    app.failure(
        json!({"command":"vault_unlock","passphrase":"synthetic initial vault passphrase"}),
    );
    assert_eq!(fixture.read("crypto.vault"), vault);
    app.failure(json!({"command":"vault_recover","passphrase":"wrong recovery passphrase"}));
    assert_eq!(fixture.read("crypto.vault"), vault);
    app.ok(json!({"command":"vault_recover","passphrase":"synthetic recovery passphrase"}));
    app.ok(
        json!({"command":"read_envelope","source":"protected.tdenc","destination":"recovered.bin"}),
    );
    assert_eq!(fixture.read("recovered.bin"), plaintext);
    app.ok(json!({"command":"vault_change_passphrase","passphrase":"synthetic replacement passphrase"}));
    app.stop();
    let mut app = Backend::start(&fixture.0);
    app.failure(
        json!({"command":"vault_unlock","passphrase":"synthetic initial vault passphrase"}),
    );
    app.ok(json!({"command":"vault_unlock","passphrase":"synthetic replacement passphrase"}));
    app.ok(
        json!({"command":"read_envelope","source":"protected.tdenc","destination":"updated.bin"}),
    );
    assert_eq!(fixture.read("updated.bin"), plaintext);
    app.stop();
}

#[test]
fn download_publication_preserves_collisions_and_rejects_a_stale_account() {
    let fixture = Fixture::new();
    fixture.write("download.txt", b"existing bytes");
    fixture.write("verified.part", b"downloaded bytes");
    let mut app = Backend::start(&fixture.0);
    app.ok(json!({"command":"seed_account","owner":101}));
    app.ok(json!({"command":"capture_account","owner":"101"}));
    let saved=app.ok(json!({"command":"publish_download","source":"verified.part","destination":"download.txt","policy":"keep_both"}));
    assert_eq!(saved["outcome"], "saved");
    assert_eq!(fixture.read("download.txt"), b"existing bytes");
    assert_eq!(fixture.read("download (1).txt"), b"downloaded bytes");
    fixture.write("skipped.part", b"skip these");
    assert_eq!(app.ok(json!({"command":"publish_download","source":"skipped.part","destination":"download.txt","policy":"skip"}))["outcome"],"skipped");
    assert_eq!(fixture.read("download.txt"), b"existing bytes");
    fixture.write("replacement.part", b"replacement");
    app.ok(json!({"command":"publish_download","source":"replacement.part","destination":"download.txt","policy":"replace"}));
    assert_eq!(fixture.read("download.txt"), b"replacement");
    fixture.write("private.part", b"account A private bytes");
    app.ok(json!({"command":"seed_account","owner":202}));
    assert!(app.failure(json!({"command":"publish_download","source":"private.part","destination":"private.txt","policy":"keep_both"})).starts_with("ACCOUNT_CHANGED:"));
    assert!(!fixture.path("private.txt").exists());
    assert_eq!(fixture.read("private.part"), b"account A private bytes");
    app.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_http_server_streams_owned_cache_and_revokes_it_after_account_switch() {
    let fixture = Fixture::new();
    let mut app = Backend::start(&fixture.0);
    app.ok(json!({"command":"seed_account","owner":101}));
    app.ok(json!({"command":"database"}));
    let db = sqlite::open(fixture.path("shares.db")).unwrap();
    db.execute("INSERT INTO shared_links(id,owner_id,message_id,file_name,password_hash,created_at) VALUES('private',101,42,'A-private.pdf','synthetic-hash',1),('legacy',NULL,42,'legacy-private.pdf','synthetic-hash',1)").unwrap();
    let password_hash = bcrypt::hash("synthetic share password", 4).unwrap();
    let mut password = db
        .prepare("UPDATE shared_links SET password_hash=? WHERE id='private'")
        .unwrap();
    password.bind((1, password_hash.as_str())).unwrap();
    password.next().unwrap();
    drop(password);
    drop(db);
    let fmp4_root = fixture.path("transcode/fmp4/101_0_42");
    std::fs::create_dir_all(&fmp4_root).unwrap();
    let fmp4_bytes: Vec<u8> = (0..64).collect();
    std::fs::write(fmp4_root.join("output.mp4"), &fmp4_bytes).unwrap();
    let hls = fixture.path("transcode/hls/101_0_42/480p");
    std::fs::create_dir_all(&hls).unwrap();
    std::fs::write(
        hls.join("index.m3u8"),
        b"#EXTM3U\n#EXTINF:1,\nsegment000.ts\n#EXT-X-ENDLIST\n",
    )
    .unwrap();
    std::fs::write(hls.join("segment000.ts"), b"synthetic owned media bytes").unwrap();
    let url = app.ok(json!({"command":"start_http"}))["url"]
        .as_str()
        .unwrap()
        .to_string();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    assert_eq!(
        client
            .get(format!("{url}/stream/home/1"))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{url}/stream/home/1?token=wrong"))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let denied = client
        .get(format!("{url}/stream/home/1"))
        .header("Origin", "https://untrusted.invalid")
        .send()
        .await
        .unwrap();
    assert!(!denied.headers().contains_key("access-control-allow-origin"));
    let owned = client.get(format!("{url}/d/private")).send().await.unwrap();
    assert_eq!(owned.status(), 200);
    assert_eq!(owned.headers()["x-content-type-options"], "nosniff");
    assert!(owned.headers().contains_key("content-security-policy"));
    assert!(owned.text().await.unwrap().contains("A-private.pdf"));
    let wrong = client
        .post(format!("{url}/d/private/verify"))
        .form(&[("password", "wrong password")])
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 200);
    assert!(!wrong.headers().contains_key("set-cookie"));
    let verified = client
        .post(format!("{url}/d/private/verify"))
        .form(&[("password", "synthetic share password")])
        .send()
        .await
        .unwrap();
    assert_eq!(verified.status(), 302);
    assert_eq!(verified.headers()["location"], "/d/private");
    let cookie = verified.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    assert!(cookie.contains("Path=/d/private"));
    let missing = client.get(format!("{url}/d/missing")).send().await.unwrap();
    assert_eq!(missing.status(), 404);
    let token = "synthetic-e2e-stream-token";
    let playlist = format!("{url}/hls/101_0_42/480p/index.m3u8?token={token}");
    let segment = format!("{url}/hls/101_0_42/480p/segment000.ts?token={token}");
    let response = client.get(&playlist).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert!(response
        .text()
        .await
        .unwrap()
        .contains(&format!("segment000.ts?token={token}")));
    let response = client.get(&segment).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    assert_eq!(
        response.bytes().await.unwrap().as_ref(),
        b"synthetic owned media bytes"
    );
    let fmp4 = format!("{url}/fmp4/101_0_42/output.mp4?token={token}");
    assert_eq!(
        client
            .get(format!("{url}/fmp4/101_0_42/output.mp4"))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let response = client
        .get(&fmp4)
        .header("Range", "bytes=4-12")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()["content-range"], "bytes 4-12/64");
    assert_eq!(response.bytes().await.unwrap().as_ref(), &fmp4_bytes[4..13]);
    app.ok(json!({"command":"seed_account","owner":202}));
    assert_eq!(client.get(&fmp4).send().await.unwrap().status(), 403);
    for token in ["private", "legacy"] {
        let response = client.get(format!("{url}/d/{token}")).send().await.unwrap();
        assert_eq!(response.status(), 404);
        assert!(!response.text().await.unwrap().contains("private.pdf"));
        let response = client
            .post(format!("{url}/d/{token}/verify"))
            .form(&[("password", "anything")])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404);
        assert!(!response.headers().contains_key("set-cookie"));
    }
    assert_eq!(client.get(&playlist).send().await.unwrap().status(), 403);
    assert_eq!(client.get(&segment).send().await.unwrap().status(), 403);
    app.stop();
    assert!(
        client
            .get(format!("{url}/stream/home/1"))
            .send()
            .await
            .is_err(),
        "stopped native server still accepts connections"
    );
}

#[test]
fn interrupted_download_persists_progress_and_requires_review_before_resume() {
    let fixture = Fixture::new();
    fixture.write("partial-download.part", b"already fetched bytes");
    let job = json!({"id":"download-42","ownerId":"101","direction":"download","kind":"download","status":"downloading","messageId":42,"filename":"download.txt","savePath":fixture.path("download.txt"),"progress":40,"transferredBytes":21,"totalBytes":50,"speedBytesPerSec":1000,"queuePosition":0,"revision":7,"createdAt":1,"updatedAt":2});
    let mut app = Backend::start(&fixture.0);
    app.ok(json!({"command":"save_transfer","job":job}));
    app.stop();
    let mut app = Backend::start(&fixture.0);
    let recovered = app.ok(json!({"command":"transfers"}));
    assert_eq!(recovered[0]["status"], "paused");
    assert_eq!(recovered[0]["errorCategory"], "interrupted");
    assert_eq!(recovered[0]["transferredBytes"], 21);
    assert_eq!(recovered[0]["speedBytesPerSec"], 0);
    assert_eq!(recovered[0]["revision"], 8);
    assert_eq!(
        fixture.read("partial-download.part"),
        b"already fetched bytes"
    );
    assert!(!fixture.path("download.txt").exists());
    app.stop();
    let mut app = Backend::start(&fixture.0);
    assert_eq!(app.ok(json!({"command":"transfers"}))[0]["revision"], 8);
    app.ok(json!({"command":"remove_transfer","id":"download-42"}));
    assert!(app
        .failure(json!({"command":"save_transfer","job":job}))
        .contains("stale updates are rejected"));
    assert_eq!(app.ok(json!({"command":"transfers"})), json!([]));
    app.stop();
}
