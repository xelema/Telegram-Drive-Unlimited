//! Isolated backend process for native E2E journeys, excluded from normal builds.
//!
//! The protocol drives production storage, crypto and loopback HTTP services.
//! It does not simulate a Tauri window or claim authenticated Telegram coverage.
use crate::commands::{download_destination, TelegramState};
use crate::crypto::{
    self,
    envelope::encrypt_reader::{EncryptingReader, EncryptionSession},
    envelope::EnvelopeHeader,
    secret::SecretKey,
    state::CryptoState,
    vault::FileVault,
};
use crate::workspace::{store::Store, AccountGuard};
use grammers_session::{storages::SqliteSession, types::PeerInfo, Session};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, AtomicU64},
        Arc,
    },
};
use tokio::sync::{Mutex, RwLock};

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn text<'a>(request: &'a Value, key: &str) -> Result<&'a str, String> {
    request[key]
        .as_str()
        .ok_or_else(|| format!("Missing {key}"))
}
fn child(root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || Path::new(name).components().count() != 1 || name == "." || name == ".." {
        return Err("Expected a fixture filename".into());
    }
    Ok(root.join(name))
}
fn disconnected() -> Arc<TelegramState> {
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

struct Driver {
    root: PathBuf,
    crypto: CryptoState,
    guard: Option<AccountGuard>,
    servers: Vec<(
        actix_web::dev::ServerHandle,
        tokio::task::JoinHandle<std::io::Result<()>>,
    )>,
}
impl Driver {
    async fn dispatch(&mut self, request: Value) -> Result<Value, String> {
        match text(&request, "command")? {
            "database" => {
                let db = crate::db::init_db_at(&self.root)?;
                crate::db::with_connection(db, |connection| {
                    let mut query = connection
                        .prepare("SELECT MAX(version) FROM app_schema_migrations")
                        .map_err(error)?;
                    query.next().map_err(error)?;
                    Ok(json!({"version": query.read::<i64,_>(0).map_err(error)?}))
                })
                .await
            }
            "seed_account" => {
                let owner = request["owner"]
                    .as_i64()
                    .filter(|value| *value > 0)
                    .ok_or("Invalid fixture owner")?;
                let path = self.root.join("telegram.session");
                let session = SqliteSession::open(&path).map_err(error)?;
                sqlite::open(&path)
                    .map_err(error)?
                    .execute("DELETE FROM peer_info")
                    .map_err(error)?;
                session.cache_peer(&PeerInfo::User {
                    id: owner,
                    auth: None,
                    bot: Some(false),
                    is_self: Some(true),
                });
                drop(session);
                Ok(json!({"owner": crate::workspace::current_owner(&self.root)?}))
            }
            "capture_account" => {
                self.guard = Some(AccountGuard::open(&self.root, request["owner"].as_str())?);
                Ok(json!({"owner": self.guard.as_ref().unwrap().owner}))
            }
            "validate_account" => {
                self.guard
                    .as_ref()
                    .ok_or("No captured account")?
                    .validate()?;
                Ok(json!(true))
            }
            "save_collection" => {
                let account = AccountGuard::open(&self.root, Some(text(&request, "owner")?))?;
                let store = Store::open(&self.root, account.owner)?;
                store.save_collection(
                    &serde_json::from_value(request["collection"].clone()).map_err(error)?,
                )?;
                account.validate()?;
                serde_json::to_value(store.snapshot()?).map_err(error)
            }
            "workspace" => {
                let account = AccountGuard::open(&self.root, Some(text(&request, "owner")?))?;
                let snapshot = Store::open(&self.root, account.owner)?.snapshot()?;
                account.validate()?;
                serde_json::to_value(snapshot).map_err(error)
            }
            "vault_create" => {
                self.crypto
                    .create_vault(text(&request, "passphrase")?.as_bytes())
                    .map_err(error)?;
                Ok(json!(true))
            }
            "vault_unlock" => {
                self.crypto
                    .unlock(text(&request, "passphrase")?.as_bytes())
                    .map_err(error)?;
                Ok(json!(true))
            }
            "vault_lock" => {
                self.crypto.lock();
                Ok(json!(true))
            }
            "vault_change_passphrase" => {
                self.crypto
                    .change_vault_passphrase(text(&request, "passphrase")?.as_bytes())
                    .map_err(error)?;
                Ok(json!(true))
            }
            "vault_export" => {
                let bundle = self
                    .crypto
                    .export_recovery(text(&request, "passphrase")?.as_bytes())
                    .map_err(error)?;
                std::fs::write(self.root.join("recovery.bundle"), bundle).map_err(error)?;
                Ok(json!(true))
            }
            "vault_recover" => {
                let bundle = std::fs::read(self.root.join("recovery.bundle")).map_err(error)?;
                self.crypto
                    .import_recovery(&bundle, text(&request, "passphrase")?.as_bytes())
                    .map_err(error)?;
                Ok(json!(true))
            }
            "fixture_encrypt" => self.create_encrypted_fixture(&request).await,
            "read_envelope" => self.read_envelope(&request).await,
            "publish_download" => {
                let source = child(&self.root, text(&request, "source")?)?;
                let destination = child(&self.root, text(&request, "destination")?)?;
                let policy = serde_json::from_value(request["policy"].clone()).map_err(error)?;
                let result = download_destination::publish(
                    &source,
                    &destination,
                    policy,
                    self.guard.as_ref(),
                )?;
                serde_json::to_value(result).map_err(error)
            }
            "save_transfer" => {
                let (store, _) =
                    crate::transfer_engine::TransferStore::open(&self.root.join("transfers.db"))?;
                let job = serde_json::from_value(request["job"].clone()).map_err(error)?;
                store.upsert(&job).await?;
                Ok(json!(true))
            }
            "transfers" => {
                let (_, jobs) =
                    crate::transfer_engine::TransferStore::open(&self.root.join("transfers.db"))?;
                serde_json::to_value(jobs).map_err(error)
            }
            "remove_transfer" => {
                let (store, _) =
                    crate::transfer_engine::TransferStore::open(&self.root.join("transfers.db"))?;
                store
                    .delete_many(&[text(&request, "id")?.to_string()])
                    .await?;
                Ok(json!(true))
            }
            "start_http" => {
                let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(error)?;
                let address = listener.local_addr().map_err(error)?;
                let server = crate::server::start_server_with_listener(
                    disconnected(),
                    "synthetic-e2e-stream-token".into(),
                    crate::db::init_db_at(&self.root)?,
                    Arc::new(crate::transcode::TranscodeManager::new(
                        self.root.join("transcode"),
                    )),
                    self.crypto.clone(),
                    self.root.clone(),
                    listener,
                )
                .map_err(error)?;
                self.servers.push((server.handle(), tokio::spawn(server)));
                Ok(json!({"url":format!("http://{address}")}))
            }
            _ => Err("Unknown native E2E command".into()),
        }
    }
    /// Generate fixture ciphertext with production slot construction and encoding.
    async fn create_encrypted_fixture(&self, request: &Value) -> Result<Value, String> {
        let source = child(&self.root, text(request, "source")?)?;
        let destination = child(&self.root, text(request, "destination")?)?;
        let input = tokio::fs::File::open(source).await.map_err(error)?;
        let size = input.metadata().await.map_err(error)?.len();
        let vault_key = self.crypto.get_current_wrapping_key().map_err(error)?;
        let dek = SecretKey::new(crypto::random::random_key());
        let uuid = crypto::random::random_uuid();
        let slot = crate::commands::fs::vault_encryption_slot(&vault_key, &uuid, &dek)?;
        let session = EncryptionSession::new_with_keys(
            size,
            vec![slot],
            br#"{"schema_version":1,"original_name":"private-e2e-document.bin","mime_type":"application/octet-stream"}"#.to_vec(),
            dek,
            uuid,
            crypto::random::random_nonce_prefix(),
        )
        .map_err(error)?;
        let mut reader = EncryptingReader::new(input, session);
        let mut output = tokio::fs::File::create(destination).await.map_err(error)?;
        let bytes = tokio::io::copy(&mut reader, &mut output)
            .await
            .map_err(error)?;
        output.sync_all().await.map_err(error)?;
        Ok(json!({"ciphertextBytes":bytes}))
    }
    /// Read a fixture envelope to prove persisted vault material still decrypts it.
    /// This does not exercise Telegram download staging or final publication.
    async fn read_envelope(&self, request: &Value) -> Result<Value, String> {
        let source = child(&self.root, text(request, "source")?)?;
        let destination = child(&self.root, text(request, "destination")?)?;
        let bytes = tokio::fs::read(source).await.map_err(error)?;
        let header = EnvelopeHeader::parse(&bytes).map_err(error)?;
        let key = self.crypto.get_current_wrapping_key().map_err(error)?;
        let mut decoder = crate::commands::fs::initialize_tdenc2_decryptor(
            &bytes[..header.core.header_length as usize],
            Some(&key),
            None,
        )?;
        let mut plaintext = Vec::new();
        for chunk in bytes[header.core.header_length as usize..].chunks(8191) {
            plaintext.extend(decoder.feed(chunk).map_err(error)?);
        }
        decoder.finish().map_err(error)?;
        tokio::fs::write(destination, &plaintext)
            .await
            .map_err(error)?;
        Ok(json!({"plaintextBytes":plaintext.len()}))
    }
}

pub async fn run() -> Result<(), String> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Explicit private fixture directory required")?,
    )
    .canonicalize()
    .map_err(error)?;
    if std::fs::read_to_string(root.join(".native-e2e-fixture")).map_err(error)?
        != "telegram-drive-synthetic-e2e\n"
    {
        return Err("Refusing to access a non-fixture directory".into());
    }
    let mut driver = Driver {
        crypto: CryptoState::new(Box::new(FileVault::new(root.join("crypto.vault")))),
        root,
        guard: None,
        servers: Vec::new(),
    };
    println!("{}", json!({"ready":true}));
    std::io::stdout().flush().map_err(error)?;
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.map_err(error)?).map_err(error)?;
        if request["command"] == "shutdown" {
            break;
        }
        let response = match driver.dispatch(request).await {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(message) => json!({"ok":false,"error":message}),
        };
        println!("{response}");
        std::io::stdout().flush().map_err(error)?;
    }
    for (handle, task) in driver.servers {
        handle.stop(true).await;
        task.await.map_err(error)?.map_err(error)?;
    }
    Ok(())
}
