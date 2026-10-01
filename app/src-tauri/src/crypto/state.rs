use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::policy::CryptoFeatureFlags;
use crate::crypto::secret::{SecretBytes, SecretKey};
use crate::crypto::vault::CryptoVault;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A unique, opaque session handle returned after vault unlock.
pub type UnlockSessionId = u64;

/// An opaque operation handle for short-lived crypto operations.
pub type OperationHandle = u64;

/// The central cryptographic state for the application.
///
/// Holds the vault, session handles, auto-lock timer, and feature flags.
/// Wrapped in `Arc<Mutex<>>` for thread-safe access from Tauri commands.
#[derive(Clone)]
pub struct CryptoState {
    inner: Arc<Mutex<CryptoStateInner>>,
    auto_lock_changed: Arc<tokio::sync::Notify>,
}

struct CryptoStateInner {
    vault: Box<dyn CryptoVault>,
    current_session: Option<UnlockSessionId>,
    sessions: HashMap<UnlockSessionId, SessionInfo>,
    operation_handles: HashMap<OperationHandle, OperationInfo>,
    prompt_secrets: HashMap<OperationHandle, PromptSecret>,
    features: CryptoFeatureFlags,
    auto_lock_timeout: Option<Duration>,
    last_activity: Instant,
    locked: bool,
}

struct SessionInfo {
    wrapping_key: SecretKey,
}

/// Session, lifetime, and capability checks for an active operation handle.
struct OperationInfo {
    session_id: UnlockSessionId,
    created_at: Instant,
    operation_class: OperationClass,
}

struct PromptSecret {
    created_at: Instant,
    secret: SecretBytes,
}

const PROMPT_SECRET_TTL: Duration = Duration::from_secs(5 * 60);
const MEDIA_OPERATION_TTL: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationClass {
    Upload,
    Download,
    Preview,
    MediaStream,
    Archive,
    Share,
    Admin,
}

