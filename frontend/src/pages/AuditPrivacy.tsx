import { useEffect, useState } from "react";
import { Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldQuestion, RefreshCw, Trash2, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { EmptyState, InlineNotice } from "@/components/ds";
import { ENCRYPTION_STATUS_CHANGED_EVENT } from "@/lib/case-auto-lock";
import type { ApprovedModel, AuditChainVerificationResult, AuditEvent, OrganizationMembership, PolicyStatus, SharedBackendConfig, StagedMigrationResult } from "@/types/electron";

// Human-readable labels for policy-managed AppSettings keys, shown as badges
// next to the org-policy status and — for the fields that have one —
// alongside the specific control it locks. Every key in
// policy-store.ts's MANAGED_SETTING_KEYS should have an entry here so a
// clinician sees "Retention period" rather than a raw settings-key name.
const MANAGED_SETTING_LABELS: Record<string, string> = {
    networkToolsEnabled: "Agent network tools",
    verificationEnabled: "Agent verification loop",
    verificationMaxRetries: "Verification max retries",
    agentMaxSteps: "Agent step limit",
    caseAutoLockMinutes: "Case auto-lock timeout",
    redactBeforeRemoteSend: "Redact before remote send",
    auditLogRetentionDays: "Audit log retention",
    auditLogBackend: "Audit log storage backend",
    medicationSafetyProviderId: "Medication safety provider",
    patientCasesBackendId: "Patient cases backend",
    sessionsBackendId: "Chat session backend",
};

function isManagedByPolicy(status: PolicyStatus | null, key: string): boolean {
    return !!status?.policy && key in status.policy.settings;
}

function ManagedByPolicyBadge({ status, settingKey }: { status: PolicyStatus | null; settingKey: string }) {
    if (!isManagedByPolicy(status, settingKey)) return null;
    return (
        <Badge variant="secondary" className="gap-1" title="Set by your organization's policy — cannot be changed on this device.">
            <Lock className="size-3" /> Organization managed
        </Badge>
    );
}

function OrganizationPolicySection() {
    const [status, setStatus] = useState<PolicyStatus | null>(null);
    const [checking, setChecking] = useState(false);

    function refresh() {
        window.api.policy.status().then(setStatus);
    }
    useEffect(refresh, []);

    async function handleReload() {
        setChecking(true);
        try {
            setStatus(await window.api.policy.reload());
        } finally {
            setChecking(false);
        }
    }

    if (!status) return null;

    if (status.state === "unmanaged") {
        return (
            <div className="rounded-xl border border-border/70 bg-card p-3.5">
                <div className="flex items-center gap-2">
                    <ShieldQuestion className="size-4 text-muted-foreground" />
                    <p className="text-xs font-semibold">Organization policy</p>
                    <Badge variant="secondary">Not configured</Badge>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                    This device isn&apos;t governed by a signed organization policy — every setting is under local control.
                    An administrator can enforce settings fleet-wide by deploying a signed policy document (see{" "}
                    <code className="rounded bg-muted px-1 py-0.5">docs/CENTRAL_POLICY.md</code>).
                </p>
            </div>
        );
    }

    const badgeVariant = status.state === "active" ? "success" : status.state === "expired_grace" ? "warning" : "destructive";
    const badgeLabel = status.state === "active" ? "Active" : status.state === "expired_grace" ? "Expired (grace period)" : "Invalid";
    const managedKeys = status.policy ? Object.keys(status.policy.settings) : [];

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <ShieldCheck className="size-4 text-muted-foreground" />
                    <p className="text-xs font-semibold">Organization policy</p>
                    <Badge variant={badgeVariant}>{badgeLabel}</Badge>
                </div>
                <Button variant="outline" size="sm" onClick={handleReload} disabled={checking} className="gap-1.5">
                    <RefreshCw className="size-3.5" /> {checking ? "Checking…" : "Check for update"}
                </Button>
            </div>
            {status.policy && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                    Issued by <strong>{status.policy.issuer}</strong>, expires {new Date(status.policy.expiresAt).toLocaleString()}
                    {status.lastVerifiedAt && ` — last verified ${new Date(status.lastVerifiedAt).toLocaleString()}`}.
                </p>
            )}
            {status.error && (
                <InlineNotice
                    variant={status.state === "expired_grace" ? "warning" : "destructive"}
                    title={status.state === "expired_grace" ? "Policy expired — operating within the grace period" : "Policy could not be verified"}
                    className="mt-2"
                >
                    {status.error}
                    {status.state === "invalid" && status.policy && " The device stays governed by the last verified policy rather than reverting to local control."}
                    {" "}Contact your administrator.
                </InlineNotice>
            )}
            {managedKeys.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {managedKeys.map((key) => (
                        <Badge key={key} variant="outline" className="gap-1">
                            <Lock className="size-3" /> {MANAGED_SETTING_LABELS[key] ?? key}
                        </Badge>
                    ))}
                </div>
            )}
        </div>
    );
}

type EncryptionAction = "setup" | "unlock" | "disable" | "changePassphrase" | null;

