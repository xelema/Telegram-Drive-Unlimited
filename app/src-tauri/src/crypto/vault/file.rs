use crate::crypto::error::{CryptoError, CryptoErrorCode, CryptoResult};
use crate::crypto::secret::SecretKey;
use crate::crypto::vault::export::{create_recovery_bundle, import_recovery_bundle};
use crate::crypto::vault::CryptoVault;
use crate::crypto::{kdf, policy, random};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zeroize::Zeroize;

const VAULT_MAGIC: &[u8; 6] = b"TDVLT2";
const VAULT_VERSION: u16 = 2;
const VAULT_AAD_DOMAIN: &[u8] = b"telegram-drive:persistent-vault:v2";
const VAULT_HEADER_SIZE: usize = 64;
const MAX_VAULT_CIPHERTEXT: usize = 1024 * 1024;
const PAYLOAD_MAGIC: &[u8; 6] = b"TDVPL2";
const MAX_PROFILES: usize = 64;
const MAX_PROFILE_ID_BYTES: usize = 128;

pub struct FileVault {
    path: PathBuf,
    unlocked: bool,
    vault_key: Option<SecretKey>,
    unlock_key: Option<SecretKey>,
    vault_salt: Option<[u8; 16]>,
    profiles: HashMap<String, SecretKey>,
    created_at: i64,
}

struct VaultFileHeader {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: [u8; 16],
    nonce: [u8; 24],
    ciphertext_length: usize,
}

