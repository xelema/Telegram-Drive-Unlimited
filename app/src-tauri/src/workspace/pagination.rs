//! Bounded IPC pages from a consistent SQLite WAL read snapshot. No schema
//! migration or whole-library materialization is needed for the cursor.
use super::{AccountGuard, Store, WorkspacePage};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
struct State {
    store: Store,
    offset: usize,
}
struct Session {
    account: AccountGuard,
    created: Instant,
    touched: AtomicU64,
    state: Mutex<State>,
}
static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const IDLE_LIMIT: Duration = Duration::from_secs(30);
const AGE_LIMIT: Duration = Duration::from_secs(300);
const MAX_SESSIONS: usize = 8;
fn expired(session: &Session) -> bool {
    let age = session.created.elapsed();
    age >= AGE_LIMIT
        || age
            .as_millis()
            .saturating_sub(u128::from(session.touched.load(Ordering::Relaxed)))
            >= IDLE_LIMIT.as_millis()
}
fn expire() {
    let removed = if let Ok(mut sessions) = SESSIONS.lock() {
        let ids: Vec<_> = sessions
            .iter()
            .filter(|(_, session)| expired(session))
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| sessions.remove(&id))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    drop(removed); // read transaction rollback happens outside the registry lock
}
static CLEANER: LazyLock<Result<(), String>> = LazyLock::new(|| {
    std::thread::Builder::new()
        .name("workspace-page-expiry".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_secs(5));
            expire();
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
});
fn discard(id: &str) {
    let removed = SESSIONS
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(id));
    drop(removed);
}
pub(super) fn read(
    root: &Path,
    owner: &str,
    cursor: Option<String>,
    limit: usize,
) -> Result<WorkspacePage, String> {
    if !(1..=512).contains(&limit) {
        return Err("Invalid workspace page limit".into());
    }
    CLEANER.as_ref().map_err(Clone::clone)?;
    let account = AccountGuard::open(root, Some(owner))?;
    expire();
    let (id, session, expected_offset) = match cursor {
        Some(cursor) => {
            let (id, offset) = cursor
                .split_once(':')
                .ok_or("WORKSPACE_PAGE_INVALID: Reload the library")?;
            let id = id.to_string();
            let offset = offset
                .parse::<usize>()
                .map_err(|_| "WORKSPACE_PAGE_INVALID: Reload the library")?;
            let session = SESSIONS
                .lock()
                .map_err(|_| "Workspace pagination unavailable")?
                .get(&id)
                .cloned()
                .ok_or("WORKSPACE_PAGE_EXPIRED: Reload the library")?;
            if !session.account.same_session(&account) {
                discard(&id);
                return Err("ACCOUNT_CHANGED: Workspace page belongs to another session".into());
            }
            (id, session, offset)
        }
        None => {
            let store = Store::open(root, account.owner)?;
            account.validate()?;
            store
                .db
                .execute("BEGIN DEFERRED")
                .map_err(|error| error.to_string())?;
            let id = uuid::Uuid::new_v4().to_string();
            let session = Arc::new(Session {
                account: account.clone(),
                created: Instant::now(),
                touched: AtomicU64::new(0),
                state: Mutex::new(State { store, offset: 0 }),
            });
            let removed = {
                let mut sessions = SESSIONS
                    .lock()
                    .map_err(|_| "Workspace pagination unavailable")?;
                let removed = if sessions.len() >= MAX_SESSIONS {
                    let oldest = sessions
                        .iter()
                        .min_by_key(|(_, session)| session.created)
                        .map(|(id, _)| id.clone())
                        .unwrap();
                    sessions.remove(&oldest)
                } else {
                    None
                };
                sessions.insert(id.clone(), session.clone());
                removed
            };
            drop(removed);
            (id, session, 0)
        }
    };
    let result = (|| {
        let mut state = session
            .state
            .lock()
            .map_err(|_| "Workspace page unavailable")?;
        account.validate()?;
        if state.offset != expected_offset {
            return Err("WORKSPACE_PAGE_INVALID: Reload the library".into());
        }
        if expired(&session) {
            return Err("WORKSPACE_PAGE_EXPIRED: Reload the library".into());
        }
        let (snapshot, total_files) = state.store.snapshot_page(state.offset, limit)?;
        state.offset += snapshot.files.len();
        account.validate()?;
        session.touched.store(
            session.created.elapsed().as_millis() as u64,
            Ordering::Relaxed,
        );
        Ok(WorkspacePage {
            snapshot,
            next_cursor: (state.offset < total_files).then(|| format!("{id}:{}", state.offset)),
            total_files,
        })
    })();
    if result
        .as_ref()
        .map_or(true, |page| page.next_cursor.is_none())
    {
        discard(&id);
    }
    result
}
