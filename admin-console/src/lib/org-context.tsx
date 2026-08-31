import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import { getMe } from "./api/client";
import { loadPermissions, type PermissionMap } from "./authz/permissions";
import type { MeResponse } from "./api/types";

interface MeContextValue {
    me: MeResponse | undefined;
    error: string | undefined;
    /** Awaitable so a caller that just mutated org membership (e.g.
     * OrgPicker creating a new organization) can wait for the refreshed
     * membership list before navigating into it — RequireOrg below bounces
     * back to "/" the instant its organizationId isn't in `me.memberships`
     * yet, which fired immediately on a fire-and-forget refresh. */
    refresh: () => Promise<void>;
}

const MeContext = createContext<MeContextValue | undefined>(undefined);

/** Fetches GET /me once per session (post-login org discovery) and shares
 * it between the org picker, the org switcher in the nav, and RequireOrg's
 * membership check below — all three need the same data, so one shared
 * fetch avoids fetching (and risking disagreement) three times. */
export function MeProvider({ children }: { children: ReactNode }) {
    const [me, setMe] = useState<MeResponse | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const mountedRef = useRef(true);
    useEffect(() => {
        // StrictMode's mount→cleanup→mount dance runs this cleanup once
        // before the "real" mount — reset to true on every mount, not just
        // once, or the ref stays permanently false and load() below never
        // commits its result again.
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const load = useCallback(async () => {
        // Intentional fetch-on-mount/refresh, same pattern (and same
        // suppression) as frontend/'s sessions-context.tsx.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setError(undefined);
        try {
            const response = await getMe();
            if (mountedRef.current) setMe(response);
        } catch (err) {
            if (mountedRef.current) setError(err instanceof Error ? err.message : "Could not load your account.");
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    return <MeContext.Provider value={{ me, error, refresh: load }}>{children}</MeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- shared with MeProvider, same as sessions-context.tsx's useSessions
export function useMe(): MeContextValue {
    const context = useContext(MeContext);
    if (context === undefined) throw new Error("useMe must be used within a MeProvider");
    return context;
}

interface OrgContextValue {
    organizationId: string;
    membership: MeResponse["memberships"][number];
    permissions: PermissionMap | undefined;
    refreshPermissions: () => void;
}

const OrgContext = createContext<OrgContextValue | undefined>(undefined);

/** Route guard for /organizations/:organizationId/* — validates the param
 * against the caller's own already-fetched memberships (defends against a
 * stale bookmark to an org the identity lost access to) and loads the
 * fixed-action permission pre-check once per org-enter. */
export function RequireOrg({ children }: { children: ReactNode }) {
    const { organizationId } = useParams<{ organizationId: string }>();
    const { me } = useMe();
    const [permissions, setPermissions] = useState<PermissionMap | undefined>(undefined);
    const [permissionsGeneration, setPermissionsGeneration] = useState(0);

    const membership = me?.memberships.find((m) => m.organization.id === organizationId);

    useEffect(() => {
        if (!organizationId || !membership) return;
        // Intentional: reset to "loading" before the fetch below resolves,
        // same pattern as MeProvider's fetch effect above.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPermissions(undefined);
        void loadPermissions(organizationId, permissionsGeneration > 0).then(setPermissions);
    }, [organizationId, membership, permissionsGeneration]);

    if (!me) return null; // still loading /me — matches this app's loading-sentinel convention
    if (!organizationId || !membership) return <Navigate to="/" replace />;

    return (
        <OrgContext.Provider
            value={{ organizationId, membership, permissions, refreshPermissions: () => setPermissionsGeneration((g) => g + 1) }}
        >
            {children}
        </OrgContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components -- shared with RequireOrg, same as sessions-context.tsx's useSessions
export function useOrg(): OrgContextValue {
    const context = useContext(OrgContext);
    if (context === undefined) throw new Error("useOrg must be used within RequireOrg");
    return context;
}