impl FileVault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            unlocked: false,
            vault_key: None,
            unlock_key: None,
            vault_salt: None,
            profiles: HashMap::new(),
            created_at: 0,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn backup_path(&self) -> PathBuf {
        self.path.with_extension("vault.bak")
    }

    fn part_path(&self) -> PathBuf {
        self.path.with_extension("vault.part")
    }

    fn readable_path(&self) -> Option<PathBuf> {
        if self.path.is_file() {
            Some(self.path.clone())
        } else {
            let backup = self.backup_path();
            backup.is_file().then_some(backup)
        }
    }

    fn encode_header(header: &VaultFileHeader) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(VAULT_HEADER_SIZE);
        bytes.extend_from_slice(VAULT_MAGIC);
        bytes.extend_from_slice(&VAULT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&header.memory_kib.to_le_bytes());
        bytes.extend_from_slice(&header.iterations.to_le_bytes());
        bytes.extend_from_slice(&header.parallelism.to_le_bytes());
        bytes.extend_from_slice(&header.salt);
        bytes.extend_from_slice(&header.nonce);
        bytes.extend_from_slice(&(header.ciphertext_length as u32).to_le_bytes());
        debug_assert_eq!(bytes.len(), VAULT_HEADER_SIZE);
        bytes
    }

    fn parse_header(bytes: &[u8]) -> CryptoResult<VaultFileHeader> {
        if bytes.len() < VAULT_HEADER_SIZE + policy::AEAD_TAG_LENGTH {
            return Err(CryptoError::truncated());
        }
        if &bytes[..6] != VAULT_MAGIC {
            return Err(CryptoError::header_invalid("Invalid vault magic"));
        }
        let version = u16::from_le_bytes([bytes[6], bytes[7]]);
        if version != VAULT_VERSION {
            return Err(CryptoError::unsupported_version(version));
        }
        let memory_kib = u32::from_le_bytes(
            bytes[8..12]
                .try_into()
                .map_err(|_| CryptoError::truncated())?,
        );
        let iterations = u32::from_le_bytes(
            bytes[12..16]
                .try_into()
                .map_err(|_| CryptoError::truncated())?,
        );
        let parallelism = u32::from_le_bytes(
            bytes[16..20]
                .try_into()
                .map_err(|_| CryptoError::truncated())?,
        );
        policy::validate_argon2_params(memory_kib, iterations, parallelism)?;
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&bytes[20..36]);
        let mut nonce = [0u8; 24];
        nonce.copy_from_slice(&bytes[36..60]);
        let ciphertext_length = u32::from_le_bytes(
            bytes[60..64]
                .try_into()
                .map_err(|_| CryptoError::truncated())?,
        ) as usize;
        if ciphertext_length < policy::AEAD_TAG_LENGTH
            || ciphertext_length > MAX_VAULT_CIPHERTEXT
            || bytes.len() != VAULT_HEADER_SIZE + ciphertext_length
        {
            return Err(CryptoError::header_invalid(
                "Invalid vault ciphertext length",
            ));
        }
        Ok(VaultFileHeader {
            memory_kib,
            iterations,
            parallelism,
            salt,
            nonce,
            ciphertext_length,
        })
    }

    fn serialize_payload(&self) -> CryptoResult<Vec<u8>> {
        let vault_key = self
            .vault_key
            .as_ref()
            .ok_or_else(CryptoError::vault_locked)?;
        if self.profiles.len() > MAX_PROFILES {
            return Err(CryptoError::new(
                CryptoErrorCode::PolicyRejected,
                "Too many encryption profiles",
            ));
        }
        let mut payload = Vec::new();
        payload.extend_from_slice(PAYLOAD_MAGIC);
        payload.extend_from_slice(&self.created_at.to_le_bytes());
        payload.extend_from_slice(vault_key.expose());
        payload.extend_from_slice(&(self.profiles.len() as u16).to_le_bytes());
        let mut profile_ids: Vec<&String> = self.profiles.keys().collect();
        profile_ids.sort();
        for profile_id in profile_ids {
            let id = profile_id.as_bytes();
            if id.is_empty() || id.len() > MAX_PROFILE_ID_BYTES {
                return Err(CryptoError::new(
                    CryptoErrorCode::PolicyRejected,
                    "Invalid encryption profile identifier",
                ));
            }
            payload.extend_from_slice(&(id.len() as u16).to_le_bytes());
            payload.extend_from_slice(id);
            payload.extend_from_slice(
                self.profiles
                    .get(profile_id)
                    .ok_or_else(|| CryptoError::internal("Profile disappeared"))?
                    .expose(),
            );
        }
        Ok(payload)
    }

    fn parse_payload(payload: &[u8]) -> CryptoResult<(i64, SecretKey, HashMap<String, SecretKey>)> {
        if payload.len() < 48 || &payload[..6] != PAYLOAD_MAGIC {
            return Err(CryptoError::wrong_key_or_corrupt());
        }
        let created_at = i64::from_le_bytes(
            payload[6..14]
                .try_into()
                .map_err(|_| CryptoError::wrong_key_or_corrupt())?,
        );
        let mut vault_key = [0u8; 32];
        vault_key.copy_from_slice(&payload[14..46]);
        let count = u16::from_le_bytes(
            payload[46..48]
                .try_into()
                .map_err(|_| CryptoError::wrong_key_or_corrupt())?,
        ) as usize;
        if count > MAX_PROFILES {
            return Err(CryptoError::wrong_key_or_corrupt());
        }
        let mut cursor = 48usize;
        let mut profiles = HashMap::with_capacity(count);
        for _ in 0..count {
            let length_end = cursor
                .checked_add(2)
                .ok_or_else(CryptoError::size_overflow)?;
            if length_end > payload.len() {
                return Err(CryptoError::truncated());
            }
            let id_length = u16::from_le_bytes(
                payload[cursor..length_end]
                    .try_into()
                    .map_err(|_| CryptoError::truncated())?,
            ) as usize;
            cursor = length_end;
            if id_length == 0 || id_length > MAX_PROFILE_ID_BYTES {
                return Err(CryptoError::wrong_key_or_corrupt());
            }
            let id_end = cursor
                .checked_add(id_length)
                .ok_or_else(CryptoError::size_overflow)?;
            let key_end = id_end
                .checked_add(32)
                .ok_or_else(CryptoError::size_overflow)?;
            if key_end > payload.len() {
                return Err(CryptoError::truncated());
            }
            let profile_id = std::str::from_utf8(&payload[cursor..id_end])
                .map_err(|_| CryptoError::wrong_key_or_corrupt())?
                .to_string();
            let mut profile_key = [0u8; 32];
            profile_key.copy_from_slice(&payload[id_end..key_end]);
            if profiles
                .insert(profile_id, SecretKey::new(profile_key))
                .is_some()
            {
                return Err(CryptoError::wrong_key_or_corrupt());
            }
            cursor = key_end;
        }
        if cursor != payload.len() {
            return Err(CryptoError::header_invalid(
                "Trailing bytes in vault payload",
            ));
        }
        Ok((created_at, SecretKey::new(vault_key), profiles))
    }

    fn encrypt_payload_with_key(
        &self,
        payload: &[u8],
        unlock_key: &SecretKey,
        salt: [u8; 16],
    ) -> CryptoResult<Vec<u8>> {
        let nonce = random::random_wrap_nonce();
        let header = VaultFileHeader {
            memory_kib: policy::ARGON2_MEMORY_FLOOR_KIB,
            iterations: policy::ARGON2_ITERATIONS_FLOOR,
            parallelism: policy::ARGON2_PARALLELISM_FLOOR,
            salt,
            nonce,
            ciphertext_length: payload
                .len()
                .checked_add(policy::AEAD_TAG_LENGTH)
                .ok_or_else(CryptoError::size_overflow)?,
        };
        let header_bytes = Self::encode_header(&header);
        let mut aad = Vec::with_capacity(VAULT_AAD_DOMAIN.len() + header_bytes.len());
        aad.extend_from_slice(VAULT_AAD_DOMAIN);
        aad.extend_from_slice(&header_bytes);
        let cipher = XChaCha20Poly1305::new_from_slice(unlock_key.expose())
            .map_err(|_| CryptoError::internal("Invalid vault unlock key"))?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: payload,
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::internal("Vault encryption failed"))?;
        if ciphertext.len() != header.ciphertext_length {
            return Err(CryptoError::internal("Vault ciphertext length mismatch"));
        }
        let mut file_bytes = header_bytes;
        file_bytes.extend_from_slice(&ciphertext);
        Ok(file_bytes)
    }

    fn atomic_write(&self, bytes: &[u8]) -> CryptoResult<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| CryptoError::internal("Vault has no parent directory"))?;
        std::fs::create_dir_all(parent)?;
        let part_path = self.part_path();
        let backup_path = self.backup_path();

        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&part_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);

        if self.path.exists() {
            if backup_path.exists() {
                std::fs::remove_file(&backup_path)?;
            }
            std::fs::rename(&self.path, &backup_path)?;
        }
        if let Err(error) = std::fs::rename(&part_path, &self.path) {
            if backup_path.exists() && !self.path.exists() {
                let _ = std::fs::rename(&backup_path, &self.path);
            }
            return Err(error.into());
        }
        if backup_path.exists() {
            std::fs::remove_file(backup_path)?;
        }
        Ok(())
    }

    fn persist_unlocked(&self) -> CryptoResult<()> {
        let unlock_key = self
            .unlock_key
            .as_ref()
            .ok_or_else(CryptoError::vault_locked)?;
        let salt = self
            .vault_salt
            .ok_or_else(|| CryptoError::internal("Missing vault salt"))?;
        let mut payload = self.serialize_payload()?;
        let result = self
            .encrypt_payload_with_key(&payload, unlock_key, salt)
            .and_then(|bytes| self.atomic_write(&bytes));
        payload.zeroize();
        result
    }

    fn initialize_from_payload(
        &mut self,
        mut payload: Vec<u8>,
        passphrase: &[u8],
    ) -> CryptoResult<()> {
        let parsed = Self::parse_payload(&payload);
        payload.zeroize();
        let (created_at, vault_key, profiles) = parsed?;
        let salt = random::random_salt();
        let unlock_key = kdf::derive_passphrase_key(
            passphrase,
            &salt,
            policy::ARGON2_MEMORY_FLOOR_KIB,
            policy::ARGON2_ITERATIONS_FLOOR,
            policy::ARGON2_PARALLELISM_FLOOR,
        )?;
        self.created_at = created_at;
        self.vault_key = Some(vault_key);
        self.profiles = profiles;
        self.unlock_key = Some(unlock_key);
        self.vault_salt = Some(salt);
        self.unlocked = true;
        if let Err(error) = self.persist_unlocked() {
            self.lock();
            return Err(error);
        }
        Ok(())
    }
}

