# Backup and restore

**Scope:** ModelForge Medical's encrypted, whole-profile backup mechanism
(`app/src/backup-store.ts`) — what it covers, how restore stays safe, and a
disaster-recovery runbook for the scenarios that actually happen. See
`docs/ENTERPRISE_READINESS_ASSESSMENT.md` §2.12 for the gap this closes
("No backup mechanism of any kind exists") and why it was Critical/P0.

## What gets backed up

Every top-level file this app persists under its `userData` directory,
enumerated by reading every `*-store.ts` module's own file path — not
guessed:

`settings.json`, `sessions.json`/`sessions.enc.json`,
`patient-cases.json`/`patient-cases.enc.json`, `case-encryption-config.json`,
`projects.json`, `model-registry.json`, `evidence-sources.json`,
`energy-usage.json`, `scheduled-tasks.json`, `download-jobs.json`,
`audit-log.json` or `audit-log.sqlite3` (+ its `-wal`/`-shm` sidecars),
`rag.db`, `policy-cache.json`.

A file that doesn't exist yet (e.g. `patient-cases.json` before any case is
created) is simply skipped — a backup only ever contains what's actually
present.

Each file's raw bytes are gzipped before being placed in the encrypted
envelope (compress first, then the unavoidable ~1.33x base64 overhead
applies only to the now-smaller compressed data — compressing already-
base64'd text barely helps, since base64 turns binary into semi-random
ASCII). Backups made before this existed (`version: 1`, uncompressed) still
restore correctly — the format version is checked per-backup, not assumed.

**Deliberately excluded:**
- `secrets.json` — provider API keys, encrypted via Electron's OS-keychain
  integration (`safeStorage`) when available. That encryption is tied to
  this specific device and OS user account; the ciphertext isn't portable to
  a different machine. Since API keys aren't PHI and are easy to re-enter,
  including this file would create a false expectation that restoring a
  backup elsewhere restores remote-provider access along with it.
- `logs/`, `benchmarks/`, `python-runtimes/`, `llamacpp-models/` — operational
  caches, logs, and re-downloadable runtime assets, not irreplaceable user
  data. Restoring old logs over current ones would be actively wrong, not
  just unnecessary.

## Encryption — a separate domain from case encryption

