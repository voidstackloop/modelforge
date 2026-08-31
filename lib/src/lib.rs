mod datastore;
mod download;
mod error;
mod manager;
mod store;

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;

pub use manager::DownloadManager;

/// Reads a JSON "database" file whole. Returns `null` for a missing file —
/// the TS caller (`app/src/json-store.ts`) treats that exactly like an
/// `ENOENT` from `fs.readFileSync` — and throws for any other I/O failure so
/// it gets logged rather than silently treated as "file doesn't exist".
#[napi]
pub fn read_json_file_native(path: String) -> napi::Result<Option<String>> {
    datastore::read_json_file(&path).map_err(|err| napi::Error::from_reason(err.to_string()))
}

/// Atomically writes `contents` to `path` (temp file + rename). See
/// `datastore::write_json_file_atomic` for why this must match
/// `json-store.ts`'s `writeJson` byte-for-byte.
#[napi]
pub fn write_json_file_atomic_native(path: String, contents: String) -> napi::Result<()> {
    datastore::write_json_file_atomic(&path, &contents)
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

/// SHA-256 hex digest — backs `audit-log-store.ts`'s hash-chain, which
/// otherwise hashes every audit event on every write.
#[napi]
pub fn sha256_hex_native(input: String) -> String {
    datastore::sha256_hex(&input)
}

/// O(1) append onto an existing JSON array file — see
/// `datastore::append_json_array_element` for the full rationale. Returns
/// `false` (not an error) whenever the fast path doesn't apply, so the
/// caller falls back to a full rewrite.
#[napi]
pub fn append_json_array_element_native(path: String, element_json: String) -> napi::Result<bool> {
    datastore::append_json_array_element(&path, &element_json)
        .map_err(|err| napi::Error::from_reason(err.to_string()))
}

#[napi(object)]
#[derive(Clone, Copy)]
pub struct DownloadProgress {
    pub received_bytes: f64,
    pub total_bytes: Option<f64>,
}

/// Downloads a GGUF file from Hugging Face into `dest_path`, resuming an
/// interrupted attempt where possible, using parallel Range-request
/// connections when the server and file size support it (falling back to a
/// single stream otherwise). Mirrors the signature and observable behavior
/// of the TypeScript `downloadGgufFile` it replaces, so callers don't need
/// to change.
///
/// `expected_sha256`, when given, is checked the same way the job-based
/// `DownloadManager` already checks each shard's (see `download::job`'s
/// `run_job_with`) — after the transfer completes, before the caller can
/// treat the file as trustworthy. A mismatch deletes the finished file
/// rather than leaving corrupt bytes behind under a name that looks like a
/// successful download.
#[napi]
pub async fn download_gguf_file(
    model_id: String,
    filename: String,
    dest_path: String,
    token: Option<String>,
    expected_sha256: Option<String>,
    on_progress: ThreadsafeFunction<DownloadProgress>,
) -> napi::Result<()> {
    let on_progress = Arc::new(on_progress);
    let progress_fn: download::ProgressFn = Arc::new(move |received_bytes, total_bytes| {
        let _ = on_progress.call(
            Ok(DownloadProgress {
                received_bytes: received_bytes as f64,
                total_bytes: total_bytes.map(|t| t as f64),
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    });

    let url = download::build_resolve_url(&model_id, &filename).map_err(napi::Error::from)?;

    download::run(
        url,
        filename.clone(),
        dest_path.clone(),
        token,
        progress_fn,
        download::DownloadControls::default(),
    )
    .await
    .map_err(napi::Error::from)?;

    verify_or_cleanup(&dest_path, &filename, expected_sha256.as_deref())
        .await
        .map_err(napi::Error::from)
}

/// Extracted from `download_gguf_file` so it's testable with plain
/// `cargo test` — unlike that function, this takes no `ThreadsafeFunction`,
/// which needs a live JS environment to construct.
async fn verify_or_cleanup(
    dest_path: &str,
    filename: &str,
    expected_sha256: Option<&str>,
) -> Result<(), crate::error::DownloadError> {
    let Some(expected) = expected_sha256 else {
        return Ok(());
    };
    if let Err(e) =
        download::verify::verify_sha256(std::path::Path::new(dest_path), filename, expected).await
    {
        // Corrupt bytes, not an incomplete transfer — same treatment
        // download::job::run_job_with gives a checksum-mismatched shard: the
        // finished file isn't trustworthy and must not be left around to be
        // mistaken for a real, usable model.
        tokio::fs::remove_file(dest_path).await.ok();
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod verify_or_cleanup_tests {
    use super::verify_or_cleanup;
    use tempfile::tempdir;

    #[tokio::test]
    async fn no_expected_hash_skips_verification_and_keeps_the_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.gguf");
        std::fs::write(&path, b"hello world").unwrap();

        verify_or_cleanup(path.to_str().unwrap(), "model.gguf", None)
            .await
            .expect("no expected hash means nothing to check");
        assert!(path.exists());
    }

    #[tokio::test]
    async fn matching_hash_succeeds_and_keeps_the_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.gguf");
        std::fs::write(&path, b"hello world").unwrap();
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

        verify_or_cleanup(path.to_str().unwrap(), "model.gguf", Some(expected))
            .await
            .expect("hash matches");
        assert!(path.exists());
    }

    #[tokio::test]
    async fn mismatched_hash_fails_and_deletes_the_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.gguf");
        std::fs::write(&path, b"hello world").unwrap();

        let err = verify_or_cleanup(
            path.to_str().unwrap(),
            "model.gguf",
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        )
        .await
        .expect_err("hash should not match");

        assert_eq!(err.kind(), "verification_failed");
        assert!(!path.exists(), "a corrupt result must not be left on disk");
    }
}
