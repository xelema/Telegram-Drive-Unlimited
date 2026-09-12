use super::store::{file_key, Store};
use crate::crypto::{
    envelope::header::{CoreHeader, EnvelopeHeader},
    policy,
};
use serde::{Deserialize, Serialize};

/// A message can be edited to a different document without changing its ID.
/// Never adopt the old, unowned encrypted_files table as an ownership proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteEnvelopeIdentity {
    pub owner: i64,
    pub folder: Option<i64>,
    pub message: i32,
    pub document: i64,
    pub ciphertext_size: u64,
}

#[derive(Serialize, Deserialize)]
struct CachedHeader {
    identity: RemoteEnvelopeIdentity,
    header: Vec<u8>,
}

pub fn suspected_envelope(document_name: &str, caption: &str) -> bool {
    caption == "TDENC2" || document_name.to_ascii_lowercase().ends_with(".tdenc")
}

pub fn validate_header(header: &[u8], ciphertext_size: u64) -> Result<(), String> {
    let parsed = EnvelopeHeader::parse(header).map_err(|e| e.to_string())?;
    let expected = crate::crypto::envelope::length::calculate_ciphertext_length(
        parsed.core.total_plaintext_length,
        parsed.core.chunk_size,
        parsed.core.header_length,
    )
    .map_err(|e| e.to_string())?;
    if expected != ciphertext_size {
        return Err("Encrypted envelope length does not match Telegram media size".into());
    }
    Ok(())
}

pub fn read(store: &Store, identity: &RemoteEnvelopeIdentity) -> Result<Option<Vec<u8>>, String> {
    if identity.owner != store.owner {
        return Err("ACCOUNT_CHANGED".into());
    }
    let entry = store.record::<CachedHeader>(
        "envelope-v1",
        &file_key(identity.folder, identity.message.into()),
    );
    // Corrupt cache data is recoverable by probing the current Telegram document.
    Ok(entry
        .ok()
        .flatten()
        .filter(|entry| {
            entry.identity == *identity
                && validate_header(&entry.header, identity.ciphertext_size).is_ok()
        })
        .map(|entry| entry.header))
}

pub fn write(
    store: &Store,
    identity: &RemoteEnvelopeIdentity,
    header: &[u8],
) -> Result<(), String> {
    if identity.owner != store.owner {
        return Err("ACCOUNT_CHANGED".into());
    }
    validate_header(header, identity.ciphertext_size)?;
    store.put_record(
        "envelope-v1",
        &file_key(identity.folder, identity.message.into()),
        &CachedHeader {
            identity: identity.clone(),
            header: header.to_vec(),
        },
    )
}

