//! Cross-platform suspension detection for vault locking.
//!
//! Tauri does not expose a portable desktop suspend event. A monotonic heartbeat
//! detects when the process stopped being scheduled for long enough to represent
//! system sleep. `RunEvent::Resumed` is also forwarded here as an immediate check.

use crate::crypto::state::CryptoState;
use crate::desktop_preferences::DesktopPreferencesState;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const SUSPEND_GAP: Duration = Duration::from_secs(20);

pub struct DesktopPowerMonitor {
    last_heartbeat: Mutex<Instant>,
}

impl DesktopPowerMonitor {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            last_heartbeat: Mutex::new(Instant::now()),
        })
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let monitor = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(HEARTBEAT_INTERVAL).await;
                monitor.check_for_suspend(&app);
            }
        });
    }

    pub fn check_for_suspend(&self, app: &AppHandle) {
        let elapsed = self
            .last_heartbeat
            .lock()
            .map(|mut last| {
                let elapsed = last.elapsed();
                *last = Instant::now();
                elapsed
            })
            .unwrap_or_default();
        if elapsed < SUSPEND_GAP {
            return;
        }
        let lock_on_sleep = app
            .try_state::<DesktopPreferencesState>()
            .map(|state| state.get().lock_on_sleep)
            .unwrap_or(true);
        if !lock_on_sleep {
            return;
        }
        if let Some(crypto_state) = app.try_state::<CryptoState>() {
            crypto_state.lock();
            let _ = app.emit("vault-locked", "system_sleep");
            log::info!("Encryption vault locked after system suspension");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_background_heartbeat_is_not_a_suspend_gap() {
        assert!(HEARTBEAT_INTERVAL < SUSPEND_GAP);
    }
}
