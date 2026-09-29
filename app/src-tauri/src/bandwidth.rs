use chrono::{Datelike, Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BandwidthStats {
    /// Monday that starts the current quota window. Kept as `date` for
    /// backwards compatibility with existing bandwidth.json files.
    pub date: String,
    pub up_bytes: u64,
    pub down_bytes: u64,
    #[serde(default = "weekly_limit_bytes")]
    pub limit_bytes: u64,
    #[serde(default = "weekly_period_name")]
    pub period: String,
}

const WEEKLY_LIMIT_BYTES: u64 = 250 * 1024 * 1024 * 1024;

fn weekly_limit_bytes() -> u64 {
    WEEKLY_LIMIT_BYTES
}
fn weekly_period_name() -> String {
    "weekly".to_string()
}

fn week_start_for(date: NaiveDate) -> NaiveDate {
    date - Duration::days(date.weekday().num_days_from_monday() as i64)
}

impl Default for BandwidthStats {
    fn default() -> Self {
        let week_start = week_start_for(Local::now().date_naive());
        Self {
            date: week_start.format("%Y-%m-%d").to_string(),
            up_bytes: 0,
            down_bytes: 0,
            limit_bytes: WEEKLY_LIMIT_BYTES,
            period: weekly_period_name(),
        }
    }
}

pub struct BandwidthManager {
    pub file_path: PathBuf,
    pub stats: Mutex<BandwidthStats>,
    pub limit: u64, // Weekly limit in bytes
}

#[derive(Clone, Copy)]
enum ReservationDirection {
    Upload,
    Download,
}

/// Releases a bandwidth reservation automatically on every error/cancellation
/// path. Successful transfers call `commit` so their bytes remain accounted.
pub struct BandwidthReservation {
    manager: std::sync::Arc<BandwidthManager>,
    bytes: u64,
    direction: ReservationDirection,
    committed: bool,
}

impl BandwidthReservation {
    pub fn upload(manager: std::sync::Arc<BandwidthManager>, bytes: u64) -> Result<Self, String> {
        manager.try_reserve_up(bytes)?;
        Ok(Self {
            manager,
            bytes,
            direction: ReservationDirection::Upload,
            committed: false,
        })
    }

    pub fn download(manager: std::sync::Arc<BandwidthManager>, bytes: u64) -> Result<Self, String> {
        manager.try_reserve_down(bytes)?;
        Ok(Self {
            manager,
            bytes,
            direction: ReservationDirection::Download,
            committed: false,
        })
    }

    pub fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for BandwidthReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        match self.direction {
            ReservationDirection::Upload => self.manager.release_up(self.bytes),
            ReservationDirection::Download => self.manager.release_down(self.bytes),
        }
    }
}

impl BandwidthManager {
    pub fn new(app_handle: &tauri::AppHandle) -> Self {
        // Resolve app data directory
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("data"));

        if !app_data_dir.exists() {
            let _ = std::fs::create_dir_all(&app_data_dir);
        }
        let file_path = app_data_dir.join("bandwidth.json");

        let stats = if file_path.exists() {
            let content = fs::read_to_string(&file_path).unwrap_or_default();
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            BandwidthStats::default()
        };

