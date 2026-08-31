import { z } from "zod";
import type { PolicyDocument } from "@/lib/api/types";

// A literal mirror of server/src/domain/types.ts's policyDocumentSchema
// (same .strict() shape) — anything that passes here is guaranteed to pass
// server-side too, giving immediate, precise, field-level feedback instead
// of a round trip.
const policyConditionSchema = z
    .object({
        StringEquals: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        StringNotEquals: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    })
    .strict();

const policyStatementSchema = z
    .object({
        sid: z.string().optional(),
        effect: z.enum(["Allow", "Deny"]),
        actions: z.array(z.string().min(1)).min(1),
        resources: z.array(z.string().min(1)).min(1),
        condition: policyConditionSchema.optional(),
    })
    .strict();

const policyDocumentSchema = z
    .object({
        version: z.literal("2026-01-01"),
        statements: z.array(policyStatementSchema).min(1),
    })
    .strict();

export type PolicyDocumentValidation = { valid: true; document: PolicyDocument } | { valid: false; errors: string[] };

export function validatePolicyDocumentJson(raw: string): PolicyDocumentValidation {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return { valid: false, errors: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
    }
    const result = policyDocumentSchema.safeParse(parsed);
    if (!result.success) {
        return { valid: false, errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
    }
    return { valid: true, document: result.data as PolicyDocument };
}
