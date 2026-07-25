use serde::{Deserialize, Serialize};
use std::path::Path;

/// Bumped whenever the shape of this file changes; a mismatch means "can't
/// trust this partial, restart clean" rather than trying to migrate it —
/// same philosophy as the single-stream path's 416-triggered restart.
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ChunkState {
    pub index: u64,
    pub start: u64,
    /// Inclusive.
    pub end: u64,
    pub received: u64,
    pub done: bool,
}

impl ChunkState {
    pub fn size(&self) -> u64 {
        self.end - self.start + 1
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadState {
    version: u32,
    pub total_bytes: u64,
    pub etag: Option<String>,
    pub chunks: Vec<ChunkState>,
}

impl DownloadState {
    pub fn new(total_bytes: u64, etag: Option<String>, ranges: &[(u64, u64)]) -> Self {
        let chunks = ranges
            .iter()
            .enumerate()
            .map(|(index, &(start, end))| ChunkState {
                index: index as u64,
                start,
                end,
                received: 0,
                done: false,
            })
            .collect();
        Self {
            version: FORMAT_VERSION,
            total_bytes,
            etag,
            chunks,
        }
    }

    pub fn received_total(&self) -> u64 {
        self.chunks.iter().map(|c| c.received).sum()
    }

    pub fn matches(&self, total_bytes: u64, etag: Option<&str>) -> bool {
        self.version == FORMAT_VERSION
            && self.total_bytes == total_bytes
            && self.etag.as_deref() == etag
    }

    pub fn load(path: &Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(self).expect("DownloadState always serializes");
        std::fs::write(path, bytes)
    }
}

/// Splits `total_bytes` into up to `max_workers` roughly-even chunks of at
/// least `min_chunk_size` bytes each. Fewer, larger chunks than `max_workers`
/// when the file is too small to usefully fill them all.
pub fn plan_chunks(total_bytes: u64, max_workers: u64, min_chunk_size: u64) -> Vec<(u64, u64)> {
    let worker_count = (total_bytes / min_chunk_size).clamp(1, max_workers);
    let chunk_size = total_bytes.div_ceil(worker_count);
    let mut ranges = Vec::new();
    let mut start = 0u64;
    while start < total_bytes {
        let end = (start + chunk_size - 1).min(total_bytes - 1);
        ranges.push((start, end));
        start = end + 1;
    }
    ranges
}
