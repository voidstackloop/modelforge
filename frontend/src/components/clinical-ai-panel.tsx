import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InlineNotice } from "@/components/ds";
import { useToast } from "@/components/toast";
import type { ClinicalAiImagingOption, ClinicalAiModelOption, ClinicalAiRequestDetail, ClinicalAiSubmitInput } from "@/types/electron";

const TEMPLATES = {
    "diagnostic-support": { label: "Diagnostic support", categories: ["presentingComplaint","symptomsTimeline","vitalSigns","conditions","labResults","imagingAndReports","imagingStudies"] },
    "medication-review": { label: "Medication review", categories: ["medications","allergies"] },
    "documentation-assist": { label: "Documentation draft", categories: ["clinicalNotes"] },
    summarization: { label: "Case summary", categories: ["presentingComplaint","symptomsTimeline","conditions","medications","clinicalNotes"] },
    teaching: { label: "Teaching review", categories: ["presentingComplaint","conditions","imagingAndReports","imagingStudies"] },
    research: { label: "Research extraction", categories: ["conditions","labResults","medications"] },
    "quality-improvement": { label: "Quality improvement", categories: ["conditions","medications","labResults"] },
} as const;
type Purpose = keyof typeof TEMPLATES;
type Preview = { dataCategories:string[];resourceCount:number;includesIdentifiers:boolean;provider:{name:string;kind:string}|null;model:{modelId:string;modelVersion:string;hostingRegion:string;processingLocation:string}|null };

const label = (value:string) => value.replace(/([A-Z])/g," $1").replace(/-/g," ").replace(/^./,c=>c.toUpperCase());
const consentPurpose = (purpose:Purpose):"treatment"|"research"|"teaching"|"quality-improvement" => purpose==="research"?"research":purpose==="teaching"?"teaching":purpose==="quality-improvement"?"quality-improvement":"treatment";

