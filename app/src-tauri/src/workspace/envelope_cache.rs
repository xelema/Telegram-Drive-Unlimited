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
