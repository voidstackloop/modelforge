# Rust Native-Core Migration — Assessment (Phase 0 deliverable)

Required initial deliverable before any Phase 1+ code changes, per the
migration brief. Scope: assess, don't rewrite. Only Phase 0 (stabilize the
existing native foundation) is implemented alongside this document — see
"What was actually changed" at the end.

## 1. Current Rust/TypeScript boundary

`lib/` (`modelforge-native`, napi-rs, Rust 2024) currently exposes, via
[lib.rs](../lib/src/lib.rs):

- `download_gguf_file`, `DownloadManager` — resumable parallel GGUF
  downloads, job management, rate/concurrency limiting, checksum
  verification ([download/](../lib/src/download/), [manager.rs](../lib/src/manager.rs)).
- `read_json_file_native`, `write_json_file_atomic_native`,
  `sha256_hex_native`, `append_json_array_element_native` — atomic JSON
  file I/O, SHA-256 hashing, and an O(1) JSON-array append
  ([datastore.rs](../lib/src/datastore.rs)).

Every native function has a TypeScript caller that falls back to a pure-Node
implementation when the addon isn't loaded:
[native-downloader.ts](../app/src/native-downloader.ts) (no fallback for the
download engine itself — it's Rust-only, opt-in at the call site) and
[native-datastore.ts](../app/src/native-datastore.ts) (full fallback for
every function, verified both ways — see
[docs/RUST_DATASTORE_TEST_REPORT.md](RUST_DATASTORE_TEST_REPORT.md)).
[json-store.ts](../app/src/json-store.ts) and
[audit-log-store.ts](../app/src/audit-log-store.ts) are the only consumers
of the datastore addon today; every other `*-store.ts` (patient cases,
sessions, evidence, model registry, settings, secrets) goes through
`json-store.ts` and inherits the native path transparently.

**Everything else is pure TypeScript**, including the specific candidates
named in the migration brief:

| Module | Lines | What it does today |
|---|---|---|
| [rag.ts](../app/src/rag.ts) | 271 | Chunking, Ollama embedding calls, brute-force `cosineSimilarity` over every chunk in a collection (own comment at L243 already flags this), orchestration |
| [rag-db.ts](../app/src/rag-db.ts) | 191 | `better-sqlite3`-backed storage for collections/documents/chunks/embeddings (blobs) |
| [case-encryption.ts](../app/src/case-encryption.ts) | 165 | `scryptSync` KDF, AES-256-GCM via Node `crypto`, in-memory `Buffer` session key, verifier-based unlock |
| [workspace-path.ts](../app/src/workspace-path.ts) | 37 | Lexical + `realpath` path confinement for agent file/terminal operations — genuinely check-then-use |
| [resource-monitor.ts](../app/src/resource-monitor.ts) | 75 | `pidusage`-based single-PID polling; tree-kill only fires *after* a breach is detected on the watched PID |
| [command-sandbox.ts](../app/src/command-sandbox.ts) | 208 | Bubblewrap (Linux) / `sandbox-exec` (macOS) wrapping; no Windows equivalent |
| [system-specs.ts](../app/src/system-specs.ts) | 986 | Platform-specific CPU/RAM/disk/GPU detection |
| [medical-safety.ts](../app/src/medical-safety.ts) | 242 | Deterministic regex-based emergency/medication/redaction/citation checks (see `MedicationSafetyProvider` abstraction already in place for swapping the engine) |

## 2. Dirty-worktree overlap risks

`git status --short` at the start of this work shows two categories of
change:

1. **This session's own uncommitted work** — the full medical-transformation
   and Rust-datastore effort (patient cases, audit log, evidence library,
   MCP rework, encryption, the datastore addon itself, etc.). None of it
   touches the files named as migration candidates above, so there is no
   direct edit-conflict risk between that work and this assessment.
2. **Two pre-existing, not-mine changes**, already flagged and intentionally
   left untouched via `git stash` at the user's direction in the prior
   turn: `app/src/huggingface.ts`/`huggingface.test.ts` (GGUF listing
   pagination) and `mastervault-mcp-server/package.json`/`package-lock.json`
   (an SDK version bump). Neither overlaps any candidate file for this
   migration. They remain stashed, not discarded.

No `git reset`, `checkout --`, or `clean` was run against anything in this
pass — per instruction, only additive changes.

## 3. Candidate modules ranked

| Rank | Module | Security value | Perf value | Migration risk | Cross-platform complexity |
|---|---|---|---|---|---|
| 1 | Persistence (audit ✅ done; patient cases/sessions/evidence/model registry not yet) | High (tamper-evidence, transactional integrity) | Medium (already fast below the old O(n²) cliff) | **High** — schema migration, concurrent-writer story, backup/restore | Low (SQLite is the same everywhere) |
| 2 | PHI cryptography (`case-encryption.ts`) | High (key handling, zeroization) | Low (scrypt is already the bottleneck by design) | **High** — must stay byte-compatible with every existing encrypted file | Low |
| 3 | Agent filesystem confinement (`workspace-path.ts`) | High (closes a real TOCTOU gap) | Low | Medium — API shape change ripples through every agent tool call site | Medium (Windows reparse points differ from Unix symlinks) |
| 4 | RAG indexing (`rag.ts`/`rag-db.ts`) | Low | Medium–High at large collection sizes; negligible at typical single-folder-attach scale | Medium — `better-sqlite3` is already native; the win is the search algorithm, not "is it Rust" | Medium (ANN library choice affects packaging) |
| 5 | Process supervisor/resource limits | Medium (tree-level accounting) | Low–Medium | Medium — Windows Job Objects, Linux cgroups v2, macOS all need separate implementations that this assessment can't verify cross-platform from this sandbox | **High** |
| 6 | System/GPU inspection | Low | Low (runs once, not hot-path) | Low | High (986 lines of exactly the platform-specific logic Rust wouldn't remove, only relocate) |
| 7 | Deterministic safety scanning | Low (already deterministic, already fast at current pattern-list size) | Low at current scale | Low | Low |
| 8 | Hardware recommender inference | None (offline training already isolated) | Low (inference is infrequent) | Low, but requires ONNX parity testing | Low |

This ranking is why Phase 1's own recommended order (audit → cases →
evidence/registry → sessions/projects → other) starts where the *already
proven* pattern (this session's audit-log work) can be extended, rather than
starting somewhere untested.

## 4. Measured baselines

From [docs/RUST_DATASTORE_TEST_REPORT.md](RUST_DATASTORE_TEST_REPORT.md),
reused rather than re-measured:

- 5,000 sequential audit events: ~20–23s (pre-Rust) → ~0.3s (Rust + O(1)
  append + soft cap).
- 10,010 events / 2× the cap (multi-trim-cycle stress test): ~1–1.5s with
  the addon; the equivalent pure-Node cost was not exercised at that scale
  (extrapolated to minutes) because it isn't representative of any real
  code path once this migration lands.

**Not yet measured** (would need to precede any Phase 1+ work on these
specific modules): RAG query latency at realistic collection sizes (10³–10⁵
chunks), `case-encryption.ts`'s `scryptSync` wall time on this machine's
CPU, `workspace-path.ts` call frequency under a long agent run,
`resource-monitor.ts` polling overhead. None of these have a reported user
complaint or profiled bottleneck in this repository today — the brief's own
P1/P2 framing (RAG, ingestion, GPU inspection, safety scanning, recommender
inference) versus P0 (persistence, crypto, filesystem/process security)
already reflects that the P0 items are risk/security-driven, not
measured-bottleneck-driven, and should be scoped accordingly.

## 5. Proposed N-API interfaces (for Phase 1, not implemented this pass)

Sketch only — these must be refined against real characterization tests
before implementation, per the brief's own "minimal typed N-API interface"
step:

```
store_open(path: String, schema_version: u32) -> StoreHandle
store_migrate(handle) -> MigrationReport
store_insert_json(handle, table: String, json: String) -> Result<String /* id */>
store_query_json(handle, table: String, filter: String) -> Result<Vec<String>>
store_transaction(handle, ops: Vec<Op>) -> Result<()>
store_backup(handle, dest: String) -> Result<()>
store_verify_integrity(handle) -> IntegrityReport
```

Every function returns structured, stable error codes (missing file,
corrupt schema, migration-in-progress, busy-timeout, etc.) rather than a
single generic `napi::Error::from_reason` string — the current datastore
functions use string reasons because their failure modes are simple
(missing file, not-an-array); a transactional store's failure modes are not,
and callers (audit sign-off UI, patient case error banners) need to
distinguish them.

## 6. Persistent-data migration plan (Phase 1, not started)

Recommended order matches the brief: audit → patient cases/case-linked
sessions → evidence/model registry → general sessions/projects → other.
For each store: characterization tests against current JSON behavior first,
then a Rust-backed implementation run side-by-side against the same test
vectors (native vs. fallback vs. new-store, three-way comparison, not just
two), then a feature flag, then — only after verified — a one-way,
backed-up, idempotent migration. The original JSON is never deleted
automatically; every existing `*-store.ts` already keeps this discipline
(see `json-store.ts`'s corrupted-file backup behavior) and the SQLite
migration should extend it, not relax it.

Provider secrets already live in `secrets-store.ts` behind
`safeStorage`/OS keychain, separate from the general JSON stores — this
plan does not propose moving them into the same SQLite database.

## 7. Rollback strategy (Phase 1, not started)

Each per-store migration ships behind a flag defaulting to the existing
JSON path. Rollback is "the flag was never flipped" for anyone who hasn't
opted in, and "restore the retained JSON backup" for anyone who has — which
is why the migration plan above insists the JSON backup is retained until
the new store's integrity check passes, not deleted at write time.

## 8. Platform build matrix

napi-rs's own targets (already declared in
[lib/package.json](../lib/package.json)): `x86_64-pc-windows-msvc`,
`x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`.
**This sandbox is Linux x86_64 only** — every verification in this pass and
in the prior Rust-datastore work was necessarily Linux-only. The CI
`rust` job in [ci.yml](../.github/workflows/ci.yml) also only runs on
`ubuntu-latest`. This is a real, standing gap: nothing in this repository's
current CI actually builds or loads the `.node` addon on Windows or macOS,
despite shipping installers for both. Closing this (a Phase 0 item in the
brief) requires CI runner access this environment doesn't have — flagged
here rather than silently left undone.

## 9. Phase-by-phase acceptance criteria

- **Phase 0** (this pass): docs reconciled with actual native-addon scope;
  native load-failure modes distinguished instead of collapsed into one
  boolean; existing fallback-path tests still pass. *Not done this pass*
  (blocked on infrastructure this sandbox lacks): multi-platform CI build
  jobs, cross-platform load verification.
- **Phase 1+**: not started. Acceptance criteria per the brief's own
  Phase 1 requirements list (WAL mode, migrations, transactional writes,
  backup/restore, corruption reporting, etc.) apply unchanged; this
  assessment doesn't relax any of them.

## 10. Files expected to change (Phase 1, if/when undertaken)

`lib/Cargo.toml` (new `rusqlite` or equivalent dependency), new
`lib/src/store/` module tree, `lib/src/lib.rs` (thin N-API surface only, per
the brief's own "don't grow one oversized lib.rs" rule), a new
`app/src/native-sqlite-store.ts` bridge mirroring `native-datastore.ts`'s
fallback pattern, and — one at a time, per the recommended order —
`audit-log-store.ts`, then `patient-cases-store.ts`/`sessions-store.ts`,
then `evidence-store.ts`/`model-registry-store.ts`. `docs/ARCHITECTURE.md`
and this assessment both get updated as each slice lands.

---

## What was actually changed

### Phase 0

1. **`docs/ARCHITECTURE.md` reconciled** — its native-addon section
   described download-only; corrected to include the datastore/audit
   functions added in the prior session.
2. **Native load-failure modes distinguished** — `native-datastore.ts` and
   `native-downloader.ts` previously collapsed every failure (`require()`
   throwing for *any* reason — missing file, wrong ABI, corrupted binary,
   unsupported platform, or an exception during the addon's own init code)
   into a single "unavailable, fall back" boolean. `getNativeCapabilityReport()`
   now inspects the thrown error and reports which of those it actually
   was, purely for diagnostics/logging — every existing fallback behavior
   is unchanged. New shared module: `app/src/native-capability.ts`.
3. **CI's `rust` job now builds and load-verifies the addon on Windows and
   macOS, not just Linux** — previously flagged here as a real, unverified
   gap. `.github/workflows/ci.yml`'s `rust` job gained a 3-OS matrix; fmt
   and clippy still run once (Rust source is OS-independent), but `cargo
   build`, `cargo test`, a real `napi build`, and a `require()` + exports
   check now run on every platform. Verified locally on Linux (the one
   platform this sandbox can run); Windows/macOS are verified for real by
   GitHub's own runners on the next push, which is the actual point — this
   sandbox was never going to be able to confirm those two itself.

### Phase 1 — smallest vertical slice

An inert SQLite scaffold for audit events: `lib/src/store/audit.rs`
(`rusqlite`, bundled SQLite, WAL mode, a `schema_version` table, an
`audit_events` table, and `open`/`migrate-from-JSON`/`count`/`verify`
functions), exposed via N-API, with a TypeScript bridge
(`app/src/native-sqlite-store.ts`). **Deliberately not wired into
`audit-log-store.ts`'s live read/write path** — nothing in the running app
calls this yet; it exists to prove the pattern (schema versioning,
idempotent migration-from-JSON safe to rerun, transactional batch inserts,
`PRAGMA integrity_check`-based corruption detection) works end-to-end
through the real built addon before committing to an actual cutover, per
the brief's own rollback requirement (ship behind a flag, default off).

9 new Rust tests (idempotent open, schema-version-recorded-once, WAL-mode
active, migration correctness/idempotency/partial-rerun/no-duplicate-rows,
a rejected malformed batch leaving zero rows behind — one bad event fails
the whole transaction rather than partially migrating), 5 new TypeScript
tests (full round trip through the actual built `.node` addon, rejected
malformed batch, and the addon-unavailable throw path), all verified via
the real built binary (`npm run build:debug` + a `require()` smoke test),
not just `cargo test`.

**A real build-infrastructure finding surfaced by adding this:** `cargo
test` started failing to link at all (not just for the new module — for
the *entire* crate, including previously-passing tests) once `rusqlite`
was added, with undefined references to `napi_reference_unref` /
`napi_delete_reference` / `napi_call_threadsafe_function`. These are napi's
own C-ABI symbols, normally supplied by the Node process that loads a
`.node` addon at runtime — a standalone `cargo test` binary has no Node
process to supply them, and this crate's `napi` dependency had
`default-features = false` without napi's own `dyn-symbols` feature (which
resolves those symbols dynamically instead of requiring them at static
link time, and is part of napi's *default* feature set — this crate had
just never turned it on, and the existing code path apparently never
triggered the linker into demanding those symbols before). Fix: added
`dyn-symbols` to the `napi` dependency's feature list in `lib/Cargo.toml`.
Re-verified after the fix that the real built addon still loads correctly
under Node (it does — see the smoke test above); this is a supported,
recommended napi-rs configuration, not a workaround.

**Explicitly not done, with reasons, per "stop and document the blocker"
rather than half-finish:**

- Actually cutting `audit-log-store.ts` over to the SQLite store, or
  migrating any other store (patient cases, sessions, evidence, model
  registry). The scaffold above is the foundation that cutover would use,
  not the cutover itself — flipping the live read/write path needs the
  three-way native/fallback/new-store comparison and feature-flag rollout
  described in §6, which is real, separately-scoped work.
- Crypto vault, RAG index, filesystem capability layer, process supervisor,
  system-inspection rewrite, ingestion, safety-scanning engine, recommender
  inference — none started. Each is a substantial, independently-scoped
  project per the brief's own phase breakdown.
