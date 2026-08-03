# Rust Datastore Migration — Test Report

This documents the full verification pass for moving ModelForge Medical's
JSON data-store I/O and the audit log's tamper-evident hash chain to a Rust
native addon (`lib/`, the same napi-rs module already used for GGUF
downloads), including the fix for the audit log's O(n²) append pattern.

Scope of the change: `app/src/json-store.ts` (read/write, used by every
`*-store.ts`), `app/src/audit-log-store.ts` (SHA-256 hashing and, separately,
its append algorithm). Every native call has a pure-TypeScript fallback —
nothing in this change requires the addon to be built; it only makes things
faster when it is.

## What changed, in one paragraph each

1. **JSON file read/write → Rust.** `lib/src/datastore.rs`'s
   `read_json_file` / `write_json_file_atomic` back `json-store.ts`'s
   `readJson` / `readJsonWithSchema` / `writeJson`. Behavior (atomic
   temp-file-then-rename, private file mode, corrupted-file backup) is
   byte-for-byte unchanged; only the underlying I/O implementation moved.
2. **Audit event hashing → Rust.** `sha256_hex` backs
   `audit-log-store.ts`'s `computeEventHash`, used both when recording an
   event and when `verifyChainIntegrity()` re-derives every event's hash.
3. **The actual bottleneck fix: O(1) audit log appends.**
   `append_json_array_element` splices a new event directly onto the end of
   the existing `audit-log.json` array — no re-reading, re-parsing, or
   re-serializing what's already on disk — paired with an in-memory
   `{count, lastHash}` cache in `audit-log-store.ts` that's checkpointed
   against the file's real mtime/size before every use and self-heals (one
   full re-read) if anything outside this module touched the file. A soft
   cap (`MAX_EVENTS` + `TRIM_BATCH` = 5000 + 100) keeps this fast
   indefinitely instead of reverting to O(n)-per-write forever once an
   install's audit log first reaches capacity — a real cliff that a smaller
   first version of this fix had (see "What stress testing caught" below).

## Test suites and results

