import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "oidc-client-ts";
import { userManager } from "./oidc-config";

interface AuthContextValue {
    user: User | null;
    isLoading: boolean;
    authError: string | null;
    signIn: () => Promise<void>;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [authError, setAuthError] = useState<string | null>(null);

    // Resolved once, before anything else renders (App.tsx wraps
    // RouterProvider in this provider) — see oidc-config.ts's redirect_uri
    // comment for why the callback is detected via a bare query-string
    // check rather than a dedicated route.
    useEffect(() => {
        void (async () => {
            const isCallback = new URLSearchParams(window.location.search).has("code");
            try {
                const resolvedUser = isCallback ? await userManager.signinRedirectCallback() : await userManager.getUser();
                if (isCallback) {
                    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
                }
                setUser(resolvedUser);
            } catch (err) {
                setAuthError(err instanceof Error ? err.message : "Sign-in failed.");
            } finally {
                setIsLoading(false);
            }
        })();
    }, []);

    // Keeps `user` in sync with anything client.ts's onUnauthorized() does
    // (userManager.removeUser() on a 401) without that module needing
    // direct access to this component's state.
    useEffect(() => {
        const handleUserUnloaded = () => setUser(null);
        userManager.events.addUserUnloaded(handleUserUnloaded);
        return () => userManager.events.removeUserUnloaded(handleUserUnloaded);
    }, []);

    async function signIn(): Promise<void> {
        setAuthError(null);
        try {
            // Navigates away on success, so nothing after this line runs in
            // that case — only a failure (unreachable IdP, misconfigured
            // issuer, discovery error) returns here at all.
            await userManager.signinRedirect();
        } catch (err) {
            setAuthError(err instanceof Error ? err.message : "Sign-in failed.");
        }
    }

    async function signOut(): Promise<void> {
        // Local-only: clears this app's own token, works against any
        // spec-compliant IdP. Real RP-initiated logout (signoutRedirect())
        // needs the IdP to advertise end_session_endpoint, which not every
        // generic IdP does — a reasonable follow-up, not a v1 requirement.
        await userManager.removeUser();
        setUser(null);
    }

    return <AuthContext.Provider value={{ user, isLoading, authError, signIn, signOut }}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- shared with AuthProvider, same as sessions-context.tsx's useSessions
export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (context === undefined) throw new Error("useAuth must be used within an AuthProvider");
    return context;
}
