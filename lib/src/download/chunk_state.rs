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

    /// Whether `chunks` is internally consistent enough to trust for a
    /// resume: correctly indexed, non-overlapping, contiguous coverage of
    /// `[0, total_bytes)`, and no chunk claiming more received bytes than it
    /// could ever hold. `matches()` above only checks the sidecar's *own*
    /// declared total_bytes/etag against the caller's expectation — it says
    /// nothing about whether `chunks` itself is well-formed, so a corrupted,
    /// partially-written (crash mid-`save`), or hand-edited sidecar that
    /// still happens to have the right top-level `total_bytes`/`etag` could
    /// otherwise pass `matches()` and reach `chunked::run`'s
    /// `chunks[chunk.index as usize]` indexing with an out-of-range index —
    /// an uncontrolled panic from untrusted on-disk state, and (separately)
    /// `ChunkState::size()`'s `end - start + 1` would silently wrap on a
    /// chunk with `end < start`. Called only for a sidecar that already
    /// passed `matches()`; both checks must hold before a resume is trusted.
    pub fn is_structurally_valid(&self) -> bool {
        if self.chunks.is_empty() {
            return false;
        }
        for (i, chunk) in self.chunks.iter().enumerate() {
            if chunk.index != i as u64 || chunk.start > chunk.end || chunk.end >= self.total_bytes {
                return false;
            }
            if chunk.received > chunk.size() {
                return false;
            }
            let expected_start = if i == 0 {
                0
            } else {
                self.chunks[i - 1].end + 1
            };
            if chunk.start != expected_start {
                return false;
            }
        }
        self.chunks
            .last()
            .is_some_and(|last| last.end == self.total_bytes - 1)
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

#[cfg(test)]
mod is_structurally_valid_tests {
    use super::*;

    fn valid_state() -> DownloadState {
        let ranges = plan_chunks(100, 4, 1);
        DownloadState::new(100, Some("etag".to_string()), &ranges)
    }

    #[test]
    fn a_freshly_planned_state_is_structurally_valid() {
        assert!(valid_state().is_structurally_valid());
    }

    #[test]
    fn empty_chunks_is_invalid() {
        let mut state = valid_state();
        state.chunks.clear();
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn an_out_of_order_index_is_invalid() {
        let mut state = valid_state();
        state.chunks[1].index = 99;
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn an_index_far_beyond_the_chunk_count_is_invalid() {
        // The exact shape that would otherwise panic chunked.rs's
        // `chunks[chunk.index as usize]` indexing.
        let mut state = valid_state();
        state.chunks[0].index = 1_000_000;
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn a_gap_between_chunks_is_invalid() {
        let mut state = valid_state();
        state.chunks[1].start += 1; // leaves a one-byte hole no chunk covers
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn overlapping_chunks_are_invalid() {
        let mut state = valid_state();
        state.chunks[1].start -= 1; // now overlaps the end of chunk 0
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn a_chunk_whose_end_reaches_past_total_bytes_is_invalid() {
        let mut state = valid_state();
        let last = state.chunks.len() - 1;
        state.chunks[last].end = state.total_bytes; // one past the valid last byte (index total_bytes - 1)
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn the_last_chunk_not_reaching_total_bytes_is_invalid() {
        let mut state = valid_state();
        let last = state.chunks.len() - 1;
        state.chunks[last].end -= 1;
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn a_chunk_with_start_after_end_is_invalid() {
        let mut state = valid_state();
        let (start, end) = (state.chunks[0].start, state.chunks[0].end);
        state.chunks[0].start = end;
        state.chunks[0].end = start; // start > end — size() would otherwise underflow
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn a_chunk_claiming_more_received_bytes_than_it_can_hold_is_invalid() {
        let mut state = valid_state();
        state.chunks[0].received = state.chunks[0].size() + 1;
        assert!(!state.is_structurally_valid());
    }

    #[test]
    fn a_single_chunk_covering_the_whole_file_is_valid() {
        let ranges = plan_chunks(10, 1, 1);
        assert!(DownloadState::new(10, None, &ranges).is_structurally_valid());
    }
}
