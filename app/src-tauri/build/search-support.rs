// Verify the linked SQLite implementation, rather than trusting an environment
// variable that a cached dependency may not have noticed. This runs on the host
// during every application build, including builds invoked outside the repo.
pub(crate) fn verify_search_support() {
    println!("cargo:rerun-if-env-changed=SQLITE_ENABLE_FTS5");
    println!("cargo:rerun-if-changed=build/search-support.rs");
    assert_eq!(
        std::env::var("SQLITE_ENABLE_FTS5").as_deref(),
        Ok("1"),
        "release blocked: .cargo/config.toml must enable SQLITE_ENABLE_FTS5=1"
    );
    let connection = sqlite::open(":memory:").expect("open release search build probe");
    connection
        .execute("CREATE VIRTUAL TABLE release_search_probe USING fts5(name)")
        .expect("release blocked: SQLite lacks FTS5; build from the repository with .cargo/config.toml, then rebuild sqlite3-src");
}
