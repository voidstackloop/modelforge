use crate::error::DownloadError;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncReadExt;

/// Read size for streamed hashing — large enough to keep syscall overhead
/// low, small enough to never hold more than this much of a multi-GB model
/// in memory at once.
const READ_CHUNK: usize = 1024 * 1024;

/// Streams `path` through SHA-256 without loading it whole into memory, and
/// compares against `expected` (case-insensitive hex). A mismatch is
/// reported as corrupt bytes, not an incomplete transfer — callers should
/// treat it as non-resumable (delete and restart), unlike every other
/// `DownloadError` variant in this module.
pub async fn verify_sha256(
    path: &Path,
    filename: &str,
    expected: &str,
) -> Result<(), DownloadError> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(DownloadError::VerificationFailed {
            filename: filename.to_string(),
            expected: expected.to_string(),
            actual,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn matching_hash_succeeds() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"hello world").unwrap();
        // sha256("hello world")
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

        verify_sha256(&path, "file.bin", expected)
            .await
            .expect("hash should match");
    }

    #[tokio::test]
    async fn matching_hash_is_case_insensitive() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let expected = "B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9";

        verify_sha256(&path, "file.bin", expected)
            .await
            .expect("hash should match regardless of case");
    }

    #[tokio::test]
    async fn mismatched_hash_fails_with_the_actual_and_expected_values() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"hello world").unwrap();

        let err = verify_sha256(
            &path,
            "file.bin",
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .await
        .expect_err("hash should not match");

        assert_eq!(err.kind(), "verification_failed");
    }
}