function EncryptionSection() {
    const [status, setStatus] = useState<{ enabled: boolean; unlocked: boolean } | null>(null);
    const [action, setAction] = useState<EncryptionAction>(null);
    const [passphrase, setPassphrase] = useState("");
    const [confirmPassphrase, setConfirmPassphrase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [autoLockMinutes, setAutoLockMinutes] = useState<number>(15);
    const [policyStatus, setPolicyStatus] = useState<PolicyStatus | null>(null);

    function refresh() {
        window.api.encryption.status().then(setStatus);
        window.api.settings.get().then((s) => setAutoLockMinutes(s.caseAutoLockMinutes ?? 15));
        window.api.policy.status().then(setPolicyStatus);
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
                        disabled={isManagedByPolicy(policyStatus, "caseAutoLockMinutes")}
                        className="h-7 rounded-lg border border-border bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <option value={0}>Never</option>
                        <option value={5}>5 minutes</option>
                        <option value={15}>15 minutes</option>
                        <option value={30}>30 minutes</option>
                        <option value={60}>1 hour</option>
                    </select>
                    <span>of inactivity</span>
                    <ManagedByPolicyBadge status={policyStatus} settingKey="caseAutoLockMinutes" />
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

/** Experimental, opt-in: routes the audit log through a Rust/SQLite store
 * instead of the JSON file (see docs/RUST_MIGRATION_ASSESSMENT.md). Off by
 * default and safe to leave off — this exists to make the backend
 * switchable/testable, not because JSON has a known problem serious enough
 * to recommend switching. */
function StorageBackendSection({ onBackendChanged }: { onBackendChanged: () => void }) {
    const [backend, setBackend] = useState<"json" | "sqlite">("json");
    const [capability, setCapability] = useState<{ available: boolean; reason?: string; detail?: string } | null>(null);
    const [sqliteDir, setSqliteDir] = useState<string | null>(null);
    const [dirError, setDirError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    function refresh() {
        window.api.settings.get().then((s) => {
            setBackend(s.auditLogBackend ?? "json");
            setSqliteDir(s.auditLogSqliteDir ?? null);
        });
        window.api.audit.sqliteCapability().then(setCapability);
    }
    useEffect(refresh, []);

    async function toggle() {
        setBusy(true);
        try {
            const next = backend === "sqlite" ? "json" : "sqlite";
            await window.api.settings.save({ auditLogBackend: next });
            refresh();
            onBackendChanged();
        } finally {
            setBusy(false);
        }
    }

    async function browseForDir() {
        const picked = await window.api.audit.pickSqliteDir();
        if (picked === null) return; // dialog cancelled
        await applyDir(picked);
    }

    async function resetToDefaultDir() {
        await applyDir(null);
    }

    async function applyDir(dir: string | null) {
        setBusy(true);
        try {
            const result = await window.api.audit.setSqliteDir(dir);
            if ("error" in result) {
                setDirError(result.error);
                return;
            }
            setDirError(null);
            refresh();
            onBackendChanged();
        } finally {
            setBusy(false);
        }
    }

    const capabilityUnavailableReason: Record<string, string> = {
        "not-built": "the native module wasn't built into this install",
        "abi-or-platform-mismatch": "the native module doesn't match this machine's platform/Node version",
        "load-error": "the native module failed to load",
    };

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="text-xs font-semibold">Audit log storage backend</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Experimental. Existing events migrate in automatically the first time you switch, and are
                        never deleted from the JSON file — switching back to JSON afterward is always possible.
                    </p>
                </div>
                <Badge variant={backend === "sqlite" ? "warning" : "secondary"}>{backend === "sqlite" ? "SQLite" : "JSON (default)"}</Badge>
            </div>

            {capability && !capability.available && (
                <p className="mt-2 text-xs text-muted-foreground">
                    SQLite backend unavailable on this install —{" "}
                    {capabilityUnavailableReason[capability.reason ?? ""] ?? "it couldn't be loaded"}. Staying on JSON
                    regardless of this setting.
                </p>
            )}

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={busy || (backend === "json" && !capability?.available)} onClick={toggle}>
                    {backend === "sqlite" ? "Switch back to JSON" : "Switch to experimental SQLite backend"}
                </Button>
            </div>

            {backend === "sqlite" && capability?.available && (
                <div className="mt-2.5 border-t border-border/60 pt-2.5">
                    <p className="text-xs font-semibold">Database location</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {sqliteDir ? (
                            <>
                                Custom location: <span className="font-mono">{sqliteDir}</span>
                            </>
                        ) : (
                            "Default location (inside this app's own data folder)."
                        )}{" "}
                        Switching directories moves events already there into the JSON file first — it does not copy
                        SQLite files between locations for you.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" disabled={busy} onClick={browseForDir}>
                            Choose folder…
                        </Button>
                        {sqliteDir && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={resetToDefaultDir}>
                                Use default location
                            </Button>
                        )}
                    </div>
                    {dirError && <p className="mt-1.5 text-xs text-destructive">{dirError}</p>}
                </div>
            )}
        </div>
    );
}

/** Configuration boundary for a future licensed medication-safety provider
 * (see medical-safety.ts's provider registry). Only the built-in,
 * non-authoritative demonstration list is registered on this build, so this
 * mostly just states that plainly — but the picker itself is real, not
 * decorative: it's exactly the mechanism a real licensed provider would show
 * up in once registered, with no fake vendor entries added to make it look
 * more populated than it is. */
function MedicationSafetyProviderSection() {
    const [data, setData] = useState<{ active: string; providers: { name: string; label: string; coverage: "demonstration" | "clinically-authoritative" }[] } | null>(null);
    const [busy, setBusy] = useState(false);

    function refresh() {
        window.api.medicalSafety.listMedicationProviders().then(setData);
    }
    useEffect(refresh, []);

    async function select(name: string) {
        setBusy(true);
        try {
            await window.api.settings.save({ medicationSafetyProviderId: name });
            refresh();
        } finally {
            setBusy(false);
        }
    }

    if (!data) return null;
    const activeProvider = data.providers.find((p) => p.name === data.active);

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="text-xs font-semibold">Medication safety provider</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        The engine behind allergy/medication conflict warnings on Patient Cases. Only a built-in,
                        non-authoritative demonstration list ships with this app — a real deployment can register a
                        licensed provider (e.g. First Databank, Lexicomp, Multum) behind this same interface.
                    </p>
                </div>
                <Badge variant={activeProvider?.coverage === "clinically-authoritative" ? "warning" : "secondary"}>
                    {activeProvider?.coverage === "clinically-authoritative" ? "Clinically authoritative" : "Demonstration only"}
                </Badge>
            </div>

            <div className="mt-2.5 flex flex-col gap-1.5">
                {data.providers.map((p) => (
                    <div key={p.name} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-xs">
                        <span>{p.label}</span>
                        {p.name === data.active ? (
                            <Badge variant="secondary">Active</Badge>
                        ) : (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => select(p.name)}>
                                Use this provider
                            </Button>
                        )}
                    </div>
                ))}
            </div>

            {data.providers.length === 1 && <p className="mt-2 text-xs italic text-muted-foreground">No additional providers are registered on this install.</p>}
        </div>
    );
}

