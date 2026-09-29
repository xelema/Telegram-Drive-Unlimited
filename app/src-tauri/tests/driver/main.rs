//! Opt-in native backend process used exclusively by tests/native_e2e.rs.
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(error) = app_lib::native_e2e::run().await {
        eprintln!("Native E2E driver failed: {error}");
        std::process::exit(1);
    }
}
