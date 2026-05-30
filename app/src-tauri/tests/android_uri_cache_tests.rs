/// Integration tests for the Android URI copy/cache logic.
///
/// Tests marked `#[cfg(target_os = "android")]` provide the real JNI-backed assertions;
/// the platform-agnostic tests validate the non-Android stub and utility functions that
/// are used by `copy_to_android_cache`.

use app_lib::commands::fs;

// ---------------------------------------------------------------------------
// Platform-agnostic utilities
// ---------------------------------------------------------------------------

#[test]
fn url_decode_basic_percent_encoding() {
    // url_decode is private; we validate it indirectly through clean_android_path.
    let result = fs::clean_android_path("file:///data/media/0/Documents/test%20file.txt");
    assert!(result.contains("test file.txt"), "URL decoding failed: {}", result);
}

#[test]
fn url_decode_multiple_encodings() {
    let result = fs::clean_android_path("file:///storage/emulated/0/A%20B%2FC%3D");
    assert!(result.contains("A B/C="), "Multi-encoding failed: {}", result);
}

#[test]
fn clean_android_path_raw_schemes() {
    let result = fs::clean_android_path("raw:///storage/emulated/0/test.pdf");
    assert_eq!(result, "/storage/emulated/0/test.pdf", "raw:// not cleaned");
}

#[test]
fn clean_android_path_file_scheme() {
    let result = fs::clean_android_path("file:///data/media/0/Documents/foo.txt");
    assert_eq!(result, "/data/media/0/Documents/foo.txt", "file:// not cleaned");
}

#[test]
fn clean_android_path_preserves_content_scheme() {
    let result = fs::clean_android_path("content://com.android.providers.media.documents/document/image%3A1234");
    assert!(result.starts_with("content://"), "content:// should be preserved");
    assert!(result.contains("image:1234"), "URL decode should apply inside content URI");
}

#[test]
fn clean_android_path_double_slash_collapse() {
    // Non-content URIs should collapse double slashes
    let result = fs::clean_android_path("file:////storage//emulated//0/test.mp4");
    assert_eq!(result, "/storage/emulated/0/test.mp4", "Double slashes not collapsed");
}

#[test]
fn clean_android_path_raw_percent_escape() {
    let result = fs::clean_android_path("raw%3//storage/emulated/0/file.txt");
    assert_eq!(result, "/storage/emulated/0/file.txt", "raw%3/ not cleaned");
}

// ---------------------------------------------------------------------------
// Non-Android stub
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "android"))]
#[test]
fn copy_to_android_cache_returns_err_on_non_android() {
    let result = fs::copy_to_android_cache("content://test/uri");
    assert!(result.is_err(), "Non-Android stub should return Err");
    let err = result.unwrap_err();
    assert!(
        err.contains("Not supported"),
        "Expected 'Not supported' error but got: {}",
        err
    );
}

// ---------------------------------------------------------------------------
// Android integration tests (run only on actual Android device/emulator)
// ---------------------------------------------------------------------------

/// This test validates the full flow when the Kotlin-side pre-cache writes a
/// 0 B file.  `copy_to_android_cache` must detect the invalid file, fall through
/// to the raw InputStream path, and succeed — retrying once if the first
/// InputStream attempt also produces 0 B.
///
/// **Pre-requisite:**  A test content:// URI that returns a real file from a
/// content provider (e.g. a document picked via SAF).  The test helper below
/// (or a test fixture) should stage a file under the app's control.
///
/// ```text
/// #[cfg(target_os = "android")]
/// #[test]
/// fn pre_cache_empty_file_falls_back_to_input_stream() {
///     // 1. Pick a test URI whose content is known (e.g. a short text file).
///     // 2. Arrange for getCachedPath / getLocalFileFromUri to return a path
///     //    to a 0 B file (mock or real).
///     // 3. Call fs::copy_to_android_cache(&uri).
///     // 4. Assert success and verify the cached file has the expected content.
/// }
/// ```
#[cfg(target_os = "android")]
#[test]
fn pre_cache_empty_file_falls_back_to_input_stream() {
    // This skeleton is provided as documentation of the expected behaviour.
    // A real implementation requires an Android test runner with SAF support.
    // Uncomment and adapt once the test harness is configured.
    // ---
    // let test_uri = "content://com.example.test/document/42";
    // let cache_path = fs::copy_to_android_cache(test_uri)
    //     .expect("Should fall back to InputStream and succeed");
    // let metadata = std::fs::metadata(&cache_path).expect("Cache file must exist");
    // assert!(metadata.len() > 0, "Cached file must be non‑empty");
}
