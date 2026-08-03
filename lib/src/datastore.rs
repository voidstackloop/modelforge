use sha2::{Digest, Sha256};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Files written here hold provider API keys and full patient/conversation
/// history — mirrors `PRIVATE_FILE_MODE` in `app/src/json-store.ts`, which
/// this function replaces the write half of. Kept in sync deliberately: if
/// one side changes, the other must too.
#[cfg(unix)]
const PRIVATE_FILE_MODE: u32 = 0o600;

/// Reads a small JSON "database" file whole. Returns `Ok(None)` for a
/// missing file (the caller treats that as "use the fallback", same as
/// `json-store.ts` catching `ENOENT`) and `Err` for any other I/O failure
/// (permission denied, not a regular file, ...) so the caller can log it —
/// this function never silently swallows a real error into `None`.
pub fn read_json_file(path: &str) -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// Writes `contents` to `path` via a temp-file-then-rename so a crash or
/// power loss mid-write can never leave a half-written file behind — a
/// rename is atomic on both Windows and POSIX filesystems. Mirrors
/// `writeJson` in `app/src/json-store.ts` byte-for-byte in behavior
/// (private file mode on unix, parent directory created as needed) so
/// either implementation can read the other's output.
pub fn write_json_file_atomic(path: &str, contents: &str) -> std::io::Result<()> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Matches json-store.ts exactly: `${filePath}.tmp-${pid}`, a plain
    // string suffix rather than a path-extension swap, so a `.json` path
    // becomes `foo.json.tmp-1234`.
    let tmp_path_str = format!("{}.tmp-{}", path.display(), std::process::id());
    let tmp_path = Path::new(&tmp_path_str);
    // Remove any stale temp file left behind by an interrupted earlier write
    // under this same pid before creating a fresh one, since setting the
    // mode below only makes sense on a file this call itself just created.
    let _ = std::fs::remove_file(tmp_path);

    std::fs::write(tmp_path, contents)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(tmp_path, std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))?;
    }

    std::fs::rename(tmp_path, path)
}

/// Appends `element_json` (a single already-serialized JSON value) onto the
/// end of an existing JSON array file **without reading, parsing, or
/// re-serializing the array's existing contents** — that full
/// read-modify-write is exactly what made `audit-log-store.ts`'s
/// `recordEvent` cost O(n) per call (O(n²) total for n sequential events),
/// since the array only ever grows.
///
/// Only succeeds (`Ok(true)`) when the file's tail unambiguously looks like
/// a JSON array this same mechanism (or a plain `JSON.stringify`) produced —
/// last non-whitespace byte is `]`. Anything else — missing file, empty
/// file, a tail that doesn't end in `]` (corrupted, truncated, or simply
/// not a JSON array) — returns `Ok(false)` so the caller falls back to a
/// full, safe read-modify-write instead of risking corrupting a file it
/// isn't sure how to interpret. This function never partially writes: the
/// truncate and the append happen against the same open file handle before
/// any bytes are removed from what was already committed.
pub fn append_json_array_element(path: &str, element_json: &str) -> std::io::Result<bool> {
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    {
        Ok(f) => f,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };

    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(false);
    }

    // A well-formed array's closing `]` is always within a few bytes of
    // EOF (trailing whitespace/newline aside), so a small fixed window from
    // the end is enough regardless of how large the array itself is.
    let window_len = len.min(64) as usize;
    let mut window = vec![0u8; window_len];
    file.seek(SeekFrom::End(-(window_len as i64)))?;
    file.read_exact(&mut window)?;

    let mut tail_end = window_len;
    while tail_end > 0 && window[tail_end - 1].is_ascii_whitespace() {
        tail_end -= 1;
    }
    if tail_end == 0 || window[tail_end - 1] != b']' {
        return Ok(false);
    }
    let bracket_index = tail_end - 1;

    // Whether the array currently holds at least one element — look at
    // whatever precedes the `]` (skipping whitespace): `[` means empty, any
    // other byte means there's already a last element to comma-separate
    // the new one from.
    let mut before_bracket = bracket_index;
    while before_bracket > 0 && window[before_bracket - 1].is_ascii_whitespace() {
        before_bracket -= 1;
    }
    let is_empty_array = before_bracket > 0 && window[before_bracket - 1] == b'[';
    if before_bracket == 0 && window_len < len as usize {
        // The window didn't reach far enough back to see what precedes the
        // bracket (only possible when window_len == 64 < len and the whole
        // window was whitespace up to the bracket, which shouldn't happen
        // for real JSON but isn't worth guessing about) — decline rather
        // than risk misjudging empty vs. non-empty.
        return Ok(false);
    }

    // Bytes from EOF back to (and including) the `]` — used to compute the
    // absolute file offset to truncate at, in terms of the whole file
    // rather than just this window.
    let truncate_at = len - (window_len - bracket_index) as u64;

    file.set_len(truncate_at)?;
    file.seek(SeekFrom::Start(truncate_at))?;
    if !is_empty_array {
        file.write_all(b",")?;
    }
    file.write_all(element_json.as_bytes())?;
    file.write_all(b"]")?;
    file.flush()?;
    Ok(true)
}