impl CryptoState {
    /// Create a new CryptoState with the given vault implementation.
    pub fn new(vault: Box<dyn CryptoVault>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(CryptoStateInner {
                vault,
                current_session: None,
                sessions: HashMap::new(),
                operation_handles: HashMap::new(),
                prompt_secrets: HashMap::new(),
                features: CryptoFeatureFlags::default(),
                auto_lock_timeout: Some(Duration::from_secs(15 * 60)),
                last_activity: Instant::now(),
                locked: true,
            })),
            auto_lock_changed: Arc::new(tokio::sync::Notify::new()),
        }
    }

    fn signal_auto_lock_change(&self) {
        // `notify_one` retains a permit when the supervisor is between waits,
        // preventing an unlock or activity update from being lost.
        self.auto_lock_changed.notify_one();
    }

    fn lock_inner(inner: &mut CryptoStateInner) {
        inner.vault.lock();
        inner.current_session = None;
        inner.sessions.clear();
        inner.operation_handles.clear();
        inner.prompt_secrets.clear();
        inner.locked = true;
    }

    /// Create a new vault and immediately make it available.
    pub fn create_vault(&self, passphrase: &[u8]) -> CryptoResult<UnlockSessionId> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        inner.vault.create(passphrase)?;
        let session_id = Self::new_unique_handle(&inner.sessions);
        let wrapping_key = inner.vault.wrapping_key()?.clone();
        inner
            .sessions
            .insert(session_id, SessionInfo { wrapping_key });
        inner.current_session = Some(session_id);
        inner.locked = false;
        inner.last_activity = Instant::now();
        drop(inner);
        self.signal_auto_lock_change();
        Ok(session_id)
    }

    /// Unlock the vault and return an opaque session handle.
    pub fn unlock(&self, passphrase: &[u8]) -> CryptoResult<UnlockSessionId> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;

        inner.vault.unlock(passphrase)?;

        let session_id = Self::new_unique_handle(&inner.sessions);

        let wrapping_key = inner.vault.wrapping_key()?.clone();

        inner
            .sessions
            .insert(session_id, SessionInfo { wrapping_key });

        inner.current_session = Some(session_id);
        inner.locked = false;
        inner.last_activity = Instant::now();
        drop(inner);
        self.signal_auto_lock_change();
        Ok(session_id)
    }

    /// Lock the vault and invalidate all handles.
    pub fn lock(&self) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::lock_inner(&mut inner);
        drop(inner);
        self.signal_auto_lock_change();
    }

    /// Check if the vault is currently locked.
    pub fn is_locked(&self) -> bool {
        self.inner.lock().map(|i| i.locked).unwrap_or(true)
    }

    /// Check whether a vault has been created.
    pub fn vault_exists(&self) -> bool {
        self.inner.lock().map(|i| i.vault.exists()).unwrap_or(false)
    }

    /// Validate a session handle.
    pub fn validate_session(&self, session_id: UnlockSessionId) -> CryptoResult<()> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        if inner.locked || inner.current_session != Some(session_id) {
            return Err(CryptoError::vault_locked());
        }
        if !inner.sessions.contains_key(&session_id) {
            return Err(CryptoError::vault_locked());
        }
        Ok(())
    }

    /// Create an operation handle scoped to a session.
    pub fn create_operation_handle(
        &self,
        session_id: UnlockSessionId,
        class: OperationClass,
    ) -> CryptoResult<OperationHandle> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;

        if inner.locked || inner.current_session != Some(session_id) {
            return Err(CryptoError::vault_locked());
        }

        inner.operation_handles.retain(|_, operation| {
            operation.operation_class != OperationClass::MediaStream
                || operation.created_at.elapsed() <= MEDIA_OPERATION_TTL
        });

        let handle = Self::new_unique_handle(&inner.operation_handles);

        inner.operation_handles.insert(
            handle,
            OperationInfo {
                session_id,
                created_at: Instant::now(),
                operation_class: class,
            },
        );

        Ok(handle)
    }

    /// Resolve a capability-scoped wrapping key only while the originating
    /// vault session is current and unlocked.
    pub fn operation_wrapping_key(
        &self,
        handle: OperationHandle,
        class: OperationClass,
    ) -> CryptoResult<SecretKey> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        if inner.locked {
            return Err(CryptoError::vault_locked());
        }
        inner.operation_handles.retain(|_, operation| {
            operation.operation_class != OperationClass::MediaStream
                || operation.created_at.elapsed() <= MEDIA_OPERATION_TTL
        });
        let operation = inner
            .operation_handles
            .get(&handle)
            .ok_or_else(CryptoError::vault_locked)?;
        if operation.operation_class != class || inner.current_session != Some(operation.session_id)
        {
            return Err(CryptoError::vault_locked());
        }
        let session_id = operation.session_id;
        let key = inner
            .sessions
            .get(&session_id)
            .map(|session| session.wrapping_key.clone())
            .ok_or_else(CryptoError::vault_locked)?;
        inner.last_activity = Instant::now();
        drop(inner);
        self.signal_auto_lock_change();
        Ok(key)
    }

    pub fn revoke_operation_handle(&self, handle: OperationHandle) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.operation_handles.remove(&handle);
        }
    }

    /// Get the wrapping key for a session.
    pub fn get_wrapping_key(&self, session_id: UnlockSessionId) -> CryptoResult<SecretKey> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        if inner.locked {
            return Err(CryptoError::vault_locked());
        }
        inner
            .sessions
            .get(&session_id)
            .map(|s| s.wrapping_key.clone())
            .ok_or_else(CryptoError::vault_locked)
    }

    /// Get the wrapping key for the currently authorized session without
    /// exposing or guessing its opaque identifier at transfer call sites.
    pub fn get_current_wrapping_key(&self) -> CryptoResult<SecretKey> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        if inner.locked {
            return Err(CryptoError::vault_locked());
        }
        let session_id = inner
            .current_session
            .ok_or_else(CryptoError::vault_locked)?;
        inner
            .sessions
            .get(&session_id)
            .map(|session| session.wrapping_key.clone())
            .ok_or_else(CryptoError::vault_locked)
    }

    pub fn current_session(&self) -> Option<UnlockSessionId> {
        self.inner.lock().ok().and_then(|inner| {
            if inner.locked {
                None
            } else {
                inner.current_session
            }
        })
    }

    fn new_unique_handle<T>(existing: &HashMap<u64, T>) -> u64 {
        loop {
            let candidate = crate::crypto::random::random_u64();
            if candidate != 0 && !existing.contains_key(&candidate) {
                return candidate;
            }
        }
    }

    /// Store a passphrase behind a short-lived, opaque, single-use token.
    /// The passphrase itself never enters queue persistence or settings.
    pub fn stage_prompt_secret(&self, secret: &[u8]) -> CryptoResult<OperationHandle> {
        if secret.len() < 8 || secret.len() > 1024 {
            return Err(CryptoError::new(
                crate::crypto::error::CryptoErrorCode::PolicyRejected,
                "File passphrase must be between 8 and 1024 bytes",
            ));
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        inner
            .prompt_secrets
            .retain(|_, entry| entry.created_at.elapsed() <= PROMPT_SECRET_TTL);
        let handle = Self::new_unique_handle(&inner.prompt_secrets);
        inner.prompt_secrets.insert(
            handle,
            PromptSecret {
                created_at: Instant::now(),
                secret: SecretBytes::from_slice(secret),
            },
        );
        Ok(handle)
    }

    /// Consume a staged passphrase exactly once. Expired or reused handles fail
    /// without revealing whether a token previously existed.
    pub fn consume_prompt_secret(&self, handle: OperationHandle) -> CryptoResult<SecretBytes> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        let entry = inner.prompt_secrets.remove(&handle).ok_or_else(|| {
            CryptoError::new(
                crate::crypto::error::CryptoErrorCode::KeyRequired,
                "Passphrase prompt expired or was already used",
            )
        })?;
        if entry.created_at.elapsed() > PROMPT_SECRET_TTL {
            return Err(CryptoError::new(
                crate::crypto::error::CryptoErrorCode::KeyRequired,
                "Passphrase prompt expired or was already used",
            ));
        }
        Ok(entry.secret)
    }

    /// Export a recovery bundle.
    pub fn export_recovery(&self, recovery_passphrase: &[u8]) -> CryptoResult<Vec<u8>> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        if inner.locked {
            return Err(CryptoError::vault_locked());
        }
        inner.vault.export_bundle(recovery_passphrase)
    }

    /// Import a recovery bundle.
    pub fn import_recovery(&self, bundle: &[u8], recovery_passphrase: &[u8]) -> CryptoResult<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        inner.vault.import_bundle(bundle, recovery_passphrase)?;
        let session_id = Self::new_unique_handle(&inner.sessions);
        let wrapping_key = inner.vault.wrapping_key()?.clone();
        inner.sessions.clear();
        inner
            .sessions
            .insert(session_id, SessionInfo { wrapping_key });
        inner.current_session = Some(session_id);
        inner.locked = false;
        inner.last_activity = Instant::now();
        drop(inner);
        self.signal_auto_lock_change();
        Ok(())
    }

    pub fn change_vault_passphrase(&self, new_passphrase: &[u8]) -> CryptoResult<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CryptoError::internal("Lock poisoned"))?;
        if inner.locked {
            return Err(CryptoError::vault_locked());
        }
        inner.vault.change_passphrase(new_passphrase)?;
        inner.last_activity = Instant::now();
        drop(inner);
        self.signal_auto_lock_change();
        Ok(())
    }

    /// Set feature flags.
    pub fn set_features(&self, features: CryptoFeatureFlags) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.features = features;
    }

    /// Get feature flags.
    pub fn get_features(&self) -> CryptoFeatureFlags {
        self.inner
            .lock()
            .map(|i| i.features.clone())
            .unwrap_or_default()
    }

    /// Set auto-lock timeout.
    pub fn set_auto_lock_timeout(&self, timeout: Option<Duration>) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.auto_lock_timeout = timeout;
        drop(inner);
        self.signal_auto_lock_change();
    }

    /// Return the current lock deadline. A locked vault or disabled timeout has
    /// no deadline and leaves the supervisor asleep until state changes.
    pub fn next_auto_lock_deadline(&self) -> Option<Instant> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.locked {
            return None;
        }
        inner
            .auto_lock_timeout
            .and_then(|timeout| inner.last_activity.checked_add(timeout))
    }

    /// Wait until unlock, activity, timeout, or explicit lock changes the
    /// deadline. This replaces periodic wakeups while the vault is idle.
    pub async fn wait_for_auto_lock_change(&self) {
        self.auto_lock_changed.notified().await;
    }

    /// Sleep until this vault crosses its current inactivity deadline. Deadline
    /// changes interrupt the sleep and are recalculated without periodic polls.
    pub async fn wait_until_auto_locked(&self) {
        loop {
            match self.next_auto_lock_deadline() {
                Some(deadline) => {
                    tokio::select! {
                        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                            if self.lock_if_auto_lock_due() {
                                return;
                            }
                        }
                        _ = self.wait_for_auto_lock_change() => {}
                    }
                }
                None => self.wait_for_auto_lock_change().await,
            }
        }
    }

    /// Atomically lock only when the current deadline is still due. The
    /// recheck prevents a simultaneous activity signal from racing the timer.
    pub fn lock_if_auto_lock_due(&self) -> bool {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let due = !inner.locked
            && inner
                .auto_lock_timeout
                .is_some_and(|timeout| inner.last_activity.elapsed() >= timeout);
        if due {
            Self::lock_inner(&mut inner);
        }
        drop(inner);
        if due {
            self.signal_auto_lock_change();
        }
        due
    }

    /// Record foreground user activity. If the deadline already elapsed while
    /// the process was suspended, lock instead of reviving the expired vault.
    /// Returns true when this activity caused the overdue vault to lock.
    pub fn record_activity(&self) -> bool {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.locked {
            return false;
        }
        let auto_locked = inner
            .auto_lock_timeout
            .is_some_and(|timeout| inner.last_activity.elapsed() >= timeout);
        if auto_locked {
            Self::lock_inner(&mut inner);
        } else {
            inner.last_activity = Instant::now();
        }
        drop(inner);
        self.signal_auto_lock_change();
        auto_locked
    }
}
