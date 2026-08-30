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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_packaged_pacman_launcher() {
        assert_eq!(
            installation_info(Some(OsStr::new("pacman"))),
            InstallationInfo {
                managed_by_package_manager: true,
                package_manager: Some("pacman".to_string()),
            }
        );
        assert_eq!(
            installation_info(Some(OsStr::new("PACMAN"))),
            InstallationInfo {
                managed_by_package_manager: true,
                package_manager: Some("pacman".to_string()),
            }
        );
    }

    #[test]
    fn leaves_other_installations_self_managed() {
        for value in [None, Some(OsStr::new("")), Some(OsStr::new("unknown"))] {
            assert_eq!(
                installation_info(value),
                InstallationInfo {
                    managed_by_package_manager: false,
                    package_manager: None,
                }
            );
        }
    }
}
