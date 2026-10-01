use serde::Serialize;
use std::ffi::OsStr;

pub const PACMAN_ENVIRONMENT_VALUE: &str = "pacman";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationInfo {
    pub managed_by_package_manager: bool,
    pub package_manager: Option<String>,
}

fn installation_info(value: Option<&OsStr>) -> InstallationInfo {
    let package_manager = value
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|value| value.eq_ignore_ascii_case(PACMAN_ENVIRONMENT_VALUE));

    InstallationInfo {
        managed_by_package_manager: package_manager.is_some(),
        package_manager: package_manager.map(|_| PACMAN_ENVIRONMENT_VALUE.to_string()),
    }
}

pub fn current_installation_info() -> InstallationInfo {
    installation_info(std::env::var_os("TELEGRAM_DRIVE_PACKAGE_MANAGER").as_deref())
}

#[tauri::command]
pub fn cmd_get_installation_info() -> InstallationInfo {
    current_installation_info()
}
