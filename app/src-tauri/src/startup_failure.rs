//! Tells the user why the application could not start instead of exiting
//! silently. Runs before any window exists, so it uses a native dialog and
//! plain English: the translated interface has not been loaded yet.
use std::path::{Path, PathBuf};

/// What to tell the user for a setup error. Kept separate from the dialog so
/// the same text reaches the log and can be checked without a display.
pub fn describe(error: &str, log_file: Option<&Path>) -> String {
    let reason = error
        .strip_prefix("error encountered during setup hook: ")
        .unwrap_or(error)
        .trim();
    let mut message = String::from(
        "Telegram Drive could not finish starting, so it closed before opening its window.\n\n",
    );
    message.push_str("Reason: ");
    message.push_str(&crate::app_log::redact(reason));
    message.push_str(
        "\n\nNothing was deleted. Your files are still in Telegram and the data on this device was left as it was.",
    );
    let lowered = reason.to_ascii_lowercase();
    // The database refuses to open data written by a later release.
    if lowered.contains("supports up to") || lowered.contains("newer version") {
        message.push_str(
            "\n\nThis usually means an older version was installed over a newer one. Install the latest release again; saved data cannot be opened by an older version.",
        );
    }
    if let Some(log_file) = log_file {
        message.push_str("\n\nDetails were written to:\n");
        message.push_str(&log_file.display().to_string());
    }
    message
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn open_folder(folder: &Path) {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    let mut command = std::process::Command::new(program);
    command.arg(folder);
    crate::process_util::hide_console_blocking(&mut command);
    let _ = command.spawn();
}

/// Record the failure and show it. Returns after the user dismisses the
/// dialog; the caller then exits.
pub fn report(error: &str) {
    let log_file: Option<PathBuf> = crate::app_log::file_path();
    log::error!("Startup failed: {error}");
    log::logger().flush();
    let message = describe(error, log_file.as_deref());
    eprintln!("{message}");

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let dialog = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("Telegram Drive could not start")
            .set_description(message);
        match log_file.as_deref().and_then(Path::parent) {
            Some(folder) => {
                let open_logs = "Open log folder".to_string();
                let choice = dialog
                    .set_buttons(rfd::MessageButtons::OkCancelCustom(
                        open_logs.clone(),
                        "Quit".to_string(),
                    ))
                    .show();
                if matches!(choice, rfd::MessageDialogResult::Ok)
                    || matches!(&choice, rfd::MessageDialogResult::Custom(label) if *label == open_logs)
                {
                    open_folder(folder);
                }
            }
            None => {
                dialog.set_buttons(rfd::MessageButtons::Ok).show();
            }
        }
    }
}
