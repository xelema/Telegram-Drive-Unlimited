//! Durable, account-scoped trip packs. Only files whose complete private copy
//! exists are reported ready; disposable preview cleanup never touches this tree.
use super::{
    assets,
    store::{Store, WorkspaceFile},
    AccountGuard,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

type Result<T> = std::result::Result<T, String>;
const KIND: &str = "offline-pack";
const RESERVE: u64 = crate::workspace::device_cache::SPACE_RESERVE;
static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static NETWORK_CACHE: OnceLock<tokio::sync::Mutex<Option<(Instant, NetworkStatus)>>> =
    OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackItem {
    pub file: WorkspaceFile,
    pub status: String,
    pub downloaded_bytes: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflinePack {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub wifi_only: bool,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: String,
    pub waiting_reason: Option<String>,
    pub auto_resume: bool,
    pub active_run: Option<String>,
    pub files: Vec<PackItem>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub known: bool,
    pub connected: bool,
    pub wifi: bool,
}

impl NetworkStatus {
    fn unknown() -> Self {
        Self {
            known: false,
            connected: false,
            wifi: false,
        }
    }
    pub fn reason(&self, wifi_only: bool) -> Option<String> {
        if !self.known {
            Some("NETWORK_STATUS_UNKNOWN".into())
        } else if !self.connected {
            Some("WAITING_FOR_NETWORK".into())
        } else if wifi_only && !self.wifi {
            Some("WAITING_FOR_WIFI".into())
        } else {
            None
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSnapshot {
    pub owner_id: String,
    pub packs: Vec<OfflinePack>,
    pub free_bytes: u64,
    pub reserve_bytes: u64,
    pub network: NetworkStatus,
}

fn jobs() -> std::sync::MutexGuard<'static, HashMap<String, Arc<AtomicBool>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
fn job_key(root: &Path, owner: i64, id: &str) -> String {
    format!("{}:{owner}:{id}", root.display())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn offline_root(data: &Path, owner: i64) -> PathBuf {
    data.join("workspace")
        .join(owner.to_string())
        .join("offline")
}

fn pack_directory(data: &Path, owner: i64, id: &str) -> Result<PathBuf> {
    if owner <= 0 || uuid::Uuid::parse_str(id).is_err() {
        return Err("INVALID_PACK: Invalid offline pack identity".into());
    }
    Ok(offline_root(data, owner).join(id))
}

fn target(data: &Path, owner: i64, pack: &OfflinePack, file: &WorkspaceFile) -> Result<PathBuf> {
    if pack.owner_id != owner.to_string() {
        return Err("ACCOUNT_CHANGED".into());
    }
    Ok(pack_directory(data, owner, &pack.id)?.join(assets::file_name(file)))
}

fn existing_path(data: &Path, owner: i64, pack: &OfflinePack, item: &PackItem) -> Result<PathBuf> {
    let base = offline_root(data, owner)
        .canonicalize()
        .map_err(|_| "OFFLINE_FILE_MISSING")?;
    let path = target(data, owner, pack, &item.file)?
        .canonicalize()
        .map_err(|_| "OFFLINE_FILE_MISSING")?;
    if !path.starts_with(base)
        || !path
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() == item.file.file.size)
    {
        return Err("OFFLINE_FILE_INCOMPLETE: Retry this file before travelling".into());
    }
    Ok(path)
}

pub fn required_bytes(pack: &OfflinePack) -> Result<u64> {
    pack.files
        .iter()
        .filter(|item| item.status != "ready" && item.status != "unsupported")
        .try_fold(0u64, |bytes, item| {
            bytes
                .checked_add(item.file.file.size)
                .ok_or_else(|| "PACK_TOO_LARGE".into())
        })
}

fn free_bytes(data: &Path, owner: i64) -> Result<u64> {
    let root = offline_root(data, owner);
    std::fs::create_dir_all(&root).map_err(|e| format!("STORAGE_UNAVAILABLE: {e}"))?;
    crate::workspace::device_cache::available_bytes(&root)
}

fn clean_partials(directory: &Path) {
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            if entry.path().extension().is_some_and(|e| e == "part")
                && entry.file_type().is_ok_and(|t| t.is_file())
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

fn save(store: &Store, pack: &mut OfflinePack) -> Result<()> {
    pack.updated_at = now();
    store.put_record(KIND, &pack.id, pack)
}

fn read_pack(store: &Store, id: &str) -> Result<OfflinePack> {
    let pack = store
        .record::<OfflinePack>(KIND, id)?
        .ok_or("PACK_NOT_FOUND")?;
    if pack.owner_id != store.owner.to_string() || pack.id != id {
        return Err("ACCOUNT_CHANGED".into());
    }
    Ok(pack)
}

fn create_record(
    store: &Store,
    name: String,
    keys: Vec<String>,
    wifi_only: bool,
    expires_at: Option<i64>,
) -> Result<OfflinePack> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || keys.is_empty() || keys.len() > 10_000 {
        return Err("INVALID_PACK: Choose a name and 1–10,000 files".into());
    }
    if expires_at
        .is_some_and(|expires| expires <= now() || expires > now() + 366 * 24 * 60 * 60 * 1000)
    {
        return Err("INVALID_EXPIRY: Choose an expiry within the next year".into());
    }
    let mut unique = HashSet::new();
    let mut files = Vec::new();
    for key in keys {
        if !unique.insert(key.clone()) {
            continue;
        }
        let file = store
            .file(&key)?
            .ok_or("FILE_NOT_INDEXED: Scan the full folder before creating this pack")?;
        let protected = file.file.encryption_state != "plain";
        files.push(PackItem { file, status: if protected {"unsupported"} else {"pending"}.into(), downloaded_bytes: 0,
            error: protected.then(||"ENCRYPTED_OFFLINE_UNAVAILABLE: Export protected files through your unlocked vault".into()) });
    }
    let mut pack = OfflinePack {
        id: uuid::Uuid::new_v4().to_string(),
        owner_id: store.owner.to_string(),
        name: name.into(),
        wifi_only,
        expires_at,
        created_at: now(),
        updated_at: now(),
        status: "paused".into(),
        waiting_reason: None,
        auto_resume: false,
        active_run: None,
        files,
    };
    required_bytes(&pack)?;
    save(store, &mut pack)?;
    Ok(pack)
}

/// Reconcile a stopped process without declaring its incomplete copies ready.
/// Expiry only removes this pack's retained directory, never Telegram originals.
pub fn maintain(data: &Path, owner: i64) -> Result<Vec<OfflinePack>> {
    let store = Store::open(data, owner)?;
    let ids = store
        .records::<OfflinePack>(KIND)?
        .into_iter()
        .map(|pack| pack.id)
        .collect::<Vec<_>>();
    let mut packs = Vec::new();
    for id in ids {
        let reconciled = store.transaction(|| {
            let mut pack = read_pack(&store, &id)?;
            let key = job_key(data, owner, &id);
            let running = jobs().contains_key(&key);
            if pack.status == "expired" || pack.expires_at.is_some_and(|expires| expires <= now()) {
                if let Some(cancelled) = jobs().get(&key) {
                    cancelled.store(true, Ordering::SeqCst);
                }
                pack.status = "expired".into();
                pack.auto_resume = false;
                pack.active_run = None;
                for item in &mut pack.files {
                    item.status = "expired".into();
                    item.downloaded_bytes = 0;
                }
                // Keep the record until cleanup succeeds. A transient sharing or
                // storage error must remain retryable on the next maintenance run.
                let directory = pack_directory(data, owner, &id)?;
                if directory.exists() {
                    std::fs::remove_dir_all(directory)
                        .map_err(|e| format!("STORAGE_UNAVAILABLE: {e}"))?;
                }
                save(&store, &mut pack)?;
                return Ok(pack);
            }
            let mut changed = false;
            if !running {
                clean_partials(&pack_directory(data, owner, &id)?);
                if pack.active_run.take().is_some()
                    || matches!(pack.status.as_str(), "running" | "waiting")
                {
                    pack.status = if pack.auto_resume { "queued" } else { "paused" }.into();
                    changed = true;
                }
            }
            let verified = pack
                .files
                .iter()
                .map(|item| existing_path(data, owner, &pack, item).is_ok())
                .collect::<Vec<_>>();
            for (item, complete) in pack.files.iter_mut().zip(verified) {
                if item.status == "ready" && !complete {
                    item.status = "pending".into();
                    item.downloaded_bytes = 0;
                    item.error = Some("OFFLINE_FILE_MISSING".into());
                    changed = true;
                }
                // download() publishes its final filename only after exact-byte
                // verification and sync. Recover a crash between rename and DB save.
                if !running
                    && complete
                    && matches!(item.status.as_str(), "pending" | "downloading" | "error")
                {
                    item.status = "ready".into();
                    item.downloaded_bytes = item.file.file.size;
                    item.error = None;
                    changed = true;
                } else if !running && item.status == "downloading" {
                    item.status = "pending".into();
                    item.downloaded_bytes = 0;
                    changed = true;
                }
            }
            if !running
                && pack.files.iter().all(|item| item.status == "ready")
                && pack.status != "ready"
            {
                pack.status = "ready".into();
                pack.auto_resume = false;
                pack.waiting_reason = None;
                changed = true;
            } else if !running
                && pack.status == "ready"
                && pack.files.iter().any(|item| item.status != "ready")
            {
                pack.status = "paused".into();
                changed = true;
            }
            if changed {
                save(&store, &mut pack)?;
            }
            Ok(pack)
        })?;
        packs.push(reconciled);
    }
    Ok(packs)
}

pub fn retained_bytes(data: &Path, owner: i64) -> u64 {
    assets::tree_size(&offline_root(data, owner))
}

fn mutate_running(
    account: &AccountGuard,
    id: &str,
    run: &str,
    change: impl FnOnce(&mut OfflinePack),
) -> Result<OfflinePack> {
    account.validate()?;
    let store = Store::open(&account.root, account.owner)?;
    store.transaction(|| {
        let mut pack = read_pack(&store, id)?;
        if pack.active_run.as_deref() != Some(run) {
            return Err("CANCELLED".into());
        }
        change(&mut pack);
        account.validate()?;
        save(&store, &mut pack)?;
        Ok(pack)
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn command_output(program: &str, args: &[&str]) -> Result<String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "NETWORK_STATUS_UNKNOWN")?
        .map_err(|_| "NETWORK_STATUS_UNKNOWN")?;
    if !output.status.success() || output.stdout.len() > 128 * 1024 {
        return Err("NETWORK_STATUS_UNKNOWN".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "NETWORK_STATUS_UNKNOWN".into())
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_network(route: &str, hardware: &str) -> NetworkStatus {
    let interface = route
        .lines()
        .find_map(|line| line.trim().strip_prefix("interface:").map(str::trim));
    let Some(interface) = interface else {
        return NetworkStatus::unknown();
    };
    let mut wireless = false;
    for block in hardware.split("Hardware Port:").skip(1) {
        let mut lines = block.lines();
        let kind = lines.next().unwrap_or("").trim();
        let device = lines.find_map(|line| line.trim().strip_prefix("Device:").map(str::trim));
        if device == Some(interface) && ["Wi-Fi", "AirPort"].contains(&kind) {
            wireless = true;
        }
    }
    NetworkStatus {
        known: true,
        connected: true,
        wifi: wireless,
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_default_interface(routes: &str) -> Option<String> {
    routes
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 8
                || fields[1] != "00000000"
                || u32::from_str_radix(fields[3], 16).ok()? & 1 == 0
            {
                return None;
            }
            let interface = fields[0];
            if !interface
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
            {
                return None;
            }
            Some((fields[6].parse::<u32>().ok()?, interface.to_string()))
        })
        .min_by_key(|(metric, _)| *metric)
        .map(|(_, interface)| interface)
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_network(value: &str) -> NetworkStatus {
    let Ok(value) =
        serde_json::from_str::<serde_json::Value>(value.trim().trim_start_matches('\u{feff}'))
    else {
        return NetworkStatus::unknown();
    };
    match (
        value.get("connected").and_then(|v| v.as_bool()),
        value.get("wifi").and_then(|v| v.as_bool()),
    ) {
        (Some(connected), Some(wifi)) => NetworkStatus {
            known: true,
            connected,
            wifi: connected && wifi,
        },
        _ => NetworkStatus::unknown(),
    }
}

pub async fn network_status() -> NetworkStatus {
    let mut cached = NETWORK_CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    if let Some((checked, status)) = &*cached {
        if checked.elapsed() < Duration::from_secs(2) {
            return status.clone();
        }
    }
    let status = read_network_status().await;
    *cached = Some((Instant::now(), status.clone()));
    status
}

async fn read_network_status() -> NetworkStatus {
    #[cfg(target_os = "android")]
    {
        return crate::commands::cmd_get_android_transfer_environment()
            .map(|value| NetworkStatus {
                known: true,
                connected: value.connected,
                wifi: value.wifi && !value.metered,
            })
            .unwrap_or_else(|_| NetworkStatus::unknown());
    }
    #[cfg(target_os = "macos")]
    {
        let (route, hardware) = tokio::join!(
            command_output("/sbin/route", &["-n", "get", "default"]),
            command_output("/usr/sbin/networksetup", &["-listallhardwareports"])
        );
        return match (route, hardware) {
            (Ok(route), Ok(hardware)) => parse_macos_network(&route, &hardware),
            _ => NetworkStatus::unknown(),
        };
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(routes) = tokio::fs::read_to_string("/proc/net/route").await else {
            return NetworkStatus::unknown();
        };
        return match linux_default_interface(&routes) {
            Some(interface) => NetworkStatus {
                known: true,
                connected: true,
                wifi: tokio::fs::try_exists(
                    Path::new("/sys/class/net").join(interface).join("wireless"),
                )
                .await
                .unwrap_or(false),
            },
            None => NetworkStatus {
                known: true,
                connected: false,
                wifi: false,
            },
        };
    }
    #[cfg(target_os = "windows")]
    {
        let script="$ErrorActionPreference='Stop'; $r=Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1; if (!$r) { @{connected=$false;wifi=$false} | ConvertTo-Json -Compress } else { $a=Get-NetAdapter -InterfaceIndex $r.InterfaceIndex; @{connected=($a.Status -eq 'Up');wifi=([int]$a.NdisPhysicalMedium -in 1,9)} | ConvertTo-Json -Compress }";
        return command_output(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", script],
        )
        .await
        .map(|value| parse_windows_network(&value))
        .unwrap_or_else(|_| NetworkStatus::unknown());
    }
    #[allow(unreachable_code)]
    NetworkStatus::unknown()
}

fn emit(app: &tauri::AppHandle, account: &AccountGuard, id: &str) {
    let _ = app.emit(
        "offline-pack-changed",
        serde_json::json!({"ownerId":account.owner.to_string(),"packId":id}),
    );
}

fn file_cancelled(account: &AccountGuard, id: &str, run: &str, index: usize) -> bool {
    if account.validate().is_err() {
        return true;
    }
    Store::open(&account.root, account.owner)
        .and_then(|store| read_pack(&store, id))
        .map(|pack| {
            pack.active_run.as_deref() != Some(run)
                || pack
                    .files
                    .get(index)
                    .is_none_or(|item| item.status == "cancelled" || item.status == "expired")
        })
        .unwrap_or(true)
}

async fn run_pack(
    app: tauri::AppHandle,
    account: AccountGuard,
    id: String,
    run: String,
    cancelled: Arc<AtomicBool>,
) -> Result<()> {
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        account.validate()?;
        let store = Store::open(&account.root, account.owner)?;
        let pack = read_pack(&store, &id)?;
        if pack.active_run.as_deref() != Some(&run) {
            return Ok(());
        }
        if pack.expires_at.is_some_and(|expires| expires <= now()) {
            maintain(&account.root, account.owner)?;
            return Ok(());
        }
        let Some(index) = pack
            .files
            .iter()
            .position(|item| matches!(item.status.as_str(), "pending" | "downloading"))
        else {
            mutate_running(&account, &id, &run, |pack| {
                pack.status = if pack.files.iter().all(|item| item.status == "ready") {
                    "ready"
                } else {
                    "error"
                }
                .into();
                pack.waiting_reason = None;
                pack.active_run = None;
                pack.auto_resume = false;
            })?;
            emit(&app, &account, &id);
            return Ok(());
        };
        let gate = network_status().await;
        if let Some(reason) = gate.reason(pack.wifi_only) {
            mutate_running(&account, &id, &run, |pack| {
                pack.status = "waiting".into();
                pack.waiting_reason = Some(reason);
            })?;
            emit(&app, &account, &id);
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue;
        }
        let file = pack.files[index].file.clone();
        let path = target(&account.root, account.owner, &pack, &file)?;
        let parent = path.parent().ok_or("Invalid offline directory")?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
        if free_bytes(&account.root, account.owner)? < file.file.size.saturating_add(RESERVE) {
            mutate_running(&account, &id, &run, |pack| {
                pack.status = "waiting".into();
                pack.waiting_reason = Some("WAITING_FOR_STORAGE".into());
            })?;
            emit(&app, &account, &id);
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue;
        }
        mutate_running(&account, &id, &run, |pack| {
            pack.status = "running".into();
            pack.waiting_reason = None;
            pack.files[index].status = "downloading".into();
            pack.files[index].downloaded_bytes = 0;
            pack.files[index].error = None;
        })?;
        emit(&app, &account, &id);
        let network_lost = Arc::new(AtomicBool::new(false));
        let monitored = network_lost.clone();
        let monitor_cancel = cancelled.clone();
        let wifi = pack.wifi_only;
        let monitor = tauri::async_runtime::spawn(async move {
            while !monitor_cancel.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if network_status().await.reason(wifi).is_some() {
                    monitored.store(true, Ordering::SeqCst);
                    break;
                }
            }
        });
        let operation = async {
            let (client, media) = assets::remote_media(&app, &account, &file).await?;
            let mut last = Instant::now() - Duration::from_secs(1);
            assets::download(
                assets::DownloadSource {
                    app: &app,
                    account: &account,
                    client: &client,
                },
                &media,
                file.file.size,
                &path,
                || {
                    cancelled.load(Ordering::SeqCst)
                        || network_lost.load(Ordering::SeqCst)
                        || pack.expires_at.is_some_and(|expires| expires <= now())
                },
                |bytes| {
                    if last.elapsed() >= Duration::from_millis(500) {
                        last = Instant::now();
                        let _ = mutate_running(&account, &id, &run, |pack| {
                            if pack.files[index].status == "downloading" {
                                pack.files[index].downloaded_bytes = bytes;
                            }
                        });
                        emit(&app, &account, &id);
                    }
                },
            )
            .await
        };
        let result: Result<()> = tokio::select! {
            result=tokio::time::timeout(Duration::from_secs(6*60*60),operation)=>result.unwrap_or_else(|_|Err("NETWORK_UNAVAILABLE: Download timed out".into())),
            _=async {loop {if cancelled.load(Ordering::SeqCst)||network_lost.load(Ordering::SeqCst)||pack.expires_at.is_some_and(|expires|expires<=now())||file_cancelled(&account,&id,&run,index){break;}tokio::time::sleep(Duration::from_millis(200)).await;}}=>Err("CANCELLED".into()),
        };
        monitor.abort();
        clean_partials(parent);
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        if pack.expires_at.is_some_and(|expires| expires <= now()) {
            maintain(&account.root, account.owner)?;
            return Ok(());
        }
        if read_pack(&Store::open(&account.root, account.owner)?, &id)?.files[index].status
            == "cancelled"
        {
            let _ = tokio::fs::remove_file(&path).await;
            continue;
        }
        match result {
            Ok(()) => {
                let finished = mutate_running(&account, &id, &run, |pack| {
                    if pack.files[index].status != "cancelled" {
                        pack.files[index].status = "ready".into();
                        pack.files[index].downloaded_bytes = file.file.size;
                        pack.files[index].error = None;
                    }
                })?;
                if finished.files[index].status == "cancelled" {
                    let _ = tokio::fs::remove_file(&path).await;
                }
            }
            Err(error) => {
                let storage_wait = error.contains("STORAGE_UNAVAILABLE");
                let waiting = storage_wait
                    || network_lost.load(Ordering::SeqCst)
                    || error.contains("NETWORK_UNAVAILABLE");
                mutate_running(&account, &id, &run, |pack| {
                    if pack.files[index].status == "cancelled" {
                        return;
                    }
                    pack.files[index].status = if waiting { "pending" } else { "error" }.into();
                    pack.files[index].downloaded_bytes = 0;
                    pack.files[index].error = Some(error);
                    if waiting {
                        pack.status = "waiting".into();
                        pack.waiting_reason = Some(
                            if storage_wait {
                                "WAITING_FOR_STORAGE"
                            } else {
                                "WAITING_FOR_NETWORK"
                            }
                            .into(),
                        );
                    }
                })?;
                if waiting {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }
        }
        emit(&app, &account, &id);
    }
}

fn launch(app: tauri::AppHandle, account: AccountGuard, id: String) -> Result<OfflinePack> {
    account.validate()?;
    let key = job_key(&account.root, account.owner, &id);
    let cancelled = Arc::new(AtomicBool::new(false));
    let inserted = {
        let mut active = jobs();
        if active.contains_key(&key) {
            false
        } else {
            active.insert(key.clone(), cancelled.clone());
            true
        }
    };
    if !inserted {
        return read_pack(&Store::open(&account.root, account.owner)?, &id);
    }
    let run = uuid::Uuid::new_v4().to_string();
    let prepared = (|| -> Result<OfflinePack> {
        let store = Store::open(&account.root, account.owner)?;
        store.transaction(|| {
            let mut pack = read_pack(&store, &id)?;
            if pack.status == "expired" || pack.expires_at.is_some_and(|expires| expires <= now()) {
                return Err("PACK_EXPIRED".into());
            }
            if cancelled.load(Ordering::SeqCst) {
                return Err("CANCELLED".into());
            }
            pack.active_run = Some(run.clone());
            pack.auto_resume = true;
            pack.status = "queued".into();
            save(&store, &mut pack)?;
            Ok(pack)
        })
    })();
    let pack = match prepared {
        Ok(pack) => pack,
        Err(error) => {
            jobs().remove(&key);
            return Err(error);
        }
    };
    tauri::async_runtime::spawn(async move {
        let outcome = run_pack(
            app.clone(),
            account.clone(),
            id.clone(),
            run.clone(),
            cancelled,
        )
        .await;
        if let Err(error) = outcome {
            let _ = mutate_running(&account, &id, &run, |pack| {
                pack.status = "paused".into();
                pack.waiting_reason = Some(error);
                pack.active_run = None;
            });
        }
        if let Ok(directory) = pack_directory(&account.root, account.owner, &id) {
            clean_partials(&directory);
            let _ = std::fs::remove_dir(directory);
        }
        jobs().remove(&key);
        emit(&app, &account, &id);
    });
    Ok(pack)
}

/// Call after sign-in/reconnect and periodically while the app is open. Work is
/// resumed only for packs the user previously started, under this same owner.
pub fn resume_pending(app: tauri::AppHandle, owner_id: String) -> Result<()> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, Some(&owner_id))?;
    for pack in maintain(&root, account.owner)? {
        if pack.auto_resume && matches!(pack.status.as_str(), "queued" | "running" | "waiting") {
            launch(app.clone(), account.clone(), pack.id)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_offline_packs_list(
    app: tauri::AppHandle,
    owner_id: String,
) -> Result<PackSnapshot> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, Some(&owner_id))?;
    let packs = maintain(&root, account.owner)?;
    let free_bytes = free_bytes(&root, account.owner)?;
    let network = network_status().await;
    account.validate()?;
    Ok(PackSnapshot {
        owner_id,
        packs,
        free_bytes,
        reserve_bytes: RESERVE,
        network,
    })
}

#[tauri::command]
pub fn cmd_offline_pack_create(
    app: tauri::AppHandle,
    owner_id: String,
    name: String,
    file_keys: Vec<String>,
    wifi_only: bool,
    expires_at: Option<i64>,
) -> Result<OfflinePack> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, Some(&owner_id))?;
    let store = Store::open(&root, account.owner)?;
    create_record(&store, name, file_keys, wifi_only, expires_at)
}

fn update_action(
    store: &Store,
    id: &str,
    action: &str,
    file_key: Option<&str>,
) -> Result<OfflinePack> {
    store.transaction(|| {
        let mut pack = read_pack(store, id)?;
        match action {
            "cancel_file" | "retry_file" => {
                let key = file_key.ok_or("Choose an offline file")?;
                let item = pack
                    .files
                    .iter_mut()
                    .find(|item| item.file.key == key)
                    .ok_or("File is not in this pack")?;
                if matches!(item.status.as_str(), "ready" | "unsupported" | "expired") {
                    return Ok(pack);
                }
                item.status = if action == "cancel_file" {
                    "cancelled"
                } else {
                    "pending"
                }
                .into();
                item.downloaded_bytes = 0;
                item.error = None;
            }
            "start" | "retry" => {
                if pack.status == "expired" {
                    return Err("PACK_EXPIRED".into());
                }
                for item in &mut pack.files {
                    if matches!(item.status.as_str(), "error" | "cancelled" | "downloading") {
                        item.status = "pending".into();
                        item.downloaded_bytes = 0;
                        item.error = None;
                    }
                }
            }
            "pause" | "cancel" | "remove" => {
                pack.active_run = None;
                pack.auto_resume = false;
                pack.status = if action == "cancel" {
                    "cancelled"
                } else {
                    "paused"
                }
                .into();
                pack.waiting_reason = None;
                for item in &mut pack.files {
                    if item.status == "downloading" {
                        item.status = "pending".into();
                        item.downloaded_bytes = 0;
                    }
                }
            }
            _ => return Err("Unknown offline pack action".into()),
        }
        save(store, &mut pack)?;
        Ok(pack)
    })
}

#[tauri::command]
pub async fn cmd_offline_pack_action(
    app: tauri::AppHandle,
    owner_id: String,
    pack_id: String,
    action: String,
    file_key: Option<String>,
) -> Result<Option<OfflinePack>> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let account = AccountGuard::open(&root, Some(&owner_id))?;
    maintain(&root, account.owner)?;
    let key = job_key(&root, account.owner, &pack_id);
    if matches!(action.as_str(), "start" | "retry") {
        let running = jobs().get(&key).cloned();
        if let Some(cancelled) = running {
            if cancelled.load(Ordering::SeqCst) {
                wait_for_stopped(&key).await?;
            } else {
                return read_pack(&Store::open(&root, account.owner)?, &pack_id).map(Some);
            }
        }
    }
    if matches!(action.as_str(), "pause" | "cancel" | "remove") {
        if let Some(cancelled) = jobs().get(&key) {
            cancelled.store(true, Ordering::SeqCst);
        }
    }
    let pack = update_action(
        &Store::open(&root, account.owner)?,
        &pack_id,
        &action,
        file_key.as_deref(),
    )?;
    account.validate()?;
    if matches!(action.as_str(), "start" | "retry" | "retry_file") {
        return launch(app, account, pack_id).map(Some);
    }
    if action == "remove" {
        // Download cancellation drops the future and its private partial. Wait
        // for that cleanup before deleting the retained tree or database record.
        wait_for_stopped(&key).await?;
        account.validate()?;
        let path = pack_directory(&root, account.owner, &pack_id)?;
        // A failed file deletion must retain the record so the user can retry.
        if path.exists() {
            std::fs::remove_dir_all(path).map_err(|e| format!("STORAGE_UNAVAILABLE: {e}"))?;
        }
        Store::open(&root, account.owner)?.remove_record(KIND, &pack_id)?;
        emit(&app, &account, &pack_id);
        return Ok(None);
    }
    emit(&app, &account, &pack_id);
    Ok(Some(pack))
}

async fn wait_for_stopped(key: &str) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(20), async {
        while jobs().contains_key(key) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "PACK_BUSY: Waiting for the current file to stop".into())
}

#[tauri::command]
pub fn cmd_offline_pack_path(
    app: tauri::AppHandle,
    owner_id: String,
    pack_id: String,
    file_key: String,
) -> Result<String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    verified_path(&root, &owner_id, &pack_id, &file_key)
}

/// The same local-only verification is available to debug device instrumentation.
/// It never connects to Telegram and does not trust the recorded ready status alone.
pub fn verified_path(root: &Path, owner_id: &str, pack_id: &str, file_key: &str) -> Result<String> {
    let account = AccountGuard::open(root, Some(owner_id))?;
    maintain(root, account.owner)?;
    let pack = read_pack(&Store::open(root, account.owner)?, pack_id)?;
    if pack.status == "expired" {
        return Err("PACK_EXPIRED".into());
    }
    let item = pack
        .files
        .iter()
        .find(|item| item.file.key == file_key && item.status == "ready")
        .ok_or("OFFLINE_FILE_INCOMPLETE")?;
    let path = existing_path(root, account.owner, &pack, item)?;
    account.validate()?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sign_in(root: &Path, owner: i64) {
        use grammers_session::{storages::SqliteSession, types::PeerInfo, Session};
        let session = SqliteSession::open(root.join("telegram.session")).unwrap();
        sqlite::open(root.join("telegram.session"))
            .unwrap()
            .execute("DELETE FROM peer_info")
            .unwrap();
        session.cache_peer(&PeerInfo::User {
            id: owner,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        });
        assert_eq!(crate::workspace::current_owner(root).unwrap(), owner);
    }
    fn setup() -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(format!("trip-pack-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root, 12).unwrap();
        let files = (1..=3)
            .map(|id| crate::models::FileMetadata {
                id,
                folder_id: None,
                name: format!("File{id}.txt"),
                size: 4,
                mime_type: Some("text/plain".into()),
                file_ext: Some("txt".into()),
                created_at: "2026-09-10T00:00:00Z".into(),
                icon_type: "file".into(),
                encryption_state: "plain".into(),
                is_favorite: false,
                is_pinned: false,
            })
            .collect::<Vec<_>>();
        store.remember_files(&files, "Saved", "scan").unwrap();
        (root, store)
    }
    #[test]
    fn full_selection_is_durable_and_never_adopted_by_another_account() {
        let (root, store) = setup();
        let pack = create_record(
            &store,
            "Trip".into(),
            vec!["saved:1".into(), "saved:2".into(), "saved:3".into()],
            true,
            None,
        )
        .unwrap();
        assert_eq!(pack.files.len(), 3);
        assert_eq!(required_bytes(&pack).unwrap(), 12);
        drop(store);
        assert_eq!(
            Store::open(&root, 12)
                .unwrap()
                .records::<OfflinePack>(KIND)
                .unwrap()[0]
                .files
                .len(),
            3
        );
        assert!(Store::open(&root, 13)
            .unwrap()
            .records::<OfflinePack>(KIND)
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restart_keeps_verified_files_and_resets_interrupted_file_without_claiming_readiness() {
        let (root, store) = setup();
        let mut pack = create_record(
            &store,
            "Trip".into(),
            vec!["saved:1".into(), "saved:2".into()],
            false,
            None,
        )
        .unwrap();
        let path = target(&root, 12, &pack, &pack.files[0].file).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"good").unwrap();
        pack.files[0].status = "ready".into();
        pack.files[0].downloaded_bytes = 4;
        pack.files[1].status = "downloading".into();
        pack.files[1].downloaded_bytes = 2;
        pack.status = "running".into();
        pack.auto_resume = true;
        pack.active_run = Some("old-process".into());
        save(&store, &mut pack).unwrap();
        let fixed = maintain(&root, 12).unwrap().remove(0);
        assert_eq!(fixed.status, "queued");
        assert_eq!(fixed.files[0].status, "ready");
        assert_eq!(fixed.files[1].status, "pending");
        assert_eq!(fixed.files[1].downloaded_bytes, 0);
        assert_eq!(required_bytes(&fixed).unwrap(), 4);
        assert_eq!(
            existing_path(&root, 12, &fixed, &fixed.files[0]).unwrap(),
            path.canonicalize().unwrap()
        );
        assert!(existing_path(&root, 13, &fixed, &fixed.files[0]).is_err());
        std::fs::write(&path, b"bad").unwrap();
        assert_eq!(maintain(&root, 12).unwrap()[0].files[0].status, "pending");
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn expiry_and_disposable_cache_clear_preserve_other_kept_files() {
        let (root, store) = setup();
        let mut pack =
            create_record(&store, "Trip".into(), vec!["saved:1".into()], false, None).unwrap();
        let path = target(&root, 12, &pack, &pack.files[0].file).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"good").unwrap();
        let sibling = offline_root(&root, 12).join("other-retained");
        std::fs::write(&sibling, b"kept").unwrap();
        crate::workspace::device_cache::clear(&root, &root.join("cache")).unwrap();
        assert!(path.exists());
        pack.expires_at = Some(now() - 1);
        save(&store, &mut pack).unwrap();
        assert_eq!(maintain(&root, 12).unwrap()[0].status, "expired");
        assert!(!path.exists());
        assert_eq!(std::fs::read(&sibling).unwrap(), b"kept");
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_network_parsers_identify_default_route_wifi_and_fail_closed() {
        let ports="Hardware Port: Ethernet\nDevice: en1\nEthernet Address: 00\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 00\n";
        assert!(parse_macos_network("route to: default\n interface: en0\n", ports).wifi);
        assert!(!parse_macos_network("interface: en1", ports).wifi);
        assert!(!parse_macos_network("interface: utun4", ports).wifi);
        assert!(!parse_macos_network("invalid", ports).known);
        let routes="Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 00000000 0003 0 0 200 00000000\nwlan0 00000000 00000000 0003 0 0 100 00000000";
        assert_eq!(linux_default_interface(routes).as_deref(), Some("wlan0"));
        assert!(
            linux_default_interface("Iface Destination\n../../bad 00000000 x 0003 0 0 0 x")
                .is_none()
        );
        assert!(parse_windows_network(r#"{"connected":true,"wifi":true}"#).wifi);
        assert!(!parse_windows_network(r#"{"connected":true,"wifi":false}"#).wifi);
        assert!(!parse_windows_network("broken").known);
        assert_eq!(
            NetworkStatus::unknown().reason(true).as_deref(),
            Some("NETWORK_STATUS_UNKNOWN")
        );
    }
    #[test]
    fn restart_recovers_verified_rename_before_readiness_was_saved() {
        let (root, store) = setup();
        let mut pack =
            create_record(&store, "Trip".into(), vec!["saved:1".into()], true, None).unwrap();
        let path = target(&root, 12, &pack, &pack.files[0].file).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"good").unwrap();
        pack.files[0].status = "downloading".into();
        pack.status = "running".into();
        pack.active_run = Some("previous-process".into());
        pack.auto_resume = true;
        save(&store, &mut pack).unwrap();
        let restored = maintain(&root, 12).unwrap().remove(0);
        assert_eq!(restored.status, "ready");
        assert_eq!(restored.files[0].downloaded_bytes, 4);
        assert!(!restored.auto_resume);
        assert!(restored.active_run.is_none());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_expiry_cleanup_keeps_record_for_a_later_retry() {
        let (root, store) = setup();
        let mut pack =
            create_record(&store, "Trip".into(), vec!["saved:1".into()], false, None).unwrap();
        let directory = pack_directory(&root, 12, &pack.id).unwrap();
        std::fs::create_dir_all(directory.parent().unwrap()).unwrap();
        // A damaged directory entry produces a deterministic deletion failure.
        std::fs::write(&directory, b"not a directory").unwrap();
        pack.expires_at = Some(now() - 1);
        save(&store, &mut pack).unwrap();
        assert!(maintain(&root, 12).is_err());
        assert!(store
            .record::<OfflinePack>(KIND, &pack.id)
            .unwrap()
            .is_some());
        std::fs::remove_file(&directory).unwrap();
        assert_eq!(maintain(&root, 12).unwrap()[0].status, "expired");
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn per_file_actions_preserve_completed_copies_and_reject_stale_workers() {
        let (root, store) = setup();
        sign_in(&root, 12);
        let account = AccountGuard::open(&root, Some("12")).unwrap();
        let mut pack = create_record(
            &store,
            "Trip".into(),
            vec!["saved:1".into(), "saved:2".into()],
            false,
            None,
        )
        .unwrap();
        pack.files[0].status = "ready".into();
        pack.files[0].downloaded_bytes = 4;
        pack.files[1].status = "downloading".into();
        pack.files[1].downloaded_bytes = 2;
        pack.active_run = Some("current".into());
        save(&store, &mut pack).unwrap();
        let stopped = update_action(&store, &pack.id, "cancel_file", Some("saved:2")).unwrap();
        assert_eq!(stopped.files[0].downloaded_bytes, 4);
        assert_eq!(stopped.files[1].status, "cancelled");
        assert!(file_cancelled(&account, &pack.id, "current", 1));
        let retried = update_action(&store, &pack.id, "retry_file", Some("saved:2")).unwrap();
        assert_eq!(retried.files[1].status, "pending");
        assert_eq!(retried.files[0].status, "ready");
        update_action(&store, &pack.id, "pause", None).unwrap();
        assert!(mutate_running(&account, &pack.id, "current", |pack| {
            pack.files[1].status = "ready".into();
        })
        .is_err());
        assert_eq!(
            read_pack(&store, &pack.id).unwrap().files[1].status,
            "pending"
        );
        // Changing the authenticated self peer also invalidates an active guard.
        sign_in(&root, 13);
        assert!(account.validate().is_err());
        assert!(file_cancelled(&account, &pack.id, "current", 1));
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
