use sha2::{Digest, Sha256};
use sqlite::{Connection, State};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const APPLICATION_SCHEMA_VERSION: i64 = 2;
const BASELINE_SCHEMA_VERSION: i64 = 1;
const ENCRYPTION_SCHEMA_VERSION: i64 = 3;
const BASELINE_NAME: &str = "baseline_known_schema";
const BASELINE_DEFINITION: &str =
    "1:baseline_known_schema:app_schema_migrations(version,name,checksum,applied_at,app_version)";
const SYNC_MIGRATION_NAME: &str = "telegram_folder_sync";
const SYNC_MIGRATION_DEFINITION: &str = "2:telegram_folder_sync:sync_settings(key,value);sync_pairs(id,local_path,channel_id,folder_key,label,sync_direction,is_active,created_at);sync_state(id,pair_id,relative_path,local_hash,remote_hash,file_size,local_mtime,remote_date,message_id,sync_status);sync_log(id,pair_id,action,relative_path,detail,created_at)";

const MIGRATION_LEDGER_SQL: &str = "CREATE TABLE app_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        app_version TEXT NOT NULL
    )";

const KNOWN_TABLES: &[&str] = &[
    "app_schema_migrations",
    "encrypted_files",
    "encryption_profiles",
    "file_activity",
    "folder_metadata",
    "groups",
    "schema_version",
    "shared_links",
    "sync_log",
    "sync_pairs",
    "sync_settings",
    "sync_state",
];

const SHARED_LINK_COLUMNS: &[&str] = &[
    "id",
    "folder_id",
    "message_id",
    "file_name",
    "file_size",
    "password_hash",
    "password_salt",
    "expires_at",
    "revoked",
    "created_at",
];
const GROUP_COLUMNS: &[&str] = &["id", "name", "color_hex", "display_order"];
const FOLDER_METADATA_COLUMNS: &[&str] = &[
    "channel_id",
    "name",
    "username",
    "is_public",
    "display_order",
    "group_id",
];
const FILE_ACTIVITY_COLUMNS: &[&str] = &[
    "folder_key",
    "folder_id",
    "message_id",
    "file_name",
    "file_size",
    "mime_type",
    "file_ext",
    "created_at",
    "encryption_state",
    "last_opened_at",
    "open_count",
    "is_favorite",
    "is_pinned",
];
const ENCRYPTED_FILE_BASE_COLUMNS: &[&str] = &[
    "folder_key",
    "message_id",
    "file_uuid",
    "envelope_version",
    "cipher_suite",
    "ciphertext_size",
    "remote_name",
    "key_profile_id",
    "header_blob",
    "header_sha256",
    "record_state",
    "created_at",
    "last_verified_at",
];
const ENCRYPTION_PROFILE_COLUMNS: &[&str] = &[
    "id",
    "label",
    "kind",
    "vault_locator",
    "created_at",
    "updated_at",
    "is_deleted",
];
const ENCRYPTION_VERSION_COLUMNS: &[&str] = &["version", "applied_at"];
const MIGRATION_LEDGER_COLUMNS: &[&str] =
    &["version", "name", "checksum", "applied_at", "app_version"];
const SYNC_SETTING_COLUMNS: &[&str] = &["key", "value"];
const SYNC_PAIR_COLUMNS: &[&str] = &[
    "id", "local_path", "channel_id", "folder_key", "label", "sync_direction",
    "is_active", "created_at",
];
const SYNC_STATE_COLUMNS: &[&str] = &[
    "id", "pair_id", "relative_path", "local_hash", "remote_hash", "file_size",
    "local_mtime", "remote_date", "message_id", "sync_status",
];
const SYNC_LOG_COLUMNS: &[&str] = &[
    "id", "pair_id", "action", "relative_path", "detail", "created_at",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaLayout {
    Empty,
    SharingOnly,
    FolderMetadata,
    EncryptionRegistry,
    FileActivity,
    Current,
}

impl SchemaLayout {
    pub fn label(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::SharingOnly => "sharing-only",
            Self::FolderMetadata => "folder-metadata",
            Self::EncryptionRegistry => "encryption-registry",
            Self::FileActivity => "file-activity",
            Self::Current => "current-managed",
        }
    }
}

