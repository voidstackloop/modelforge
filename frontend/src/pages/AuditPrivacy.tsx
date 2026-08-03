import { useEffect, useState } from "react";
import { Lock, LockOpen, ShieldAlert, ShieldCheck, Trash2, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { EmptyState, InlineNotice } from "@/components/ds";
import { ENCRYPTION_STATUS_CHANGED_EVENT } from "@/lib/case-auto-lock";
import type { ApprovedModel, AuditChainVerificationResult, AuditEvent } from "@/types/electron";

type EncryptionAction = "setup" | "unlock" | "disable" | "changePassphrase" | null;

function EncryptionSection() {
    const [status, setStatus] = useState<{ enabled: boolean; unlocked: boolean } | null>(null);
    const [action, setAction] = useState<EncryptionAction>(null);
    const [passphrase, setPassphrase] = useState("");
    const [confirmPassphrase, setConfirmPassphrase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [autoLockMinutes, setAutoLockMinutes] = useState<number>(15);

    function refresh() {
        window.api.encryption.status().then(setStatus);
        window.api.settings.get().then((s) => setAutoLockMinutes(s.caseAutoLockMinutes ?? 15));
        window.dispatchEvent(new Event(ENCRYPTION_STATUS_CHANGED_EVENT));
    }
    useEffect(refresh, []);

    async function saveAutoLockMinutes(minutes: number) {
        setAutoLockMinutes(minutes);
        await window.api.settings.save({ caseAutoLockMinutes: minutes });
        window.dispatchEvent(new Event(ENCRYPTION_STATUS_CHANGED_EVENT));
    }

    function resetForm() {
        setAction(null);
        setPassphrase("");
        setConfirmPassphrase("");
        setError(null);
    }

    async function submitSetup() {
        if (passphrase !== confirmPassphrase) {
            setError("Passphrases don't match.");
            return;
        }
        setBusy(true);
        try {
            const res = await window.api.encryption.setup(passphrase);
            if (res.success) {
                resetForm();
                refresh();
            } else {
                setError(res.error ?? "Could not enable encryption.");
            }
        } finally {
            setBusy(false);
        }
    }

    async function submitUnlock() {
        setBusy(true);
        try {
            const res = await window.api.encryption.unlock(passphrase);
            if (res.success) {
                resetForm();
                refresh();
            } else {
                setError("Incorrect passphrase.");
            }
        } finally {
            setBusy(false);
        }
    }

    async function submitDisable() {
        setBusy(true);
        try {
            const res = await window.api.encryption.disable(passphrase);
            if (res.success) {
                resetForm();
                refresh();
            } else {
                setError(res.error ?? "Could not disable encryption.");
            }
        } finally {
            setBusy(false);
        }
    }

    async function submitChangePassphrase() {
        if (confirmPassphrase.length < 8) {
            setError("New passphrase must be at least 8 characters.");
            return;
        }
        setBusy(true);
        try {
            const res = await window.api.encryption.changePassphrase(passphrase, confirmPassphrase);
            if (res.success) {
                resetForm();
                refresh();
            } else {
                setError(res.error ?? "Could not change passphrase.");
            }
        } finally {
            setBusy(false);
        }
    }

    async function handleLock() {
        await window.api.encryption.lock();
        refresh();
    }

    if (!status) return null;

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="flex items-center gap-1.5 text-xs font-semibold">
                        {status.enabled ? status.unlocked ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" /> : null}
                        Encryption at rest — patient cases and chat sessions
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {status.enabled
                            ? status.unlocked
                                ? "Enabled and unlocked — patient case and chat session data is decrypted for this session."
                                : "Enabled and locked — enter the passphrase to access Patient Cases and Clinical Assistant chat history."
                            : "Off by default. Turning this on encrypts both patient-cases.json (allergies, medications, conditions, notes) and sessions.json (chat history, which often carries the same clinical detail pasted or typed into a message) under one passphrase — the passphrase itself is never stored anywhere."}
                    </p>
                </div>
                {status.enabled && (
                    <Badge variant={status.unlocked ? "success" : "warning"}>{status.unlocked ? "Unlocked" : "Locked"}</Badge>
                )}
            </div>

            {!action && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                    {!status.enabled && (
                        <Button size="sm" variant="outline" onClick={() => setAction("setup")}>
                            Enable encryption
                        </Button>
                    )}
                    {status.enabled && status.unlocked && (
                        <>
                            <Button size="sm" variant="outline" onClick={handleLock} className="gap-1.5">
                                <Lock className="size-3.5" /> Lock now
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setAction("changePassphrase")}>
                                Change passphrase
                            </Button>
                            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setAction("disable")}>
                                Disable encryption
                            </Button>
                        </>
                    )}
                    {status.enabled && !status.unlocked && (
                        <Button size="sm" onClick={() => setAction("unlock")} className="gap-1.5">
                            <LockOpen className="size-3.5" /> Unlock
                        </Button>
                    )}
                </div>
            )}

            {status.enabled && !action && (
                <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
                    <span>Auto-lock after</span>
                    <select
                        value={autoLockMinutes}
                        onChange={(e) => saveAutoLockMinutes(Number(e.target.value))}
                        className="h-7 rounded-lg border border-border bg-background px-2 text-xs"
                    >
                        <option value={0}>Never</option>
                        <option value={5}>5 minutes</option>
                        <option value={15}>15 minutes</option>
                        <option value={30}>30 minutes</option>
                        <option value={60}>1 hour</option>
                    </select>
                    <span>of inactivity</span>
                </div>
            )}

            {action && (
                <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                    {action === "setup" && (
                        <>
                            <Input type="password" placeholder="New passphrase (min 8 characters)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="h-8 text-xs" autoFocus />
                            <Input type="password" placeholder="Confirm passphrase" value={confirmPassphrase} onChange={(e) => setConfirmPassphrase(e.target.value)} className="h-8 text-xs" />
                        </>
                    )}
                    {action === "unlock" && (
                        <Input type="password" placeholder="Passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="h-8 text-xs" autoFocus />
                    )}
                    {action === "disable" && (
                        <Input type="password" placeholder="Passphrase (to confirm)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="h-8 text-xs" autoFocus />
                    )}
                    {action === "changePassphrase" && (
                        <>
                            <Input type="password" placeholder="Current passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="h-8 text-xs" autoFocus />
                            <Input type="password" placeholder="New passphrase (min 8 characters)" value={confirmPassphrase} onChange={(e) => setConfirmPassphrase(e.target.value)} className="h-8 text-xs" />
                        </>
                    )}
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            disabled={busy || !passphrase}
                            onClick={
                                action === "setup"
                                    ? submitSetup
                                    : action === "unlock"
                                      ? submitUnlock
                                      : action === "disable"
                                        ? submitDisable
                                        : submitChangePassphrase
                            }
                        >
                            Confirm
                        </Button>
                        <Button size="sm" variant="outline" onClick={resetForm}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

function ModelRegistrySection() {
    const [models, setModels] = useState<ApprovedModel[]>([]);
    const [provider, setProvider] = useState("");
    const [modelId, setModelId] = useState("");
    const [busy, setBusy] = useState(false);

    function refresh() {
        window.api.modelRegistry.list().then(setModels);
    }
    useEffect(refresh, []);

    const active = models.filter((m) => !m.retiredAt);
    const isActive = active.length > 0;

    async function handleApprove() {
        if (!provider.trim() || !modelId.trim()) return;
        setBusy(true);
        try {
            await window.api.modelRegistry.approve(provider.trim(), modelId.trim(), []);
            setProvider("");
            setModelId("");
            refresh();
        } finally {
            setBusy(false);
        }
    }

    async function handleRetire(id: string) {
        await window.api.modelRegistry.retire(id);
        refresh();
    }

    async function handleRemove(id: string) {
        await window.api.modelRegistry.remove(id);
        refresh();
    }

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="flex items-center gap-1.5 text-xs font-semibold">
                        <ListChecks className="size-3.5" /> Approved model registry
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {isActive
                            ? "Restricted — only models listed below may be used for clinical requests. Adding the first entry activates this restriction; retiring the last one lifts it."
                            : "Off by default — every configured model is currently selectable. Approve at least one model below to restrict Clinical Assistant to a vetted allowlist."}
                    </p>
                </div>
                {isActive && <Badge variant="warning">Restricted</Badge>}
            </div>

            {active.length > 0 && (
                <div className="mt-2.5 flex flex-col gap-1">
                    {active.map((m) => (
                        <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-xs">
                            <span>
                                {m.provider} / {m.modelId}
                            </span>
                            <div className="flex items-center gap-1">
                                <Button size="sm" variant="ghost" onClick={() => handleRetire(m.id)}>
                                    Retire
                                </Button>
                                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleRemove(m.id)}>
                                    Remove
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {models.some((m) => m.retiredAt) && (
                <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">Retired ({models.filter((m) => m.retiredAt).length})</summary>
                    <div className="mt-1.5 flex flex-col gap-1">
                        {models
                            .filter((m) => m.retiredAt)
                            .map((m) => (
                                <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/40 px-3 py-1.5">
                                    <span>
                                        {m.provider} / {m.modelId}
                                    </span>
                                    <Button size="sm" variant="ghost" onClick={() => handleRemove(m.id)}>
                                        Remove
                                    </Button>
                                </div>
                            ))}
                    </div>
                </details>
            )}

            <div className="mt-3 flex gap-2 border-t border-border/60 pt-2.5">
                <Input placeholder="Provider (e.g. openai)" value={provider} onChange={(e) => setProvider(e.target.value)} className="h-8 text-xs" />
                <Input placeholder="Model id (e.g. gpt-5)" value={modelId} onChange={(e) => setModelId(e.target.value)} className="h-8 text-xs" />
                <Button size="sm" disabled={busy || !provider.trim() || !modelId.trim()} onClick={handleApprove}>
                    Approve
                </Button>
            </div>
        </div>
    );
}

const CATEGORY_LABEL: Record<AuditEvent["actionCategory"], string> = {
    "case-created": "Case created",
    "case-updated": "Case updated",
    "case-deleted": "Case deleted",
    "case-viewed": "Case viewed",
    "model-call-local": "Model call (local)",
    "model-call-remote": "Model call (remote)",
    "mcp-tool-call": "MCP tool call",
    export: "Data exported",
    "data-deleted": "Data deleted",
    "settings-changed": "Settings changed",
};

export default function AuditPrivacy() {
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [events, setEvents] = useState<AuditEvent[]>([]);
    const [retentionDays, setRetentionDays] = useState(0);
    const [integrityResult, setIntegrityResult] = useState<AuditChainVerificationResult | null>(null);
    const [checkingIntegrity, setCheckingIntegrity] = useState(false);

    function refresh() {
        if (!hasApi) return;
        window.api.audit.list().then(setEvents);
        window.api.settings.get().then((s) => setRetentionDays(s.auditLogRetentionDays ?? 0));
    }

    async function handleVerifyIntegrity() {
        setCheckingIntegrity(true);
        try {
            setIntegrityResult(await window.api.audit.verifyIntegrity());
        } finally {
            setCheckingIntegrity(false);
        }
    }

    useEffect(refresh, [hasApi]);

    async function saveRetention(days: number) {
        setRetentionDays(days);
        await window.api.settings.save({ auditLogRetentionDays: days });
        refresh();
    }

    async function handleClear() {
        if (!confirm("Clear the entire audit log? This cannot be undone.")) return;
        await window.api.audit.clearAll();
        refresh();
    }

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Audit &amp; Privacy is only available when running inside the Electron app.
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <ShieldCheck className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Audit &amp; Privacy</span>
            </div>

            <ScrollArea className="flex-1">
                <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
                    <InlineNotice variant="warning" title="Not a certified compliance product">
                        ModelForge Medical stores data locally by default and logs an audit trail of who did what
                        and when. It does <strong>not</strong> claim HIPAA, HITRUST, or any other regulatory
                        certification — treat it as a local tool whose privacy posture you're responsible for
                        evaluating against your own organization's requirements before using it with real patient
                        data.
                    </InlineNotice>

                    <EncryptionSection />

                    <ModelRegistrySection />

                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-border/70 bg-card p-3.5">
                            <p className="text-xs font-semibold">Storage</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Patient cases, evidence sources, and chat history are stored as local files on this
                                device. Nothing is synced to a server this app controls.
                            </p>
                        </div>
                        <div className="rounded-xl border border-border/70 bg-card p-3.5">
                            <p className="text-xs font-semibold">Remote model calls</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Sending a message to a cloud provider (OpenAI, Anthropic, Gemini, or a custom
                                endpoint) transmits whatever context is included in that request to that provider,
                                subject to their own terms — see the transmission preview shown before each remote
                                send in Clinical Assistant.
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-muted-foreground">Audit log ({events.length} events)</p>
                        <div className="flex items-center gap-2">
                            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                Retain for
                                <select
                                    value={retentionDays}
                                    onChange={(e) => saveRetention(Number(e.target.value))}
                                    className="h-7 rounded-lg border border-border bg-background px-2 text-xs"
                                >
                                    <option value={0}>Forever</option>
                                    <option value={30}>30 days</option>
                                    <option value={90}>90 days</option>
                                    <option value={365}>1 year</option>
                                </select>
                            </label>
                            <Button variant="outline" size="sm" onClick={handleVerifyIntegrity} disabled={checkingIntegrity} className="gap-1.5">
                                <ShieldCheck className="size-3.5" /> {checkingIntegrity ? "Verifying…" : "Verify integrity"}
                            </Button>
                            {events.length > 0 && (
                                <Button variant="outline" size="sm" onClick={handleClear} className="gap-1.5">
                                    <Trash2 className="size-3.5" /> Clear log
                                </Button>
                            )}
                        </div>
                    </div>

                    {integrityResult && (
                        <InlineNotice
                            variant={integrityResult.valid ? "success" : "destructive"}
                            title={integrityResult.valid ? "Audit log integrity verified" : "Audit log integrity check failed"}
                        >
                            {integrityResult.valid ? (
                                <>
                                    {integrityResult.checkedCount} hash-chained event(s) verified — none were modified,
                                    reordered, or deleted since being recorded.
                                    {integrityResult.checkedCount === 0 && events.length > 0 && (
                                        <> (These events predate hash-chaining and can't be retroactively verified.)</>
                                    )}
                                </>
                            ) : (
                                <span className="flex items-start gap-1.5">
                                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                                    {integrityResult.reason ?? "The audit log does not match its recorded hash chain."}
                                </span>
                            )}
                        </InlineNotice>
                    )}

                    {events.length === 0 ? (
                        <EmptyState icon={<ShieldCheck className="size-5" />} title="No audit events yet" description="Actions like creating a case or sending a message to a remote model appear here." />
                    ) : (
                        <div className="flex flex-col gap-1">
                            {events.map((e) => (
                                <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-2 text-xs">
                                    <div className="flex items-center gap-2">
                                        <Badge variant={e.actionCategory === "model-call-remote" ? "warning" : "secondary"}>
                                            {CATEGORY_LABEL[e.actionCategory]}
                                        </Badge>
                                        {e.mcpServerName && (
                                            <span className="text-muted-foreground">
                                                {e.mcpServerName} · {e.mcpToolName} · {e.approvalOutcome}
                                                {e.durationMs !== undefined ? ` · ${e.durationMs}ms` : ""}
                                            </span>
                                        )}
                                        {e.targetType && <span className="text-muted-foreground">{e.targetType}</span>}
                                    </div>
                                    <span className="text-muted-foreground">{new Date(e.timestamp).toLocaleString()}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
