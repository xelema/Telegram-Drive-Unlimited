use crate::crypto::error::CryptoResult;
use crate::crypto::secret::SecretKey;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum VaultCapture {
    Create,
    Read,
    Replace,
    Resident,
}

/// Trait for vault persistence backends.
///
/// Implementations include:
/// - `FileVault`: passphrase-protected persistent production backend
pub trait CryptoVault: Send + Sync {
    /// Capture owned input for a strictly memory-only preparation. No KDF runs here.
    fn preparation_snapshot(&self) -> CryptoResult<Box<dyn CryptoVault>>;
    /// Capture operation-specific disk input on a blocking worker before KDF.
    fn capture_preparation_files(&mut self, access: VaultCapture) -> CryptoResult<()>;
    /// Revalidate captured primary/backup bytes, then persist prepared ciphertext.
    fn commit_prepared(&mut self) -> CryptoResult<()>;
    /// Bind reauthentication to all vault/profile material, without exposing it.
    fn material_fingerprint(&self) -> CryptoResult<[u8; 32]>;
    #[cfg(feature = "native-e2e")]
    fn test_cleanup_failure(&mut self, fail: bool);
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

    /// Decrypt a recovery bundle and compare it with the unlocked vault
    /// without changing anything on disk or in memory.
    fn verify_bundle(
        &self,
        bundle: &[u8],
        recovery_passphrase: &[u8],
    ) -> CryptoResult<RecoveryVerification>;

    /// Import an encrypted recovery bundle.
    ///
    /// `vault_passphrase` is the passphrase that will unlock the restored
    /// vault. When it is `None` the vault must already be unlocked and its
    /// current passphrase is kept; the recovery-bundle passphrase never
    /// becomes the vault passphrase implicitly.
    ///
    /// Replacing an unlocked vault with a bundle that holds a different vault
    /// key, or lacks profile keys the vault holds, is refused unless
    /// `allow_key_replacement` is set. The previous vault file is archived
    /// before any replacement.
    fn import_bundle(
        &mut self,
        bundle: &[u8],
        recovery_passphrase: &[u8],
        vault_passphrase: Option<&[u8]>,
        allow_key_replacement: bool,
    ) -> CryptoResult<()>;

    /// Stable, non-secret identifier of the unlocked vault's key material.
    fn identity(&self) -> CryptoResult<String>;
}

/// Outcome of comparing a recovery bundle with the unlocked vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct RecoveryVerification {
    /// The bundle restores the same vault key this vault uses.
    pub matches_vault_key: bool,
    /// Profile keys held by the vault that the bundle would not restore.
    pub missing_profiles: usize,
}

impl RecoveryVerification {
    /// The bundle can restore everything the vault currently protects.
    pub fn is_complete(&self) -> bool {
        self.matches_vault_key && self.missing_profiles == 0
    }
}

pub mod export;
pub mod file;

pub use file::FileVault;
