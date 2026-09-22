use super::*;
use grammers_session::{storages::SqliteSession, types::PeerInfo, Session};

struct Fixture(PathBuf);
impl Fixture {
    fn new(owner: i64) -> Self {
        let fixture = Self(
            std::env::temp_dir().join(format!("sync-operation-account-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&fixture.0).unwrap();
        fixture.set_owner(owner);
        fixture
    }
    fn set_owner(&self, owner: i64) {
        let session = SqliteSession::open(self.0.join("telegram.session")).unwrap();
        // A new login replaces the session. Merely adding another self peer would
        // leave the first account as SQLite's self lookup and would not switch it.
        sqlite::open(self.0.join("telegram.session"))
            .unwrap()
            .execute("DELETE FROM peer_info")
            .unwrap();
        session.cache_peer(&PeerInfo::User {
            id: owner,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
        assert_eq!(crate::workspace::current_owner(&self.0).unwrap(), owner);
    }
    fn guard(&self) -> AccountGuard {
        AccountGuard::open(&self.0, None).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn sync_operation_waiting_for_client_cannot_adopt_a_new_account() {
    let fixture = Fixture::new(100);
    let account = fixture.guard();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, resumed) = tokio::sync::oneshot::channel();
    let side_effect = AtomicBool::new(false);
    let operation = with_operation_account(&account, async {
        entered.send(()).unwrap();
        resumed.await.unwrap();
        // This is the same scoped capture + actual-client identity check used by
        // unqueued sync upload/download and by delete/rename after cloning.
        let captured = operation_account()?.ok_or("Missing original sync owner")?;
        captured.validate_client_owner(200)?;
        side_effect.store(true, Ordering::SeqCst);
        Ok(())
    });
    let switch = async {
        started.await.unwrap();
        fixture.set_owner(200);
        release.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(operation, switch);
    assert!(result.unwrap_err().contains("ACCOUNT_CHANGED"));
    assert!(!side_effect.load(Ordering::SeqCst));
    assert!(operation_account().unwrap().is_none());
}

#[tokio::test]
async fn an_old_cloned_client_is_rejected_even_when_the_saved_account_is_current() {
    let fixture = Fixture::new(200);
    let account = fixture.guard();
    let result = with_operation_account(&account, async {
        tokio::task::yield_now().await;
        let captured = operation_account()?.ok_or("Missing sync owner")?;
        captured.validate_client_owner(100)
    })
    .await;
    assert!(result.unwrap_err().contains("another account"));
}

#[tokio::test]
async fn concurrent_scoped_operations_keep_their_own_owner_and_clear_afterwards() {
    let first = Fixture::new(100);
    let second = Fixture::new(200);
    let first_account = first.guard();
    let second_account = second.guard();
    let run = |expected| async move {
        tokio::task::yield_now().await;
        let captured = operation_account()?.ok_or("Missing sync owner")?;
        captured.validate_client_owner(expected)
    };
    let (first_result, second_result) = tokio::join!(
        with_operation_account(&first_account, run(100)),
        with_operation_account(&second_account, run(200)),
    );
    first_result.unwrap();
    second_result.unwrap();
    assert!(operation_account().unwrap().is_none());
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_session_reads {
    use super::*;
    use std::time::{Duration, Instant};

    fn isolated_login(
        fixture: &Fixture,
        lifecycle: &WorkspaceLifecycle,
    ) -> (Arc<SqliteSession>, HashMap<PathBuf, RegisteredSession>) {
        std::fs::remove_file(fixture.0.join("telegram.session")).unwrap();
        let session = Arc::new(SqliteSession::open(fixture.0.join("telegram.session")).unwrap());
        let sessions = HashMap::from([(
            fixture.0.clone(),
            RegisteredSession {
                session: Arc::downgrade(&session),
                identity: Some(session_file_identity(&fixture.0.join("telegram.session")).unwrap()),
                generation: lifecycle.generation.load(Ordering::SeqCst),
                ready: true,
            },
        )]);
        (session, sessions)
    }

    #[test]
    fn verified_fresh_login_persists_identity_before_resuming_a_suspended_workspace() {
        let fixture = Fixture::new(101);
        let lifecycle = WorkspaceLifecycle::default();
        lifecycle.suspend();
        let (session, sessions) = isolated_login(&fixture, &lifecycle);
        let captured = AuthenticationSession::capture_in(&sessions, &lifecycle, &session).unwrap();
        assert!(lifecycle.signing_out.load(Ordering::SeqCst));
        assert_eq!(
            read_session_identity(&fixture.0.join("telegram.session")).unwrap(),
            None
        );

        let verified_peer = PeerInfo::User {
            id: 202,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        };
        captured
            .complete_in(&sessions, &lifecycle, &verified_peer, None)
            .unwrap();
        assert!(!lifecycle.signing_out.load(Ordering::SeqCst));
        assert_eq!(
            read_session_identity(&fixture.0.join("telegram.session")).unwrap(),
            Some(202)
        );
        assert!(matches!(
            session.peer(PeerId::self_user()),
            Some(PeerInfo::User { id: 202, .. })
        ));
    }

    #[test]
    fn delayed_auth_reply_cannot_resume_or_overwrite_a_new_login_after_logout() {
        let fixture = Fixture::new(101);
        let lifecycle = WorkspaceLifecycle::default();
        let (old_session, old_sessions) = isolated_login(&fixture, &lifecycle);
        let old =
            AuthenticationSession::capture_in(&old_sessions, &lifecycle, &old_session).unwrap();
        lifecycle.suspend();
        let old_peer = PeerInfo::User {
            id: 101,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        };
        assert!(old
            .complete_in(&old_sessions, &lifecycle, &old_peer, None)
            .unwrap_err()
            .starts_with("ACCOUNT_CHANGED:"));
        assert!(lifecycle.signing_out.load(Ordering::SeqCst));
        assert!(old_session.peer(PeerId::self_user()).is_none());

        let replacement = Fixture::new(303);
        let (new_session, new_sessions) = isolated_login(&replacement, &lifecycle);
        let new =
            AuthenticationSession::capture_in(&new_sessions, &lifecycle, &new_session).unwrap();
        let new_peer = PeerInfo::User {
            id: 202,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        };
        new.complete_in(&new_sessions, &lifecycle, &new_peer, None)
            .unwrap();
        assert!(old
            .complete_in(&new_sessions, &lifecycle, &old_peer, None)
            .is_err());
        assert!(!lifecycle.signing_out.load(Ordering::SeqCst));
        assert_eq!(
            read_session_identity(&replacement.0.join("telegram.session")).unwrap(),
            Some(202)
        );
    }

    #[test]
    fn a_fresh_session_can_register_then_acquire_its_authenticated_identity() {
        let fixture = Fixture::new(101);
        std::fs::remove_file(fixture.0.join("telegram.session")).unwrap();
        let session = open_session(&fixture.0).unwrap();
        assert!(current_owner(&fixture.0)
            .unwrap_err()
            .starts_with("ACCOUNT_UNAVAILABLE:"));
        register_session(&fixture.0, &session).unwrap();
        assert!(current_owner(&fixture.0)
            .unwrap_err()
            .starts_with("ACCOUNT_REQUIRED:"));
        session.cache_peer(&PeerInfo::User {
            id: 101,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
        assert_eq!(current_owner(&fixture.0).unwrap(), 101);
        assert_eq!(
            Arc::strong_count(&session),
            1,
            "The registry must not retain a logged-out session"
        );
    }

    #[test]
    fn live_owner_reads_and_reconnect_share_the_telegram_writers_mutex() {
        let fixture = Fixture::new(101);
        let session = open_session(&fixture.0).unwrap();
        register_session(&fixture.0, &session).unwrap();
        let account = fixture.guard();
        let writer_session = session.clone();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let writer_barrier = barrier.clone();
        let writer = std::thread::spawn(move || {
            writer_barrier.wait();
            for id in 1_000..2_000 {
                writer_session.cache_peer(&PeerInfo::User {
                    id,
                    auth: None,
                    bot: Some(false),
                    is_self: Some(false),
                });
            }
        });
        barrier.wait();
        let mut failures = 0;
        for iteration in 0..1_000 {
            failures += usize::from(current_owner(&fixture.0) != Ok(101));
            failures += usize::from(account.validate().is_err());
            if iteration % 100 == 0 {
                let reconnected = open_session(&fixture.0).unwrap();
                assert!(Arc::ptr_eq(&session, &reconnected));
                register_session(&fixture.0, &reconnected).unwrap();
            }
        }
        writer
            .join()
            .expect("Telegram peer-cache writer must remain healthy");
        assert_eq!(
            failures, 0,
            "Ownership reads must not fail under normal peer-cache writes"
        );
        assert_eq!(current_owner(&fixture.0).unwrap(), 101);
    }

    #[cfg(unix)]
    #[test]
    fn replacement_between_open_and_registration_cannot_bind_the_old_connection_to_a_new_file() {
        let fixture = Fixture::new(101);
        let session = open_session(&fixture.0).unwrap();
        std::fs::rename(
            fixture.0.join("telegram.session"),
            fixture.0.join("retired.session"),
        )
        .unwrap();
        // Create the replacement through the library; do not register it yet.
        let replacement = SqliteSession::open(fixture.0.join("telegram.session")).unwrap();
        replacement.cache_peer(&PeerInfo::User {
            id: 202,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
        drop(replacement);
        assert!(register_session(&fixture.0, &session)
            .unwrap_err()
            .starts_with("ACCOUNT_CHANGED:"));
        assert!(current_owner(&fixture.0)
            .unwrap_err()
            .starts_with("ACCOUNT_CHANGED:"));
        let replacement = open_session(&fixture.0).unwrap();
        assert!(!Arc::ptr_eq(&session, &replacement));
        register_session(&fixture.0, &replacement).unwrap();
        assert_eq!(current_owner(&fixture.0).unwrap(), 202);
    }

    #[cfg(unix)]
    #[test]
    fn registered_owner_rejects_replaced_storage_and_does_not_keep_an_expired_session_alive() {
        let fixture = Fixture::new(101);
        let session = open_session(&fixture.0).unwrap();
        register_session(&fixture.0, &session).unwrap();
        let account = fixture.guard();
        std::fs::rename(
            fixture.0.join("telegram.session"),
            fixture.0.join("retired.session"),
        )
        .unwrap();
        let replacement = SqliteSession::open(fixture.0.join("telegram.session")).unwrap();
        replacement.cache_peer(&PeerInfo::User {
            id: 202,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
        drop(replacement);
        assert!(account
            .validate()
            .unwrap_err()
            .starts_with("ACCOUNT_CHANGED:"));
        drop(session);
        assert_eq!(current_owner(&fixture.0).unwrap(), 202);
        assert!(account
            .validate()
            .unwrap_err()
            .starts_with("ACCOUNT_CHANGED:"));
    }

    #[test]
    fn owner_lookup_waits_for_a_brief_telegram_writer_without_changing_the_session() {
        let fixture = Fixture::new(101);
        let path = fixture.0.join("telegram.session");
        let before = std::fs::read(&path).unwrap();
        let writer_path = path.clone();
        let (ready, acquired) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            let connection = sqlite::open(writer_path).unwrap();
            connection.execute("BEGIN EXCLUSIVE").unwrap();
            ready.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(60));
            connection.execute("ROLLBACK").unwrap();
        });
        acquired.recv().unwrap();
        assert_eq!(current_owner(&fixture.0).unwrap(), 101);
        writer.join().unwrap();
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[test]
    fn a_persistent_writer_lock_fails_closed_without_panicking_or_waiting_indefinitely() {
        let fixture = Fixture::new(101);
        let connection = sqlite::open(fixture.0.join("telegram.session")).unwrap();
        connection.execute("BEGIN EXCLUSIVE").unwrap();
        let started = Instant::now();
        let error = current_owner(&fixture.0).unwrap_err();
        assert!(error.starts_with("ACCOUNT_UNAVAILABLE:"));
        assert!(started.elapsed() < Duration::from_secs(2));
        connection.execute("ROLLBACK").unwrap();
        assert_eq!(current_owner(&fixture.0).unwrap(), 101);
    }

    #[test]
    fn an_account_change_committed_during_contention_invalidates_the_old_guard() {
        let fixture = Fixture::new(101);
        let account = fixture.guard();
        let path = fixture.0.join("telegram.session");
        let (ready, acquired) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            let connection = sqlite::open(path).unwrap();
            connection
                .execute("BEGIN EXCLUSIVE; UPDATE peer_info SET peer_id=202 WHERE subtype=1")
                .unwrap();
            ready.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(60));
            connection.execute("COMMIT").unwrap();
        });
        acquired.recv().unwrap();
        assert!(account
            .validate()
            .unwrap_err()
            .starts_with("ACCOUNT_CHANGED:"));
        writer.join().unwrap();
        assert_eq!(current_owner(&fixture.0).unwrap(), 202);
    }

    #[test]
    fn supported_session_self_identity_matches_the_pinned_library_for_users_and_bots() {
        for bot in [false, true] {
            let fixture = Fixture::new(101);
            let session = SqliteSession::open(fixture.0.join("telegram.session")).unwrap();
            session.cache_peer(&PeerInfo::User {
                id: 101,
                auth: None,
                bot: Some(bot),
                is_self: Some(true),
            });
            let Some(PeerInfo::User { id, .. }) = session.peer(PeerId::self_user()) else {
                panic!("Missing synthetic self peer");
            };
            assert_eq!(current_owner(&fixture.0).unwrap(), id);
        }
    }

    #[test]
    fn unsupported_or_ambiguous_identity_is_rejected_without_repairing_user_data() {
        for change in [
            "PRAGMA user_version=2",
            "PRAGMA user_version=0",
            "DROP TABLE peer_info",
            "DELETE FROM peer_info",
            "UPDATE peer_info SET peer_id=-101",
            "UPDATE peer_info SET peer_id=1099511627776",
            "UPDATE peer_info SET subtype=5",
            "INSERT INTO peer_info(peer_id,subtype) VALUES(202,1)",
        ] {
            let fixture = Fixture::new(101);
            let path = fixture.0.join("telegram.session");
            let connection = sqlite::open(&path).unwrap();
            connection.execute(change).unwrap();
            drop(connection);
            let before = std::fs::read(&path).unwrap();
            assert!(current_owner(&fixture.0).is_err(), "{change}");
            assert_eq!(std::fs::read(path).unwrap(), before, "{change}");
        }
        let fixture = Fixture::new(101);
        let path = fixture.0.join("telegram.session");
        std::fs::remove_file(&path).unwrap();
        assert!(current_owner(&fixture.0).is_err());
        assert!(!path.exists());
    }
}