pub fn inspect_schema(conn: &Connection) -> Result<SchemaLayout, String> {
    quick_check(conn)?;

    let tables = table_names(conn)?;
    let unknown_tables: Vec<_> = tables
        .iter()
        .filter(|name| !KNOWN_TABLES.contains(&name.as_str()))
        .cloned()
        .collect();
    if !unknown_tables.is_empty() {
        return Err(format!(
            "Database contains tables from an unknown schema: {}. No changes were made.",
            unknown_tables.join(", ")
        ));
    }

    if tables.is_empty() {
        return Ok(SchemaLayout::Empty);
    }

    require_table(&tables, "shared_links")?;
    validate_columns(conn, "shared_links", SHARED_LINK_COLUMNS)?;

    let has_groups = tables.contains("groups");
    let has_folder_metadata = tables.contains("folder_metadata");
    if has_groups != has_folder_metadata {
        return Err(
            "Database has a partial folder-metadata schema. No changes were made.".to_string(),
        );
    }
    if has_groups {
        validate_columns(conn, "groups", GROUP_COLUMNS)?;
        validate_columns(conn, "folder_metadata", FOLDER_METADATA_COLUMNS)?;
    }

    let encryption_presence = [
        tables.contains("encrypted_files"),
        tables.contains("encryption_profiles"),
        tables.contains("schema_version"),
    ];
    let has_encryption = encryption_presence.iter().all(|present| *present);
    if !has_encryption && encryption_presence.iter().any(|present| *present) {
        return Err(
            "Database has a partial encryption registry. No changes were made.".to_string(),
        );
    }
    if has_encryption {
        validate_columns(conn, "encrypted_files", ENCRYPTED_FILE_BASE_COLUMNS)?;
        validate_columns(conn, "encryption_profiles", ENCRYPTION_PROFILE_COLUMNS)?;
        validate_columns(conn, "schema_version", ENCRYPTION_VERSION_COLUMNS)?;
        reject_newer_version(
            conn,
            "schema_version",
            ENCRYPTION_SCHEMA_VERSION,
            "encryption",
        )?;
    }

    let has_file_activity = tables.contains("file_activity");
    if has_file_activity {
        validate_columns(conn, "file_activity", FILE_ACTIVITY_COLUMNS)?;
    }

    let sync_presence = [
        tables.contains("sync_settings"),
        tables.contains("sync_pairs"),
        tables.contains("sync_state"),
        tables.contains("sync_log"),
    ];
    let has_sync = sync_presence.iter().all(|present| *present);
    if !has_sync && sync_presence.iter().any(|present| *present) {
        return Err("Database has a partial folder-sync schema. No changes were made.".to_string());
    }
    if has_sync {
        validate_columns(conn, "sync_settings", SYNC_SETTING_COLUMNS)?;
        validate_columns(conn, "sync_pairs", SYNC_PAIR_COLUMNS)?;
        validate_columns(conn, "sync_state", SYNC_STATE_COLUMNS)?;
        validate_columns(conn, "sync_log", SYNC_LOG_COLUMNS)?;
    }

    let has_migration_ledger = tables.contains("app_schema_migrations");
    if has_migration_ledger {
        validate_columns(conn, "app_schema_migrations", MIGRATION_LEDGER_COLUMNS)?;
        validate_existing_baseline(conn)?;
        validate_sync_migration(conn, has_sync)?;
        if !(has_groups && has_encryption && has_file_activity) {
            return Err(
                "Managed database is missing tables required by its recorded schema version. No changes were made."
                    .to_string(),
            );
        }
        return Ok(SchemaLayout::Current);
    }

    match (has_groups, has_encryption, has_file_activity) {
        (false, false, false) => Ok(SchemaLayout::SharingOnly),
        (true, false, false) => Ok(SchemaLayout::FolderMetadata),
        (_, true, false) => Ok(SchemaLayout::EncryptionRegistry),
        (_, false, true) => Ok(SchemaLayout::FileActivity),
        (_, true, true) => Ok(SchemaLayout::Current),
    }
}

