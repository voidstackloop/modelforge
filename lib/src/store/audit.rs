// Phase-1 SQLite-backed audit-event store (see
// docs/RUST_MIGRATION_ASSESSMENT.md). Reachable from audit-log-store.ts only
// when a clinician/admin explicitly opts in via Settings
// (`auditLogBackend: "sqlite"`, default "json") — the JSON file remains the
// default, untouched path for everyone else. `list_audit_events_json`
// returns data in the exact shape the JSON file uses so the TypeScript side
// can reuse its existing parsing/sorting/purge/hash-verification logic
// unchanged regardless of which backend is active.
//
// Every function opens its own short-lived connection rather than holding
// one across the N-API boundary — simpler to reason about (no Send/Sync
// juggling of a live `Connection` handed to JS) and appropriate for a
// scaffold that isn't on any hot path. A real cutover would likely want a
// pooled/held connection; that's a decision for when this actually replaces
// the JSON path, not before.

use napi_derive::napi;
use rusqlite::{Connection, OptionalExtension, params};

const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
        id                  TEXT PRIMARY KEY,
        timestamp           TEXT NOT NULL,
        action_category     TEXT NOT NULL,
        target_type         TEXT,
        target_id           TEXT,
        detail              TEXT,
        mcp_server_id       TEXT,
        mcp_server_name     TEXT,
        mcp_tool_name       TEXT,
        approval_outcome    TEXT,
        duration_ms         INTEGER,
        previous_event_hash TEXT,
        event_hash          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
";

const CURRENT_SCHEMA_VERSION: i64 = 1;

fn open_connection(db_path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    // WAL mode: readers (e.g. a future "export audit log" IPC call) don't
    // block a concurrent writer, and vice versa — the brief's own
    // concurrency-safety requirement for this store.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Waits up to 5s for a lock instead of failing immediately under
    // momentary contention — cheap insurance for a store that will
    // eventually see writes from the main process's own async IPC handlers.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA_SQL)?;

    let version: i64 = conn
        .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
            row.get(0)
        })
        .optional()?
        .unwrap_or(0);
    if version == 0 {
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            params![CURRENT_SCHEMA_VERSION],
        )?;
    }
    // No migration steps exist yet (this is schema version 1, the first
    // one) — the version row's only job right now is to exist, so a real
    // future migration has something to compare against instead of having
    // to special-case "no version row at all" as its own case.

    Ok(conn)
}

/// Opens (creating on first use) the audit SQLite store at `db_path` and
/// applies the schema. Idempotent — safe to call on every app start.
#[napi]
pub fn open_audit_store(db_path: String) -> napi::Result<()> {
    open_connection(&db_path).map_err(|err| napi::Error::from_reason(err.to_string()))?;
    Ok(())
}

#[napi(object)]
pub struct MigrationReport {
    pub migrated: u32,
    pub skipped_existing: u32,
    pub total_source_events: u32,
}

