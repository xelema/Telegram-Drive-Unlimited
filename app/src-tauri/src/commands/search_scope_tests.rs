use super::{search_source_folder, validate_search_client};
use crate::workspace::AccountGuard;
use grammers_session::{storages::SqliteSession, types::PeerInfo, Session};
use grammers_tl_types as tl;
use std::path::{Path, PathBuf};

struct SearchSession(PathBuf);
impl SearchSession {
    fn new(owner: i64) -> Self {
        let root = std::env::temp_dir().join(format!("search-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        sign_in(&root, owner);
        Self(root)
    }
}
impl Drop for SearchSession {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn sign_in(root: &Path, owner: i64) {
    for file in [
        "telegram.session",
        "telegram.session-wal",
        "telegram.session-shm",
    ] {
        let _ = std::fs::remove_file(root.join(file));
    }
    let session = SqliteSession::open(root.join("telegram.session")).unwrap();
    session.cache_peer(&PeerInfo::User {
        id: owner,
        auth: None,
        bot: Some(false),
        is_self: Some(true),
    });
}

#[test]
fn omitted_expected_owner_still_verifies_the_captured_client_and_session() {
    let session = SearchSession::new(101);
    let captured = AccountGuard::open(&session.0, None).unwrap();
    assert_eq!(captured.owner, 101);
    validate_search_client(&captured, 101).unwrap();
    assert!(validate_search_client(&captured, 202)
        .unwrap_err()
        .contains("ACCOUNT_CHANGED"));
    assert!(AccountGuard::open(&session.0, Some("202")).is_err());
}

#[test]
fn an_account_switch_while_search_awaits_rejects_the_old_results() {
    let session = SearchSession::new(101);
    let captured = AccountGuard::open(&session.0, Some("101")).unwrap();
    validate_search_client(&captured, 101).unwrap();
    sign_in(&session.0, 202);
    // Same captured client and query, but the saved account changed while the
    // remote request was pending. Final validation must reject the response.
    assert!(validate_search_client(&captured, 101)
        .unwrap_err()
        .contains("ACCOUNT_CHANGED"));
    let next = AccountGuard::open(&session.0, Some("202")).unwrap();
    validate_search_client(&next, 202).unwrap();
}

#[test]
fn only_the_captured_owners_saved_messages_map_to_the_explicit_null_source() {
    assert_eq!(
        search_source_folder(
            &tl::enums::Peer::User(tl::types::PeerUser { user_id: 101 }),
            101
        ),
        None
    );
    assert_eq!(
        search_source_folder(
            &tl::enums::Peer::User(tl::types::PeerUser { user_id: 202 }),
            101
        ),
        Some(202)
    );
    assert_eq!(
        search_source_folder(
            &tl::enums::Peer::Channel(tl::types::PeerChannel { channel_id: 101 }),
            101
        ),
        Some(101)
    );
    assert_eq!(
        search_source_folder(
            &tl::enums::Peer::Chat(tl::types::PeerChat { chat_id: 101 }),
            101
        ),
        Some(101)
    );
}
