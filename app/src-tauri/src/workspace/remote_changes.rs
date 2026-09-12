//! Update only the initiating account's cache after a verified remote mutation.
//! Unowned legacy encryption/inventory rows are never reassigned or erased.
use super::{
    store::{file_key, Store},
    AccountGuard,
};

pub enum Change {
    Rename {
        folder: Option<i64>,
        message: i32,
        name: String,
    },
    Delete {
        folder: Option<i64>,
        message: i32,
    },
    Move {
        source: Option<i64>,
        message: i32,
        target: Option<i64>,
        new_message: i32,
    },
}

fn apply(account: &AccountGuard, changes: Vec<Change>) -> Result<(), String> {
    account.validate()?;
    let store = Store::open(&account.root, account.owner)?;
    store.transaction(|| {
        for change in changes {
            account.validate()?;
            match change {
                Change::Rename {
                    folder,
                    message,
                    name,
                } => {
                    if let Some(mut file) = store.file(&file_key(folder, i64::from(message)))? {
                        file.file.name = name;
                        store.remember_local_file(&file.file)?;
                    }
                }
                Change::Delete { folder, message } => {
                    let key = file_key(folder, i64::from(message));
                    store.execute(
                        "DELETE FROM workspace_files WHERE key=?",
                        &[key.clone().into()],
                    )?;
                    store.remove_record("envelope-v1", &key)?;
                }
                Change::Move {
                    source,
                    message,
                    target,
                    new_message,
                } => {
                    let old_key = file_key(source, i64::from(message));
                    let new_key = file_key(target, i64::from(new_message));
                    if let Some(mut file) = store.file(&old_key)? {
                        file.file.folder_id = target;
                        file.file.id = i64::from(new_message);
                        store.remember_local_file(&file.file)?;
                        for table in ["workspace_tags", "workspace_membership"] {
                            store.execute(
                                &format!("UPDATE OR IGNORE {table} SET file=? WHERE file=?"),
                                &[new_key.clone().into(), old_key.clone().into()],
                            )?;
                        }
                        for kind in ["favorite", "pin", "activity"] {
                            if let Some(value) =
                                store.record::<serde_json::Value>(kind, &old_key)?
                            {
                                store.put_record(kind, &new_key, &value)?;
                            }
                        }
                    }
                    store.execute("DELETE FROM workspace_files WHERE key=?", &[old_key.into()])?;
                    store.remove_record("envelope-v1", &file_key(source, i64::from(message)))?;
                }
            }
        }
        account.validate()
    })
}

pub async fn record(account: &AccountGuard, changes: Vec<Change>) -> Result<(), String> {
    let account = account.clone();
    tokio::task::spawn_blocking(move || apply(&account, changes))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::FileMetadata;
    use grammers_session::{storages::SqliteSession, types::PeerInfo, Session};
    struct Fixture {
        root: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("file-mutation-owner-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let fixture = Self { root };
            fixture.sign_in(101);
            for owner in [101, 202] {
                Store::open(&fixture.root, owner)
                    .unwrap()
                    .remember_local_file(&FileMetadata {
                        id: 42,
                        folder_id: None,
                        name: format!("private-{owner}.txt"),
                        size: 10,
                        mime_type: Some("text/plain".into()),
                        file_ext: Some("txt".into()),
                        created_at: "date".into(),
                        icon_type: "file".into(),
                        encryption_state: "plain".into(),
                        is_favorite: false,
                        is_pinned: false,
                    })
                    .unwrap();
            }
            fixture
        }
        fn sign_in(&self, owner: i64) {
            for name in [
                "telegram.session",
                "telegram.session-wal",
                "telegram.session-shm",
            ] {
                let _ = std::fs::remove_file(self.root.join(name));
            }
            let session = SqliteSession::open(self.root.join("telegram.session")).unwrap();
            session.cache_peer(&PeerInfo::User {
                id: owner,
                auth: None,
                bot: Some(false),
                is_self: Some(true),
            });
        }
        fn account(&self) -> AccountGuard {
            AccountGuard::open(&self.root, Some("101")).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn file_cache_rename_move_and_delete_never_touch_another_account() {
        let fixture = Fixture::new();
        let account = fixture.account();
        let a = Store::open(&fixture.root, 101).unwrap();
        a.tag(&["saved:42".into()], "keep-tag", true).unwrap();
        a.put_record("favorite", "saved:42", &true).unwrap();
        a.put_record(
            "envelope-v1",
            "saved:42",
            &serde_json::json!({"test":"bound to the original message"}),
        )
        .unwrap();
        apply(
            &account,
            vec![Change::Rename {
                folder: None,
                message: 42,
                name: "renamed.txt".into(),
            }],
        )
        .unwrap();
        assert_eq!(
            a.file("saved:42").unwrap().unwrap().file.name,
            "renamed.txt"
        );
        apply(
            &account,
            vec![Change::Move {
                source: None,
                message: 42,
                target: Some(9),
                new_message: 84,
            }],
        )
        .unwrap();
        assert!(a.file("saved:42").unwrap().is_none());
        assert!(a
            .record::<serde_json::Value>("envelope-v1", "saved:42")
            .unwrap()
            .is_none());
        let moved = a.file("9:84").unwrap().unwrap();
        assert_eq!(moved.file.name, "renamed.txt");
        assert!(moved.file.is_favorite);
        assert_eq!(moved.tags, ["keep-tag"]);
        apply(
            &account,
            vec![Change::Delete {
                folder: Some(9),
                message: 84,
            }],
        )
        .unwrap();
        assert!(a.file("9:84").unwrap().is_none());
        let b = Store::open(&fixture.root, 202).unwrap();
        assert_eq!(
            b.file("saved:42").unwrap().unwrap().file.name,
            "private-202.txt"
        );
    }
    #[test]
    fn file_cache_update_after_account_switch_preserves_both_owners() {
        let fixture = Fixture::new();
        let account = fixture.account();
        fixture.sign_in(202);
        assert!(apply(
            &account,
            vec![Change::Delete {
                folder: None,
                message: 42
            }]
        )
        .unwrap_err()
        .contains("ACCOUNT_CHANGED"));
        for owner in [101, 202] {
            assert!(Store::open(&fixture.root, owner)
                .unwrap()
                .file("saved:42")
                .unwrap()
                .is_some());
        }
    }
    #[test]
    fn failed_file_cache_move_rolls_back_the_original_metadata() {
        let fixture = Fixture::new();
        let account = fixture.account();
        let a = Store::open(&fixture.root, 101).unwrap();
        a.execute("CREATE TRIGGER fail_move BEFORE INSERT ON workspace_files WHEN NEW.key='9:84' BEGIN SELECT RAISE(FAIL,'disk unavailable'); END", &[]).unwrap();
        assert!(apply(
            &account,
            vec![Change::Move {
                source: None,
                message: 42,
                target: Some(9),
                new_message: 84
            }]
        )
        .is_err());
        assert!(a.file("saved:42").unwrap().is_some());
        assert!(a.file("9:84").unwrap().is_none());
    }
}