impl CryptoVault for FileVault {
    fn exists(&self) -> bool {
        self.path.is_file() || self.backup_path().is_file()
    }

    fn create(&mut self, passphrase: &[u8]) -> CryptoResult<()> {
        if self.exists() {
            return Err(CryptoError::new(
                CryptoErrorCode::PolicyRejected,
                "A vault already exists",
            ));
        }
        if passphrase.len() < 8 {
            return Err(CryptoError::new(
                CryptoErrorCode::PolicyRejected,
                "Vault passphrase is too short",
            ));
        }
        self.created_at = chrono::Utc::now().timestamp();
        self.vault_key = Some(SecretKey::new(random::random_key()));
        self.profiles.clear();
        let salt = random::random_salt();
        self.unlock_key = Some(kdf::derive_passphrase_key(
            passphrase,
            &salt,
            policy::ARGON2_MEMORY_FLOOR_KIB,
            policy::ARGON2_ITERATIONS_FLOOR,
            policy::ARGON2_PARALLELISM_FLOOR,
        )?);
        self.vault_salt = Some(salt);
        self.unlocked = true;
        if let Err(error) = self.persist_unlocked() {
            self.lock();
            return Err(error);
        }
        Ok(())
    }

    fn unlock(&mut self, passphrase: &[u8]) -> CryptoResult<()> {
        let path = self.readable_path().ok_or_else(|| {
            CryptoError::new(CryptoErrorCode::KeyRequired, "Vault does not exist")
        })?;
        let mut bytes = Vec::new();
        OpenOptions::new()
            .read(true)
            .open(path)?
            .read_to_end(&mut bytes)?;
        let header = Self::parse_header(&bytes)?;
        let unlock_key = kdf::derive_passphrase_key(
            passphrase,
            &header.salt,
            header.memory_kib,
            header.iterations,
            header.parallelism,
        )?;
        let header_bytes = &bytes[..VAULT_HEADER_SIZE];
        let mut aad = Vec::with_capacity(VAULT_AAD_DOMAIN.len() + VAULT_HEADER_SIZE);
        aad.extend_from_slice(VAULT_AAD_DOMAIN);
        aad.extend_from_slice(header_bytes);
        let cipher = XChaCha20Poly1305::new_from_slice(unlock_key.expose())
            .map_err(|_| CryptoError::internal("Invalid vault unlock key"))?;
        let decrypted = cipher.decrypt(
            XNonce::from_slice(&header.nonce),
            Payload {
                msg: &bytes[VAULT_HEADER_SIZE..],
                aad: &aad,
            },
        );
        bytes.zeroize();
        let mut payload = decrypted.map_err(|_| CryptoError::wrong_key_or_corrupt())?;
        let parsed = Self::parse_payload(&payload);
        payload.zeroize();
        let (created_at, vault_key, profiles) = parsed?;
        self.created_at = created_at;
        self.vault_key = Some(vault_key);
        self.profiles = profiles;
        self.unlock_key = Some(unlock_key);
        self.vault_salt = Some(header.salt);
        self.unlocked = true;
        Ok(())
    }

