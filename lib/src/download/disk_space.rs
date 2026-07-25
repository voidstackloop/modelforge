use crate::error::DownloadError;
use std::path::Path;

/// Safety margin over the raw required byte count — filesystem overhead
/// (block rounding, journal/metadata) and any other concurrent writer to the
/// same volume both eat into what `available_space` reports as free.
const SAFETY_MARGIN: f64 = 1.05;

/// Checked once per job at start against the *sum* of all shards' expected
/// sizes, not per-shard — fails fast before any bytes move rather than
/// letting a multi-file job get partway through and strand a shard.
///
/// Takes the free-space lookup as an injected closure rather than calling
/// `fs4::available_space` directly, so tests can exercise the
/// under-threshold path without needing an actually-full disk — the same
/// seam `progress::ProgressFn` already uses for testability.
pub fn check(
    available_bytes: impl FnOnce() -> std::io::Result<u64>,
    required_bytes: u64,
) -> Result<(), DownloadError> {
    let available = available_bytes()?;
    let required = (required_bytes as f64 * SAFETY_MARGIN) as u64;
    if available < required {
        return Err(DownloadError::InsufficientDiskSpace {
            required,
            available,
        });
    }
    Ok(())
}

/// Real free-space lookup for a given destination directory, backed by
/// `fs4`. `dir` must already exist.
pub fn available_space(dir: &Path) -> std::io::Result<u64> {
    fs4::available_space(dir)
}