A backup uses **its own passphrase**, independent of whatever
case-encryption passphrase is (or isn't) active. This is deliberate:

- A backup must be encrypted by default *regardless* of whether case
  encryption is enabled on the live install — a backup file is a more
  likely leak vector than the live install itself (it gets copied to
  external drives, cloud-synced folders, email attachments).
- Reusing the live case-encryption key would tie old backups to a
  passphrase that may no longer exist after a rotation, with no fallback.

Same primitives as case encryption throughout (`scrypt` key derivation,
AES-256-GCM, an HMAC verifier that rejects a wrong passphrase before ever
attempting decryption) — independent state, not a new algorithm to review.

**There is no passphrase recovery mechanism, by design — the same as case
encryption.** If you lose a backup's passphrase, that backup's contents are
permanently unrecoverable. Write it down somewhere durable (a password
manager, not a sticky note on the monitor) before you need it.

## Why restore is safe: the three-phase design

1. **Decrypt and validate first, touching nothing.** Wrong passphrase,
   corrupted file, or a manifest with an internal checksum mismatch all fail
   here — before any live file is touched. A file name outside the
   known-safe list (defense against a malformed or forward-incompatible
   manifest ever being turned into a filesystem path) is rejected the same
   way.
2. **An automatic safety snapshot of the current state is taken first,**
   encrypted with the same passphrase just used for the restore. This is
   what makes restore itself reversible — restoring the wrong backup by
   mistake is undone by restoring that safety snapshot right back.
3. **Staged, verified writes, then an atomic swap.** Every restored file is
   written to a temporary directory and read back to confirm it matches
   before anything live is replaced. Encrypted-vs-plaintext counterpart
   files (`sessions.json`/`sessions.enc.json`,
   `patient-cases.json`/`patient-cases.enc.json`) are cleared first so a
   restore can never leave both sides of a pair on disk — matching the same
   invariant case-encryption's own stores already maintain on every normal
   write.

## Recovery point / recovery time

Backups can be manual (Settings → Audit & Privacy → Backup & Restore →
**Create backup**) or **scheduled**, in the same section's "Scheduled
backups" card. Turning scheduling on gives a real, operator-defined RPO —
**recovery point = at most `intervalHours`**, not "however long since you
remembered." Manual backups remain available alongside scheduling for an
on-demand copy before something risky (an upgrade, a bulk edit).

Scheduling is still **app-open only**: it runs on a timer inside the running
ModelForge process, the same limitation `scheduler.ts` (agent-prompt
scheduling) already has — there is no OS-level task registration, so a
device that's off or asleep for longer than `intervalHours` will have a
gap. An institution needing a guaranteed RPO across device downtime still
needs to operationalize that (e.g. "leave ModelForge running," or a manual
backup before extended downtime) rather than relying on the app alone.

Scheduled backups need a passphrase available with nobody present to type
it — that passphrase is stored in this device's OS keychain via the same
mechanism (`secrets-store.ts` / Electron `safeStorage`) already used for
provider API keys, including its already-handled fallback (logged at warn
level) on systems with no OS credential store. **This is a different trust
model than manual backups**, whose passphrase never touches disk — a manual
backup's passphrase exists only in memory for the moment it's used. Turning
on scheduling is an explicit choice to accept that trade-off in exchange for
a real RPO; the Settings UI states it plainly, and it's called out here
rather than left implicit.

Recovery time is however long it takes to run the restore flow (seconds,
for the mechanism itself) plus whatever time is needed to locate a
recent-enough backup file and remember its passphrase.

## Cloud backup destination (optional, secondary)

Settings → Audit & Privacy → Backup & Restore → "Cloud backup destination"
lets a scheduled backup also upload to any S3-compatible object store (AWS
S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, DigitalOcean Spaces, and
similar) rather than a specific provider's own SDK/OAuth integration — one
endpoint/bucket/access-key configuration covers all of them, matching the
same "bring your own credentials" pattern already used for LLM provider API
keys. The secret access key is stored the same way (OS keychain via
`secrets-store.ts`).

This is **best-effort and secondary**: a scheduled backup's local write to
`destinationDir` happens first and is what's recorded as success or failure
in the schedule's `lastError`. The cloud upload happens after, and its
failure is recorded separately (`lastCloudError`) without affecting or
retrying the local write — a network hiccup or a misconfigured bucket never
turns a successful local backup into a reported failure. "Test connection"
in the UI round-trips a tiny temporary object (PUT then DELETE) so
credentials and bucket permissions can be verified before relying on them
for a real backup.

## Disaster-recovery runbook

### Scenario: device lost, stolen, or destroyed

1. Install ModelForge Medical on a new device.
2. Settings → Audit & Privacy → Backup & Restore → **Restore from backup**.
3. Select the most recent `.mfbackup` file from wherever it was stored
   (external drive, secure cloud folder, etc. — the backup file itself is
   encrypted, so where it's stored matters less than how recent it is).
4. Enter the backup passphrase, review the preview (backup date, app
   version, file list), confirm.
5. If case encryption was enabled at backup time, the app will now show
   Patient Cases/Clinical Assistant as locked — unlock with the
   case-encryption passphrase that was active at backup time (this is a
   *different* passphrase from the backup's own, if you set it up that way).

### Scenario: local data corrupted (a store's own corruption-recovery kicked
in — see `docs/ARCHITECTURE.md`'s persistence pattern — but you want to go
back further than that)

1. Same restore flow as above, using a backup from before the corruption.

### Scenario: restored the wrong backup, or a backup you didn't mean to

1. Every restore leaves a safety snapshot at
   `<userData>/backups/pre-restore-<timestamp>.mfbackup`, reported in the
   success message and recorded (path only, no content) in the audit log.
2. Restore *that* file, using the same passphrase you used for the restore
   that created it.

### Scenario: forgot the backup passphrase

There is no recovery path — this is the same irreversible-by-design
trade-off as case encryption's own passphrase (`docs/CENTRAL_POLICY.md`'s
sibling document, `docs/CLINICAL_WORKSPACE.md`, makes the same point about
case encryption). The backup is permanently unreadable. This is why the
passphrase must be stored somewhere durable before it's needed, not
something this document can work around.

### Scenario: need to verify a backup is good without restoring it

1. Backup & Restore → **Restore from backup** → select the file → enter the
   passphrase → **Preview**. This decrypts and validates (including every
   file's checksum) without touching any live data — cancel afterward if you
   only wanted to confirm the backup is readable.

## What's deliberately not built

- **Cross-device backup transport/sharing.** A backup file is portable
  (any ModelForge install with the right passphrase can restore it), but
  there's no in-app mechanism for getting it *to* another device — that's
  the user's own file-transfer method (a cloud backup destination, above,
  covers the "get it off this device automatically" part, but not moving it
  onward to a specific other device).
- **OS-level scheduling.** Both manual and scheduled backups only run while
  ModelForge is open — see the RPO section above. Waking the app on a
  schedule the OS enforces even while the app is closed (a system service,
  a launch agent) isn't built.
- **A specific cloud provider's own SDK/OAuth integration.** The cloud
  destination is deliberately generic S3-compatible rather than, say, a
  native Dropbox/Google Drive/OneDrive integration with its own consent
  flow — those remain reachable only indirectly, via a local sync folder
  chosen as the scheduled-backup destination or manual save location.

None of these are safety gaps in what's built — they're scope boundaries,
stated honestly rather than silently absent.