pub fn prepare_baseline_backup(
    conn: &Connection,
    database_path: &Path,
    source_layout: SchemaLayout,
) -> Result<Option<PathBuf>, String> {
    if source_layout == SchemaLayout::Empty || table_exists(conn, "app_schema_migrations")? {
        return Ok(None);
    }

    let file_name = database_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            "Database filename is not valid Unicode; backup was not attempted.".to_string()
        })?;
    let backup_path = database_path.with_file_name(format!(
        "{file_name}.pre-migration-v{APPLICATION_SCHEMA_VERSION}"
    ));

    if backup_path.exists() {
        reject_symbolic_link(&backup_path)?;
        validate_backup(&backup_path)?;
        return Ok(Some(backup_path));
    }

    let backup_path_text = backup_path.to_str().ok_or_else(|| {
        "Database backup path is not valid Unicode; backup was not attempted.".to_string()
    })?;
    let mut statement = conn
        .prepare("VACUUM INTO ?")
        .map_err(|error| format!("Failed to prepare database backup: {error}"))?;
    statement
        .bind((1, backup_path_text))
        .map_err(|error| format!("Failed to bind database backup path: {error}"))?;
    statement
        .next()
        .map_err(|error| format!("Failed to create database backup: {error}"))?;

    reject_symbolic_link(&backup_path)?;
    restrict_backup_permissions(&backup_path)?;
    validate_backup(&backup_path)?;
    Ok(Some(backup_path))
}

pub fn install_baseline(conn: &Connection) -> Result<(), String> {
    let layout = inspect_schema(conn)?;
    if layout == SchemaLayout::Current && table_exists(conn, "app_schema_migrations")? {
        return Ok(());
    }
    if layout != SchemaLayout::Current {
        return Err(format!(
            "Refusing to baseline incomplete database layout '{}'.",
            layout.label()
        ));
    }

    conn.execute("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        conn.execute(MIGRATION_LEDGER_SQL)
            .map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare(
                "INSERT INTO app_schema_migrations
                 (version, name, checksum, applied_at, app_version)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .map_err(|error| error.to_string())?;
        statement
            .bind((1, BASELINE_SCHEMA_VERSION))
            .map_err(|error| error.to_string())?;
        statement
            .bind((2, BASELINE_NAME))
            .map_err(|error| error.to_string())?;
        statement
            .bind((3, baseline_checksum().as_str()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((4, chrono::Utc::now().timestamp()))
            .map_err(|error| error.to_string())?;
        statement
            .bind((5, env!("CARGO_PKG_VERSION")))
            .map_err(|error| error.to_string())?;
        statement.next().map_err(|error| error.to_string())?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute("COMMIT").map_err(|error| error.to_string())?;
            quick_check(conn)
        }
        Err(error) => {
            let _ = conn.execute("ROLLBACK");
            Err(error)
        }
    }
}

fn validate_existing_baseline(conn: &Connection) -> Result<(), String> {
    reject_newer_version(
        conn,
        "app_schema_migrations",
        APPLICATION_SCHEMA_VERSION,
        "application",
    )?;

    let mut statement = conn
        .prepare("SELECT name, checksum FROM app_schema_migrations WHERE version = ?")
        .map_err(|error| error.to_string())?;
    statement
        .bind((1, BASELINE_SCHEMA_VERSION))
        .map_err(|error| error.to_string())?;
    if statement.next().map_err(|error| error.to_string())? != State::Row {
        return Err(
            "Application migration ledger has no recognized baseline. No changes were made."
                .to_string(),
        );
    }
    let name = statement
        .read::<String, _>(0)
        .map_err(|error| error.to_string())?;
    let checksum = statement
        .read::<String, _>(1)
        .map_err(|error| error.to_string())?;
    if name != BASELINE_NAME || checksum != baseline_checksum() {
        return Err(
            "Application migration baseline does not match this build. No changes were made."
                .to_string(),
        );
    }
    Ok(())
}

fn validate_sync_migration(conn: &Connection, has_sync: bool) -> Result<(), String> {
    let mut statement = conn
        .prepare("SELECT name, checksum FROM app_schema_migrations WHERE version = 2")
        .map_err(|error| error.to_string())?;
    let has_record = statement.next().map_err(|error| error.to_string())? == State::Row;
    if has_record != has_sync {
        return Err("Folder-sync tables and their migration record do not match. No changes were made.".to_string());
    }
    if has_record {
        let name = statement.read::<String, _>(0).map_err(|error| error.to_string())?;
        let checksum = statement.read::<String, _>(1).map_err(|error| error.to_string())?;
        if name != SYNC_MIGRATION_NAME || checksum != sync_migration_checksum() {
            return Err("Folder-sync migration does not match this build. No changes were made.".to_string());
        }
    }
    Ok(())
}

pub fn sync_migration_record() -> (&'static str, String) {
    (SYNC_MIGRATION_NAME, sync_migration_checksum())
}

fn quick_check(conn: &Connection) -> Result<(), String> {
    let mut statement = conn
        .prepare("PRAGMA quick_check(1)")
        .map_err(|error| error.to_string())?;
    if statement.next().map_err(|error| error.to_string())? != State::Row {
        return Err("SQLite integrity check returned no result. No changes were made.".to_string());
    }
    let result = statement
        .read::<String, _>(0)
        .map_err(|error| error.to_string())?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!(
            "SQLite integrity check failed: {result}. No changes were made."
        ))
    }
}

