-- Backs PostgresIdempotencyStore (see store/idempotency-store.ts's doc
-- comment for the full contract). response_body is the exact JSON body a
-- prior POST/PUT sent to its caller, replayed verbatim on a retried
-- request presenting the same (organization_id, idempotency_key) with a
-- matching request_hash.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status_code SMALLINT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, idempotency_key)
);

-- Supports a future scheduled cleanup (`DELETE ... WHERE created_at < now() - interval '...'`).
-- Not run by this service itself — see PostgresIdempotencyStore's doc
-- comment on why lazy expiry-on-read is sufficient for correctness and a
-- scheduled sweep is an operational, not application, concern.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at);
