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
import { useToast } from "@/components/toast";
import { ImagingPanel } from "@/components/imaging-panel";
import { ClinicalAiPanel } from "@/components/clinical-ai-panel";
import type { CaseConsent, ClinicalNote, MedicationSafetyResult, PatientCase } from "@/types/electron";

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

/** Renders one of four distinct states for a medication-safety check —
 * matches/warnings found, checked with no matches (never worded as "safe" or
 * "cleared"), unavailable/failed, or not applicable (nothing recorded yet).
 * `warnings.length === 0` alone is never sufficient to pick a state — see
 * MedicationSafetyResult's doc comment in app/src/medical-safety.ts. */
function MedicationSafetyNotice({ result }: { result: MedicationSafetyResult | null }) {
    if (!result) return null;

    if (!result.applicable) {
        return (
            <InlineNotice variant="default" title="No allergies or medications recorded">
                Nothing to check yet — add allergies or medications below to run a check.
            </InlineNotice>
        );
    }

    if (result.status === "unavailable" || result.status === "failed") {
        return (
            <InlineNotice
                variant="destructive"
                title={result.status === "unavailable" ? "Medication safety check unavailable" : "Medication safety check failed"}
            >
                {result.error ?? "The medication safety check could not run."} Treat this as unverified — it does not
                mean the recorded medications and allergies are safe together.
            </InlineNotice>
        );
    }

    if (result.warnings.length > 0) {
        return (
            <InlineNotice variant="warning" title="Possible allergy/medication conflicts — clinician review required">
                <ul className="list-disc space-y-1 pl-4">
                    {result.warnings.map((w, i) => (
                        <li key={i}>{w.detail}</li>
                    ))}
                </ul>
                <p className="mt-1.5 text-xs italic">
                    Generated by {result.providerLabel} — {result.limitations}
                </p>
            </InlineNotice>
        );
    }

    // Checked, zero warnings. Deliberately never worded as "safe", "cleared",
    // or "no interactions" — that would misrepresent a limited demonstration
    // matcher's silence as a clinical clearance.
    return (
        <InlineNotice variant="info" title="No matches found">
            No matches found by {result.providerLabel}; this is not a clinical interaction check.
            <p className="mt-1.5 text-xs italic">{result.limitations}</p>
        </InlineNotice>
    );
}

export default function PatientCaseDetail() {
    const { caseId } = useParams();
    const navigate = useNavigate();
    const toast = useToast();
    const [patientCase, setPatientCase] = useState<PatientCase | null>(null);
    const [medicationSafety, setMedicationSafety] = useState<MedicationSafetyResult | null>(null);
    const [locked, setLocked] = useState(false);
    // Distinct from `locked` — see PatientCases.tsx's identical distinction
    // for why: patientCases.get() can fail for a reason no passphrase
    // fixes (a shared/networked backend unreachable), and that must never
    // look like — or silently resolve to — an encryption lock screen.
    const [loadError, setLoadError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<"case" | "clinical-ai" | "imaging">("case");

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
                .then((c) => {
                    setLoadError(null);
                    setPatientCase(c);
                })
                .catch((err) => setLoadError((err as Error).message));
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
            .then(setMedicationSafety)
            // The IPC call itself can reject (e.g. malformed input rejected at
            // the validation boundary) separately from the in-band
            // status: "failed"/"unavailable" the store already returns for a
            // provider-side failure — this covers that outer failure mode so
            // it still renders as an explicit unavailable state instead of
            // silently leaving the last known result on screen.
            .catch(() =>
                setMedicationSafety({
                    providerName: "unknown",
                    providerLabel: "Medication safety check",
                    status: "failed",
                    evaluatedAt: new Date().toISOString(),
                    applicable: true,
                    warnings: [],
                    limitations: "",
                    error: "The medication safety check failed to complete. Treat this as unverified, not as a clean result.",
                })
            );
        // Deliberately narrower than the full `patientCase` object — this
        // check only depends on allergies/medications, so it must not re-run
        // on every unrelated field edit (title, notes, consent, ...).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [patientCase?.allergies.value, patientCase?.medications.value]);

    async function persist(partial: Record<string, unknown>) {
        if (!caseId) return;
        // version: the case as this screen last loaded it — the real
        // optimistic-concurrency check (see patient-cases-store.ts's
        // mutateCase doc comment: without a caller-supplied version, a
        // conflict can only be detected within a single call, not against
        // what a clinician's screen has been showing them). Only matters
        // once a shared/networked backend is active; the local backend has
        // exactly one writer and never conflicts.
        try {
            const updated = await window.api.patientCases.update(caseId, partial, patientCase?.version ?? null);
            if (updated) setPatientCase(updated);
        } catch (err) {
            // A conflict means someone else's edit already won — reload so
            // the screen reflects what's actually current rather than
            // silently keeping stale data on screen, and let the clinician
            // decide whether to redo their change against the fresh copy.
            toast.error((err as Error).message);
            loadCase();
        }
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

    if (loadError) {
        return (
            <div className="flex h-full items-center justify-center p-8">
                <InlineNotice
                    variant="destructive"
                    title="Couldn't load this case"
                    action={
                        <Button variant="outline" size="sm" onClick={loadCase} className="shrink-0">
                            Retry
                        </Button>
                    }
                >
                    {loadError}
                </InlineNotice>
            </div>
        );
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
                <div className="ml-auto flex rounded-lg border border-border p-0.5 text-xs">
                    <button className={`rounded-md px-3 py-1 ${activeTab === "case" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setActiveTab("case")}>Case</button>
                    <button className={`rounded-md px-3 py-1 ${activeTab === "clinical-ai" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setActiveTab("clinical-ai")}>Clinical AI</button>
                    <button className={`rounded-md px-3 py-1 ${activeTab === "imaging" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setActiveTab("imaging")}>Imaging</button>
                </div>
            </div>

            <ScrollArea className="flex-1">
                <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
                    {activeTab === "imaging" ? <ImagingPanel caseId={patientCase.id} /> : activeTab === "clinical-ai" ? <ClinicalAiPanel caseId={patientCase.id} /> : <>
                    <Input
                        value={patientCase.title}
                        onChange={(e) => setPatientCase({ ...patientCase, title: e.target.value })}
                        onBlur={(e) => persist({ title: e.target.value })}
                        className="text-base font-medium"
                        aria-label="Case title"
                    />

                    <MedicationSafetyNotice result={medicationSafety} />

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
                    </>}
                </div>
            </ScrollArea>
        </div>
    );
}