fn validate_backup(backup_path: &Path) -> Result<(), String> {
    let backup = sqlite::open(backup_path)
        .map_err(|error| format!("Could not open migration backup for verification: {error}"))?;
    quick_check(&backup)
        .map_err(|error| format!("Migration backup verification failed: {error}"))?;
    inspect_schema(&backup)
        .map(|_| ())
        .map_err(|error| format!("Migration backup has an unrecognized schema: {error}"))
}

fn reject_symbolic_link(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect migration backup: {error}"))?;
    if metadata.file_type().is_symlink() {
        Err("Migration backup path is a symbolic link; no changes were made.".to_string())
    } else if !metadata.is_file() {
        Err("Migration backup path is not a regular file; no changes were made.".to_string())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn restrict_backup_permissions(backup_path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(backup_path)
        .map_err(|error| format!("Could not inspect migration backup permissions: {error}"))?
        .permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(backup_path, permissions)
        .map_err(|error| format!("Could not restrict migration backup permissions: {error}"))
}

#[cfg(not(unix))]
fn restrict_backup_permissions(_backup_path: &Path) -> Result<(), String> {
    // Windows backups inherit the access-control list of the application data
    // directory. The app never broadens those inherited permissions.
    Ok(())
}

fn table_names(conn: &Connection) -> Result<BTreeSet<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .map_err(|error| error.to_string())?;
    let mut tables = BTreeSet::new();
    while statement.next().map_err(|error| error.to_string())? == State::Row {
        tables.insert(
            statement
                .read::<String, _>(0)
                .map_err(|error| error.to_string())?,
        );
    }
    Ok(tables)
}

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool, String> {
    Ok(table_names(conn)?.contains(table_name))
}

fn table_columns(conn: &Connection, table_name: &str) -> Result<BTreeSet<String>, String> {
    let mut statement = conn
        .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
        .map_err(|error| error.to_string())?;
    statement
        .bind((1, table_name))
        .map_err(|error| error.to_string())?;
    let mut columns = BTreeSet::new();
    while statement.next().map_err(|error| error.to_string())? == State::Row {
        columns.insert(
            statement
                .read::<String, _>(0)
                .map_err(|error| error.to_string())?,
        );
    }
    Ok(columns)
}

fn validate_columns(
    conn: &Connection,
    table_name: &str,
    required_columns: &[&str],
) -> Result<(), String> {
    let columns = table_columns(conn, table_name)?;
    let missing: Vec<_> = required_columns
        .iter()
        .filter(|column| !columns.contains(**column))
        .copied()
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Table '{table_name}' is missing required columns: {}. No changes were made.",
            missing.join(", ")
        ))
    }
}