/// Imports events from `json_array` (the exact contents of the existing
/// `audit-log.json`) into the SQLite store, skipping any `id` already
/// present — safe to run repeatedly (e.g. on every app start) without
/// duplicating rows, which is what makes this a real migration path rather
/// than a one-shot script: nothing about running it twice, or running it
/// against a store that already has some rows from a previous partial run,
/// produces wrong results.
#[napi]
pub fn migrate_audit_log_from_json(
    db_path: String,
    json_array: String,
) -> napi::Result<MigrationReport> {
    let events: Vec<serde_json::Value> = serde_json::from_str(&json_array)
        .map_err(|err| napi::Error::from_reason(format!("invalid JSON: {err}")))?;

    let mut conn =
        open_connection(&db_path).map_err(|err| napi::Error::from_reason(err.to_string()))?;
    let tx = conn
        .transaction()
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;

    let mut migrated = 0u32;
    let mut skipped_existing = 0u32;

    for event in &events {
        let id = event.get("id").and_then(|v| v.as_str()).ok_or_else(|| {
            napi::Error::from_reason("an event in the source JSON is missing its \"id\" field")
        })?;

        let exists: bool = tx
            .query_row(
                "SELECT 1 FROM audit_events WHERE id = ?1",
                params![id],
                |_| Ok(true),
            )
            .optional()
            .map_err(|err| napi::Error::from_reason(err.to_string()))?
            .unwrap_or(false);
        if exists {
            skipped_existing += 1;
            continue;
        }

        tx.execute(
            "INSERT INTO audit_events (
                id, timestamp, action_category, target_type, target_id, detail,
                mcp_server_id, mcp_server_name, mcp_tool_name, approval_outcome,
                duration_ms, previous_event_hash, event_hash
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                id,
                event.get("timestamp").and_then(|v| v.as_str()),
                event.get("actionCategory").and_then(|v| v.as_str()),
                event.get("targetType").and_then(|v| v.as_str()),
                event.get("targetId").and_then(|v| v.as_str()),
                event.get("detail").and_then(|v| v.as_str()),
                event.get("mcpServerId").and_then(|v| v.as_str()),
                event.get("mcpServerName").and_then(|v| v.as_str()),
                event.get("mcpToolName").and_then(|v| v.as_str()),
                event.get("approvalOutcome").and_then(|v| v.as_str()),
                event.get("durationMs").and_then(|v| v.as_i64()),
                event.get("previousEventHash").and_then(|v| v.as_str()),
                event.get("eventHash").and_then(|v| v.as_str()),
            ],
        )
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        migrated += 1;
    }

    tx.commit()
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;

    Ok(MigrationReport {
        migrated,
        skipped_existing,
        total_source_events: events.len() as u32,
    })
}

/// Total row count — used by tests and by a future migration-verification
/// step to confirm nothing was silently dropped.
#[napi]
pub fn audit_event_count(db_path: String) -> napi::Result<u32> {
    let conn =
        open_connection(&db_path).map_err(|err| napi::Error::from_reason(err.to_string()))?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM audit_events", [], |row| row.get(0))
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
    Ok(count as u32)
}

#[napi(object)]
pub struct StoreIntegrityReport {
    pub ok: bool,
    pub event_count: u32,
    pub detail: String,
}

/// Runs SQLite's own `PRAGMA integrity_check` (page-level corruption
/// detection — a different, complementary concern from the JSON store's
/// hash-chain tamper-evidence, which detects *content* edits, not on-disk
/// structural corruption) and reports the row count alongside it.
#[napi]
pub fn verify_audit_store(db_path: String) -> napi::Result<StoreIntegrityReport> {
    let conn =
        open_connection(&db_path).map_err(|err| napi::Error::from_reason(err.to_string()))?;
    let detail: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
    let event_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM audit_events", [], |row| row.get(0))
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
    Ok(StoreIntegrityReport {
        ok: detail == "ok",
        event_count: event_count as u32,
        detail,
    })
}

/// The most recently inserted event's `event_hash` (by SQLite's own
/// implicit rowid, which tracks insertion order), or `None` for an empty
/// store or one whose last event predates hash-chaining. Lets a caller
/// building a new event chain onto this store without needing to fetch and
/// parse every row just to find the tail.
#[napi]
pub fn get_last_audit_event_hash(db_path: String) -> napi::Result<Option<String>> {
    let conn =
        open_connection(&db_path).map_err(|err| napi::Error::from_reason(err.to_string()))?;
    conn.query_row(
        "SELECT event_hash FROM audit_events ORDER BY rowid DESC LIMIT 1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| napi::Error::from_reason(err.to_string()))
}

/// Every event in the store, serialized as a JSON array in insertion order
/// — same field names (camelCase) and shape as the JSON file this store can
/// be migrated from, so a TypeScript caller can reuse exactly the same
/// parsing/sorting/purge/verification logic regardless of which backend
/// produced the data.
#[napi]
pub fn list_audit_events_json(db_path: String) -> napi::Result<String> {
    let conn =
        open_connection(&db_path).map_err(|err| napi::Error::from_reason(err.to_string()))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, timestamp, action_category, target_type, target_id, detail,
                    mcp_server_id, mcp_server_name, mcp_tool_name, approval_outcome,
                    duration_ms, previous_event_hash, event_hash
             FROM audit_events ORDER BY rowid ASC",
        )
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;

    let rows = stmt
        .query_map([], |row| {
            let mut obj = serde_json::Map::new();
            obj.insert("id".into(), row.get::<_, String>(0)?.into());
            obj.insert("timestamp".into(), row.get::<_, String>(1)?.into());
            obj.insert("actionCategory".into(), row.get::<_, String>(2)?.into());
            insert_optional_string(&mut obj, "targetType", row.get(3)?);
            insert_optional_string(&mut obj, "targetId", row.get(4)?);
            insert_optional_string(&mut obj, "detail", row.get(5)?);
            insert_optional_string(&mut obj, "mcpServerId", row.get(6)?);
            insert_optional_string(&mut obj, "mcpServerName", row.get(7)?);
            insert_optional_string(&mut obj, "mcpToolName", row.get(8)?);
            insert_optional_string(&mut obj, "approvalOutcome", row.get(9)?);
            let duration_ms: Option<i64> = row.get(10)?;
            if let Some(ms) = duration_ms {
                obj.insert("durationMs".into(), ms.into());
            }
            insert_optional_string(&mut obj, "previousEventHash", row.get(11)?);
            insert_optional_string(&mut obj, "eventHash", row.get(12)?);
            Ok(serde_json::Value::Object(obj))
        })
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;

    let events: Vec<serde_json::Value> = rows
        .collect::<rusqlite::Result<_>>()
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
    serde_json::to_string(&events).map_err(|err| napi::Error::from_reason(err.to_string()))
}

