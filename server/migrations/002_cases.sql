-- Patient case storage for PostgresCaseStore. A separate per-organization
-- counter table (rather than MAX(version)+1 over patient_cases) so a
-- version number is never reused after a case is deleted and a new case
-- happens to reuse the same id — the counter only ever moves forward.

CREATE TABLE IF NOT EXISTS case_version_counters (
    organization_id UUID PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
    next_version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS patient_cases (
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    -- Client-generated (randomUUID() in app/src/patient-cases-store.ts),
    -- not necessarily a UUID-format string in every future caller — TEXT,
    -- not the UUID type, so this table never rejects an id shape the
    -- client-side contract doesn't itself constrain.
    case_id TEXT NOT NULL,
    version BIGINT NOT NULL,
    -- The full PatientCaseEnvelope (domain/case-types.ts) — see that
    -- file's doc comment for why this is an opaque JSON blob rather than a
    -- normalized clinical schema.
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (organization_id, case_id)
);
CREATE INDEX IF NOT EXISTS idx_patient_cases_organization_id ON patient_cases (organization_id);
