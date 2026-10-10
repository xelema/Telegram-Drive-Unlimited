//! Owned, memory-only vault work. Persistence and publication belong to the caller.
use super::{
    error::{CryptoError, CryptoResult},
    secret::SecretBytes,
    vault::{CryptoVault, RecoveryVerification, VaultCapture},
};

pub(crate) enum Operation {
    Create(SecretBytes),
    Unlock(SecretBytes),
    Change {
        current: SecretBytes,
        replacement: SecretBytes,
    },
    Export(SecretBytes),
    Verify {
        bundle: Vec<u8>,
        passphrase: SecretBytes,
    },
    Import {
        bundle: Vec<u8>,
        recovery: SecretBytes,
        vault_passphrase: Option<SecretBytes>,
        allow_replacement: bool,
        replace_existing: bool,
    },
}
#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Create,
    Unlock,
    Change,
    Export,
    Verify,
    Import,
}
impl Operation {
    pub fn kind(&self) -> Kind {
        match self {
            Self::Create(_) => Kind::Create,
            Self::Unlock(_) => Kind::Unlock,
            Self::Change { .. } => Kind::Change,
            Self::Export(_) => Kind::Export,
            Self::Verify { .. } => Kind::Verify,
            Self::Import { .. } => Kind::Import,
        }
    }
    pub fn disk_access(&self) -> VaultCapture {
        match self {
            Self::Create(_) => VaultCapture::Create,
            Self::Unlock(_) | Self::Change { .. } => VaultCapture::Read,
            Self::Import { .. } => VaultCapture::Replace,
            Self::Export(_) | Self::Verify { .. } => VaultCapture::Resident,
        }
    }
    pub fn requires_unlocked(&self) -> bool {
        matches!(
            self,
            Self::Change { .. }
                | Self::Export(_)
                | Self::Verify { .. }
                | Self::Import {
                    vault_passphrase: None,
                    ..
                }
        )
    }
}
pub(crate) enum Value {
    Unit,
    Session(u64),
    Bundle(Vec<u8>),
    Verification(RecoveryVerification),
}
pub(crate) struct Prepared {
    pub vault: Box<dyn CryptoVault>,
    pub value: Value,
}
pub(crate) fn prepare(
    mut vault: Box<dyn CryptoVault>,
    operation: Operation,
) -> CryptoResult<Prepared> {
    let value = match operation {
        Operation::Create(passphrase) => {
            vault.create(passphrase.expose())?;
            Value::Unit
        }
        Operation::Unlock(passphrase) => {
            vault.unlock(passphrase.expose())?;
            Value::Unit
        }
        Operation::Change {
            current,
            replacement,
        } => {
            let material = vault.material_fingerprint()?;
            vault.unlock(current.expose())?;
            if vault.material_fingerprint()? != material {
                return Err(CryptoError::wrong_key_or_corrupt());
            }
            vault.change_passphrase(replacement.expose())?;
            Value::Unit
        }
        Operation::Export(passphrase) => Value::Bundle(vault.export_bundle(passphrase.expose())?),
        Operation::Verify { bundle, passphrase } => {
            Value::Verification(vault.verify_bundle(&bundle, passphrase.expose())?)
        }
        Operation::Import {
            bundle,
            recovery,
            vault_passphrase,
            allow_replacement,
            replace_existing,
        } => {
            if vault.exists() && !replace_existing {
                return Err(CryptoError::new(
                    super::error::CryptoErrorCode::PolicyRejected,
                    "[RECOVERY_CONFIRMATION_REQUIRED] Import would replace the existing vault",
                ));
            }
            vault.import_bundle(
                &bundle,
                recovery.expose(),
                vault_passphrase.as_ref().map(SecretBytes::expose),
                allow_replacement,
            )?;
            Value::Unit
        }
    };
    Ok(Prepared { vault, value })
}
