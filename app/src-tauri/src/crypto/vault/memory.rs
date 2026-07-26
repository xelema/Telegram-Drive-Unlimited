use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::secret::SecretKey;
use crate::crypto::vault::CryptoVault;
use std::collections::HashMap;

/// Test-only in-memory vault implementation.
/// Never persists to disk. All keys are lost on drop.
pub struct MemoryVault {
    created: bool,
    unlocked: bool,
    vault_key: Option<SecretKey>,
    profiles: HashMap<String, SecretKey>,
}

impl MemoryVault {
    pub fn new() -> Self {
        Self {
            created: false,
            unlocked: false,
            vault_key: None,
            profiles: HashMap::new(),
        }
    }
}

impl CryptoVault for MemoryVault {
    fn exists(&self) -> bool {
        self.created
    }

    fn create(&mut self, _passphrase: &[u8]) -> CryptoResult<()> {
        // In test mode, skip KDF and store a random key
        let key = SecretKey::new(crate::crypto::random::random_key());
        self.vault_key = Some(key);
        self.unlocked = true;
        self.created = true;
        Ok(())
    }

    fn unlock(&mut self, _passphrase: &[u8]) -> CryptoResult<()> {
        if self.vault_key.is_some() {
            self.unlocked = true;
            Ok(())
        } else {
            Err(CryptoError::wrong_key_or_corrupt())
        }
    }

    fn lock(&mut self) {
        self.unlocked = false;
        // Keys remain in memory but are inaccessible while locked
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
        self.profiles.insert(profile_id.to_string(), wrapping_key);
        Ok(())
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

    fn change_passphrase(&mut self, _new_passphrase: &[u8]) -> CryptoResult<()> {
        if !self.unlocked {
            return Err(CryptoError::vault_locked());
        }
        Ok(())
    }

    fn export_bundle(&self, _recovery_passphrase: &[u8]) -> CryptoResult<Vec<u8>> {
        if !self.unlocked {
            return Err(CryptoError::vault_locked());
        }
        // Test-only: return a dummy bundle
        Ok(b"recovery_bundle_v1".to_vec())
    }

    fn import_bundle(&mut self, bundle: &[u8], _recovery_passphrase: &[u8]) -> CryptoResult<()> {
        if bundle == b"recovery_bundle_v1" {
            if self.vault_key.is_none() {
                let key = SecretKey::new(crate::crypto::random::random_key());
                self.vault_key = Some(key);
            }
            self.unlocked = true;
            self.created = true;
            Ok(())
        } else {
            Err(CryptoError::wrong_key_or_corrupt())
        }
    }
}

impl Drop for MemoryVault {
    fn drop(&mut self) {
        self.lock();
    }
}