/// SHA-256 hex digest of `input`, used by `audit-log-store.ts`'s hash-chain
/// (`computeEventHash`) — moved here since a growing audit log means this
/// runs once per recorded event, on every event already in the file (see
/// that module's `recordEvent`).
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn parsed(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn read_missing_file_returns_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert_eq!(read_json_file(path.to_str().unwrap()).unwrap(), None);
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("store.json");
        write_json_file_atomic(path.to_str().unwrap(), r#"{"a":1}"#).unwrap();
        assert_eq!(
            read_json_file(path.to_str().unwrap()).unwrap(),
            Some(r#"{"a":1}"#.to_string())
        );
    }

    #[test]
    fn write_overwrites_existing_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("store.json");
        write_json_file_atomic(path.to_str().unwrap(), "first").unwrap();
        write_json_file_atomic(path.to_str().unwrap(), "second").unwrap();
        assert_eq!(
            read_json_file(path.to_str().unwrap()).unwrap(),
            Some("second".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_sets_private_file_mode_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        write_json_file_atomic(path.to_str().unwrap(), "{}").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, PRIVATE_FILE_MODE);
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // Empty-string SHA-256, a standard test vector.
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_hex_is_deterministic_and_input_sensitive() {
        assert_eq!(sha256_hex("hello"), sha256_hex("hello"));
        assert_ne!(sha256_hex("hello"), sha256_hex("world"));
    }

    #[test]
    fn append_returns_false_for_a_missing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert!(!append_json_array_element(path.to_str().unwrap(), "1").unwrap());
    }

    #[test]
    fn append_returns_false_for_an_empty_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("empty.json");
        std::fs::write(&path, "").unwrap();
        assert!(!append_json_array_element(path.to_str().unwrap(), "1").unwrap());
    }

    #[test]
    fn append_returns_false_when_the_tail_is_not_a_json_array() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("not-array.json");
        std::fs::write(&path, r#"{"a":1}"#).unwrap();
        assert!(!append_json_array_element(path.to_str().unwrap(), "1").unwrap());
        // Original content must be untouched by a declined append.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"a":1}"#);
    }

    #[test]
    fn append_returns_false_for_a_truncated_array() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("truncated.json");
        std::fs::write(&path, "[1,2,3").unwrap(); // missing closing bracket
        assert!(!append_json_array_element(path.to_str().unwrap(), "4").unwrap());
    }

    #[test]
    fn append_onto_an_empty_array() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(&path, "[]").unwrap();
        assert!(append_json_array_element(path.to_str().unwrap(), r#"{"a":1}"#).unwrap());
        assert_eq!(parsed(&path), serde_json::json!([{"a": 1}]));
    }

    #[test]
    fn append_onto_a_compact_non_empty_array() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(&path, "[1,2]").unwrap();
        assert!(append_json_array_element(path.to_str().unwrap(), "3").unwrap());
        assert_eq!(parsed(&path), serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn append_onto_a_pretty_printed_array_stays_valid_json() {
        // Mirrors json-store.ts's writeJson, which uses
        // JSON.stringify(data, null, 2) — the append doesn't need to match
        // that formatting, just produce a file that still parses correctly.
        let dir = tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(&path, "[\n  1,\n  2\n]\n").unwrap();
        assert!(append_json_array_element(path.to_str().unwrap(), "3").unwrap());
        assert_eq!(parsed(&path), serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn repeated_appends_preserve_order_and_never_touch_earlier_bytes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(&path, "[]").unwrap();
        for i in 0..50 {
            assert!(append_json_array_element(path.to_str().unwrap(), &i.to_string()).unwrap());
        }
        let expected: Vec<i32> = (0..50).collect();
        assert_eq!(parsed(&path), serde_json::json!(expected));
    }
}