/// The fetch future is evaluated only for an absent or obsolete document-bound
/// header. Tests inject bytes through this same path without contacting Telegram.
pub async fn resolve(
    account: &super::AccountGuard,
    identity: &RemoteEnvelopeIdentity,
    fetch: impl std::future::Future<Output = Result<Vec<u8>, String>>,
) -> Result<Vec<u8>, String> {
    account.validate()?;
    if account.owner != identity.owner {
        return Err("ACCOUNT_CHANGED".into());
    }
    let read_account = account.clone();
    let read_identity = identity.clone();
    let cached = tokio::task::spawn_blocking(move || {
        read_account.validate()?;
        let header = read(
            &Store::open(&read_account.root, read_account.owner)?,
            &read_identity,
        )?;
        read_account.validate()?;
        Ok::<_, String>(header)
    })
    .await
    .map_err(|e| e.to_string())??;
    account.validate()?;
    if let Some(header) = cached {
        return Ok(header);
    }
    let header = fetch.await?;
    account.validate()?;
    validate_header(&header, identity.ciphertext_size)?;
    let publish_account = account.clone();
    let publish_identity = identity.clone();
    let publish_header = header.clone();
    tokio::task::spawn_blocking(move || {
        publish_account.validate()?;
        let store = Store::open(&publish_account.root, publish_account.owner)?;
        store.transaction(|| {
            write(&store, &publish_identity, &publish_header)?;
            publish_account.validate()
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    account.validate()?;
    Ok(header)
}

/// Only verified document-bound headers belong in this account's inventory.
/// Old, unassigned registry rows remain preserved and are never claimed here.
pub fn inventory(store: &Store) -> Result<Vec<(u16, u64, u64)>, String> {
    let mut groups = std::collections::BTreeMap::<u16, (u64, u64)>::new();
    for value in store.records::<serde_json::Value>("envelope-v1")? {
        let Ok(entry) = serde_json::from_value::<CachedHeader>(value) else {
            continue;
        };
        if entry.identity.owner != store.owner
            || validate_header(&entry.header, entry.identity.ciphertext_size).is_err()
        {
            continue;
        }
        if store
            .file(&file_key(
                entry.identity.folder,
                entry.identity.message.into(),
            ))?
            .is_some_and(|file| file.file.encryption_state == "plain")
        {
            continue;
        }
        let parsed = EnvelopeHeader::parse(&entry.header).map_err(|e| e.to_string())?;
        let group = groups.entry(parsed.core.format_version).or_default();
        group.0 = group.0.saturating_add(1);
        group.1 = group.1.saturating_add(entry.identity.ciphertext_size);
    }
    Ok(groups
        .into_iter()
        .map(|(version, (count, size))| (version, count, size))
        .collect())
}

/// Keep the remainder of the first network chunk after parsing the core.
/// Telegram commonly returns the entire header and payload together.
#[derive(Default)]
pub struct HeaderProbe {
    bytes: Vec<u8>,
    expected: Option<usize>,
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::crypto::{
        envelope::header::KeySlotEntry,
        envelope::key_slot::{wrap_dek_with_nonce, KeySlotContext},
        secret::SecretKey,
    };
    use grammers_session::{storages::SqliteSession, types::PeerInfo, Session};
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
    };

    pub fn sign_in(root: &Path, owner: i64) {
        let session = SqliteSession::open(root.join("telegram.session")).unwrap();
        // The fixture client keeps SQLite open, so replace the self peer in
        // place instead of relying on unlinking an open database on Windows.
        sqlite::open(root.join("telegram.session"))
            .unwrap()
            .execute("DELETE FROM peer_info")
            .unwrap();
        session.cache_peer(&PeerInfo::User {
            id: owner,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
        assert_eq!(crate::workspace::current_owner(root).unwrap(), owner);
    }
    pub struct Fixture {
        pub root: PathBuf,
        pub account: super::super::AccountGuard,
        pub client: grammers_client::Client,
        _pool: grammers_mtsender::SenderPool,
    }
    impl Fixture {
        pub fn new(owner: i64) -> Self {
            let root =
                std::env::temp_dir().join(format!("envelope-routing-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            sign_in(&root, owner);
            let session = Arc::new(SqliteSession::open(root.join("telegram.session")).unwrap());
            let pool = grammers_mtsender::SenderPool::new(session, 1);
            let client = grammers_client::Client::new(&pool);
            let account =
                super::super::AccountGuard::open(&root, Some(&owner.to_string())).unwrap();
            Self {
                root,
                account,
                client,
                _pool: pool,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// A valid existing TDENC2 vault header, including a real authenticated key
    /// slot, so read-path tests exercise production unwrap/metadata verification.
    pub fn vault_header(name: &str, seed: u8) -> (Vec<u8>, u64, SecretKey) {
        let uuid = [seed; 16];
        let salt = [2; 16];
        let nonce = [3; 24];
        let dek = SecretKey::new([seed; 32]);
        let master = SecretKey::new([seed + 1; 32]);
        let kind = policy::SlotKind::Vault as u8;
        let algorithm = policy::KdfAlgorithm::HkdfSha256 as u16;
        let wrapping =
            crate::crypto::kdf::derive_file_wrapping_key(&master, &uuid, &salt, kind, 0).unwrap();
        let wrapped = wrap_dek_with_nonce(
            &KeySlotContext {
                file_uuid: &uuid,
                format_version: policy::FORMAT_VERSION,
            },
            &dek,
            &wrapping,
            kind,
            0,
            algorithm,
            0,
            0,
            0,
            &salt,
            nonce,
        )
        .unwrap();
        let header=EnvelopeHeader::build(uuid,policy::DEFAULT_CHUNK_SIZE,vec![KeySlotEntry {
            kind,slot_id:0,kdf_algorithm:algorithm,argon2_memory_kib:0,argon2_iterations:0,argon2_parallelism:0,
            salt,wrap_nonce:nonce,wrapped_dek:wrapped,
        }],serde_json::to_string(&serde_json::json!({"schema_version":1,"original_name":name,"mime_type":"video/mp4"})).unwrap().as_bytes(),
            123,[4;16],&dek).unwrap();
        let parsed = EnvelopeHeader::parse(&header).unwrap();
        let size = crate::crypto::envelope::length::calculate_ciphertext_length(
            123,
            parsed.core.chunk_size,
            parsed.core.header_length,
        )
        .unwrap();
        (header, size, master)
    }

    pub fn media(name: &str, document: i64, size: u64) -> grammers_client::types::Media {
        use grammers_tl_types::{enums, types};
        grammers_client::types::Media::Document(
            grammers_client::types::media::Document::from_raw_media(types::MessageMediaDocument {
                nopremium: false,
                spoiler: false,
                video: false,
                round: false,
                voice: false,
                document: Some(enums::Document::Document(types::Document {
                    id: document,
                    access_hash: 1,
                    file_reference: vec![],
                    date: 0,
                    mime_type: "video/mp4".into(),
                    size: size as i64,
                    thumbs: None,
                    video_thumbs: None,
                    dc_id: 1,
                    attributes: vec![enums::DocumentAttribute::Filename(
                        types::DocumentAttributeFilename {
                            file_name: name.into(),
                        },
                    )],
                })),
                alt_documents: None,
                video_cover: None,
                video_timestamp: None,
                ttl_seconds: None,
            }),
        )
    }
}
impl HeaderProbe {
    pub fn push(&mut self, mut chunk: &[u8]) -> Result<Option<Vec<u8>>, String> {
        while !chunk.is_empty() && self.expected.is_none_or(|len| self.bytes.len() < len) {
            let target = self.expected.unwrap_or(policy::CORE_HEADER_SIZE);
            let take = (target - self.bytes.len()).min(chunk.len());
            self.bytes.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if self.expected.is_none() && self.bytes.len() == policy::CORE_HEADER_SIZE {
                let core = CoreHeader::parse(&self.bytes).map_err(|e| e.to_string())?;
                let expected = core.header_length as usize;
                if !(policy::CORE_HEADER_SIZE..=policy::MAX_HEADER_LENGTH).contains(&expected) {
                    return Err("Invalid encrypted header length".into());
                }
                self.expected = Some(expected);
            }
        }
        if self.expected == Some(self.bytes.len()) {
            EnvelopeHeader::parse(&self.bytes).map_err(|e| e.to_string())?;
            Ok(Some(std::mem::take(&mut self.bytes)))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{envelope::header::KeySlotEntry, secret::SecretKey};

    #[tokio::test]
    async fn legacy_headers_are_preserved_but_only_current_remote_bytes_are_adopted() {
        use test_support::{vault_header, Fixture};
        let fixture = Fixture::new(22);
        let (old, size, old_key) = vault_header("A-private.mp4", 7);
        let (current, current_size, current_key) = vault_header("B-private.mp4", 8);
        assert_eq!(size, current_size);
        let legacy = sqlite::open(fixture.root.join("shares.db")).unwrap();
        legacy.execute("CREATE TABLE encrypted_files (folder_key TEXT,message_id INTEGER,header_blob BLOB)").unwrap();
        let mut insert = legacy
            .prepare("INSERT INTO encrypted_files VALUES('home',42,?)")
            .unwrap();
        insert.bind((1, old.as_slice())).unwrap();
        insert.next().unwrap();
        drop(insert);
        let a = Store::open(&fixture.root, 11).unwrap();
        let a_id = RemoteEnvelopeIdentity {
            owner: 11,
            folder: None,
            message: 42,
            document: 100,
            ciphertext_size: size,
        };
        write(&a, &a_id, &old).unwrap();
        let b_id = RemoteEnvelopeIdentity {
            owner: 22,
            ..a_id.clone()
        };
        let selected = resolve(&fixture.account, &b_id, async { Ok(current.clone()) })
            .await
            .unwrap();
        let reader =
            crate::commands::fs::initialize_tdenc2_decryptor(&selected, Some(&current_key), None)
                .unwrap();
        assert!(String::from_utf8_lossy(reader.metadata_plaintext()).contains("B-private.mp4"));
        assert!(
            crate::commands::fs::initialize_tdenc2_decryptor(&selected, Some(&old_key), None)
                .is_err()
        );
        assert_eq!(
            resolve(&fixture.account, &b_id, async {
                Err("cache should prevent this fetch".into())
            })
            .await
            .unwrap(),
            current
        );
        let (replacement, _, replacement_key) = vault_header("C-private.mp4", 9);
        let replaced_id = RemoteEnvelopeIdentity {
            document: 101,
            ..b_id.clone()
        };
        let selected = resolve(&fixture.account, &replaced_id, async {
            Ok(replacement.clone())
        })
        .await
        .unwrap();
        assert!(crate::commands::fs::initialize_tdenc2_decryptor(
            &selected,
            Some(&replacement_key),
            None
        )
        .is_ok());
        assert!(crate::commands::fs::initialize_tdenc2_decryptor(
            &selected,
            Some(&current_key),
            None
        )
        .is_err());
        let mut statement = legacy
            .prepare("SELECT header_blob FROM encrypted_files")
            .unwrap();
        statement.next().unwrap();
        assert_eq!(statement.read::<Vec<u8>, _>(0).unwrap(), old);
        let b = Store::open(&fixture.root, 22).unwrap();
        assert_eq!(
            inventory(&b).unwrap(),
            vec![(policy::FORMAT_VERSION, 1, size)]
        );
        let other = Store::open(&fixture.root, 33).unwrap();
        assert!(inventory(&other).unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_header_fetched_across_account_change_is_never_cached() {
        let fixture = test_support::Fixture::new(22);
        let (header, size, _) = test_support::vault_header("private.mp4", 7);
        let id = RemoteEnvelopeIdentity {
            owner: 22,
            folder: None,
            message: 42,
            document: 100,
            ciphertext_size: size,
        };
        let result = resolve(&fixture.account, &id, async {
            test_support::sign_in(&fixture.root, 33);
            Ok(header)
        })
        .await;
        assert!(result.unwrap_err().contains("ACCOUNT_CHANGED"));
        let store = Store::open(&fixture.root, 22).unwrap();
        assert!(read(&store, &id).unwrap().is_none());
    }

    fn header(name: &str, seed: u8, passphrase: bool) -> (Vec<u8>, u64) {
        let slot = KeySlotEntry {
            kind: if passphrase {
                policy::SlotKind::Passphrase as u8
            } else {
                policy::SlotKind::Vault as u8
            },
            slot_id: 0,
            kdf_algorithm: if passphrase {
                policy::KdfAlgorithm::Argon2id as u16
            } else {
                policy::KdfAlgorithm::HkdfSha256 as u16
            },
            argon2_memory_kib: if passphrase {
                policy::ARGON2_MEMORY_FLOOR_KIB
            } else {
                0
            },
            argon2_iterations: if passphrase {
                policy::ARGON2_ITERATIONS_FLOOR
            } else {
                0
            },
            argon2_parallelism: if passphrase {
                policy::ARGON2_PARALLELISM_FLOOR
            } else {
                0
            },
            salt: [1; 16],
            wrap_nonce: [2; 24],
            wrapped_dek: [3; 48],
        };
        let bytes = EnvelopeHeader::build(
            [seed; 16],
            policy::DEFAULT_CHUNK_SIZE,
            vec![slot],
            name.as_bytes(),
            123,
            [5; 16],
            &SecretKey::new([seed; 32]),
        )
        .unwrap();
        let parsed = EnvelopeHeader::parse(&bytes).unwrap();
        let size = crate::crypto::envelope::length::calculate_ciphertext_length(
            123,
            parsed.core.chunk_size,
            parsed.core.header_length,
        )
        .unwrap();
        (bytes, size)
    }

    #[test]
    fn envelope_cache_rejects_other_owner_and_replaced_documents() {
        let root = std::env::temp_dir().join(format!("envelope-test-{}", uuid::Uuid::new_v4()));
        let a = Store::open(&root, 11).unwrap();
        let b = Store::open(&root, 22).unwrap();
        let (ha, size) = header("account A secret", 9, false);
        let (hb, _) = header("account B secret", 8, false);
        let ia = RemoteEnvelopeIdentity {
            owner: 11,
            folder: None,
            message: 42,
            document: 100,
            ciphertext_size: size,
        };
        let ib = RemoteEnvelopeIdentity {
            owner: 22,
            ..ia.clone()
        };
        write(&a, &ia, &ha).unwrap();
        assert!(read(&b, &ib).unwrap().is_none());
        assert!(read(&b, &ia).is_err());
        write(&b, &ib, &hb).unwrap();
        let selected = EnvelopeHeader::parse(&read(&b, &ib).unwrap().unwrap()).unwrap();
        assert_eq!(
            selected
                .verify_and_decrypt_metadata(&SecretKey::new([8; 32]))
                .unwrap(),
            b"account B secret"
        );
        assert!(selected
            .verify_and_decrypt_metadata(&SecretKey::new([9; 32]))
            .is_err());
        assert!(read(
            &b,
            &RemoteEnvelopeIdentity {
                document: 101,
                ..ib.clone()
            }
        )
        .unwrap()
        .is_none());
        assert!(read(
            &b,
            &RemoteEnvelopeIdentity {
                ciphertext_size: size + 1,
                ..ib.clone()
            }
        )
        .unwrap()
        .is_none());
        assert!(read(
            &b,
            &RemoteEnvelopeIdentity {
                folder: Some(7),
                ..ib.clone()
            }
        )
        .unwrap()
        .is_none());
        drop(a);
        drop(b);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn envelope_cache_preserves_same_owner_passphrase_headers() {
        let root = std::env::temp_dir().join(format!("envelope-test-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&root, 11).unwrap();
        let (bytes, size) = header("private", 9, true);
        let id = RemoteEnvelopeIdentity {
            owner: 11,
            folder: None,
            message: 42,
            document: 100,
            ciphertext_size: size,
        };
        write(&store, &id, &bytes).unwrap();
        let cached = read(&store, &id).unwrap().unwrap();
        assert_eq!(cached, bytes);
        assert_eq!(
            EnvelopeHeader::parse(&cached).unwrap().key_slots[0].kind,
            policy::SlotKind::Passphrase as u8
        );
        assert!(!suspected_envelope("report.pdf", ""));
        assert!(suspected_envelope("file.TDENC", "renamed"));
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn envelope_header_probe_handles_single_and_split_chunks_without_payload() {
        let (bytes, _) = header("private", 9, false);
        let mut whole = bytes.clone();
        whole.extend_from_slice(&[7; 1024]);
        assert_eq!(HeaderProbe::default().push(&whole).unwrap().unwrap(), bytes);
        for split in [
            1,
            policy::CORE_HEADER_SIZE - 1,
            policy::CORE_HEADER_SIZE,
            bytes.len() - 1,
        ] {
            let mut probe = HeaderProbe::default();
            assert!(probe.push(&whole[..split]).unwrap().is_none());
            assert_eq!(probe.push(&whole[split..]).unwrap().unwrap(), bytes);
        }
        assert!(HeaderProbe::default()
            .push(&[0; policy::CORE_HEADER_SIZE])
            .is_err());
    }
}
