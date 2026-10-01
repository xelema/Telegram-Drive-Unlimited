use actix_web::dev::ServerHandle;
use std::sync::{Arc, Mutex};

#[cfg(not(target_os = "android"))]
use std::io;
#[cfg(not(target_os = "android"))]
use std::net::{Ipv4Addr, TcpListener};
#[cfg(not(target_os = "android"))]
use std::time::Duration;

#[cfg(not(target_os = "android"))]
const BIND_RETRY_DELAYS: [Duration; 5] = [
    Duration::from_millis(25),
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(400),
];

struct GenerationHandle {
    generation: u64,
    handle: ServerHandle,
}

#[derive(Default)]
struct LifecycleState {
    generation: u64,
    handle: Option<GenerationHandle>,
    running: bool,
    last_error: Option<String>,
}

/// Coordinates one restartable local Actix server.
///
/// Generation changes and handle installation share the same synchronous lock,
/// so a server from an obsolete settings update can never publish itself over a
/// newer generation. The async operation lock serializes stop/bind transitions
/// without blocking Tauri's worker threads.
pub struct LocalServerLifecycle {
    state: Mutex<LifecycleState>,
    operation: tokio::sync::Mutex<()>,
}

impl LocalServerLifecycle {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(LifecycleState::default()),
            operation: tokio::sync::Mutex::new(()),
        })
    }

    /// Reserve a new desired configuration and clear visible runtime state
    /// immediately. The existing listener is stopped by the serialized restart
    /// operation, but the UI never reports it as current after this point.
    pub fn request_restart(&self) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.checked_add(1).unwrap_or(1);
        state.running = false;
        state.last_error = None;
        state.generation
    }

    pub async fn lock_operation(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.operation.lock().await
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .generation
            == generation
    }

    pub fn install_handle(&self, generation: u64, handle: ServerHandle) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.generation != generation {
            return false;
        }
        state.handle = Some(GenerationHandle { generation, handle });
        state.running = true;
        state.last_error = None;
        true
    }

    pub fn take_handle(&self) -> Option<ServerHandle> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.running = false;
        state.handle.take().map(|entry| entry.handle)
    }

    pub fn server_finished(&self, generation: u64, error: Option<String>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state
            .handle
            .as_ref()
            .is_some_and(|entry| entry.generation == generation)
        {
            state.handle = None;
        }
        if state.generation == generation {
            state.running = false;
            if let Some(error) = error {
                state.last_error = Some(error);
            }
        }
    }

    pub fn set_error(&self, generation: u64, error: String) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generation == generation {
            state.running = false;
            state.last_error = Some(error);
        }
    }

    pub fn status(&self) -> (bool, Option<String>) {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        (state.running, state.last_error.clone())
    }

    pub fn begin_shutdown(&self) -> Option<ServerHandle> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.checked_add(1).unwrap_or(1);
        state.running = false;
        state.handle.take().map(|entry| entry.handle)
    }
}

#[cfg(not(target_os = "android"))]
pub async fn bind_loopback_with_retry(
    port: u16,
    lifecycle: &LocalServerLifecycle,
    generation: u64,
) -> Result<Option<TcpListener>, io::Error> {
    bind_loopback_with_delays(port, &BIND_RETRY_DELAYS, || {
        lifecycle.is_current(generation)
    })
    .await
}

#[cfg(not(target_os = "android"))]
async fn bind_loopback_with_delays<F>(
    port: u16,
    retry_delays: &[Duration],
    mut should_continue: F,
) -> Result<Option<TcpListener>, io::Error>
where
    F: FnMut() -> bool,
{
    let address = (Ipv4Addr::LOCALHOST, port);
    let mut attempt = 0usize;
    loop {
        if !should_continue() {
            return Ok(None);
        }
        match TcpListener::bind(address) {
            Ok(listener) => return Ok(Some(listener)),
            Err(error)
                if error.kind() == io::ErrorKind::AddrInUse && attempt < retry_delays.len() =>
            {
                tokio::time::sleep(retry_delays[attempt]).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}
