use crate::db::DbConnection;
use rand::Rng;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ShareInfo {
    pub id: String,
    pub file_name: String,
    pub file_size: i64,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub has_password: bool,
    pub link: String,
}

fn generate_share_token() -> String {
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.random()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Hash a password using bcrypt (cost factor 12).
/// bcrypt embeds the salt in the output hash string, so no separate salt storage is needed.
fn hash_password(password: &str) -> Result<String, String> {
    bcrypt::non_truncating_hash(password, 12).map_err(|e| format!("Password hashing failed: {}", e))
}

const MIN_SHARE_PASSWORD_CHARS: usize = 4;
const MAX_SHARE_PASSWORD_CHARS: usize = 128;
const MAX_SHARE_PASSWORD_BYTES: usize = 72;

fn validate_share_password(password: Option<String>) -> Result<Option<String>, String> {
    let Some(password) = password else {
        return Ok(None);
    };
    if password.is_empty() {
        return Ok(None);
    }
    let chars = password.chars().count();
    if !(MIN_SHARE_PASSWORD_CHARS..=MAX_SHARE_PASSWORD_CHARS).contains(&chars)
        || password.len() > MAX_SHARE_PASSWORD_BYTES
    {
        return Err(format!(
            "Share passwords must contain between {MIN_SHARE_PASSWORD_CHARS} and {MAX_SHARE_PASSWORD_CHARS} characters"
        ));
    }
    Ok(Some(password))
}

#[tauri::command]
pub async fn cmd_create_share(
    folder_id: Option<i64>,
    message_id: i32,
    file_name: String,
    file_size: i64,
    password: Option<String>,
    expiry_hours: Option<i64>,
    db_pool: State<'_, DbConnection>,
) -> Result<ShareInfo, String> {
    let token = generate_share_token();
    let created_at = chrono::Utc::now().timestamp();
    let expires_at = expiry_hours.map(|hours| created_at + hours * 3600);
    let password = validate_share_password(password)?;
    // Bcrypt is deliberately completed on a blocking worker before the SQLite
    // connection is acquired, so expensive password work cannot hold the DB lock.
    let password_hash = match password {
        Some(password) => Some(
            tokio::task::spawn_blocking(move || hash_password(&password))
                .await
                .map_err(|error| format!("Password hashing worker failed: {error}"))??,
        ),
        None => None,
    };
    let database = db_pool.inner().clone();
    let token_for_db = token.clone();
    let file_name_for_db = file_name.clone();
    let has_password = crate::db::with_connection(database, move |conn| {
        let folder_key = folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "home".to_string());
        let mut encrypted = conn
            .prepare("SELECT 1 FROM encrypted_files WHERE folder_key = ? AND message_id = ? AND record_state = 'active'")
            .map_err(|e| e.to_string())?;
        encrypted.bind((1, folder_key.as_str())).map_err(|e| e.to_string())?;
        encrypted.bind((2, i64::from(message_id))).map_err(|e| e.to_string())?;
        if matches!(encrypted.next(), Ok(sqlite::State::Row)) {
            return Err("[ENCRYPTED_SHARE_UNAVAILABLE] Encrypted sharing is disabled until a credential-safe sharing flow is available".to_string());
        }

        let mut stmt = conn.prepare(
            "INSERT INTO shared_links (id, folder_id, message_id, file_name, file_size, password_hash, password_salt, expires_at, revoked, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
        ).map_err(|e| e.to_string())?;
        stmt.bind((1, token_for_db.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((2, folder_id)).map_err(|e| e.to_string())?;
        stmt.bind((3, message_id as i64)).map_err(|e| e.to_string())?;
        stmt.bind((4, file_name_for_db.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((5, file_size)).map_err(|e| e.to_string())?;
        stmt.bind((6, password_hash.as_deref())).map_err(|e| e.to_string())?;
        stmt.bind::<(usize, Option<&str>)>((7, None)).map_err(|e| e.to_string())?;
        stmt.bind((8, expires_at)).map_err(|e| e.to_string())?;
        stmt.bind((9, created_at)).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;
        Ok(password_hash.is_some())
    }).await?;

    let link = format!("http://127.0.0.1:{}/d/{}", crate::STREAM_PORT, token);

    Ok(ShareInfo {
        id: token,
        file_name,
        file_size,
        created_at,
        expires_at,
        has_password,
        link,
    })
}

#[cfg(test)]
mod tests {
    use super::validate_share_password;

    #[test]
    fn share_password_policy_is_bounded_without_changing_unprotected_links() {
        assert_eq!(validate_share_password(None).unwrap(), None);
        assert_eq!(validate_share_password(Some(String::new())).unwrap(), None);
        assert!(validate_share_password(Some("abc".to_string())).is_err());
        assert!(validate_share_password(Some("a".repeat(129))).is_err());
        assert!(validate_share_password(Some("a".repeat(73))).is_err());
        assert_eq!(
            validate_share_password(Some("safe-password".to_string())).unwrap(),
            Some("safe-password".to_string())
        );
    }
}

#[tauri::command]
pub async fn cmd_list_shares(db_pool: State<'_, DbConnection>) -> Result<Vec<ShareInfo>, String> {
    let database = db_pool.inner().clone();
    crate::db::with_connection(database, |conn| {
        let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, message_id, file_name, file_size, password_hash, expires_at, created_at 
             FROM shared_links WHERE revoked = 0 ORDER BY created_at DESC"
        )
        .map_err(|e| e.to_string())?;

    let mut shares = Vec::new();
    while let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        let id = stmt.read::<String, _>("id").map_err(|e| e.to_string())?;
        let has_password = stmt.read::<Option<String>, _>("password_hash").ok().flatten().is_some();
        let expires_at = stmt.read::<Option<i64>, _>("expires_at").ok().flatten();
        let file_name = stmt.read::<String, _>("file_name").map_err(|e| e.to_string())?;
        let file_size = stmt.read::<i64, _>("file_size").map_err(|e| e.to_string())?;
        let created_at = stmt.read::<i64, _>("created_at").map_err(|e| e.to_string())?;
        let link = format!("http://127.0.0.1:{}/d/{}", crate::STREAM_PORT, id);

        shares.push(ShareInfo {
            id,
            file_name,
            file_size,
            created_at,
            expires_at,
            has_password,
            link,
        });
    }

        Ok(shares)
    }).await
}

#[tauri::command]
pub async fn cmd_revoke_share(id: String, db_pool: State<'_, DbConnection>) -> Result<(), String> {
    let database = db_pool.inner().clone();
    crate::db::with_connection(database, move |conn| {
        let mut stmt = conn
            .prepare("UPDATE shared_links SET revoked = 1 WHERE id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}
