use chrono::{Datelike, Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
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
            self.save_locked(&stats);
        }
    }

    pub fn can_transfer(&self, bytes: u64) -> Result<(), String> {
        self.check_and_reset();
        let stats = self.stats.lock().unwrap();
        let total = stats.up_bytes + stats.down_bytes + bytes;
        if total > self.limit {
            return Err(format!(
                "Weekly bandwidth limit ({}) exceeded! Used: {}",
                self.format_bytes(self.limit),
                self.format_bytes(total)
            ));
        }
        Ok(())
    }

    /// Atomically check the limit AND reserve bandwidth for an upload.
    /// Call release_up() if the transfer fails to avoid permanently consuming quota.
    pub fn try_reserve_up(&self, bytes: u64) -> Result<(), String> {
        self.check_and_reset();
        let mut stats = self.stats.lock().unwrap();
        let total = stats.up_bytes + stats.down_bytes + bytes;
        if total > self.limit {
            return Err(format!(
                "Weekly bandwidth limit ({}) exceeded! Used: {}",
                self.format_bytes(self.limit),
                self.format_bytes(total)
            ));
        }
        stats.up_bytes += bytes;
        self.save_locked(&stats);
        Ok(())
    }

    /// Atomically check the limit AND reserve bandwidth for a download.
    /// Call release_down() if the transfer fails to avoid permanently consuming quota.
    pub fn try_reserve_down(&self, bytes: u64) -> Result<(), String> {
        self.check_and_reset();
        let mut stats = self.stats.lock().unwrap();
        let total = stats.up_bytes + stats.down_bytes + bytes;
        if total > self.limit {
            return Err(format!(
                "Weekly bandwidth limit ({}) exceeded! Used: {}",
                self.format_bytes(self.limit),
                self.format_bytes(total)
            ));
        }
        stats.down_bytes += bytes;
        self.save_locked(&stats);
        Ok(())
    }

    /// Release reserved upload bandwidth after a failed transfer.
    pub fn release_up(&self, bytes: u64) {
        let mut stats = self.stats.lock().unwrap();
        stats.up_bytes = stats.up_bytes.saturating_sub(bytes);
        self.save_locked(&stats);
    }

    /// Release reserved download bandwidth after a failed transfer.
    pub fn release_down(&self, bytes: u64) {
        let mut stats = self.stats.lock().unwrap();
        stats.down_bytes = stats.down_bytes.saturating_sub(bytes);
        self.save_locked(&stats);
    }

    pub fn add_up(&self, bytes: u64) {
        self.check_and_reset();
        let mut stats = self.stats.lock().unwrap();
        stats.up_bytes += bytes;
        self.save_locked(&stats);
    }

    pub fn add_down(&self, bytes: u64) {
        self.check_and_reset();
        let mut stats = self.stats.lock().unwrap();
        stats.down_bytes += bytes;
        self.save_locked(&stats);
    }

    fn save_locked(&self, stats: &BandwidthStats) {
        if let Ok(json) = serde_json::to_string(stats) {
            let _ = fs::write(&self.file_path, json);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_manager(label: &str) -> std::sync::Arc<BandwidthManager> {
        let path = std::env::temp_dir().join(format!(
            "telegram-drive-bandwidth-{label}-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::sync::Arc::new(BandwidthManager {
            file_path: path,
            stats: Mutex::new(BandwidthStats::default()),
            limit: WEEKLY_LIMIT_BYTES,
        })
    }

    #[test]
    fn week_starts_on_monday() {
        assert_eq!(
            week_start_for(NaiveDate::from_ymd_opt(2026, 8, 23).unwrap()),
            NaiveDate::from_ymd_opt(2026, 8, 17).unwrap()
        );
        assert_eq!(
            week_start_for(NaiveDate::from_ymd_opt(2026, 8, 24).unwrap()),
            NaiveDate::from_ymd_opt(2026, 8, 24).unwrap()
        );
    }

    #[test]
    fn legacy_daily_stats_receive_weekly_defaults() {
        let stats: BandwidthStats =
            serde_json::from_str(r#"{"date":"2026-08-20","up_bytes":10,"down_bytes":20}"#).unwrap();
        assert_eq!(stats.limit_bytes, WEEKLY_LIMIT_BYTES);
        assert_eq!(stats.period, "weekly");
        assert_eq!(stats.up_bytes + stats.down_bytes, 30);
    }

    #[test]
    fn failed_download_reservations_release_quota_on_drop() {
        let manager = test_manager("release");
        {
            let _reservation = BandwidthReservation::download(manager.clone(), 4096).unwrap();
            assert_eq!(manager.get_stats().down_bytes, 4096);
        }
        assert_eq!(manager.get_stats().down_bytes, 0);
        let _ = std::fs::remove_file(&manager.file_path);
    }

    #[test]
    fn committed_download_reservations_remain_accounted() {
        let manager = test_manager("commit");
        {
            let mut reservation = BandwidthReservation::download(manager.clone(), 4096).unwrap();
            reservation.commit();
        }
        assert_eq!(manager.get_stats().down_bytes, 4096);
        let _ = std::fs::remove_file(&manager.file_path);
    }
}
