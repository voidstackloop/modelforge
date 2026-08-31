-- Backs PostgresIamStore.getAuthorizationEpoch (see store/iam-store.ts's
-- doc comment on that method for the full rationale). One row per
-- organization, created lazily by the first group/policy mutation that
-- bumps it — an organization that has never had one simply has no row, and
-- getAuthorizationEpoch treats that as epoch 1.

CREATE TABLE IF NOT EXISTS authorization_epochs (
    organization_id UUID PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL DEFAULT 1
);
