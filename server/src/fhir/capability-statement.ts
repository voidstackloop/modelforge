import type { FhirCapabilityStatement } from "@modelforge/contracts";
import { fhirCapabilityStatementSchema } from "@modelforge/contracts";

/**
 * Advertises exactly the interactions routes/fhir.ts actually implements —
 * `read` on Patient/DiagnosticReport/ImagingStudy, `search-type` on
 * DocumentReference only (its route has no by-id read, see that file). A
 * real SMART-on-FHIR client is expected to call this before doing anything
 * else; keeping it honest (never advertising an interaction that 404s) is
 * the whole point of publishing it at all.
 */
export function buildCapabilityStatement(): FhirCapabilityStatement {
    return fhirCapabilityStatementSchema.parse({
        resourceType: "CapabilityStatement",
        status: "active",
        date: new Date().toISOString(),
        kind: "instance",
        fhirVersion: "4.0.1",
        format: ["json"],
        rest: [
            {
                mode: "server",
                resource: [
                    { type: "Patient", interaction: [{ code: "read" }] },
                    { type: "DiagnosticReport", interaction: [{ code: "read" }] },
                    { type: "ImagingStudy", interaction: [{ code: "read" }] },
                    { type: "DocumentReference", interaction: [{ code: "search-type" }] },
                ],
            },
        ],
    } satisfies FhirCapabilityStatement);
}
