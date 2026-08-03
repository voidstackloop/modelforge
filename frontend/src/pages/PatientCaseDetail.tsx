import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { InlineNotice } from "@/components/ds";
import { CaseLockScreen } from "@/components/case-lock-screen";
import { CASE_LOCKED_EVENT } from "@/lib/case-auto-lock";
import type { CaseConsent, ClinicalNote, PatientCase } from "@/types/electron";

type StringFieldKey = "presentingComplaint" | "symptomsTimeline" | "vitalSigns" | "imagingAndReports";
type ListFieldKey = "conditions" | "allergies" | "medications";

/** One structured case field: a label, its content, and a checkbox that
 * controls whether it's eligible to be sent to a model — the on-screen
 * embodiment of "the user controls exactly which case fields are sent." */
function FieldRow({
    label,
    includeInContext,
    onToggleInclude,
    children,
}: {
    label: string;
    includeInContext: boolean;
    onToggleInclude: (value: boolean) => void;
    children: React.ReactNode;
}) {
    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="mb-2 flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-foreground">{label}</label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={includeInContext}
                        onChange={(e) => onToggleInclude(e.target.checked)}
                        className="size-3.5 accent-primary"
                    />
                    Include when sending to model
                </label>
            </div>
            {children}
        </div>
    );
}

const CONSENT_SCOPE_LABEL: Record<CaseConsent["scope"], string> = {
    "ai-assistance": "AI assistance on this case",
    "remote-model-use": "Sending this case's data to a remote/cloud model",
    research: "Use of this case's data for research",
};

/** A recording mechanism, not an enforcement one — nothing in this app
 * currently blocks an action based on consent state (there's no identity
 * system yet to gate against, see docs/ENTERPRISE_READINESS_ASSESSMENT.md).
 * This exists so consent is at least a structured, auditable fact instead
 * of buried in free text. */
