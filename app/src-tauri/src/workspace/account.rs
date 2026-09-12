use grammers_session::{
    storages::SqliteSession,
    types::{PeerId, PeerInfo},
    Session,
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

static SIGNING_OUT: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);

tokio::task_local! {
    static OPERATION_ACCOUNT: AccountGuard;
}

pub(crate) fn operation_account() -> Result<Option<AccountGuard>, String> {
    let account = OPERATION_ACCOUNT.try_with(Clone::clone).ok();
    if let Some(account) = &account {
        account.validate()?;
    }
    Ok(account)
}

/// Preserve the original owner and epoch across each awaited sync operation.
pub(crate) async fn with_operation_account<T>(
    account: &AccountGuard,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    account.validate()?;
    let result = OPERATION_ACCOUNT.scope(account.clone(), operation).await;
    if result.is_ok() {
        account.validate()?;
    }
    result
}

pub fn suspend() {
    SIGNING_OUT.store(true, Ordering::SeqCst);
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

pub fn resume() {
    SIGNING_OUT.store(false, Ordering::SeqCst);
}

/// The saved session's authenticated self peer is available offline. Never
/// infer ownership from a folder number, API ID, or an unscoped legacy cache.
pub fn current_owner(root: &Path) -> Result<i64, String> {
    if SIGNING_OUT.load(Ordering::SeqCst) {
        return Err("ACCOUNT_CHANGED: Sign in again to open this workspace".into());
    }
    let path = root.join("telegram.session");
    if !path.is_file() {
        return Err("ACCOUNT_REQUIRED: Sign in to open your workspace".into());
    }
    let session = SqliteSession::open(path)
        .map_err(|_| "ACCOUNT_UNAVAILABLE: The saved account is temporarily unavailable")?;
    match session.peer(PeerId::self_user()) {
        Some(PeerInfo::User {
            id,
            is_self: Some(true),
            ..
        }) if id > 0 => Ok(id),
        _ => Err("ACCOUNT_REQUIRED: Sign in to open your workspace".into()),
    }
}

#[derive(Clone)]
pub struct AccountGuard {
    pub root: PathBuf,
    pub owner: i64,
    generation: u64,
}

impl AccountGuard {
    pub fn open(root: &Path, expected: Option<&str>) -> Result<Self, String> {
        let generation = GENERATION.load(Ordering::SeqCst);
        let owner = current_owner(root)?;
        if generation != GENERATION.load(Ordering::SeqCst)
            || expected.is_some_and(|id| id != owner.to_string())
        {
            return Err("ACCOUNT_CHANGED: Reopen your workspace for the current account".into());
        }
        Ok(Self {
            root: root.into(),
            owner,
            generation,
        })
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.generation != GENERATION.load(Ordering::SeqCst)
            || current_owner(&self.root)? != self.owner
        {
            Err("ACCOUNT_CHANGED: This operation belongs to a different session".into())
        } else {
            Ok(())
        }
    }

    /// The persisted session and in-memory client can change at different awaits.
    /// Verify the actual connected client once at the start of a remote read.
    pub async fn validate_client(&self, client: &grammers_client::Client) -> Result<(), String> {
        self.validate()?;
        let user = client.get_me().await.map_err(|e| e.to_string())?;
        self.validate_client_owner(user.bare_id())
    }

    fn validate_client_owner(&self, owner: i64) -> Result<(), String> {
        if owner != self.owner {
            return Err("ACCOUNT_CHANGED: Connected client belongs to another account".into());
        }
        self.validate()
    }
}

#[cfg(test)]
#[path = "account_scope_tests.rs"]
mod account_scope_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_read_rejects_a_stale_client_and_a_changed_saved_session() {
        let root = std::env::temp_dir().join(format!("workspace-client-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let session = SqliteSession::open(root.join("telegram.session")).unwrap();
        session.cache_peer(&PeerInfo::User {
            id: 101,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
        let account = AccountGuard::open(&root, Some("101")).unwrap();
        assert!(account
            .validate_client_owner(202)
            .unwrap_err()
            .contains("ACCOUNT_CHANGED"));
        assert!(account.validate_client_owner(101).is_ok());
        drop(session);
        for name in [
            "telegram.session",
            "telegram.session-wal",
            "telegram.session-shm",
        ] {
            let _ = std::fs::remove_file(root.join(name));
        }
        let session = SqliteSession::open(root.join("telegram.session")).unwrap();
        session.cache_peer(&PeerInfo::User {
            id: 202,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
        assert!(account.validate_client_owner(101).is_err());
        drop(session);
        std::fs::remove_dir_all(root).unwrap();
    }
}