        Self {
            file_path,
            stats: Mutex::new(stats),
            limit: WEEKLY_LIMIT_BYTES,
        }
    }

    pub fn check_and_reset(&self) {
        let today = Local::now().date_naive();
        let week_start = week_start_for(today);
        let mut stats = self.stats.lock().unwrap();
        let previous = stats.clone();
        let stored_date = NaiveDate::parse_from_str(&stats.date, "%Y-%m-%d").ok();
        let belongs_to_current_week = stored_date
            .map(|date| date >= week_start && date <= today)
            .unwrap_or(false);
        let canonical_date = week_start.format("%Y-%m-%d").to_string();
        let metadata_changed = stats.date != canonical_date
            || stats.limit_bytes != self.limit
            || stats.period != "weekly";

        if !belongs_to_current_week {
            println!(
                "[Bandwidth] New week detected. Resetting stats. Old period: {}, New period: {}",
                stats.date, week_start
            );
            stats.up_bytes = 0;
            stats.down_bytes = 0;
        }
        // Canonicalize legacy daily files without discarding usage recorded
        // earlier in the same week, and keep API metadata authoritative.
        stats.date = canonical_date;
        stats.limit_bytes = self.limit;
        stats.period = weekly_period_name();
        if !belongs_to_current_week || metadata_changed {
            if let Err(error) = self.save_locked(&stats) {
                *stats = previous;
                log::error!("Unable to persist the bandwidth period rollover: {error}");
            }
        }
    }

    /// Atomically check the limit AND reserve bandwidth for an upload.
    /// Call release_up() if the transfer fails to avoid permanently consuming quota.
    pub fn try_reserve_up(&self, bytes: u64) -> Result<(), String> {
        self.check_and_reset();
        let mut stats = self.stats.lock().unwrap();
        let total = stats
            .up_bytes
            .checked_add(stats.down_bytes)
            .and_then(|used| used.checked_add(bytes))
            .ok_or_else(|| "Bandwidth accounting overflowed".to_string())?;
        if total > self.limit {
            return Err(format!(
                "Weekly bandwidth limit ({}) exceeded! Used: {}",
                self.format_bytes(self.limit),
                self.format_bytes(total)
            ));
        }
        let previous = stats.clone();
        stats.up_bytes = stats
            .up_bytes
            .checked_add(bytes)
            .ok_or_else(|| "Bandwidth accounting overflowed".to_string())?;
        if let Err(error) = self.save_locked(&stats) {
            *stats = previous;
            return Err(error);
        }
        Ok(())
    }

    /// Atomically check the limit AND reserve bandwidth for a download.
    /// Call release_down() if the transfer fails to avoid permanently consuming quota.
    pub fn try_reserve_down(&self, bytes: u64) -> Result<(), String> {
        self.check_and_reset();
        let mut stats = self.stats.lock().unwrap();
        let total = stats
            .up_bytes
            .checked_add(stats.down_bytes)
            .and_then(|used| used.checked_add(bytes))
            .ok_or_else(|| "Bandwidth accounting overflowed".to_string())?;
        if total > self.limit {
            return Err(format!(
                "Weekly bandwidth limit ({}) exceeded! Used: {}",
                self.format_bytes(self.limit),
                self.format_bytes(total)
            ));
        }
        let previous = stats.clone();
        stats.down_bytes = stats
            .down_bytes
            .checked_add(bytes)
            .ok_or_else(|| "Bandwidth accounting overflowed".to_string())?;
        if let Err(error) = self.save_locked(&stats) {
            *stats = previous;
            return Err(error);
        }
        Ok(())
    }

    /// Release reserved upload bandwidth after a failed transfer.
    pub fn release_up(&self, bytes: u64) {
        let mut stats = self.stats.lock().unwrap();
        let previous = stats.clone();
        stats.up_bytes = stats.up_bytes.saturating_sub(bytes);
        if let Err(error) = self.save_locked(&stats) {
            *stats = previous;
            log::error!("Unable to release an upload bandwidth reservation: {error}");
        }
    }

    /// Release reserved download bandwidth after a failed transfer.
    pub fn release_down(&self, bytes: u64) {
        let mut stats = self.stats.lock().unwrap();
        let previous = stats.clone();
        stats.down_bytes = stats.down_bytes.saturating_sub(bytes);
        if let Err(error) = self.save_locked(&stats) {
            *stats = previous;
            log::error!("Unable to release a download bandwidth reservation: {error}");
        }
    }

    fn save_locked(&self, stats: &BandwidthStats) -> Result<(), String> {
        persist_stats_atomically(&self.file_path, stats)
    }

    pub fn get_stats(&self) -> BandwidthStats {
        self.check_and_reset();
        self.stats.lock().unwrap().clone()
    }

    fn format_bytes(&self, bytes: u64) -> String {
        const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
        let mut v = bytes as f64;
        let mut i = 0;
        while v >= 1024.0 && i < UNITS.len() - 1 {
            v /= 1024.0;
            i += 1;
        }
        format!("{:.2} {}", v, UNITS[i])
    }
}

fn persist_stats_atomically(path: &Path, stats: &BandwidthStats) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Bandwidth data path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".bandwidth.{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(stats).map_err(|error| error.to_string())?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        atomic_replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    if !destination.exists() {
        return fs::rename(source, destination).map_err(|error| error.to_string());
    }
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}