function ConsentSection({
    records,
    onGrant,
    onRevoke,
}: {
    records: CaseConsent[];
    onGrant: (scope: CaseConsent["scope"], method: string) => void;
    onRevoke: (consentId: string) => void;
}) {
    const [scope, setScope] = useState<CaseConsent["scope"]>("ai-assistance");
    const [method, setMethod] = useState("");

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <p className="mb-2 text-xs font-semibold">Consent</p>
            {records.length > 0 && (
                <div className="mb-2.5 flex flex-col gap-1.5">
                    {records.map((r) => (
                        <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-2.5 py-1.5 text-xs">
                            <span>
                                <span className="font-medium">{CONSENT_SCOPE_LABEL[r.scope]}</span>
                                <span className="text-muted-foreground">
                                    {" "}
                                    — granted {new Date(r.grantedAt).toLocaleDateString()} ({r.method})
                                    {r.revokedAt && <> — revoked {new Date(r.revokedAt).toLocaleDateString()}</>}
                                </span>
                            </span>
                            {!r.revokedAt && (
                                <Button size="sm" variant="ghost" className="h-6 text-destructive" onClick={() => onRevoke(r.id)}>
                                    Revoke
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
                <select
                    value={scope}
                    onChange={(e) => setScope(e.target.value as CaseConsent["scope"])}
                    className="h-7 rounded-lg border border-border bg-background px-2 text-xs"
                >
                    {Object.entries(CONSENT_SCOPE_LABEL).map(([key, label]) => (
                        <option key={key} value={key}>
                            {label}
                        </option>
                    ))}
                </select>
                <Input
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    placeholder="How was consent obtained? (e.g. verbal, written form)"
                    className="h-7 max-w-xs text-xs"
                />
                <Button
                    size="sm"
                    variant="outline"
                    disabled={!method.trim()}
                    onClick={() => {
                        onGrant(scope, method);
                        setMethod("");
                    }}
                >
                    Record consent
                </Button>
            </div>
        </div>
    );
}

const REVIEW_OUTCOME_LABEL: Record<NonNullable<ClinicalNote["review"]>["outcome"], string> = {
    accepted: "Accepted",
    "accepted-with-edits": "Accepted with edits",
    rejected: "Rejected",
};

/** Model-inference notes carry no clinical weight until a clinician has
 * looked at them and recorded an outcome — presence in the case is not the
 * same as review. Clinician-authored notes need no sign-off, so they render
 * without the review controls entirely. */
function ClinicalNotesSection({
    notes,
    onAdd,
    onReview,
}: {
    notes: ClinicalNote[];
    onAdd: (text: string) => void;
    onReview: (noteId: string, reviewedBy: string, outcome: NonNullable<ClinicalNote["review"]>["outcome"]) => void;
}) {
    const [draft, setDraft] = useState("");
    const [reviewingNoteId, setReviewingNoteId] = useState<string | null>(null);
    const [reviewerName, setReviewerName] = useState("");

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <p className="mb-2 text-xs font-semibold">Clinical notes</p>
            {notes.length > 0 && (
                <div className="mb-2.5 flex flex-col gap-2">
                    {notes.map((n) => (
                        <div key={n.id} className="rounded-lg border border-border/50 p-2.5 text-xs">
                            <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">{n.author === "model-inference" ? "Model-generated" : "Clinician"}</span>
                                <span className="text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</span>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap">{n.text}</p>
                            {n.author === "model-inference" && (
                                <div className="mt-2 border-t border-border/40 pt-2">
                                    {n.review ? (
                                        <p className="text-muted-foreground">
                                            {REVIEW_OUTCOME_LABEL[n.review.outcome]} by {n.review.reviewedBy} on{" "}
                                            {new Date(n.review.reviewedAt).toLocaleDateString()}
                                        </p>
                                    ) : reviewingNoteId === n.id ? (
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <Input
                                                value={reviewerName}
                                                onChange={(e) => setReviewerName(e.target.value)}
                                                placeholder="Reviewer name"
                                                className="h-7 max-w-[10rem] text-xs"
                                            />
                                            {(Object.keys(REVIEW_OUTCOME_LABEL) as NonNullable<ClinicalNote["review"]>["outcome"][]).map((outcome) => (
                                                <Button
                                                    key={outcome}
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={!reviewerName.trim()}
                                                    onClick={() => {
                                                        onReview(n.id, reviewerName.trim(), outcome);
                                                        setReviewingNoteId(null);
                                                        setReviewerName("");
                                                    }}
                                                >
                                                    {REVIEW_OUTCOME_LABEL[outcome]}
                                                </Button>
                                            ))}
                                        </div>
                                    ) : (
                                        <span className="flex items-center gap-1.5 text-warning">
                                            <AlertTriangle className="size-3.5" /> Not yet reviewed —{" "}
                                            <button className="underline" onClick={() => setReviewingNoteId(n.id)}>
                                                sign off
                                            </button>
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
            <div className="flex gap-1.5">
                <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Add a clinician note…"
                    className="min-h-9 text-xs"
                />
                <Button
                    size="sm"
                    variant="outline"
                    className="self-end"
                    disabled={!draft.trim()}
                    onClick={() => {
                        onAdd(draft.trim());
                        setDraft("");
                    }}
                >
                    Add
                </Button>
            </div>
        </div>
    );
}

export default function PatientCaseDetail() {
    const { caseId } = useParams();
    const navigate = useNavigate();
    const [patientCase, setPatientCase] = useState<PatientCase | null>(null);
    const [conflicts, setConflicts] = useState<{ kind: string; medication: string; conflictsWith: string; detail: string }[]>([]);
    const [locked, setLocked] = useState(false);

    function loadCase() {
        if (!caseId) return;
        window.api.encryption.status().then((status) => {
            if (status.enabled && !status.unlocked) {
                setLocked(true);
                return;
            }
            setLocked(false);
            window.api.patientCases
                .get(caseId)
                .then(setPatientCase)
                .catch(() => setLocked(true));
        });
    }

    useEffect(loadCase, [caseId]);

    useEffect(() => {
        window.addEventListener(CASE_LOCKED_EVENT, loadCase);
        return () => window.removeEventListener(CASE_LOCKED_EVENT, loadCase);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [caseId]);

    useEffect(() => {
        if (!patientCase) return;
        window.api.patientCases
            .checkConflicts(patientCase.allergies.value, patientCase.medications.value)
            .then(setConflicts);
        // Deliberately narrower than the full `patientCase` object — this
        // check only depends on allergies/medications, so it must not re-run
        // on every unrelated field edit (title, notes, consent, ...).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [patientCase?.allergies.value, patientCase?.medications.value]);

    async function persist(partial: Record<string, unknown>) {
        if (!caseId) return;
        const updated = await window.api.patientCases.update(caseId, partial);
        if (updated) setPatientCase(updated);
    }

    async function handleGrantConsent(scope: "ai-assistance" | "remote-model-use" | "research", method: string) {
        if (!caseId || !method.trim()) return;
        const updated = await window.api.patientCases.grantConsent(caseId, scope, method.trim());
        if (updated) setPatientCase(updated);
    }

    async function handleRevokeConsent(consentId: string) {
        if (!caseId) return;
        const updated = await window.api.patientCases.revokeConsent(caseId, consentId);
        if (updated) setPatientCase(updated);
    }

    async function handleAddNote(text: string) {
        if (!caseId || !text.trim()) return;
        const updated = await window.api.patientCases.addNote(caseId, "clinician", text.trim());
        if (updated) setPatientCase(updated);
    }

    async function handleReviewNote(noteId: string, reviewedBy: string, outcome: NonNullable<ClinicalNote["review"]>["outcome"]) {
        if (!caseId) return;
        const updated = await window.api.patientCases.reviewNote(caseId, noteId, reviewedBy, outcome);
        if (updated) setPatientCase(updated);
    }

    function updateStringField(key: StringFieldKey, value: string) {
        if (!patientCase) return;
        persist({ [key]: { ...patientCase[key], value } });
    }

    function toggleInclude(key: StringFieldKey | ListFieldKey, includeInContext: boolean) {
        if (!patientCase) return;
        persist({ [key]: { ...patientCase[key], includeInContext } });
    }

    function updateListField(key: ListFieldKey, raw: string) {
        if (!patientCase) return;
        const value = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        persist({ [key]: { ...patientCase[key], value } });
    }

    if (locked) {
        return <CaseLockScreen onUnlocked={loadCase} />;
    }

    if (!patientCase) {
        return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Loading case…</div>;
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <Button variant="ghost" size="icon" className="size-7" onClick={() => navigate("/cases")} aria-label="Back to cases">
                    <ArrowLeft className="size-4" />
                </Button>
                <span className="text-sm font-semibold">{patientCase.title}</span>
            </div>

            <ScrollArea className="flex-1">
                <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
                    <Input
                        value={patientCase.title}
                        onChange={(e) => setPatientCase({ ...patientCase, title: e.target.value })}
                        onBlur={(e) => persist({ title: e.target.value })}
                        className="text-base font-medium"
                        aria-label="Case title"
                    />

                    {conflicts.length > 0 && (
                        <InlineNotice variant="warning" title="Possible allergy/medication conflicts — clinician review required">
                            <ul className="list-disc space-y-1 pl-4">
                                {conflicts.map((c, i) => (
                                    <li key={i}>{c.detail}</li>
                                ))}
                            </ul>
                            <p className="mt-1.5 text-xs italic">
                                Generated by simple keyword matching, not a licensed drug-interaction database. Verify independently.
                            </p>
                        </InlineNotice>
                    )}

                    <FieldRow
                        label="Presenting complaint"
                        includeInContext={patientCase.presentingComplaint.includeInContext}
                        onToggleInclude={(v) => toggleInclude("presentingComplaint", v)}
                    >
                        <Textarea
                            value={patientCase.presentingComplaint.value}
                            onChange={(e) => setPatientCase({ ...patientCase, presentingComplaint: { ...patientCase.presentingComplaint, value: e.target.value } })}
                            onBlur={(e) => updateStringField("presentingComplaint", e.target.value)}
                            className="min-h-16 text-sm"
                        />
                    </FieldRow>

                    <FieldRow
                        label="Symptoms and timeline"
                        includeInContext={patientCase.symptomsTimeline.includeInContext}
                        onToggleInclude={(v) => toggleInclude("symptomsTimeline", v)}
                    >
                        <Textarea
                            value={patientCase.symptomsTimeline.value}
                            onChange={(e) => setPatientCase({ ...patientCase, symptomsTimeline: { ...patientCase.symptomsTimeline, value: e.target.value } })}
                            onBlur={(e) => updateStringField("symptomsTimeline", e.target.value)}
                            className="min-h-16 text-sm"
                        />
                    </FieldRow>

                    <FieldRow
                        label="Vital signs"
                        includeInContext={patientCase.vitalSigns.includeInContext}
                        onToggleInclude={(v) => toggleInclude("vitalSigns", v)}
                    >
                        <Input
                            value={patientCase.vitalSigns.value}
                            onChange={(e) => setPatientCase({ ...patientCase, vitalSigns: { ...patientCase.vitalSigns, value: e.target.value } })}
                            onBlur={(e) => updateStringField("vitalSigns", e.target.value)}
                            placeholder="e.g. BP 122/78, HR 76, RR 16, Temp 37.0°C, SpO2 98%"
                            className="text-sm"
                        />
                    </FieldRow>

                    <div className="grid gap-3 sm:grid-cols-2">
                        <FieldRow
                            label="Known conditions"
                            includeInContext={patientCase.conditions.includeInContext}
                            onToggleInclude={(v) => toggleInclude("conditions", v)}
                        >
                            <Input
                                defaultValue={patientCase.conditions.value.join(", ")}
                                onBlur={(e) => updateListField("conditions", e.target.value)}
                                placeholder="Comma-separated, e.g. Hypertension, Type 2 diabetes"
                                className="text-sm"
                            />
                        </FieldRow>
                        <FieldRow
                            label="Allergies"
                            includeInContext={patientCase.allergies.includeInContext}
                            onToggleInclude={(v) => toggleInclude("allergies", v)}
                        >
                            <Input
                                defaultValue={patientCase.allergies.value.join(", ")}
                                onBlur={(e) => updateListField("allergies", e.target.value)}
                                placeholder="Comma-separated, e.g. Penicillin, Latex"
                                className="text-sm"
                            />
                        </FieldRow>
                    </div>

                    <FieldRow
                        label="Current medications"
                        includeInContext={patientCase.medications.includeInContext}
                        onToggleInclude={(v) => toggleInclude("medications", v)}
                    >
                        <Input
                            defaultValue={patientCase.medications.value.join(", ")}
                            onBlur={(e) => updateListField("medications", e.target.value)}
                            placeholder="Comma-separated, e.g. Metformin 500mg, Lisinopril 10mg"
                            className="text-sm"
                        />
                    </FieldRow>

                    <FieldRow
                        label="Imaging and reports"
                        includeInContext={patientCase.imagingAndReports.includeInContext}
                        onToggleInclude={(v) => toggleInclude("imagingAndReports", v)}
                    >
                        <Textarea
                            value={patientCase.imagingAndReports.value}
                            onChange={(e) => setPatientCase({ ...patientCase, imagingAndReports: { ...patientCase.imagingAndReports, value: e.target.value } })}
                            onBlur={(e) => updateStringField("imagingAndReports", e.target.value)}
                            className="min-h-16 text-sm"
                        />
                    </FieldRow>

                    <ClinicalNotesSection
                        notes={patientCase.clinicalNotes}
                        onAdd={handleAddNote}
                        onReview={handleReviewNote}
                    />

                    <ConsentSection
                        records={patientCase.consentRecords}
                        onGrant={handleGrantConsent}
                        onRevoke={handleRevokeConsent}
                    />

                    <InlineNotice variant="default" title="Provenance">
                        <p>
                            Fields above are clinician-entered facts you type directly. Nothing here is a model
                            inference — model-generated content only ever appears in the Clinical Assistant chat,
                            never written back into this case automatically.
                        </p>
                    </InlineNotice>

                    <div className="flex items-start gap-2 rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <p>
                            This case is stored unencrypted in this app's local data folder. Treat this device's
                            disk-level security (login password, disk encryption) as part of protecting this data —
                            ModelForge Medical does not itself certify HIPAA compliance.
                        </p>
                    </div>
                </div>
            </ScrollArea>
        </div>
    );
}
