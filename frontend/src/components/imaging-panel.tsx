import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, ExternalLink, FileUp, Image, RefreshCw, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineNotice } from "@/components/ds";
import { useToast } from "@/components/toast";
import type { CreateImagingShareInput, ImagingIngestionJob, ImagingStudy } from "@/types/electron";

function Modal({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-label={title}>
            <div className={`max-h-[92vh] w-full overflow-auto rounded-xl border border-border bg-card p-4 shadow-xl ${wide ? "max-w-[96vw]" : "max-w-xl"}`}>
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold">{title}</h2>
                    <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
                </div>
                {children}
            </div>
        </div>
    );
}

function ShareDialog({ study, onClose }: { study: ImagingStudy; onClose: () => void }) {
    const toast = useToast();
    const [mode, setMode] = useState<CreateImagingShareInput["mode"]>("external-portal");
    const [recipient, setRecipient] = useState("");
    const [purpose, setPurpose] = useState("care coordination");
    const [consentBasis, setConsentBasis] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [oneTimeSecret, setOneTimeSecret] = useState<{ accessToken: string; verificationCode: string } | null>(null);

    async function submit() {
        setSubmitting(true);
        try {
            const share: CreateImagingShareInput = {
                mode,
                purposeOfUse: purpose.trim(),
                consentBasis: consentBasis.trim(),
                expiresInHours: 72,
                ...(mode === "external-portal" ? { recipientEmail: recipient.trim() } : { recipientUserId: recipient.trim() }),
            };
            const result = await window.api.imaging.createShare(study.id, share);
            setOneTimeSecret(result.external ?? null);
            toast.success("Imaging share created.");
            if (!result.external) onClose();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setSubmitting(false);
        }
    }

    if (oneTimeSecret) {
        return (
            <Modal title="External access details — shown once" onClose={onClose}>
                <InlineNotice variant="warning" title="Deliver these values separately">
                    The access token and verification code are intentionally returned only now. Send them through different trusted channels.
                </InlineNotice>
                <dl className="mt-3 space-y-2 text-xs">
                    <div><dt className="font-semibold">Access token</dt><dd className="mt-1 break-all rounded bg-muted p-2 font-mono select-all">{oneTimeSecret.accessToken}</dd></div>
                    <div><dt className="font-semibold">Verification code</dt><dd className="mt-1 rounded bg-muted p-2 font-mono select-all">{oneTimeSecret.verificationCode}</dd></div>
                </dl>
            </Modal>
        );
    }

    return (
        <Modal title={`Share ${study.description ?? "imaging study"}`} onClose={onClose}>
            <div className="space-y-3 text-xs">
                <label className="block">Recipient type
                    <select className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" value={mode} onChange={(e) => setMode(e.target.value as CreateImagingShareInput["mode"])}>
                        <option value="internal">Internal clinician</option>
                        <option value="cross-organization">Cross-organization clinician</option>
                        <option value="external-portal">External portal recipient</option>
                    </select>
                </label>
                <label className="block">{mode === "external-portal" ? "Recipient email" : "Recipient user ID"}
                    <Input className="mt-1" type={mode === "external-portal" ? "email" : "text"} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
                </label>
                <label className="block">Purpose of use<Input className="mt-1" value={purpose} onChange={(e) => setPurpose(e.target.value)} /></label>
                <label className="block">Consent basis<Input className="mt-1" placeholder="Document the authorization or consent basis" value={consentBasis} onChange={(e) => setConsentBasis(e.target.value)} /></label>
                <InlineNotice variant="default" title="Least privilege">This grants view-only access to this exact study for 72 hours. Downloads remain disabled.</InlineNotice>
                <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={submitting || !recipient.trim() || !purpose.trim() || !consentBasis.trim()} onClick={submit}>{submitting ? "Creating…" : "Create share"}</Button></div>
            </div>
        </Modal>
    );
}