fn insert_optional_string(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: Option<String>,
) {
    if let Some(v) = value {
        obj.insert(key.to_string(), v.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn db_path(dir: &tempfile::TempDir) -> String {
        dir.path()
            .join("audit.sqlite3")
            .to_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn open_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        open_connection(&path).unwrap();
        open_connection(&path).unwrap(); // must not error on an already-initialized store
        assert_eq!(audit_event_count(path).unwrap(), 0);
    }

    #[test]
    fn open_audit_store_napi_entrypoint_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        open_audit_store(path.clone()).unwrap();
        open_audit_store(path.clone()).unwrap();
        assert_eq!(audit_event_count(path).unwrap(), 0);
    }

    #[test]
    fn schema_version_is_recorded_exactly_once() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        open_connection(&path).unwrap();
        open_connection(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn wal_mode_is_active() {
        let dir = tempdir().unwrap();
        let conn = open_connection(&db_path(&dir)).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn migrates_events_from_json() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        let json = r#"[
            {"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created","eventHash":"h1"},
            {"id":"b","timestamp":"2026-01-01T00:00:01.000Z","actionCategory":"case-updated","previousEventHash":"h1","eventHash":"h2"}
        ]"#;
        let report = migrate_audit_log_from_json(path.clone(), json.to_string()).unwrap();
        assert_eq!(report.migrated, 2);
        assert_eq!(report.skipped_existing, 0);
        assert_eq!(report.total_source_events, 2);
        assert_eq!(audit_event_count(path).unwrap(), 2);
    }

    #[test]
    fn migration_is_idempotent_across_repeated_runs() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        let json = r#"[{"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created"}]"#;

        migrate_audit_log_from_json(path.clone(), json.to_string()).unwrap();
        let second = migrate_audit_log_from_json(path.clone(), json.to_string()).unwrap();

        assert_eq!(second.migrated, 0);
        assert_eq!(second.skipped_existing, 1);
        assert_eq!(audit_event_count(path).unwrap(), 1); // not duplicated
    }

    #[test]
    fn migration_only_inserts_the_new_events_on_a_partial_rerun() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        let first_batch = r#"[{"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created"}]"#;
        migrate_audit_log_from_json(path.clone(), first_batch.to_string()).unwrap();

        let grown_batch = r#"[
            {"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created"},
            {"id":"b","timestamp":"2026-01-01T00:00:01.000Z","actionCategory":"case-updated"}
        ]"#;
        let report = migrate_audit_log_from_json(path.clone(), grown_batch.to_string()).unwrap();

        assert_eq!(report.migrated, 1);
        assert_eq!(report.skipped_existing, 1);
        assert_eq!(audit_event_count(path).unwrap(), 2);
    }

    #[test]
    fn migration_rejects_an_event_with_no_id_and_inserts_nothing_from_that_batch() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        let json = r#"[
            {"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created"},
            {"timestamp":"2026-01-01T00:00:01.000Z","actionCategory":"case-updated"}
        ]"#;
        assert!(migrate_audit_log_from_json(path.clone(), json.to_string()).is_err());
        // The whole batch is one transaction — a bad event must not leave a
        // half-migrated store behind.
        assert_eq!(audit_event_count(path).unwrap(), 0);
    }

    #[test]
    fn verify_reports_ok_and_the_correct_count() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        let json = r#"[{"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created"}]"#;
        migrate_audit_log_from_json(path.clone(), json.to_string()).unwrap();

        let report = verify_audit_store(path).unwrap();
        assert!(report.ok);
        assert_eq!(report.event_count, 1);
        assert_eq!(report.detail, "ok");
    }

    #[test]
    fn preserves_hash_chain_fields_through_migration() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        let json = r#"[{"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created","previousEventHash":null,"eventHash":"deadbeef"}]"#;
        migrate_audit_log_from_json(path.clone(), json.to_string()).unwrap();

        let conn = Connection::open(&path).unwrap();
        let (prev, hash): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT previous_event_hash, event_hash FROM audit_events WHERE id = 'a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(prev, None);
        assert_eq!(hash, Some("deadbeef".to_string()));
    }

    #[test]
    fn last_event_hash_is_none_for_an_empty_store() {
        let dir = tempdir().unwrap();
        assert_eq!(get_last_audit_event_hash(db_path(&dir)).unwrap(), None);
    }

    #[test]
    fn last_event_hash_tracks_insertion_order_not_id_order() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        // Inserted out of lexical id order — rowid (insertion order) must
        // still win, not a query that happened to sort by id.
        let json = r#"[
            {"id":"z","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created","eventHash":"h-z"},
            {"id":"a","timestamp":"2026-01-01T00:00:01.000Z","actionCategory":"case-updated","previousEventHash":"h-z","eventHash":"h-a"}
        ]"#;
        migrate_audit_log_from_json(path.clone(), json.to_string()).unwrap();
        assert_eq!(
            get_last_audit_event_hash(path).unwrap(),
            Some("h-a".to_string())
        );
    }

    #[test]
    fn list_audit_events_json_round_trips_through_migration() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        let json = r#"[
            {"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created","targetType":"patient-case","targetId":"case-1","eventHash":"h1"},
            {"id":"b","timestamp":"2026-01-01T00:00:01.000Z","actionCategory":"mcp-tool-call","mcpServerId":"graphify","mcpToolName":"query","approvalOutcome":"approved","durationMs":42,"previousEventHash":"h1","eventHash":"h2"}
        ]"#;
        migrate_audit_log_from_json(path.clone(), json.to_string()).unwrap();

        let listed: serde_json::Value =
            serde_json::from_str(&list_audit_events_json(path).unwrap()).unwrap();
        let events = listed.as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["id"], "a");
        assert_eq!(events[0]["targetType"], "patient-case");
        assert_eq!(events[1]["id"], "b");
        assert_eq!(events[1]["mcpServerId"], "graphify");
        assert_eq!(events[1]["durationMs"], 42);
        assert_eq!(events[1]["previousEventHash"], "h1");
        // Fields absent on the source event must stay absent (see the
        // dedicated omission test below), matching audit-log-store.ts's own
        // AuditEvent fields being optional (`?`), not nullable.
        assert!(events[0].as_object().unwrap().get("mcpServerId").is_none());
    }

    #[test]
    fn list_audit_events_json_omits_optional_fields_entirely_rather_than_nulling_them() {
        let dir = tempdir().unwrap();
        let path = db_path(&dir);
        let json = r#"[{"id":"a","timestamp":"2026-01-01T00:00:00.000Z","actionCategory":"case-created"}]"#;
        migrate_audit_log_from_json(path.clone(), json.to_string()).unwrap();

        let listed: serde_json::Value =
            serde_json::from_str(&list_audit_events_json(path).unwrap()).unwrap();
        let event = listed.as_array().unwrap()[0].as_object().unwrap();
        for absent_field in [
            "targetType",
            "targetId",
            "detail",
            "mcpServerId",
            "durationMs",
            "previousEventHash",
            "eventHash",
        ] {
            assert!(
                !event.contains_key(absent_field),
                "expected {absent_field} to be omitted, not present as null"
            );
        }
    }
}
