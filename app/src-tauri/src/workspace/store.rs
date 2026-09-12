use crate::models::FileMetadata;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sqlite::{Connection, State, Value};
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, String>;

pub fn file_key(folder: Option<i64>, message: i64) -> String {
    format!(
        "{}:{message}",
        folder
            .map(|id| id.to_string())
            .unwrap_or_else(|| "saved".into())
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    #[serde(default)]
    pub cover_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearch {
    pub id: String,
    pub name: String,
    pub query: String,
    pub filters: serde_json::Value,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub folder_key: Option<String>,
    #[serde(default)]
    pub collection_id: Option<String>,
    #[serde(default)]
    pub favorites_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    #[serde(flatten)]
    pub file: FileMetadata,
    pub key: String,
    pub folder_name: String,
    pub tags: Vec<String>,
    pub collection_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub owner_id: String,
    pub files: Vec<WorkspaceFile>,
    pub collections: Vec<Collection>,
    pub searches: Vec<SavedSearch>,
    pub scans: Vec<serde_json::Value>,
}

/// A database per verified Telegram account. Additional feature modules use
/// typed records in the same transaction-capable store, not browser storage.
pub struct Store {
    pub db: Connection,
    pub root: PathBuf,
    pub owner: i64,
}
impl Store {
    pub fn open(data: &Path, owner: i64) -> Result<Self> {
        if owner <= 0 {
            return Err("ACCOUNT_REQUIRED".into());
        }
        let root = data.join("workspace").join(owner.to_string());
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let mut db = sqlite::open(root.join("workspace.db")).map_err(|e| e.to_string())?;
        db.set_busy_timeout(5000).map_err(|e| e.to_string())?;
        db.execute(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS workspace_files (
              key TEXT PRIMARY KEY, folder TEXT NOT NULL, metadata TEXT NOT NULL,
              folder_name TEXT NOT NULL, scan TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS workspace_records (
              kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
              updated INTEGER NOT NULL, PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS workspace_membership (
              collection TEXT NOT NULL, file TEXT NOT NULL, PRIMARY KEY(collection,file));
            CREATE TABLE IF NOT EXISTS workspace_tags (
              file TEXT NOT NULL, tag TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(file,tag));
            PRAGMA user_version=1;",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { db, root, owner })
    }
    pub fn execute(&self, sql: &str, args: &[Value]) -> Result<()> {
        let mut statement = self.db.prepare(sql).map_err(|e| e.to_string())?;
        statement.bind(args).map_err(|e| e.to_string())?;
        statement.next().map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn transaction<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        self.db
            .execute("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        match action() {
            Ok(value) => {
                self.db.execute("COMMIT").map_err(|e| e.to_string())?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.execute("ROLLBACK");
                Err(error)
            }
        }
    }
    pub fn record<T: DeserializeOwned>(&self, kind: &str, id: &str) -> Result<Option<T>> {
        let mut s = self
            .db
            .prepare("SELECT value FROM workspace_records WHERE kind=? AND id=?")
            .map_err(|e| e.to_string())?;
        s.bind(&[Value::String(kind.into()), Value::String(id.into())][..])
            .map_err(|e| e.to_string())?;
        if s.next().map_err(|e| e.to_string())? == State::Row {
            serde_json::from_str(&s.read::<String, _>(0).map_err(|e| e.to_string())?)
                .map(Some)
                .map_err(|e| e.to_string())
        } else {
            Ok(None)
        }
    }
    pub fn records<T: DeserializeOwned>(&self, kind: &str) -> Result<Vec<T>> {
        let mut s = self
            .db
            .prepare("SELECT value FROM workspace_records WHERE kind=? ORDER BY updated DESC,id")
            .map_err(|e| e.to_string())?;
        s.bind((1, kind)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while s.next().map_err(|e| e.to_string())? == State::Row {
            out.push(
                serde_json::from_str(&s.read::<String, _>(0).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
        Ok(out)
    }
    pub fn put_record<T: Serialize>(&self, kind: &str, id: &str, value: &T) -> Result<()> {
        if id.is_empty() || id.len() > 256 {
            return Err("Invalid record identifier".into());
        }
        self.execute("INSERT INTO workspace_records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,updated=excluded.updated",
            &[kind.into(), id.into(), serde_json::to_string(value).map_err(|e| e.to_string())?.into(), chrono::Utc::now().timestamp_millis().into()])
    }
    pub fn remove_record(&self, kind: &str, id: &str) -> Result<()> {
        self.execute(
            "DELETE FROM workspace_records WHERE kind=? AND id=?",
            &[kind.into(), id.into()],
        )
    }
    pub fn remember_files(
        &self,
        files: &[FileMetadata],
        folder_name: &str,
        scan: &str,
    ) -> Result<()> {
        self.transaction(|| {
            for original in files {
                if original.id <= 0 { return Err("Invalid message identifier".into()); }
                let mut file = original.clone();
                // A metadata-protected filename must not become a persistent
                // plaintext tag/gallery index after the vault is locked.
                if file.encryption_state != "plain" {
                    file.name = "Protected file".into();
                    file.mime_type = Some("application/octet-stream".into());
                    file.file_ext = None;
                    file.encryption_state = "encrypted_locked".into();
                }
                self.execute("INSERT INTO workspace_files VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET metadata=excluded.metadata,folder_name=excluded.folder_name,scan=excluded.scan",
                    &[file_key(file.folder_id, file.id).into(), file.folder_id.map(|id| id.to_string()).unwrap_or_else(|| "saved".into()).into(), serde_json::to_string(&file).map_err(|e| e.to_string())?.into(), folder_name.into(), scan.into()])?;
            }
            Ok(())
        })
    }
    pub fn complete_scan(&self, folder: Option<i64>, scan: &str) -> Result<()> {
        self.execute(
            "DELETE FROM workspace_files WHERE folder=? AND scan<>?",
            &[
                folder
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "saved".into())
                    .into(),
                scan.into(),
            ],
        )
    }
    /// A user action may refresh metadata without taking the file out of an
    /// in-progress inventory generation. Protected names remain transient.
    pub fn remember_local_file(&self, original: &FileMetadata) -> Result<()> {
        if original.id <= 0 {
            return Err("Invalid message identifier".into());
        }
        let key = file_key(original.folder_id, original.id);
        let mut file = original.clone();
        if let Some(previous) = self.file(&key)? {
            file.is_favorite = previous.file.is_favorite;
            file.is_pinned = previous.file.is_pinned;
            if file.created_at.is_empty() {
                file.created_at = previous.file.created_at;
            }
        }
        if file.encryption_state != "plain" {
            file.name = "Protected file".into();
            file.mime_type = Some("application/octet-stream".into());
            file.file_ext = None;
            file.encryption_state = "encrypted_locked".into();
        }
        let folder = file
            .folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "saved".into());
        let folder_name = file
            .folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "Saved Messages".into());
        self.execute("INSERT INTO workspace_files VALUES(?,?,?,?,'activity') ON CONFLICT(key) DO UPDATE SET metadata=excluded.metadata",
            &[key.into(), folder.into(), serde_json::to_string(&file).map_err(|e| e.to_string())?.into(), folder_name.into()])
    }
    fn strings(&self, sql: &str, key: &str) -> Result<Vec<String>> {
        let mut s = self.db.prepare(sql).map_err(|e| e.to_string())?;
        s.bind((1, key)).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        while s.next().map_err(|e| e.to_string())? == State::Row {
            result.push(s.read(0).map_err(|e| e.to_string())?);
        }
        Ok(result)
    }
    fn string_groups(&self, sql: &str) -> Result<std::collections::HashMap<String, Vec<String>>> {
        let mut statement = self.db.prepare(sql).map_err(|e| e.to_string())?;
        let mut groups = std::collections::HashMap::<String, Vec<String>>::new();
        while statement.next().map_err(|e| e.to_string())? == State::Row {
            groups
                .entry(statement.read(0).map_err(|e| e.to_string())?)
                .or_default()
                .push(statement.read(1).map_err(|e| e.to_string())?);
        }
        Ok(groups)
    }
    /// Point lookup keeps each thumbnail request independent of library size.
    pub fn file(&self, key: &str) -> Result<Option<WorkspaceFile>> {
        let mut statement = self
            .db
            .prepare("SELECT metadata,folder_name FROM workspace_files WHERE key=?")
            .map_err(|e| e.to_string())?;
        statement.bind((1, key)).map_err(|e| e.to_string())?;
        if statement.next().map_err(|e| e.to_string())? != State::Row {
            return Ok(None);
        }
        let mut file: FileMetadata =
            serde_json::from_str(&statement.read::<String, _>(0).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        file.is_favorite = self
            .record::<bool>("favorite", key)?
            .unwrap_or(file.is_favorite);
        file.is_pinned = self.record::<bool>("pin", key)?.unwrap_or(file.is_pinned);
        Ok(Some(WorkspaceFile {
            file,
            key: key.into(),
            folder_name: statement.read(1).map_err(|e| e.to_string())?,
            tags: self.strings(
                "SELECT tag FROM workspace_tags WHERE file=? ORDER BY tag",
                key,
            )?,
            collection_ids: self.strings(
                "SELECT collection FROM workspace_membership WHERE file=? ORDER BY collection",
                key,
            )?,
        }))
    }
    pub fn folder_files(&self, folder: Option<i64>) -> Result<Vec<FileMetadata>> {
        let key = folder
            .map(|id| id.to_string())
            .unwrap_or_else(|| "saved".into());
        let mut statement = self
            .db
            .prepare(
                "SELECT f.metadata,r.value,p.value FROM workspace_files f
             LEFT JOIN workspace_records r ON r.kind='favorite' AND r.id=f.key
             LEFT JOIN workspace_records p ON p.kind='pin' AND p.id=f.key
             WHERE f.folder=? ORDER BY json_extract(f.metadata,'$.id') DESC",
            )
            .map_err(|e| e.to_string())?;
        statement
            .bind((1, key.as_str()))
            .map_err(|e| e.to_string())?;
        let mut files = Vec::new();
        while statement.next().map_err(|e| e.to_string())? == State::Row {
            let mut file: FileMetadata =
                serde_json::from_str(&statement.read::<String, _>(0).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if let Some(value) = statement
                .read::<Option<String>, _>(1)
                .map_err(|e| e.to_string())?
            {
                file.is_favorite = serde_json::from_str(&value).map_err(|e| e.to_string())?;
            }
            if let Some(value) = statement
                .read::<Option<String>, _>(2)
                .map_err(|e| e.to_string())?
            {
                file.is_pinned = serde_json::from_str(&value).map_err(|e| e.to_string())?;
            }
            files.push(file);
        }
        Ok(files)
    }
    pub fn files(&self) -> Result<Vec<WorkspaceFile>> {
        // Three queries per snapshot rather than three queries per file.
        let mut tags =
            self.string_groups("SELECT file,tag FROM workspace_tags ORDER BY file,tag")?;
        let mut memberships = self.string_groups(
            "SELECT file,collection FROM workspace_membership ORDER BY file,collection",
        )?;
        let mut s = self.db.prepare("SELECT f.key,f.metadata,f.folder_name,r.value,p.value FROM workspace_files f LEFT JOIN workspace_records r ON r.kind='favorite' AND r.id=f.key LEFT JOIN workspace_records p ON p.kind='pin' AND p.id=f.key ORDER BY json_extract(f.metadata,'$.created_at') DESC,f.key").map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        while s.next().map_err(|e| e.to_string())? == State::Row {
            let key = s.read::<String, _>(0).map_err(|e| e.to_string())?;
            let mut file: FileMetadata =
                serde_json::from_str(&s.read::<String, _>(1).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if let Some(value) = s.read::<Option<String>, _>(3).map_err(|e| e.to_string())? {
                file.is_favorite = serde_json::from_str(&value).map_err(|e| e.to_string())?;
            }
            if let Some(value) = s.read::<Option<String>, _>(4).map_err(|e| e.to_string())? {
                file.is_pinned = serde_json::from_str(&value).map_err(|e| e.to_string())?;
            }
            result.push(WorkspaceFile {
                file,
                tags: tags.remove(&key).unwrap_or_default(),
                collection_ids: memberships.remove(&key).unwrap_or_default(),
                key,
                folder_name: s.read(2).map_err(|e| e.to_string())?,
            });
        }
        Ok(result)
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let removals = self.records::<serde_json::Value>("removal")?;
        let hidden: std::collections::HashSet<_> = removals
            .iter()
            .filter(|value| {
                matches!(
                    value.get("status").and_then(|v| v.as_str()),
                    Some("pending" | "deleting" | "deleted")
                )
            })
            .filter_map(|value| value.get("key").and_then(|v| v.as_str()))
            .collect();
        let files = self
            .files()?
            .into_iter()
            .filter(|file| !hidden.contains(file.key.as_str()))
            .collect();
        Ok(Snapshot {
            owner_id: self.owner.to_string(),
            files,
            collections: self.records("collection")?,
            searches: self.records("search")?,
            scans: self.records("scan")?,
        })
    }
    pub fn save_collection(&self, value: &Collection) -> Result<()> {
        if value.name.trim().is_empty() || value.name.len() > 120 {
            return Err("Collection name must contain 1–120 characters".into());
        }
        if !["blue", "green", "amber", "rose", "violet", "slate"].contains(&value.color.as_str())
            || !["folder", "heart", "plane", "briefcase", "film", "book"]
                .contains(&value.icon.as_str())
        {
            return Err("Choose a collection color and icon".into());
        }
        self.put_record("collection", &value.id, value)
    }
    pub fn remove_collection(&self, id: &str) -> Result<()> {
        self.transaction(|| {
            self.remove_record("collection", id)?;
            self.execute(
                "DELETE FROM workspace_membership WHERE collection=?",
                &[id.into()],
            )
        })
    }
    pub fn assign(&self, keys: &[String], collection: &str, add: bool) -> Result<()> {
        if self
            .record::<Collection>("collection", collection)?
            .is_none()
        {
            return Err("Collection no longer exists".into());
        }
        self.transaction(|| {
            for key in keys {
                self.execute(
                    if add {
                        "INSERT OR IGNORE INTO workspace_membership VALUES(?,?)"
                    } else {
                        "DELETE FROM workspace_membership WHERE collection=? AND file=?"
                    },
                    &[collection.into(), key.clone().into()],
                )?;
            }
            Ok(())
        })
    }
    pub fn tag(&self, keys: &[String], tag: &str, add: bool) -> Result<()> {
        let tag = tag.trim();
        if tag.is_empty() || tag.chars().count() > 40 {
            return Err("Tags must contain 1–40 characters".into());
        }
        self.transaction(|| {
            for key in keys {
                self.execute(
                    if add {
                        "INSERT OR IGNORE INTO workspace_tags VALUES(?,?)"
                    } else {
                        "DELETE FROM workspace_tags WHERE file=? AND tag=?"
                    },
                    &[key.clone().into(), tag.into()],
                )?;
            }
            Ok(())
        })
    }
    pub fn save_search(&self, value: &SavedSearch) -> Result<()> {
        if value.name.trim().is_empty() || value.name.len() > 120 || value.query.len() > 500 {
            return Err("Invalid saved search".into());
        }
        if value
            .folder_key
            .as_ref()
            .is_some_and(|key| key != "saved" && !key.parse::<i64>().is_ok_and(|id| id > 0))
        {
            return Err("Invalid saved-search folder".into());
        }
        if value.tags.len() > 100
            || value
                .tags
                .iter()
                .any(|tag| tag.trim().is_empty() || tag.chars().count() > 40)
        {
            return Err("Invalid saved-search tags".into());
        }
        if value
            .collection_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256)
        {
            return Err("Invalid saved-search collection".into());
        }
        for (field, options) in [
            ("scope", &["folder", "all"][..]),
            (
                "type",
                &[
                    "all", "image", "video", "audio", "document", "archive", "other",
                ][..],
            ),
            ("size", &["any", "small", "medium", "large"][..]),
            ("date", &["any", "7d", "30d", "1y"][..]),
        ] {
            if !value
                .filters
                .get(field)
                .and_then(|v| v.as_str())
                .is_some_and(|v| options.contains(&v))
            {
                return Err(format!("Invalid search {field}"));
            }
        }
        self.put_record("search", &value.id, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let p = std::env::temp_dir().join(format!("workspace-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    fn file(id: i64, folder: Option<i64>) -> FileMetadata {
        FileMetadata {
            id,
            folder_id: folder,
            name: "Trip.jpg".into(),
            size: 12,
            mime_type: Some("image/jpeg".into()),
            file_ext: Some("jpg".into()),
            created_at: "2026-09-10T00:00:00Z".into(),
            icon_type: "image".into(),
            encryption_state: "plain".into(),
            is_favorite: false,
            is_pinned: false,
        }
    }
    #[test]
    fn saved_search_rules_survive_reopen_and_legacy_defaults_are_safe() {
        let root = root();
        let mut search: SavedSearch = serde_json::from_value(serde_json::json!({"id":"search", "name":"Trip photos", "query":"beach", "filters":{"scope":"all","type":"image","size":"small","date":"30d"}, "tags":["Beach", "Family"]})).unwrap();
        assert!(search.folder_key.is_none());
        assert!(search.collection_id.is_none());
        assert!(!search.favorites_only);
        search.folder_key = Some("saved".into());
        search.collection_id = Some("trip".into());
        search.favorites_only = true;
        {
            let store = Store::open(&root, 1).unwrap();
            store
                .save_collection(&Collection {
                    id: "trip".into(),
                    name: "Trip".into(),
                    color: "blue".into(),
                    icon: "plane".into(),
                    cover_key: None,
                })
                .unwrap();
            store.save_search(&search).unwrap();
        }
        let store = Store::open(&root, 1).unwrap();
        let saved = store.snapshot().unwrap().searches.remove(0);
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            serde_json::to_value(&search).unwrap()
        );
        assert!(Store::open(&root, 2)
            .unwrap()
            .snapshot()
            .unwrap()
            .searches
            .is_empty());
        search.folder_key = Some("0".into());
        assert!(store.save_search(&search).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn collections_tags_and_files_survive_reopen_and_remain_account_scoped() {
        let root = root();
        {
            let store = Store::open(&root, 1).unwrap();
            store
                .remember_files(&[file(42, None), file(42, Some(9))], "Trips", "scan")
                .unwrap();
            store
                .save_collection(&Collection {
                    id: "trip".into(),
                    name: "Trip".into(),
                    color: "blue".into(),
                    icon: "plane".into(),
                    cover_key: None,
                })
                .unwrap();
            store
                .assign(&["saved:42".into(), "9:42".into()], "trip", true)
                .unwrap();
            store.tag(&["saved:42".into()], "Beach", true).unwrap();
        }
        let store = Store::open(&root, 1).unwrap();
        let snap = store.snapshot().unwrap();
        assert_eq!(snap.files.len(), 2);
        assert!(snap.files.iter().all(|f| f.collection_ids == ["trip"]));
        assert_eq!(
            snap.files
                .iter()
                .find(|f| f.key == "saved:42")
                .unwrap()
                .tags,
            ["Beach"]
        );
        assert!(Store::open(&root, 2)
            .unwrap()
            .snapshot()
            .unwrap()
            .files
            .is_empty());
        store.remove_collection("trip").unwrap();
        assert_eq!(store.files().unwrap().len(), 2);
        assert!(store
            .files()
            .unwrap()
            .iter()
            .all(|f| f.collection_ids.is_empty()));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn completed_scan_prunes_missing_files_but_preserves_membership_for_restoration() {
        let root = root();
        let store = Store::open(&root, 1).unwrap();
        store
            .remember_files(&[file(1, None), file(2, None)], "Saved", "a")
            .unwrap();
        store
            .remember_files(&[file(2, None)], "Saved", "b")
            .unwrap();
        assert_eq!(store.files().unwrap().len(), 2);
        store.complete_scan(None, "b").unwrap();
        assert_eq!(store.files().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn protected_metadata_is_not_persisted_as_cleartext_in_gallery() {
        let root = root();
        let store = Store::open(&root, 1).unwrap();
        let mut file = file(1, None);
        file.encryption_state = "encrypted_unlocked".into();
        file.name = "private-receipt.pdf".into();
        store.remember_files(&[file], "Saved", "a").unwrap();
        let saved = store.files().unwrap().remove(0);
        assert_eq!(saved.file.name, "Protected file");
        assert_eq!(saved.file.encryption_state, "encrypted_locked");
        std::fs::remove_dir_all(root).unwrap();
    }
}