    fn lock(&mut self) {
        self.unlocked = false;
        self.vault_key = None;
        self.unlock_key = None;
        self.vault_salt = None;
        self.profiles.clear();
    }

    fn is_unlocked(&self) -> bool {
        self.unlocked
    }

    fn wrapping_key(&self) -> CryptoResult<&SecretKey> {
        if !self.unlocked {
            return Err(CryptoError::vault_locked());
        }
        self.vault_key
            .as_ref()
            .ok_or_else(CryptoError::vault_locked)
    }

    fn save_profile(&mut self, profile_id: &str, wrapping_key: SecretKey) -> CryptoResult<()> {
        if !self.unlocked {
            return Err(CryptoError::vault_locked());
        }
        if profile_id.is_empty() || profile_id.len() > MAX_PROFILE_ID_BYTES {
            return Err(CryptoError::new(
                CryptoErrorCode::PolicyRejected,
                "Invalid profile identifier",
            ));
        }
        self.profiles.insert(profile_id.to_string(), wrapping_key);
        self.persist_unlocked()
    }

    fn load_wrapping_key(&self, profile_id: &str) -> CryptoResult<SecretKey> {
        if !self.unlocked {
            return Err(CryptoError::vault_locked());
        }
        self.profiles
            .get(profile_id)
            .cloned()
            .ok_or_else(CryptoError::key_required)
    }

    fn change_passphrase(&mut self, new_passphrase: &[u8]) -> CryptoResult<()> {
        if !self.unlocked {
            return Err(CryptoError::vault_locked());
        }
        if new_passphrase.len() < 8 || new_passphrase.len() > 1024 {
            return Err(CryptoError::new(
                CryptoErrorCode::PolicyRejected,
                "Vault passphrase must be between 8 and 1024 bytes",
            ));
        }
        let salt = random::random_salt();
        let new_unlock_key = kdf::derive_passphrase_key(
            new_passphrase,
            &salt,
            policy::ARGON2_MEMORY_FLOOR_KIB,
            policy::ARGON2_ITERATIONS_FLOOR,
            policy::ARGON2_PARALLELISM_FLOOR,
        )?;
        let mut payload = self.serialize_payload()?;
        let encrypted = self.encrypt_payload_with_key(&payload, &new_unlock_key, salt);
        payload.zeroize();
        let file_bytes = encrypted?;
        self.atomic_write(&file_bytes)?;
        self.unlock_key = Some(new_unlock_key);
        self.vault_salt = Some(salt);
        Ok(())
    }