fn require_table(tables: &BTreeSet<String>, table_name: &str) -> Result<(), String> {
    if tables.contains(table_name) {
        Ok(())
    } else {
        Err(format!(
            "Database is missing required table '{table_name}'. No changes were made."
        ))
    }
}

fn reject_newer_version(
    conn: &Connection,
    table_name: &str,
    supported_version: i64,
    schema_name: &str,
) -> Result<(), String> {
    let query = format!("SELECT MAX(version) FROM {table_name}");
    let mut statement = conn.prepare(query).map_err(|error| error.to_string())?;
    if statement.next().map_err(|error| error.to_string())? != State::Row {
        return Ok(());
    }
    let version = statement.read::<i64, _>(0).unwrap_or(0);
    if version > supported_version {
        Err(format!(
            "Database uses {schema_name} schema version {version}, but this build supports up to {supported_version}. No changes were made."
        ))
    } else {
        Ok(())
    }
}

fn baseline_checksum() -> String {
    let digest = Sha256::digest(BASELINE_DEFINITION.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sync_migration_checksum() -> String {
    let digest = Sha256::digest(SYNC_MIGRATION_DEFINITION.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARING_SCHEMA: &str = "CREATE TABLE shared_links (
            id TEXT PRIMARY KEY,
            folder_id INTEGER,
            message_id INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            password_hash TEXT,
            password_salt TEXT,
            expires_at INTEGER,
            revoked INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )";

    const CURRENT_SCHEMA: &str = "CREATE TABLE groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            color_hex TEXT DEFAULT '#3B82F6',
            display_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE folder_metadata (
            channel_id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            username TEXT,
            is_public INTEGER NOT NULL DEFAULT 0,
            display_order INTEGER NOT NULL DEFAULT 0,
            group_id INTEGER
        );
        CREATE TABLE encrypted_files (
            folder_key TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            file_uuid BLOB NOT NULL,
            envelope_version INTEGER NOT NULL,
            cipher_suite INTEGER NOT NULL,
            ciphertext_size INTEGER NOT NULL,
            plaintext_size INTEGER,
            remote_name TEXT NOT NULL,
            key_profile_id TEXT,
            protection_mode TEXT NOT NULL DEFAULT 'vault',
            metadata_protected INTEGER NOT NULL DEFAULT 0,
            header_blob BLOB,
            header_sha256 BLOB,
            record_state TEXT NOT NULL DEFAULT 'active',
            reconciliation_state TEXT NOT NULL DEFAULT 'ok',
            created_at INTEGER NOT NULL,
            last_verified_at INTEGER,
            PRIMARY KEY(folder_key, message_id)
        );
        CREATE TABLE encryption_profiles (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            kind TEXT NOT NULL,
            vault_locator TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
        INSERT INTO schema_version VALUES (3, 1);
        CREATE TABLE file_activity (
            folder_key TEXT NOT NULL,
            folder_id INTEGER,
            message_id INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            mime_type TEXT,
            file_ext TEXT,
            created_at TEXT NOT NULL DEFAULT '',
            encryption_state TEXT NOT NULL DEFAULT 'plain',
            last_opened_at INTEGER NOT NULL DEFAULT 0,
            open_count INTEGER NOT NULL DEFAULT 0,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(folder_key, message_id)
        )";

    fn connection() -> Connection {
        sqlite::open(":memory:").expect("open in-memory database")
    }

    fn create_current_schema(conn: &Connection) {
        conn.execute(SHARING_SCHEMA).expect("create sharing schema");
        conn.execute(CURRENT_SCHEMA).expect("create current schema");
    }

    #[test]
    fn recognizes_empty_and_historical_sharing_layouts() {
        let conn = connection();
        assert_eq!(inspect_schema(&conn).unwrap(), SchemaLayout::Empty);
        conn.execute(SHARING_SCHEMA).unwrap();
        assert_eq!(inspect_schema(&conn).unwrap(), SchemaLayout::SharingOnly);
    }

    #[test]
    fn recognizes_released_folder_and_encryption_layouts() {
        let conn = connection();
        conn.execute(SHARING_SCHEMA).unwrap();
        conn.execute(
            "CREATE TABLE groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                color_hex TEXT DEFAULT '#3B82F6',
                display_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE folder_metadata (
                channel_id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                username TEXT,
                is_public INTEGER NOT NULL DEFAULT 0,
                display_order INTEGER NOT NULL DEFAULT 0,
                group_id INTEGER
            )",
        )
        .unwrap();
        assert_eq!(inspect_schema(&conn).unwrap(), SchemaLayout::FolderMetadata);

        conn.execute(
            "CREATE TABLE encrypted_files (
                folder_key TEXT NOT NULL,
                message_id INTEGER NOT NULL,
                file_uuid BLOB NOT NULL,
                envelope_version INTEGER NOT NULL,
                cipher_suite INTEGER NOT NULL,
                ciphertext_size INTEGER NOT NULL,
                remote_name TEXT NOT NULL,
                key_profile_id TEXT,
                header_blob BLOB,
                header_sha256 BLOB,
                record_state TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER NOT NULL,
                last_verified_at INTEGER,
                PRIMARY KEY(folder_key, message_id)
            );
            CREATE TABLE encryption_profiles (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                kind TEXT NOT NULL,
                vault_locator TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );
            INSERT INTO schema_version VALUES (3, 1)",
        )
        .unwrap();
        assert_eq!(
            inspect_schema(&conn).unwrap(),
            SchemaLayout::EncryptionRegistry
        );
    }

    #[test]
    fn baselines_current_schema_without_changing_user_records() {
        let conn = connection();
        create_current_schema(&conn);
        conn.execute(
            "INSERT INTO shared_links
             (id, message_id, file_name, created_at) VALUES ('share-1', 10, 'photo.jpg', 1)",
        )
        .unwrap();

        install_baseline(&conn).unwrap();
        install_baseline(&conn).unwrap();

        let mut statement = conn
            .prepare("SELECT file_name FROM shared_links WHERE id = 'share-1'")
            .unwrap();
        assert_eq!(statement.next().unwrap(), State::Row);
        assert_eq!(statement.read::<String, _>(0).unwrap(), "photo.jpg");
        let mut migration = conn
            .prepare("SELECT COUNT(*) FROM app_schema_migrations")
            .unwrap();
        assert_eq!(migration.next().unwrap(), State::Row);
        assert_eq!(migration.read::<i64, _>(0).unwrap(), 1);
    }

    #[test]
    fn rejects_partial_and_unknown_schemas_without_modifying_them() {
        let partial = connection();
        partial.execute(SHARING_SCHEMA).unwrap();
        partial
            .execute("CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT)")
            .unwrap();
        assert!(inspect_schema(&partial)
            .unwrap_err()
            .contains("partial folder-metadata"));
        assert!(!table_exists(&partial, "app_schema_migrations").unwrap());

        let unknown = connection();
        unknown.execute(SHARING_SCHEMA).unwrap();
        unknown
            .execute("CREATE TABLE future_data (id INTEGER)")
            .unwrap();
        assert!(inspect_schema(&unknown)
            .unwrap_err()
            .contains("unknown schema"));
        assert!(!table_exists(&unknown, "app_schema_migrations").unwrap());
    }

    #[test]
    fn rejects_newer_application_versions_and_modified_baselines() {
        let newer = connection();
        create_current_schema(&newer);
        newer.execute(MIGRATION_LEDGER_SQL).unwrap();
        newer
            .execute(
                "INSERT INTO app_schema_migrations
                 VALUES (3, 'future', 'future', 1, '9.0.0')",
            )
            .unwrap();
        assert!(inspect_schema(&newer)
            .unwrap_err()
            .contains("supports up to 2"));

        let modified = connection();
        create_current_schema(&modified);
        modified.execute(MIGRATION_LEDGER_SQL).unwrap();
        modified
            .execute(
                "INSERT INTO app_schema_migrations
                 VALUES (1, 'baseline_known_schema', 'wrong', 1, '2.2.7')",
            )
            .unwrap();
        assert!(inspect_schema(&modified)
            .unwrap_err()
            .contains("does not match this build"));
    }

    #[test]
    fn accepts_complete_folder_sync_schema_v2() {
        let conn = connection();
        create_current_schema(&conn);
        install_baseline(&conn).unwrap();
        conn.execute(
            "CREATE TABLE sync_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE sync_pairs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, local_path TEXT NOT NULL UNIQUE,
                channel_id INTEGER NOT NULL, folder_key TEXT NOT NULL, label TEXT,
                sync_direction TEXT NOT NULL, is_active INTEGER NOT NULL, created_at INTEGER NOT NULL
             );
             CREATE TABLE sync_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER NOT NULL,
                relative_path TEXT NOT NULL, local_hash TEXT, remote_hash TEXT,
                file_size INTEGER NOT NULL, local_mtime INTEGER, remote_date INTEGER,
                message_id INTEGER, sync_status TEXT NOT NULL, UNIQUE(pair_id, relative_path)
             );
             CREATE TABLE sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER, action TEXT NOT NULL,
                relative_path TEXT, detail TEXT, created_at INTEGER NOT NULL
             );",
        )
        .unwrap();
        let (name, checksum) = sync_migration_record();
        let mut statement = conn.prepare(
            "INSERT INTO app_schema_migrations (version, name, checksum, applied_at, app_version) VALUES (2, ?, ?, 1, 'test')",
        ).unwrap();
        statement.bind((1, name)).unwrap();
        statement.bind((2, checksum.as_str())).unwrap();
        statement.next().unwrap();
        assert_eq!(inspect_schema(&conn).unwrap(), SchemaLayout::Current);
    }

    #[test]
    fn creates_and_reuses_a_verified_pre_migration_backup() {
        let unique = format!(
            "telegram-drive-db-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let database_path = std::env::temp_dir().join(format!("{unique}.db"));
        let backup_path = std::env::temp_dir().join(format!(
            "{unique}.db.pre-migration-v{APPLICATION_SCHEMA_VERSION}"
        ));
        let conn = sqlite::open(&database_path).unwrap();
        conn.execute(SHARING_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO shared_links
             (id, message_id, file_name, created_at) VALUES ('share-1', 10, 'photo.jpg', 1)",
        )
        .unwrap();

        let created = prepare_baseline_backup(&conn, &database_path, SchemaLayout::SharingOnly)
            .unwrap()
            .unwrap();
        assert_eq!(created, backup_path);
        let reused = prepare_baseline_backup(&conn, &database_path, SchemaLayout::SharingOnly)
            .unwrap()
            .unwrap();
        assert_eq!(reused, backup_path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&backup_path)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0);
        }

        let backup = sqlite::open(&backup_path).unwrap();
        let mut statement = backup
            .prepare("SELECT file_name FROM shared_links WHERE id = 'share-1'")
            .unwrap();
        assert_eq!(statement.next().unwrap(), State::Row);
        assert_eq!(statement.read::<String, _>(0).unwrap(), "photo.jpg");
        drop(statement);
        drop(backup);
        drop(conn);
        std::fs::remove_file(&backup_path).unwrap();
        std::fs::remove_file(&database_path).unwrap();
    }
}