export function ClinicalAiPanel({caseId}:{caseId:string}) {
    const toast=useToast();
    const [models,setModels]=useState<ClinicalAiModelOption[]>([]);
    const [imaging,setImaging]=useState<ClinicalAiImagingOption[]>([]);
    const [activity,setActivity]=useState<ClinicalAiRequestDetail[]>([]);
    const [consents,setConsents]=useState<Awaited<ReturnType<typeof window.api.clinicalAi.listConsents>>>([]);
    const [purpose,setPurpose]=useState<Purpose>("diagnostic-support");
    const [modelId,setModelId]=useState("");
    const [categories,setCategories]=useState<string[]>([...TEMPLATES["diagnostic-support"].categories]);
    const [jobIds,setJobIds]=useState<string[]>([]);
    const [preview,setPreview]=useState<Preview|null>(null);
    const [busy,setBusy]=useState(false);
    const [error,setError]=useState<string|null>(null);
    const [reviewText,setReviewText]=useState<Record<string,string>>({});

    const reload=useCallback(async()=>{
        try { const [m,c,i,a]=await Promise.all([window.api.clinicalAi.listModels(),window.api.clinicalAi.listConsents(caseId),window.api.clinicalAi.listImagingOptions(caseId),window.api.clinicalAi.listActivity(caseId)]);setModels(m);setConsents(c);setImaging(i);setActivity(a);setModelId(current=>current||m[0]?.model.id||"");setError(null); }
        catch(err){setError((err as Error).message);}
    },[caseId]);
    useEffect(()=>{const timer=window.setTimeout(()=>void reload(),0);return()=>window.clearTimeout(timer);},[reload]);

    function changePurpose(next:Purpose){setPurpose(next);setCategories([...TEMPLATES[next].categories]);setJobIds([]);setPreview(null);}

    const scopedCategories=useMemo(()=>categories.filter(category=>category!=="imagingStudies"||jobIds.length>0),[categories,jobIds]);
    const request=useMemo<ClinicalAiSubmitInput>(()=>({providerModelId:modelId,purposeOfUse:purpose,requestedCategories:scopedCategories,selectedDeidentificationJobIds:jobIds}),[modelId,purpose,scopedCategories,jobIds]);
    const templateCategories: readonly string[] = TEMPLATES[purpose].categories;
    const activeConsent=consents.find(c=>c.purpose===consentPurpose(purpose)&&c.status==="active"&&(!c.expiresAt||new Date(c.expiresAt)>new Date()));
    const consentCovers=!!activeConsent&&scopedCategories.every(category=>activeConsent.dataCategories.includes(category));

    async function runPreview(){setBusy(true);try{setPreview(await window.api.clinicalAi.preview(caseId,request) as Preview);setError(null);}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
    async function grantConsent(){setBusy(true);try{await window.api.clinicalAi.createConsent(caseId,{purpose:consentPurpose(purpose),dataCategories:scopedCategories});await reload();toast.success("AI data-sharing consent recorded.");}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
    async function submit(){if(!preview)return;setBusy(true);try{await window.api.clinicalAi.submit(caseId,request);setPreview(null);await reload();toast.success("Unsigned AI draft created for clinician review.");}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
    async function recordReview(outputId:string,decision:"accepted"|"rejected"|"corrected"|"escalated"){
        const text=reviewText[outputId]?.trim();if((decision==="corrected"||decision==="escalated")&&!text){setError(`Enter ${decision==="corrected"?"corrected text":"an escalation reason"} first.`);return;}
        setBusy(true);try{await window.api.clinicalAi.review(outputId,{decision,correctedText:decision==="corrected"?text:undefined,escalationReason:decision==="escalated"?text:undefined});await reload();toast.success("Clinician decision recorded immutably.");}catch(err){setError((err as Error).message);}finally{setBusy(false);}
    }

    return <div className="space-y-4">
        <InlineNotice variant="warning" title="Clinical decision support — clinician review required">Outputs are unsigned drafts. They do not diagnose, prescribe, place orders, or update the medical record.</InlineNotice>
        {error&&<InlineNotice variant="destructive" title="Clinical AI unavailable" action={<Button size="sm" variant="outline" onClick={()=>void reload()}>Retry</Button>}>{error}</InlineNotice>}

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2"><Sparkles className="size-4"/><h3 className="text-sm font-semibold">New assisted task</h3></div>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-medium">Task template<select className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm" value={purpose} onChange={e=>changePurpose(e.target.value as Purpose)}>{Object.entries(TEMPLATES).map(([id,t])=><option key={id} value={id}>{t.label}</option>)}</select></label>
                <label className="space-y-1 text-xs font-medium">Approved model<select className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm" value={modelId} onChange={e=>{setModelId(e.target.value);setPreview(null);}}><option value="">Select a model</option>{models.map(item=><option key={item.model.id} value={item.model.id}>{item.provider.name} · {item.model.modelId} {item.model.modelVersion}</option>)}</select></label>
            </div>
            {models.length===0&&<p className="text-xs text-warning">No enabled tenant-approved model is available. An administrator must approve one first.</p>}
            <div><p className="mb-2 text-xs font-semibold">Data scope</p><div className="grid gap-2 sm:grid-cols-2">{templateCategories.filter(c=>c!=="imagingStudies").map(category=><label key={category} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs"><input type="checkbox" checked={categories.includes(category)} onChange={e=>{setCategories(v=>e.target.checked?[...v,category]:v.filter(x=>x!==category));setPreview(null);}}/>{label(category)}</label>)}</div></div>
            {templateCategories.includes("imagingStudies")&&<div><p className="mb-2 text-xs font-semibold">Reviewed de-identified imaging</p>{imaging.length===0?<p className="text-xs text-muted-foreground">No approved de-identification result is available for this case.</p>:<div className="space-y-2">{imaging.map(option=><label key={option.job.id} className="flex items-start gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs"><input className="mt-0.5" type="checkbox" checked={jobIds.includes(option.job.id)} onChange={e=>{setJobIds(v=>e.target.checked?[...v,option.job.id]:v.filter(x=>x!==option.job.id));setPreview(null);}}/><span><b>{option.modalities.join(", ")||"Imaging study"}</b> · {option.numberOfSeries} series / {option.numberOfInstances} instances<br/><span className="text-muted-foreground">{option.job.profile} · {option.job.reviewStatus}</span></span></label>)}</div>}</div>}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3"><span className="text-xs text-muted-foreground">Only checked fields and approved imaging manifests are shared.</span><Button size="sm" disabled={busy||!modelId||scopedCategories.length===0} onClick={()=>void runPreview()}>{busy?<Loader2 className="mr-1 size-3 animate-spin"/>:<ShieldCheck className="mr-1 size-3"/>}Preview sharing</Button></div>
        </section>

        {preview&&<section className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-4"><h3 className="text-sm font-semibold">Confirm what will be shared</h3><div className="grid gap-2 text-xs sm:grid-cols-2"><p><b>Provider:</b> {preview.provider?.name??"Unavailable"} ({preview.provider?.kind??"unknown"})</p><p><b>Model:</b> {preview.model?.modelId} {preview.model?.modelVersion}</p><p><b>Processing:</b> {preview.model?.processingLocation} / {preview.model?.hostingRegion}</p><p><b>Resources:</b> {preview.resourceCount}</p></div><p className="text-xs"><b>Categories:</b> {preview.dataCategories.map(label).join(", ")}</p>{preview.includesIdentifiers&&<p className="flex items-center gap-1.5 text-xs text-warning"><AlertTriangle className="size-3.5"/>Selected free text may contain identifiers even after automated redaction.</p>}{!consentCovers?<div className="flex items-center justify-between gap-2 rounded-md border border-warning/50 p-2 text-xs"><span>No active consent covers this exact scope.</span><Button size="sm" variant="outline" disabled={busy} onClick={()=>void grantConsent()}>Record consent</Button></div>:<p className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5"/>Active consent v{activeConsent?.version} covers this scope.</p>}<div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={()=>setPreview(null)}>Cancel</Button><Button size="sm" disabled={busy||!consentCovers} onClick={()=>void submit()}>Create unsigned draft</Button></div></section>}

        <section className="space-y-3"><h3 className="text-sm font-semibold">Activity and provenance</h3>{activity.length===0?<p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">No Clinical AI activity for this case.</p>:activity.map(item=><article key={item.request.id} className="space-y-3 rounded-xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><b>{label(item.request.purposeOfUse)}</b><span className="rounded-full bg-muted px-2 py-0.5">{label(item.request.status)}</span><span className="text-muted-foreground">{new Date(item.request.createdAt).toLocaleString()}</span></div><p className="text-xs text-muted-foreground">Scope: {item.request.dataScope.dataCategories.map(label).join(", ")} · Policy snapshot {item.request.policySnapshotHash.slice(0,12)}…</p>{item.transformations.length>0&&<p className="text-xs text-muted-foreground">Controls: {item.transformations.map(t=>label(t.kind)).join(" → ")}</p>}{item.outputs.map(({output,citations,review})=><div key={output.id} className="space-y-2 rounded-lg border border-border/70 p-3"><div><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Generated conclusion</p><p className="whitespace-pre-wrap text-sm">{output.summary}</p></div>{output.evidence.length>0&&<div><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Evidence</p><ul className="list-disc pl-4 text-xs">{output.evidence.map((value,index)=><li key={index}>{value}</li>)}</ul></div>}{output.uncertainty&&<div><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Uncertainty</p><p className="text-xs">{output.uncertainty}</p></div>}{output.followUp.length>0&&<div><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Suggested follow-up</p><ul className="list-disc pl-4 text-xs">{output.followUp.map((value,index)=><li key={index}>{value}</li>)}</ul></div>}<p className="text-xs text-muted-foreground">Citations: {citations.length?citations.map(c=>`${c.resourceType}:${c.resourceId}`).join(", "):"none"}</p>{review?<p className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5"/>{label(review.decision)} by clinician on {new Date(review.reviewedAt).toLocaleString()}</p>:<div className="space-y-2 border-t border-border pt-2"><Textarea value={reviewText[output.id]??""} onChange={e=>setReviewText(v=>({...v,[output.id]:e.target.value}))} placeholder="Required for correction or escalation; optional review note otherwise" className="min-h-14 text-xs"/><div className="flex flex-wrap gap-1.5">{(["accepted","rejected","corrected","escalated"] as const).map(decision=><Button key={decision} size="sm" variant="outline" disabled={busy} onClick={()=>void recordReview(output.id,decision)}>{label(decision)}</Button>)}</div></div>}</div>)}</article>)}</section>
    </div>;
}
