import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState, InlineNotice } from "@/components/ds";
import { useToast } from "@/components/toast";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/format-time";
import type { SmartLaunchToken, SmartTrustedIssuer } from "@/types/electron";

/** Registers a new trusted EHR — org-admin only server-side
 * (smartLaunch:manage); this form is shown to everyone (the API itself is
 * the enforcement point, same as every other admin-shaped action in this
 * app — see imaging-panel.tsx's ShareDialog for the same convention), so a
 * clinician without rights sees a normal toast error rather than a hidden
 * control that mysteriously isn't there. */
function AddTrustedIssuerForm({ onAdded }: { onAdded: () => void }) {
    const toast = useToast();
    const [issuer, setIssuer] = useState("");
    const [clientId, setClientId] = useState("");
    const [redirectUris, setRedirectUris] = useState("");
    const [submitting, setSubmitting] = useState(false);

    async function submit() {
        setSubmitting(true);
        try {
            const uris = redirectUris.split(",").map((u) => u.trim()).filter(Boolean);
            await window.api.smartLaunch.upsertTrustedIssuer({ issuer: issuer.trim(), clientId: clientId.trim(), redirectUris: uris });
            setIssuer(""); setClientId(""); setRedirectUris("");
            toast.success("Trusted EHR issuer saved.");
            onAdded();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="rounded-xl border border-border/70 bg-card p-3">
            <p className="mb-2 text-xs font-semibold">Register a trusted EHR</p>
            <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-xs">FHIR base URL (issuer)
                    <Input className="mt-1" placeholder="https://ehr.example-hospital.test/fhir" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
                </label>
                <label className="block text-xs">Client ID
                    <Input className="mt-1" placeholder="modelforge-client" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                </label>
                <label className="block text-xs sm:col-span-2">Redirect URIs (comma-separated)
                    <Input className="mt-1" placeholder="http://127.0.0.1:51824/smart/callback" value={redirectUris} onChange={(e) => setRedirectUris(e.target.value)} />
                </label>
            </div>
            <div className="mt-2 flex justify-end">
                <Button size="sm" disabled={submitting || !issuer.trim() || !clientId.trim() || !redirectUris.trim()} onClick={() => void submit()}>
                    <Plus className="size-3.5" />Add
                </Button>
            </div>
        </div>
    );
}

export default function ExternalEhr() {
    const { t } = useI18n();
    const toast = useToast();
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [issuers, setIssuers] = useState<SmartTrustedIssuer[]>([]);
    const [sessions, setSessions] = useState<SmartLaunchToken[]>([]);
    const [selectedIssuer, setSelectedIssuer] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [launching, setLaunching] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const refresh = useCallback((): Promise<void> => {
        if (!hasApi) return Promise.resolve();
        return Promise.all([window.api.smartLaunch.listTrustedIssuers(), window.api.smartLaunch.listSessions()])
            .then(([nextIssuers, nextSessions]) => {
                setIssuers(nextIssuers);
                setSessions(nextSessions);
                setSelectedIssuer((current) => current || nextIssuers[0]?.issuer || "");
                setError(null);
            })
            .catch((err: unknown) => setError((err as Error).message))
            .finally(() => setLoading(false));
    }, [hasApi]);

    useEffect(() => { void refresh(); }, [refresh]);

    async function launch() {
        if (!selectedIssuer) return;
        setLaunching(true);
        try {
            const result = await window.api.smartLaunch.start(selectedIssuer);
            if (result.error) {
                toast.error(result.error);
            } else {
                toast.success(`Connected — patient ${result.token?.patientId ?? "context"} available.`);
                await refresh();
            }
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setLaunching(false);
        }
    }

    async function removeIssuer(issuer: string) {
        if (!confirm(`Remove trusted EHR "${issuer}"? Existing sessions from it are unaffected, but no new launch can start against it.`)) return;
        setBusyId(issuer);
        try {
            await window.api.smartLaunch.deleteTrustedIssuer(issuer);
            toast.success("Trusted EHR removed.");
            await refresh();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setBusyId(null);
        }
    }

    async function revokeSession(session: SmartLaunchToken) {
        setBusyId(session.id);
        try {
            await window.api.smartLaunch.revokeSession(session.id);
            toast.success("Session revoked.");
            await refresh();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setBusyId(null);
        }
    }

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                External EHR is only available when running inside the Electron app.
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <ExternalLink className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{t.externalEhr}</span>
                <Button className="ml-auto" size="sm" variant="outline" onClick={() => { setLoading(true); void refresh(); }} disabled={loading}>
                    <RefreshCw className="size-3.5" />Refresh
                </Button>
            </div>

            <ScrollArea className="flex-1">
                <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
                    <InlineNotice variant="info" title="SMART App Launch (client role)">
                        Connects this app to an external EHR's own FHIR data for a patient-scoped session — it does not
                        automatically attach anything to a case. See docs/SMART_LAUNCH.md for the full flow and its disclosed
                        gaps (no automatic data pull, public-client PKCE only).
                    </InlineNotice>
                    {error && <InlineNotice variant="destructive" title="Couldn't load SMART launch data">{error}</InlineNotice>}

                    <div className="rounded-xl border border-border/70 bg-card p-3">
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><Zap className="size-3.5" />Start a launch</p>
                        {issuers.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No trusted EHRs are registered yet — add one below.</p>
                        ) : (
                            <div className="flex items-center gap-2">
                                <select className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-xs" value={selectedIssuer} onChange={(e) => setSelectedIssuer(e.target.value)}>
                                    {issuers.map((iss) => <option key={iss.id} value={iss.issuer}>{iss.issuer}</option>)}
                                </select>
                                <Button size="sm" disabled={launching || !selectedIssuer} onClick={() => void launch()}>
                                    {launching ? "Waiting for authorization…" : "Launch"}
                                </Button>
                            </div>
                        )}
                        {launching && <p className="mt-2 text-xs text-muted-foreground">A browser window opened for you to sign in at the EHR. Complete authorization there, then return here.</p>}
                    </div>

                    <div className="rounded-xl border border-border/70 bg-card p-3">
                        <p className="mb-2 text-xs font-semibold">Active sessions</p>
                        {sessions.length === 0 ? (
                            <EmptyState title="No sessions yet" description="Launch above to connect to a trusted EHR." />
                        ) : (
                            <div className="space-y-1.5">
                                {sessions.map((session) => (
                                    <div key={session.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 p-2 text-xs">
                                        <div className="min-w-0">
                                            <p className="truncate font-medium">{session.issuer}</p>
                                            <p className="text-muted-foreground">
                                                {session.patientId ? `Patient ${session.patientId} · ` : ""}
                                                Connected {formatRelativeTime(session.createdAt)} · expires {formatRelativeTime(session.expiresAt)}
                                            </p>
                                        </div>
                                        <Button size="sm" variant="ghost" disabled={busyId === session.id} onClick={() => void revokeSession(session)}>
                                            <Trash2 className="size-3.5" />Revoke
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <AddTrustedIssuerForm onAdded={() => void refresh()} />

                    {issuers.length > 0 && (
                        <div className="rounded-xl border border-border/70 bg-card p-3">
                            <p className="mb-2 text-xs font-semibold">Trusted EHRs</p>
                            <div className="space-y-1.5">
                                {issuers.map((iss) => (
                                    <div key={iss.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 p-2 text-xs">
                                        <div className="min-w-0">
                                            <p className="truncate font-medium">{iss.issuer}</p>
                                            <p className="text-muted-foreground">client_id {iss.clientId} · {iss.redirectUris.length} redirect URI(s)</p>
                                        </div>
                                        <Button size="sm" variant="ghost" disabled={busyId === iss.issuer} onClick={() => void removeIssuer(iss.issuer)}>
                                            <Trash2 className="size-3.5" />Remove
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
