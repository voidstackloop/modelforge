mod download;
mod error;
mod manager;

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;

pub use manager::DownloadManager;

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