type SharedBackendFormState = { baseUrl: string; issuer: string; clientId: string; audience: string };
const EMPTY_SHARED_BACKEND_FORM: SharedBackendFormState = { baseUrl: "", issuer: "", clientId: "", audience: "" };

/**
 * Enterprise mode's connection setup: configure → connect (OIDC PKCE via
 * shared-backend-auth.ts) → pick an organization. This is the UI half of
 * app/src/shared-backend-config-store.ts / shared-backend-auth.ts /
 * shared-backend-client.ts — see packages/server/README.md for the server side.
 * Selecting the resulting backend for actual case storage happens in
 * PatientCasesBackendSection below, once this section reports "connected"
 * (that section's list only shows a "shared" entry as usable once
 * isAvailable() is true — see shared-patient-cases-backend.ts).
 */
function SharedBackendConnectionSection() {
    const [config, setConfig] = useState<SharedBackendConfig | null | undefined>(undefined);
    const [status, setStatus] = useState<{ configured: boolean; connected: boolean } | null>(null);
    const [memberships, setMemberships] = useState<OrganizationMembership[] | null>(null);
    const [editingConfig, setEditingConfig] = useState(false);
    const [form, setForm] = useState<SharedBackendFormState>(EMPTY_SHARED_BACKEND_FORM);
    const [newOrgName, setNewOrgName] = useState("");
    const [creatingOrg, setCreatingOrg] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [migration, setMigration] = useState<StagedMigrationResult | null>(null);

    function refresh() {
        window.api.sharedBackend.getConfig().then(setConfig);
        window.api.sharedBackend.status().then(setStatus);
    }
    useEffect(refresh, []);

    useEffect(() => {
        if (status?.connected && config && !config.organizationId) {
            window.api.sharedBackend
                .listOrganizations()
                .then(setMemberships)
                .catch((err) => setError((err as Error).message));
        }
    }, [status?.connected, config]);

    function startEditingConfig() {
        setForm(
            config
                ? { baseUrl: config.baseUrl, issuer: config.issuer, clientId: config.clientId, audience: config.audience ?? "" }
                : EMPTY_SHARED_BACKEND_FORM
        );
        setError(null);
        setEditingConfig(true);
    }

    async function saveConfig() {
        if (!form.baseUrl.trim() || !form.issuer.trim() || !form.clientId.trim()) {
            setError("Backend URL, issuer, and client ID are all required.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await window.api.sharedBackend.setConfig({
                baseUrl: form.baseUrl.trim(),
                issuer: form.issuer.trim(),
                clientId: form.clientId.trim(),
                audience: form.audience.trim() || undefined,
            });
            setMemberships(null);
            setEditingConfig(false);
            refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function removeConfig() {
        if (!confirm("Remove this shared backend configuration and disconnect? Patient cases already stored locally are unaffected.")) return;
        setBusy(true);
        try {
            await window.api.sharedBackend.clearConfig();
            setMemberships(null);
            refresh();
        } finally {
            setBusy(false);
        }
    }

    async function handleConnect() {
        setBusy(true);
        setError(null);
        setMemberships(null);
        try {
            const result = await window.api.sharedBackend.connect();
            if (!result.connected) setError(result.error ?? "Could not connect.");
            refresh();
        } finally {
            setBusy(false);
        }
    }

    async function handleDisconnect() {
        setBusy(true);
        try {
            await window.api.sharedBackend.disconnect();
            setMemberships(null);
            refresh();
        } finally {
            setBusy(false);
        }
    }

    async function selectOrganization(organizationId: string) {
        setBusy(true);
        setError(null);
        try {
            await window.api.sharedBackend.selectOrganization(organizationId);
            refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleCreateOrganization() {
        if (!newOrgName.trim()) return;
        setBusy(true);
        setError(null);
        try {
            const { organization } = await window.api.sharedBackend.createOrganization(newOrgName.trim());
            await window.api.sharedBackend.selectOrganization(organization.id);
            setNewOrgName("");
            setCreatingOrg(false);
            refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function stageMigration() {
        setBusy(true);
        setError(null);
        try {
            setMigration(await window.api.sharedBackend.stageLocalCases());
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function activateMigration() {
        if (!migration || !confirm("Activate the validated shared copy and switch this profile to the shared backend? The local source and encrypted safety backup will be retained.")) return;
        setBusy(true);
        setError(null);
        try {
            const session = await window.api.sharedBackend.activateCaseMigration(migration.session.id);
            setMigration({ ...migration, session });
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function rollbackMigration() {
        if (!migration || !confirm("Disable the imported shared dataset and switch back to the preserved local source?")) return;
        setBusy(true);
        setError(null);
        try {
            const session = await window.api.sharedBackend.rollbackCaseMigration(migration.session.id);
            setMigration({ ...migration, session });
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    if (config === undefined || !status) return null;
    const selectedOrg = memberships?.find((m) => m.organization?.id === config?.organizationId)?.organization ?? null;

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="text-xs font-semibold">Shared backend (enterprise mode)</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Optional: connects this install to an institution-operated backend for shared patient-case
                        storage across a care team, via your organization's own identity provider — see{" "}
                        <code className="text-[11px]">packages/server/README.md</code> in this project for what runs on the
                        other end. Nothing here is required for normal, local-only use.
                    </p>
                </div>
                {status.connected ? (
                    <Badge variant="success">Connected</Badge>
                ) : status.configured ? (
                    <Badge variant="warning">Configured, not connected</Badge>
                ) : (
                    <Badge variant="secondary">Not configured</Badge>
                )}
            </div>

            {!editingConfig && (
                <div className="mt-2.5 flex flex-col gap-2">
                    {config && (
                        <div className="rounded-lg border border-border/50 px-3 py-2 text-xs text-muted-foreground">
                            <p>
                                <span className="text-foreground">Backend:</span> {config.baseUrl}
                            </p>
                            <p>
                                <span className="text-foreground">Identity provider:</span> {config.issuer}
                            </p>
                            {selectedOrg && (
                                <p>
                                    <span className="text-foreground">Organization:</span> {selectedOrg.name}
                                </p>
                            )}
                        </div>
                    )}

                    {error && <p className="text-xs text-destructive">{error}</p>}

                    <div className="flex flex-wrap gap-2">
                        {!config && (
                            <Button size="sm" variant="outline" onClick={startEditingConfig}>
                                Configure shared backend
                            </Button>
                        )}
                        {config && !status.connected && (
                            <>
                                <Button size="sm" disabled={busy} onClick={handleConnect}>
                                    Connect
                                </Button>
                                <Button size="sm" variant="outline" onClick={startEditingConfig}>
                                    Edit configuration
                                </Button>
                                <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={removeConfig}>
                                    Remove
                                </Button>
                            </>
                        )}
                        {config && status.connected && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={handleDisconnect}>
                                Disconnect
                            </Button>
                        )}
                    </div>

                    {status.connected && !config?.organizationId && (
                        <div className="mt-1 flex flex-col gap-1.5 border-t border-border/60 pt-2.5">
                            <p className="text-xs font-medium">Choose an organization to act as</p>
                            {memberships === null && <p className="text-xs text-muted-foreground">Loading…</p>}
                            {memberships?.map((m) =>
                                m.organization ? (
                                    <div
                                        key={m.organization.id}
                                        className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-xs"
                                    >
                                        <span>{m.organization.name}</span>
                                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => selectOrganization(m.organization!.id)}>
                                            Use this organization
                                        </Button>
                                    </div>
                                ) : null
                            )}
                            {memberships?.length === 0 && (
                                <p className="text-xs text-muted-foreground">
                                    No organizations yet for this identity — create the first one below.
                                </p>
                            )}
                            {!creatingOrg ? (
                                <Button size="sm" variant="outline" className="w-fit" onClick={() => setCreatingOrg(true)}>
                                    Create new organization
                                </Button>
                            ) : (
                                <div className="flex gap-2">
                                    <Input
                                        placeholder="Organization name"
                                        value={newOrgName}
                                        onChange={(e) => setNewOrgName(e.target.value)}
                                        className="h-8 text-xs"
                                        autoFocus
                                    />
                                    <Button size="sm" disabled={busy || !newOrgName.trim()} onClick={handleCreateOrganization}>
                                        Create
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => setCreatingOrg(false)}>
                                        Cancel
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}

                    {status.connected && config?.organizationId && (
                        <>
                            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
                                <p className="font-medium text-foreground">Local-to-shared case migration</p>
                                <p className="mt-1 text-muted-foreground">
                                    Creates and verifies an encrypted local backup, uploads resumable batches into an invisible staging area,
                                    then shows validation and collision results before any shared case becomes visible.
                                </p>
                                {!migration && (
                                    <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={stageMigration}>
                                        Stage local cases and preview
                                    </Button>
                                )}
                                {migration && (
                                    <div className="mt-2 space-y-2">
                                        <p>
                                            Status: <Badge variant={migration.session.status === "active" ? "success" : migration.session.status === "rolled-back" ? "secondary" : "warning"}>{migration.session.status}</Badge>
                                        </p>
                                        <p className="text-muted-foreground">
                                            {migration.preview.valid} valid · {migration.preview.invalid} invalid · {migration.preview.collisions} collisions
                                        </p>
                                        <div className="rounded border border-border/50 bg-background p-2">
                                            <p className="font-medium text-foreground">Encrypted safety backup</p>
                                            <p className="break-all text-muted-foreground">{migration.backupPath}</p>
                                            <p className="mt-1 text-muted-foreground">Recovery key (save separately):</p>
                                            <code className="block break-all select-all text-[11px] text-foreground">{migration.recoveryKey}</code>
                                        </div>
                                        {migration.session.status === "validated" && migration.preview.invalid === 0 && migration.preview.collisions === 0 && (
                                            <Button size="sm" disabled={busy} onClick={activateMigration}>Activate shared dataset</Button>
                                        )}
                                        {migration.session.status === "active" && (
                                            <Button size="sm" variant="outline" disabled={busy} onClick={rollbackMigration}>Roll back to local source</Button>
                                        )}
                                    </div>
                                )}
                            </div>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="w-fit"
                                disabled={busy}
                                onClick={() => window.api.sharedBackend.clearSelectedOrganization().then(refresh)}
                            >
                                Change organization
                            </Button>
                        </>
                    )}
                </div>
            )}

            {editingConfig && (
                <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                    <Input
                        placeholder="Backend URL, e.g. https://iam.example-hospital.org"
                        value={form.baseUrl}
                        onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                        className="h-8 text-xs"
                        autoFocus
                    />
                    <Input
                        placeholder="Identity provider issuer URL"
                        value={form.issuer}
                        onChange={(e) => setForm((f) => ({ ...f, issuer: e.target.value }))}
                        className="h-8 text-xs"
                    />
                    <Input
                        placeholder="OAuth client ID"
                        value={form.clientId}
                        onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
                        className="h-8 text-xs"
                    />
                    <Input
                        placeholder="Audience (optional)"
                        value={form.audience}
                        onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))}
                        className="h-8 text-xs"
                    />
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    <div className="flex gap-2">
                        <Button size="sm" disabled={busy} onClick={saveConfig}>
                            Save
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingConfig(false)}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

/** Configuration boundary for a future shared/networked patient-cases
 * backend (see patient-cases-store.ts's backend registry) — the seam a care
 * team's centralized case list, or an IT-managed database behind a fleet of
 * installs, would plug into. Only the local, this-device-only JSON store
 * (optionally encrypted at rest) and the shared HTTP backend (configured/
 * connected via SharedBackendConnectionSection above) are registered on
 * this build. */
function PatientCasesBackendSection() {
    const [data, setData] = useState<{
        active: string;
        backends: { name: string; label: string; scope: "local" | "shared"; available: boolean }[];
    } | null>(null);
    const [busy, setBusy] = useState(false);

    function refresh() {
        window.api.patientCases.listBackends().then(setData);
    }
    useEffect(refresh, []);

    async function select(name: string) {
        setBusy(true);
        try {
            await window.api.settings.save({ patientCasesBackendId: name });
            refresh();
        } finally {
            setBusy(false);
        }
    }

    if (!data) return null;
    const activeBackend = data.backends.find((b) => b.name === data.active);

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="text-xs font-semibold">Patient case storage backend</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Where Patient Cases data actually lives. The local, this-device-only store is always
                        available; the institutional backend can be selected after you connect and choose an
                        organization above.
                    </p>
                </div>
                <Badge variant={!activeBackend?.available || activeBackend?.scope === "shared" ? "warning" : "secondary"}>
                    {!activeBackend?.available ? "Shared unavailable" : activeBackend.scope === "shared" ? "Shared" : "Local only"}
                </Badge>
            </div>

            <div className="mt-2.5 flex flex-col gap-1.5">
                {data.backends.map((b) => (
                    <div key={b.name} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-xs">
                        <span>{b.label}</span>
                        {b.name === data.active ? (
                            <Badge variant={b.available ? "secondary" : "warning"}>{b.available ? "Active" : "Unavailable"}</Badge>
                        ) : (
                            <Button size="sm" variant="ghost" disabled={busy || !b.available} onClick={() => select(b.name)}>
                                {b.available ? "Use this backend" : "Connect first"}
                            </Button>
                        )}
                    </div>
                ))}
            </div>

            {data.backends.some((backend) => backend.scope === "shared" && !backend.available) && (
                <p className="mt-2 text-xs italic text-muted-foreground">
                    Connect the shared backend and choose an organization before selecting institutional storage.
                </p>
            )}
        </div>
    );
}

/** Same configuration-boundary pattern as PatientCasesBackendSection above,
 * mirrored for chat sessions (P1 item 7). A session shared this way is
 * visible to its owner and anyone explicitly added via the Share action in
 * the chat sidebar — never automatically to the whole organization. */
function SessionsBackendSection() {
    const [data, setData] = useState<{
        active: string;
        backends: { name: string; label: string; scope: "local" | "shared"; available: boolean }[];
    } | null>(null);
    const [busy, setBusy] = useState(false);

    function refresh() {
        window.api.sessions.listBackends().then(setData);
    }
    useEffect(refresh, []);

    async function select(name: string) {
        setBusy(true);
        try {
            await window.api.settings.save({ sessionsBackendId: name });
            refresh();
        } finally {
            setBusy(false);
        }
    }

    if (!data) return null;
    const activeBackend = data.backends.find((b) => b.name === data.active);

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="text-xs font-semibold">Chat session storage backend</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Where chat sessions actually live. The local, this-device-only store is always available;
                        the institutional backend can be selected after you connect and choose an organization above.
                    </p>
                </div>
                <Badge variant={!activeBackend?.available || activeBackend?.scope === "shared" ? "warning" : "secondary"}>
                    {!activeBackend?.available ? "Shared unavailable" : activeBackend.scope === "shared" ? "Shared" : "Local only"}
                </Badge>
            </div>

            <div className="mt-2.5 flex flex-col gap-1.5">
                {data.backends.map((b) => (
                    <div key={b.name} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-xs">
                        <span>{b.label}</span>
                        {b.name === data.active ? (
                            <Badge variant={b.available ? "secondary" : "warning"}>{b.available ? "Active" : "Unavailable"}</Badge>
                        ) : (
                            <Button size="sm" variant="ghost" disabled={busy || !b.available} onClick={() => select(b.name)}>
                                {b.available ? "Use this backend" : "Connect first"}
                            </Button>
                        )}
                    </div>
                ))}
            </div>

            {data.backends.some((backend) => backend.scope === "shared" && !backend.available) && (
                <p className="mt-2 text-xs italic text-muted-foreground">
                    Connect the shared backend and choose an organization before selecting institutional storage.
                </p>
            )}
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
    "backup-created": "Backup created",
    "backup-restored": "Backup restored",
};

type BackupMode = "none" | "create" | "restore";

function BackupRestoreSection() {
    const [mode, setMode] = useState<BackupMode>("none");
    const [passphrase, setPassphrase] = useState("");
    const [confirmPassphrase, setConfirmPassphrase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [restoreFilePath, setRestoreFilePath] = useState<string | null>(null);
    const [restorePreview, setRestorePreview] = useState<import("@/types/electron").BackupSummary | null>(null);

    function reset() {
        setMode("none");
        setPassphrase("");
        setConfirmPassphrase("");
        setError(null);
        setRestoreFilePath(null);
        setRestorePreview(null);
    }

    async function handleCreate() {
        if (passphrase.length < 8) {
            setError("Passphrase must be at least 8 characters.");
            return;
        }
        if (passphrase !== confirmPassphrase) {
            setError("Passphrases don't match.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const result = await window.api.backup.create(passphrase);
            if (result.success) {
                setSuccessMessage(`Backup saved to ${result.filePath}`);
                reset();
            }
            // canceled (no filePath): user closed the save dialog — leave the form as-is, no error.
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handlePickRestoreFile() {
        setSuccessMessage(null);
        const picked = await window.api.backup.pickFile();
        if (picked.canceled || !picked.filePath) return;
        setRestoreFilePath(picked.filePath);
        setMode("restore");
        setError(null);
    }

    async function handlePreview() {
        if (!restoreFilePath || !passphrase) return;
        setBusy(true);
        setError(null);
        try {
            setRestorePreview(await window.api.backup.verifyFile(restoreFilePath, passphrase));
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleConfirmRestore() {
        if (!restoreFilePath || !passphrase) return;
        if (!confirm("Restore this backup? Current data will be replaced (a safety copy of the current data is made automatically first).")) return;
        setBusy(true);
        setError(null);
        try {
            const result = await window.api.backup.restoreFile(restoreFilePath, passphrase);
            setSuccessMessage(
                `Restored ${result.filesRestored.length} file(s). A safety copy of your previous data was saved to ${result.safetySnapshotPath} — restore that file to undo this.`
            );
            reset();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <p className="text-xs font-semibold">Backup &amp; Restore</p>
            <p className="mt-1 text-xs text-muted-foreground">
                Encrypted, whole-profile backups (patient cases, chat sessions, audit log, and other local data) under
                a passphrase of your choosing — a separate encryption domain from case encryption's own passphrase, if
                that's enabled. Provider API keys are never included: they're tied to this device's OS keychain and
                easy to re-enter, so including them would create a false expectation that a restored backup carries
                remote-provider access with it.
            </p>

            {successMessage && (
                <InlineNotice variant="success" className="mt-2">
                    {successMessage}
                </InlineNotice>
            )}

            {mode === "none" && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            setMode("create");
                            setSuccessMessage(null);
                        }}
                    >
                        Create backup
                    </Button>
                    <Button size="sm" variant="outline" onClick={handlePickRestoreFile}>
                        Restore from backup
                    </Button>
                </div>
            )}

            {mode === "create" && (
                <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                    <Input
                        type="password"
                        placeholder="Backup passphrase (min 8 characters)"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        className="h-8 text-xs"
                        autoFocus
                    />
                    <Input
                        type="password"
                        placeholder="Confirm passphrase"
                        value={confirmPassphrase}
                        onChange={(e) => setConfirmPassphrase(e.target.value)}
                        className="h-8 text-xs"
                    />
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    <div className="flex gap-2">
                        <Button size="sm" disabled={busy || !passphrase} onClick={handleCreate}>
                            Save backup file…
                        </Button>
                        <Button size="sm" variant="outline" onClick={reset}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}

            {mode === "restore" && restoreFilePath && (
                <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                    <p className="truncate text-xs text-muted-foreground" title={restoreFilePath}>
                        File: <span className="font-mono">{restoreFilePath}</span>
                    </p>
                    <Input
                        type="password"
                        placeholder="Backup passphrase"
                        value={passphrase}
                        onChange={(e) => {
                            setPassphrase(e.target.value);
                            setRestorePreview(null);
                        }}
                        className="h-8 text-xs"
                        autoFocus
                    />
                    {error && <p className="text-xs text-destructive">{error}</p>}

                    {!restorePreview && (
                        <div className="flex gap-2">
                            <Button size="sm" disabled={busy || !passphrase} onClick={handlePreview}>
                                Preview
                            </Button>
                            <Button size="sm" variant="outline" onClick={reset}>
                                Cancel
                            </Button>
                        </div>
                    )}

                    {restorePreview && (
                        <>
                            <InlineNotice variant="warning" title="This will replace current data">
                                Backup from {new Date(restorePreview.createdAt).toLocaleString()} (ModelForge {restorePreview.appVersion}),{" "}
                                {restorePreview.fileNames.length} file{restorePreview.fileNames.length === 1 ? "" : "s"}:{" "}
                                {restorePreview.fileNames.join(", ")}. A safety copy of your current data is made automatically before
                                anything is replaced, so this can be undone.
                            </InlineNotice>
                            <div className="flex gap-2">
                                <Button size="sm" variant="destructive" disabled={busy} onClick={handleConfirmRestore}>
                                    Restore now
                                </Button>
                                <Button size="sm" variant="outline" onClick={reset}>
                                    Cancel
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

function BackupScheduleSection() {
    const [schedule, setScheduleState] = useState<import("@/types/electron").BackupSchedule | null>(null);
    const [hasPassphrase, setHasPassphrase] = useState(false);
    const [passphraseInput, setPassphraseInput] = useState("");
    const [intervalHours, setIntervalHours] = useState(24);
    const [retentionCount, setRetentionCount] = useState(14);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    function refresh() {
        window.api.backup.getSchedule().then((s) => {
            setScheduleState(s);
            setIntervalHours(s.intervalHours);
            setRetentionCount(s.retentionCount);
        });
        window.api.backup.hasAutoPassphrase().then(setHasPassphrase);
    }

    useEffect(refresh, []);

    async function handlePickDestination() {
        const picked = await window.api.backup.pickScheduleDestination();
        if (picked.canceled) return;
        refresh();
    }

    async function handleSavePassphrase() {
        if (passphraseInput.length < 8) {
            setError("Passphrase must be at least 8 characters.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await window.api.backup.setAutoPassphrase(passphraseInput);
            setPassphraseInput("");
            refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleClearPassphrase() {
        if (!confirm("Turn off scheduled backups and remove the stored automatic-backup passphrase?")) return;
        await window.api.backup.clearAutoPassphrase();
        refresh();
    }

    async function handleSaveSettings(enabled: boolean) {
        setBusy(true);
        setError(null);
        try {
            const updated = await window.api.backup.setSchedule({ enabled, intervalHours, retentionCount });
            setScheduleState(updated);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    if (!schedule) return null;

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <p className="text-xs font-semibold">Scheduled backups</p>
            <p className="mt-1 text-xs text-muted-foreground">
                Runs an encrypted backup automatically on the interval below, to the destination folder you choose —
                this is what turns recovery point into a real, operator-defined number instead of "however long since
                you last remembered." This only runs while ModelForge is open (no OS-level scheduling), and its
                passphrase is stored in this device's OS keychain (the same mechanism used for provider API keys) so
                it can run with nobody present — a different trust model than a manual backup's passphrase, which
                never touches disk.
            </p>

            {error && (
                <InlineNotice variant="warning" className="mt-2">
                    {error}
                </InlineNotice>
            )}

            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={handlePickDestination}>
                        {schedule.destinationDir ? "Change destination folder…" : "Choose destination folder…"}
                    </Button>
                    {schedule.destinationDir && (
                        <span className="truncate text-xs text-muted-foreground" title={schedule.destinationDir}>
                            {schedule.destinationDir}
                        </span>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        Every
                        <select
                            value={intervalHours}
                            onChange={(e) => setIntervalHours(Number(e.target.value))}
                            className="h-7 rounded-md border border-border bg-background px-1.5 text-xs"
                        >
                            <option value={6}>6 hours</option>
                            <option value={12}>12 hours</option>
                            <option value={24}>24 hours</option>
                            <option value={48}>2 days</option>
                            <option value={168}>7 days</option>
                        </select>
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        Keep last
                        <Input
                            type="number"
                            min={1}
                            value={retentionCount}
                            onChange={(e) => setRetentionCount(Math.max(1, Number(e.target.value)))}
                            className="h-7 w-16 text-xs"
                        />
                        backups
                    </label>
                </div>

                {!hasPassphrase ? (
                    <div className="flex flex-col gap-2">
                        <Input
                            type="password"
                            placeholder="Automatic-backup passphrase (min 8 characters)"
                            value={passphraseInput}
                            onChange={(e) => setPassphraseInput(e.target.value)}
                            className="h-8 text-xs"
                        />
                        <Button size="sm" disabled={busy || !passphraseInput} onClick={handleSavePassphrase} className="w-fit">
                            Save passphrase
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs">
                            <input
                                type="checkbox"
                                checked={schedule.enabled}
                                disabled={busy || !schedule.destinationDir}
                                onChange={(e) => handleSaveSettings(e.target.checked)}
                                className="accent-primary"
                            />
                            Enabled
                        </label>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => handleSaveSettings(schedule.enabled)}>
                            Save interval / retention
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={handleClearPassphrase}>
                            Turn off &amp; forget passphrase
                        </Button>
                    </div>
                )}

                {(schedule.lastRunAt || schedule.lastError || schedule.lastCloudError) && (
                    <div className="text-xs text-muted-foreground">
                        {schedule.lastRunAt && <p>Last run: {new Date(schedule.lastRunAt).toLocaleString()}</p>}
                        {schedule.lastError && <p className="text-destructive">Last error: {schedule.lastError}</p>}
                        {schedule.lastCloudError && <p className="text-destructive">Last cloud upload error: {schedule.lastCloudError}</p>}
                    </div>
                )}
            </div>
        </div>
    );
}

function CloudBackupSection() {
    const [config, setConfig] = useState<import("@/types/electron").CloudBackupConfig | null>(null);
    const [hasSecret, setHasSecret] = useState(false);
    const [secretInput, setSecretInput] = useState("");
    const [endpoint, setEndpoint] = useState("");
    const [region, setRegion] = useState("us-east-1");
    const [bucket, setBucket] = useState("");
    const [accessKeyId, setAccessKeyId] = useState("");
    const [pathStyle, setPathStyle] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<"ok" | null>(null);

    function refresh() {
        window.api.backup.getCloudConfig().then((c) => {
            setConfig(c);
            setEndpoint(c.endpoint);
            setRegion(c.region);
            setBucket(c.bucket);
            setAccessKeyId(c.accessKeyId);
            setPathStyle(c.pathStyle);
        });
        window.api.backup.hasCloudSecret().then(setHasSecret);
    }

    useEffect(refresh, []);

    async function handleSaveConfig() {
        setBusy(true);
        setError(null);
        setTestResult(null);
        try {
            const updated = await window.api.backup.setCloudConfig({ endpoint, region, bucket, accessKeyId, pathStyle });
            setConfig(updated);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleSaveSecret() {
        if (!secretInput) return;
        setBusy(true);
        setError(null);
        try {
            await window.api.backup.setCloudSecret(secretInput);
            setSecretInput("");
            refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleClearSecret() {
        if (!confirm("Turn off the cloud backup destination and remove the stored secret key?")) return;
        await window.api.backup.clearCloudSecret();
        refresh();
    }

    async function handleTestConnection() {
        setBusy(true);
        setError(null);
        setTestResult(null);
        try {
            await window.api.backup.testCloudConnection();
            setTestResult("ok");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleToggleEnabled(enabled: boolean) {
        setBusy(true);
        try {
            const updated = await window.api.backup.setCloudConfig({ enabled });
            setConfig(updated);
        } finally {
            setBusy(false);
        }
    }

    if (!config) return null;

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3.5">
            <p className="text-xs font-semibold">Cloud backup destination</p>
            <p className="mt-1 text-xs text-muted-foreground">
                Optional secondary copy of every scheduled backup, uploaded to any S3-compatible object store (AWS
                S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, and similar all work — bring your own bucket and
                credentials). This is best-effort: if the upload fails, the local scheduled backup that already
                succeeded is unaffected. The secret key is stored the same way as provider API keys (this device's OS
                keychain where available).
            </p>

            {error && (
                <InlineNotice variant="warning" className="mt-2">
                    {error}
                </InlineNotice>
            )}
            {testResult === "ok" && (
                <InlineNotice variant="success" className="mt-2">
                    Connection test succeeded — credentials and bucket are reachable.
                </InlineNotice>
            )}

            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                <Input placeholder="Endpoint (e.g. https://s3.us-west-2.amazonaws.com)" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="h-8 text-xs" />
                <div className="flex gap-2">
                    <Input placeholder="Region" value={region} onChange={(e) => setRegion(e.target.value)} className="h-8 text-xs" />
                    <Input placeholder="Bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} className="h-8 text-xs" />
                </div>
                <Input placeholder="Access key ID" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} className="h-8 text-xs" />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" checked={pathStyle} onChange={(e) => setPathStyle(e.target.checked)} className="accent-primary" />
                    Path-style addressing (endpoint/bucket/key instead of bucket.endpoint/key) — needed for some
                    providers like MinIO.
                </label>
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={handleSaveConfig}>
                        Save destination
                    </Button>
                </div>

                {!hasSecret ? (
                    <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
                        <Input
                            type="password"
                            placeholder="Secret access key"
                            value={secretInput}
                            onChange={(e) => setSecretInput(e.target.value)}
                            className="h-8 text-xs"
                        />
                        <Button size="sm" disabled={busy || !secretInput} onClick={handleSaveSecret} className="w-fit">
                            Save secret key
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
                        <label className="flex items-center gap-1.5 text-xs">
                            <input
                                type="checkbox"
                                checked={config.enabled}
                                disabled={busy}
                                onChange={(e) => handleToggleEnabled(e.target.checked)}
                                className="accent-primary"
                            />
                            Enabled
                        </label>
                        <Button size="sm" variant="outline" disabled={busy} onClick={handleTestConnection}>
                            Test connection
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={handleClearSecret}>
                            Turn off &amp; forget secret key
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function AuditPrivacy() {
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [events, setEvents] = useState<AuditEvent[]>([]);
    const [retentionDays, setRetentionDays] = useState(0);
    const [integrityResult, setIntegrityResult] = useState<AuditChainVerificationResult | null>(null);
    const [checkingIntegrity, setCheckingIntegrity] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const [policyStatus, setPolicyStatus] = useState<PolicyStatus | null>(null);

    // The experimental SQLite backend's migrate-in/merge-back happens lazily,
    // inside this very call (audit-log-store.ts's syncOnBackendTransition(),
    // triggered from listEvents()) — not inside the Settings toggle that
    // switches auditLogBackend itself. So a failure here (a locked/corrupted
    // SQLite file, a disk-full write) is exactly where switching the backend
    // can go wrong, and without this it failed silently: the toggle would
    // already show "SQLite" as active (that part genuinely did succeed) while
    // the event list underneath it just never updated, with nothing telling
    // the user their audit trail might not reflect reality. It's safe to
    // retry — syncOnBackendTransition() only advances its own bookkeeping
    // after a migration/merge succeeds, so a failed attempt is retried
    // automatically on the very next list/record call, this one included.
    function refresh() {
        if (!hasApi) return;
        window.api.audit
            .list()
            .then((evts) => {
                setEvents(evts);
                setListError(null);
            })
            .catch((err) => setListError(err instanceof Error ? err.message : String(err)));
        window.api.settings.get().then((s) => setRetentionDays(s.auditLogRetentionDays ?? 0));
        window.api.policy.status().then(setPolicyStatus);
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

                    <OrganizationPolicySection />

                    <EncryptionSection />

                    <ModelRegistrySection />

                    <StorageBackendSection onBackendChanged={refresh} />

                    <MedicationSafetyProviderSection />

                    <SharedBackendConnectionSection />

                    <PatientCasesBackendSection />

                    <SessionsBackendSection />

                    <BackupRestoreSection />

                    <BackupScheduleSection />

                    <CloudBackupSection />

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
                                    disabled={isManagedByPolicy(policyStatus, "auditLogRetentionDays")}
                                    className="h-7 rounded-lg border border-border bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    <option value={0}>Forever</option>
                                    <option value={30}>30 days</option>
                                    <option value={90}>90 days</option>
                                    <option value={365}>1 year</option>
                                </select>
                                <ManagedByPolicyBadge status={policyStatus} settingKey="auditLogRetentionDays" />
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

                    {listError && (
                        <InlineNotice
                            variant="destructive"
                            title="Couldn't load the audit log"
                            action={
                                <Button variant="outline" size="sm" onClick={refresh}>
                                    Retry
                                </Button>
                            }
                        >
                            {listError}
                            {" — the events shown below may be out of date. If you just switched the storage"}
                            {" backend, this is usually transient and safe to retry."}
                        </InlineNotice>
                    )}

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
