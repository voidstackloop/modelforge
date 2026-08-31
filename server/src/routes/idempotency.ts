import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { IdempotencyStore } from "../store/idempotency-store.js";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
// Generous enough for a UUID or any reasonable client-generated token,
// tight enough to keep a rejected/malformed header from being used to
// stuff an arbitrarily large string into the store as a lookup key.
const MAX_KEY_LENGTH = 255;

function hashRequest(request: FastifyRequest): string {
    return createHash("sha256")
        .update(request.method)
        .update("\n")
        .update(request.url)
        .update("\n")
        .update(JSON.stringify(request.body ?? null))
        .digest("hex");
}

export type IdempotencyOutcome =
    | { replay: true }
    | { replay: false; record: (statusCode: number, body: unknown) => Promise<void> };

/**
 * Idempotency-Key support for case writes (routes/cases.ts's POST/PUT), per
 * docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md's "Offline edit and reconnect"
 * flow: "each edit has a UUID idempotency key... Duplicate keys with the
 * same request hash return the original response; reuse with a different
 * hash returns a conflict."
 *
 * Entirely opt-in — a request with no Idempotency-Key header gets
 * `{ replay: false, record: <no-op> }` and the route behaves exactly as it
 * did before this existed. This matters specifically for PUT/If-Match: a
 * client whose edit actually succeeded server-side but never saw the
 * response (dropped connection, timeout) would otherwise retry with its
 * now-stale If-Match version and get a spurious 412 indistinguishable from
 * a real concurrent edit by someone else. Presenting the same
 * Idempotency-Key with an identical body on the retry replays the original
 * response instead, so the retry is safe.
 *
 * Only the write routes' *server-side* half of that flow — a client must
 * still generate a key once per logical edit attempt and resend the same
 * one on retry for any of this to help. The Electron app's client does
 * exactly that as of P1 item 5 (app/src/case-offline-cache.ts's durable
 * outbox): a queued write generates its idempotency key once, and reuses it
 * on every flush attempt against this same key across process restarts.
 *
 * Callers must check `replay` before doing anything else: `true` means a
 * cached response (or a 409 conflict for a reused key with a different
 * hash) has already been sent via `reply`, and the route handler must
 * return immediately. `false` provides `record`, which the handler must
 * call with whatever status/body it ultimately sends, so a genuinely new
 * key becomes replayable for a future retry.
 */
export async function withIdempotencyKey(
    idempotencyStore: IdempotencyStore,
    organizationId: string,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<IdempotencyOutcome> {
    const header = request.headers[IDEMPOTENCY_KEY_HEADER];
    const key = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
    if (!key || key.length === 0 || key.length > MAX_KEY_LENGTH) {
        return { replay: false, record: async () => {} };
    }

    const hash = hashRequest(request);
    const existing = await idempotencyStore.get(organizationId, key);
    if (existing) {
        if (existing.requestHash !== hash) {
            reply.code(409).send({
                error: "idempotency_key_reused",
                message: "This Idempotency-Key was already used for a different request.",
            });
        } else {
            reply.code(existing.statusCode).send(existing.responseBody);
        }
        return { replay: true };
    }

    return {
        replay: false,
        record: async (statusCode: number, body: unknown) => {
            await idempotencyStore.put(organizationId, key, { requestHash: hash, statusCode, responseBody: body });
        },
    };
}
