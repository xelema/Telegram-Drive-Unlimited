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