    fn export_bundle(&self, recovery_passphrase: &[u8]) -> CryptoResult<Vec<u8>> {
        if !self.unlocked {
            return Err(CryptoError::vault_locked());
        }
        let mut payload = self.serialize_payload()?;
        let result = create_recovery_bundle(&payload, recovery_passphrase);
        payload.zeroize();
        result
    }

    fn import_bundle(&mut self, bundle: &[u8], recovery_passphrase: &[u8]) -> CryptoResult<()> {
        let payload = import_recovery_bundle(bundle, recovery_passphrase)?;
        self.initialize_from_payload(payload, recovery_passphrase)
    }
}

impl Drop for FileVault {
    fn drop(&mut self) {
        self.lock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "telegram-drive-{label}-{}-{}.vault",
            std::process::id(),
            random::random_u64()
        ))
    }

    #[test]
    fn persists_locks_and_rejects_wrong_passphrase() {
        let path = test_path("persistent");
        let original_key = {
            let mut vault = FileVault::new(path.clone());
            vault.create(b"correct horse battery staple").unwrap();
            let key = vault.wrapping_key().unwrap().clone();
            vault.lock();
            assert!(vault.wrapping_key().is_err());
            assert!(vault.unlock(b"wrong passphrase").is_err());
            vault.unlock(b"correct horse battery staple").unwrap();
            assert_eq!(key.expose(), vault.wrapping_key().unwrap().expose());
            key
        };
        let mut restarted = FileVault::new(path.clone());
        restarted.unlock(b"correct horse battery staple").unwrap();
        assert_eq!(
            original_key.expose(),
            restarted.wrapping_key().unwrap().expose()
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn recovery_restores_original_vault_material() {
        let source_path = test_path("recovery-source");
        let restored_path = test_path("recovery-restored");
        let mut source = FileVault::new(source_path.clone());
        source.create(b"source vault passphrase").unwrap();
        source
            .save_profile("profile-a", SecretKey::new([0xAB; 32]))
            .unwrap();
        let original_key = source.wrapping_key().unwrap().clone();
        let bundle = source.export_bundle(b"recovery bundle passphrase").unwrap();

        let mut restored = FileVault::new(restored_path.clone());
        restored
            .import_bundle(&bundle, b"recovery bundle passphrase")
            .unwrap();
        assert_eq!(
            original_key.expose(),
            restored.wrapping_key().unwrap().expose()
        );
        assert_eq!(
            restored.load_wrapping_key("profile-a").unwrap().expose(),
            &[0xAB; 32]
        );
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(restored_path);
    }

    #[test]
    fn passphrase_change_reprotects_without_rotating_vault_key() {
        let path = test_path("passphrase-change");
        let original_key = {
            let mut vault = FileVault::new(path.clone());
            vault.create(b"old vault passphrase").unwrap();
            let key = vault.wrapping_key().unwrap().clone();
            vault.change_passphrase(b"new vault passphrase").unwrap();
            vault.lock();
            assert!(vault.unlock(b"old vault passphrase").is_err());
            vault.unlock(b"new vault passphrase").unwrap();
            assert_eq!(key.expose(), vault.wrapping_key().unwrap().expose());
            key
        };
        let mut restarted = FileVault::new(path.clone());
        restarted.unlock(b"new vault passphrase").unwrap();
        assert_eq!(original_key.expose(), restarted.wrapping_key().unwrap().expose());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn invalid_recovery_import_does_not_replace_existing_vault() {
        let path = test_path("recovery-atomicity");
        let mut vault = FileVault::new(path.clone());
        vault.create(b"existing vault passphrase").unwrap();
        let original_key = vault.wrapping_key().unwrap().clone();
        assert!(vault.import_bundle(b"modified bundle", b"recovery passphrase").is_err());
        assert_eq!(original_key.expose(), vault.wrapping_key().unwrap().expose());
        vault.lock();
        vault.unlock(b"existing vault passphrase").unwrap();
        assert_eq!(original_key.expose(), vault.wrapping_key().unwrap().expose());
        let _ = std::fs::remove_file(path);
    }
}
