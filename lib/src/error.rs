use thiserror::Error;

/// Mirrors the error wording `app/src/huggingface.ts`'s `downloadGgufFile`
/// produced, so `main.ts`'s `logger.error(...error.message...)` and any
/// `/incomplete/`-style matching on the message keep working unchanged.
#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("Couldn't reach Hugging Face: {0}")]
    Unreachable(String),

    #[error("Failed to download \"{filename}\" (HTTP {status}).")]
    HttpStatus { filename: String, status: u16 },

    #[error(
        "Download of \"{filename}\" was incomplete (got {received} of {total} bytes) — try downloading it again to resume."
    )]
    Incomplete {
        filename: String,
        received: u64,
        total: u64,
    },

    /// Mid-stream I/O or connection failures are rethrown as-is by the TS
    /// version rather than wrapped in a friendlier message; do the same here.
    #[error("{0}")]
    Raw(String),

    /// A pause request was observed mid-stream — not a failure, but modeled
    /// as one so the same `?`-propagation path that already handles "keep
    /// the .part file, stop here" for network errors handles this too.
    #[error("Download of \"{filename}\" was paused.")]
    Paused { filename: String },

    /// A cancel request was observed mid-stream. Unlike every other variant
    /// here, the caller deletes `.part`/`.part.json` on this one — it's not
    /// meant to be resumed.
    #[error("Download of \"{filename}\" was cancelled.")]
    Cancelled { filename: String },

    #[error("Not enough disk space: {required} bytes required, {available} available.")]
    InsufficientDiskSpace { required: u64, available: u64 },

    #[error("Checksum mismatch for \"{filename}\": expected {expected}, got {actual}.")]
    VerificationFailed {
        filename: String,
        expected: String,
        actual: String,
    },
}

impl DownloadError {
    /// Matches `DownloadErrorKind` in `app/src/download-jobs-store.ts` —
    /// deliberately returns one of that exact set of string literals so the
    /// TS side never needs a second mapping table.
    pub fn kind(&self) -> &'static str {
        match self {
            DownloadError::HttpStatus { status, .. } if *status == 401 || *status == 403 => {
                "auth_required"
            }
            DownloadError::HttpStatus { status, .. } if *status == 404 => "not_found",
            DownloadError::InsufficientDiskSpace { .. } => "disk_space",
            DownloadError::VerificationFailed { .. } => "verification_failed",
            DownloadError::Unreachable(_) | DownloadError::Incomplete { .. } => "network",
            DownloadError::Paused { .. } | DownloadError::Cancelled { .. } => "unknown",
            DownloadError::HttpStatus { .. } | DownloadError::Raw(_) => "unknown",
        }
    }

    /// Whether a fresh attempt (retry / manual resume) is worth trying.
    /// `Paused`/`Cancelled` aren't real failures so they're excluded from
    /// the caller's retry bookkeeping entirely rather than answered here.
    pub fn retryable(&self) -> bool {
        match self {
            DownloadError::InsufficientDiskSpace { .. } => false,
            DownloadError::HttpStatus { status, .. } => {
                *status == 401 || *status == 403 || *status >= 500
            }
            _ => true,
        }
    }
}

impl From<DownloadError> for napi::Error {
    fn from(err: DownloadError) -> Self {
        napi::Error::from_reason(err.to_string())
    }
}

impl From<std::io::Error> for DownloadError {
    fn from(err: std::io::Error) -> Self {
        DownloadError::Raw(err.to_string())
    }
}
