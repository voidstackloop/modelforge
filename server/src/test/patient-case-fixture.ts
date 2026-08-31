import { patientCaseSchema, type PatientCase } from "@modelforge/contracts";

export function patientCaseFixture(id: string, extra: Record<string, unknown> = {}): PatientCase {
    const now = new Date().toISOString();
    return patientCaseSchema.parse({
        id,
        title: "Synthetic case",
        demographics: { value: {}, includeInContext: false },
        presentingComplaint: { value: "", includeInContext: false },
        symptomsTimeline: { value: "", includeInContext: false },
        vitalSigns: { value: "", includeInContext: false },
        conditions: { value: [], includeInContext: false },
        allergies: { value: [], includeInContext: false },
        medications: { value: [], includeInContext: false },
        labResults: { value: [], includeInContext: false },
        imagingAndReports: { value: "", includeInContext: false },
        clinicalNotes: [],
        attachments: [],
        consentRecords: [],
        createdAt: now,
        updatedAt: now,
        ...extra,
    });
}
