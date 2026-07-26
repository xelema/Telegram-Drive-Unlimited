use crate::crypto::error::CryptoResult;
use crate::crypto::secret::SecretKey;

/// Trait for vault persistence backends.
///
/// Implementations include:
/// - `MemoryVault`: test-only, never persists
/// - `FileVault`: passphrase-protected persistent production backend
pub trait CryptoVault: Send + Sync {
    /// Check whether a vault has been created.
    fn exists(&self) -> bool;

    /// Create a new vault protected by the given passphrase.
    fn create(&mut self, passphrase: &[u8]) -> CryptoResult<()>;

    /// Unlock the vault with the given passphrase.
    fn unlock(&mut self, passphrase: &[u8]) -> CryptoResult<()>;

    /// Lock the vault and zeroize all key material.
    fn lock(&mut self);

    /// Check if the vault is currently unlocked.
    fn is_unlocked(&self) -> bool;

    /// Get the vault's wrapping key (if unlocked).
    fn wrapping_key(&self) -> CryptoResult<&SecretKey>;

    /// Store a profile's wrapping key.
    fn save_profile(&mut self, profile_id: &str, wrapping_key: SecretKey) -> CryptoResult<()>;

    /// Load a profile's wrapping key.
    fn load_wrapping_key(&self, profile_id: &str) -> CryptoResult<SecretKey>;

    /// Re-protect the same vault material with a new user passphrase.
    fn change_passphrase(&mut self, new_passphrase: &[u8]) -> CryptoResult<()>;

    /// Export an encrypted recovery bundle.
    fn export_bundle(&self, recovery_passphrase: &[u8]) -> CryptoResult<Vec<u8>>;

    /// Import an encrypted recovery bundle.
    fn import_bundle(&mut self, bundle: &[u8], recovery_passphrase: &[u8]) -> CryptoResult<()>;
}

pub mod export;
pub mod file;
pub mod memory;

pub use file::FileVault;
pub use memory::MemoryVault;
