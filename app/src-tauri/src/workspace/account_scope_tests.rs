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