export function ImagingPanel({ caseId }: { caseId: string }) {
    const toast = useToast();
    const inputRef = useRef<HTMLInputElement>(null);
    const [studies, setStudies] = useState<ImagingStudy[]>([]);
    const [activity, setActivity] = useState<ImagingIngestionJob[]>([]);
    const [heldJobs, setHeldJobs] = useState<ImagingIngestionJob[]>([]);
    const [resolvingJobId, setResolvingJobId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [shareStudy, setShareStudy] = useState<ImagingStudy | null>(null);
    const [viewer, setViewer] = useState<{ study: ImagingStudy; url: string } | null>(null);

    // Promise-chained rather than async/await, and `loading` is only ever
    // cleared here: both so the mount effect below never sets state
    // synchronously (react-hooks/set-state-in-effect). Same shape as
    // pages/PatientCases.tsx's own refresh(). Still returns a promise, so
    // upload/resolveHeldJob can await it.
    const refresh = useCallback((): Promise<void> => {
        return Promise.all([window.api.imaging.listStudies(caseId), window.api.imaging.listActivity()])
            .then(([nextStudies, nextActivity]) => {
                setStudies(nextStudies);
                const relevant = nextActivity.filter((job) => !job.studyId || nextStudies.some((study) => study.id === job.studyId));
                setActivity(relevant.slice(0, 20));
                // Held jobs are never truncated away by the 20-item activity
                // cap — an unresolved ambiguous match is an action item, not
                // a log line, so it gets its own list.
                setHeldJobs(relevant.filter((job) => job.status === "review-required"));
                setError(null);
            })
            .catch((err: unknown) => setError((err as Error).message))
            .finally(() => setLoading(false));
    }, [caseId]);

    useEffect(() => { void refresh(); }, [refresh]);

    async function upload(files: FileList | null) {
        if (!files?.length) return;
        setUploading(true);
        try {
            for (const file of Array.from(files)) {
                await window.api.imaging.upload(caseId, file.name, new Uint8Array(await file.arrayBuffer()));
            }
            toast.success(`${files.length} DICOM file${files.length === 1 ? "" : "s"} submitted.`);
            await refresh();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setUploading(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    }

    async function resolveHeldJob(job: ImagingIngestionJob, decision: "attach" | "reject") {
        setResolvingJobId(job.id);
        try {
            await window.api.imaging.resolveIngestionJob(job.id, decision, decision === "attach" ? caseId : undefined);
            toast.success(decision === "attach" ? `${job.fileName} attached to this case.` : `${job.fileName} rejected.`);
            await refresh();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setResolvingJobId(null);
        }
    }

    async function prepareViewer(study: ImagingStudy) {
        try {
            const launch = await window.api.imaging.openViewer(study.id);
            setViewer({ study, url: launch.viewerUrl });
        } catch (err) {
            toast.error((err as Error).message);
        }
    }

    function closeViewer() {
        if (viewer) void window.api.imaging.closeViewer(viewer.url);
        setViewer(null);
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h2 className="text-sm font-semibold">Clinical imaging</h2><p className="text-xs text-muted-foreground">DICOM studies linked to this case</p></div>
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setLoading(true); void refresh(); }} disabled={loading}><RefreshCw className="size-3.5" />Refresh</Button>
                    <Button size="sm" onClick={() => inputRef.current?.click()} disabled={uploading}><FileUp className="size-3.5" />{uploading ? "Uploading…" : "Upload DICOM"}</Button>
                    <input ref={inputRef} className="hidden" type="file" accept=".dcm,application/dicom" multiple onChange={(e) => void upload(e.target.files)} />
                </div>
            </div>

            {error && <InlineNotice variant="destructive" title="Imaging unavailable">{error}</InlineNotice>}
            {!error && !loading && studies.length === 0 && <div className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground"><Image className="mx-auto mb-2 size-6" />No imaging studies are linked to this case.</div>}
            <div className="space-y-2">
                {studies.map((study) => (
                    <div key={study.id} className="rounded-xl border border-border/70 bg-card p-3">
                        <div className="flex items-start justify-between gap-3">
                            <div><p className="text-sm font-medium">{study.description ?? `${study.modalities.join(" / ")} study`}</p><p className="mt-0.5 text-xs text-muted-foreground">{study.studyDate ?? "Date unavailable"} · {study.numberOfSeries} series · {study.numberOfInstances} instances · {study.ingestionStatus}</p></div>
                            <div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => void prepareViewer(study)}><ExternalLink className="size-3.5" />View</Button><Button size="sm" variant="outline" onClick={() => setShareStudy(study)}><Share2 className="size-3.5" />Share</Button></div>
                        </div>
                    </div>
                ))}
            </div>

            {heldJobs.length > 0 && (
                <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold"><AlertTriangle className="size-3.5" />Awaiting patient-match review</p>
                    <p className="mb-2 text-xs text-muted-foreground">
                        These files matched more than one case by patient identifier, so they were held rather than attached automatically. Confirm each one belongs to this case before attaching it.
                    </p>
                    <div className="space-y-1.5">
                        {heldJobs.map((job) => (
                            <div key={job.id} className="flex items-center justify-between gap-2 text-xs">
                                <span className="truncate">{job.fileName}</span>
                                <div className="flex shrink-0 gap-1">
                                    <Button size="sm" variant="outline" disabled={resolvingJobId !== null} onClick={() => void resolveHeldJob(job, "attach")}>Attach to this case</Button>
                                    <Button size="sm" variant="ghost" disabled={resolvingJobId !== null} onClick={() => void resolveHeldJob(job, "reject")}>Reject</Button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="rounded-xl border border-border/70 bg-card p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><Activity className="size-3.5" />Activity</p>
                {activity.length === 0 ? <p className="text-xs text-muted-foreground">No recent imaging ingestion activity for this case.</p> : <div className="space-y-1.5">{activity.map((job) => <div key={job.id} className="flex items-center justify-between gap-2 text-xs"><span className="truncate">{job.fileName}</span><span className="shrink-0 text-muted-foreground">{job.status}{job.failureCategory ? ` · ${job.failureCategory}` : ""}</span></div>)}</div>}
            </div>

            <InlineNotice variant="warning" title="Not validated for primary diagnosis">Use an institutionally validated diagnostic workstation for primary interpretation. This workflow is for review, collaboration, and documentation.</InlineNotice>
            {viewer && <Modal wide title={viewer.study.description ?? "OHIF imaging viewer"} onClose={closeViewer}>
                <div className="mb-2 rounded-md bg-warning/15 px-3 py-2 text-center text-xs font-semibold text-warning">Not validated for primary diagnosis</div>
                <iframe title="OHIF imaging viewer" src={viewer.url} className="h-[68vh] w-full rounded border border-border bg-black" allow="fullscreen" />
            </Modal>}
            {shareStudy && <ShareDialog study={shareStudy} onClose={() => setShareStudy(null)} />}
        </div>
    );
}
