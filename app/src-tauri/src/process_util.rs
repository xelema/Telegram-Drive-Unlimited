//! Child-process helpers shared by media, diagnostics and network probes.

/// Windows `CREATE_NO_WINDOW`. Without it every console helper (FFmpeg,
/// `ipconfig`) briefly opens a terminal window over the application.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Prevents an asynchronous child process from opening a console window.
pub fn hide_console(command: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

/// Prevents a blocking child process from opening a console window.
pub fn hide_console_blocking(command: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}
