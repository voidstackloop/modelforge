mod datastore;
mod download;
mod error;
mod manager;

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
#[napi]
pub async fn download_gguf_file(
    model_id: String,
    filename: String,
    dest_path: String,
    token: Option<String>,
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
        filename,
        dest_path,
        token,
        progress_fn,
        download::DownloadControls::default(),
    )
    .await
    .map_err(napi::Error::from)
}