| Suite | Tool | Files | Tests | Result |
|---|---|---|---|---|
| Rust unit | `cargo test` | 4 modules (`datastore`, `download`, `manager`, root) | 37 | ✅ 37 passed |
| Rust format/lint | `cargo fmt --check`, `cargo clippy -- -D warnings` | — | — | ✅ clean |
| App unit (native addon built) | `vitest` | 41 | 570 | ✅ 570 passed |
| App unit (native addon absent — CI's default) | `vitest` | 41 | 570 | ✅ 569 passed, 1 skipped* |
| Frontend unit | `vitest` | 14 | 95 | ✅ 95 passed |
| Frontend lint/typecheck | `eslint`, `tsc -b` | — | — | ✅ clean |
| App typecheck/build | `tsc`, `tsc -p` | — | — | ✅ clean |
| E2E (real Electron app, Playwright) | `playwright test` | 6 specs | 9 | ✅ 9 passed |

\* The one skipped test (`stays correct across multiple trim cycles (2x the
cap)`) is a large-scale stress test that's only meaningful with the native
addon's fast-append path active — without it, it would legitimately take
minutes of pure O(n²) work to prove something the smaller cap test already
covers, so it's guarded with `it.skipIf(!nativeAddonPresent)` rather than
slowing down the standard CI run for no additional signal.

Every suite above was run **twice**: once with the native addon built
(`npm run build:debug` in `lib/`), once with `app/native/` temporarily moved
aside to force the pure-TypeScript fallback path. Both runs pass with
identical test *results* — only timing differs, which is exactly the
property this change is supposed to have (a pure performance optimization,
zero behavior change).

## New tests added this round

- `lib/src/datastore.rs` — 8 new Rust tests for `append_json_array_element`:
  missing file, empty file, non-array tail, truncated array, append onto an
  empty array, append onto a compact array, append onto a pretty-printed
  (indented) array, and a 50-iteration repeated-append order/content check.
- `app/src/native-datastore.test.ts` — a 4th test (`appendJsonArrayElementNative`)
  covering both the addon-present and addon-absent branches.
- `app/src/audit-log-store.test.ts` — 3 new tests:
  - **Multi-trim-cycle stress test** (10,010 events, 2× the cap): proves the
    soft-cap design stays correct — bounded size, valid hash chain, newest
    event always retained — across many trim cycles, not just the original
    single 10-events-over-cap case.
  - **Self-healing under external mutation**: writes directly to
    `audit-log.json` between two `recordEvent()` calls (simulating a text
    editor, restored backup, or another process) and confirms the store
    notices (via the mtime/size checkpoint) and reseeds instead of trusting
    a now-stale cached hash — and confirms `verifyChainIntegrity()` still
    correctly reports the resulting anomaly as broken, rather than the
    self-healing silently "fixing" what is a genuine tamper signal.
  - **Informational timing benchmark**: 2,000 sequential `recordEvent()`
    calls, logged (not just asserted) so the number is visible in test
    output; asserted only against a generous 20s ceiling meant to catch a
    regression back to O(n²), not to pin an exact number.
- `e2e/tests/audit-log-persistence.spec.ts` (new spec, 1 test): drives the
  real Electron app — create a patient case → confirm the resulting
  `case-created` audit event appears in the Audit & Privacy page → click
  "Verify integrity" → relaunch against the same profile → confirm the event
  and a valid integrity check both survived to disk. This is the one place
  in the whole suite that never knows or cares whether native or fallback
  served the write — it only checks that the end-to-end behavior is
  correct, which is the actual guarantee this change needs to hold.

## Timing comparison

All numbers are real, from this sandbox, for the 5,010-event scenario the
original bottleneck was reported and measured against
(`audit-log-store.test.ts`'s "caps retained events instead of growing
without bound", later widened to 5,110 events to actually exercise the new
soft cap):

| Configuration | Time for ~5,000 sequential audit events |
|---|---|
| Before any Rust migration (pure Node/TS, full read-modify-write + `crypto` hash per write) | ~20–23s |
| Rust I/O + hashing, but still full read-modify-write per write (first migration pass) | ~20–21s (I/O/hash constant factor only — the O(n²) shape was unchanged) |
| Rust I/O + hashing + O(1) append + soft-cap trimming (final) | **~0.3s** |
| Same final code, native addon *not* built (fallback path) | ~22–24s (unchanged from "before" — confirms zero regression when the addon is unavailable) |

That's roughly a **70×** improvement for the scenario that motivated this
work, achieved by fixing the actual algorithmic shape (O(n²) → effectively
O(n) below the soft cap) rather than only speeding up the same repeated
work in a faster language.

The larger 2×-cap stress test (10,010 events, only run with the addon
present) completes in **~1–1.5s**. Extrapolating the old O(n²) behavior to
that same scale would have taken on the order of minutes.

## What stress testing caught (and fixed)

The first version of this fix (committed before this test-writing pass)
handled the *ramp-up* phase correctly — 0 up to the 5,000-event cap — but
fell back to a full read-modify-write on literally every single event once
at or over the cap, because the cap was enforced exactly. That's fine for a
5,010-event test (only 10 events pay the slow-path cost), but it means any
install that runs long enough to actually *reach* its audit log cap — which
real usage over weeks/months will — reverts to the original O(n)-per-write
cost forever afterward, for its entire remaining lifetime. The large-scale
(10,010-event, 2× cap) stress test added in this pass is what surfaced this:
it timed out at the original 60s budget instead of the sub-2-second result
the smaller test showed.

Fix: the cap became a **soft cap** — `MAX_EVENTS` (5,000, unchanged,
still what Settings → Audit & Privacy and every existing test describes)
plus a `TRIM_BATCH` (100) of slack. The file is allowed to grow up to
5,100 events before a single full-array trim brings it back down to
exactly 5,000, so the O(n) trim cost is amortized over 100 appends instead
of paid on every one — capacity is a steady state the fast path stays in
indefinitely, not a wall it hits once and never leaves.

## Correctness properties preserved (unchanged by any of this)

- **Tamper-evidence never trusts the cache.** `verifyChainIntegrity()` and
  `listEvents()` always re-read the real file from disk — the in-memory
  cache exists purely to make `recordEvent()`'s own bookkeeping cheap, and
  is never consulted for anything that needs to be actually trustworthy.
- **Retention purging is exact when active.** Age-based retention
  (Settings → Audit & Privacy) still forces the full read-modify-write path
  on every write while enabled, since purging by age requires seeing every
  event's timestamp — unchanged from before this work, verified by the
  pre-existing "purges expired events on write too" test.
- **On-disk format is unchanged.** Still a plain JSON array
  (`JSON.stringify`-compatible), still readable by literally every existing
  test that does `JSON.parse(fs.readFileSync(auditLogPath()))` directly —
  nothing about this change required a migration or a new file format.
- **Every fallback is exercised, not just written.** Every "falls back to
  X" comment in the code was verified by actually forcing that path (hiding
  the built addon, or in the Rust tests, feeding malformed/missing files
  directly) and confirming the fallback produces the same result the
  primary path would have.
