import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { CASE_LOCKED_EVENT, ENCRYPTION_STATUS_CHANGED_EVENT } from "./case-auto-lock";
import type { ChatSession, Project } from "@/types/electron";

interface SessionsContextValue {
    sessions: ChatSession[];
    projects: Project[];
    loading: boolean;
    hasApi: boolean;
    /** True when case-encryption is enabled but locked — chat sessions share
     * that same encryption gate (see sessions-store.ts), so `sessions` is
     * empty and stale, not "genuinely no chats yet", whenever this is true. */
    sessionsLocked: boolean;
    refresh: () => Promise<void>;
    createSession: (model: string | null, projectId?: string | null) => Promise<ChatSession>;
    deleteSession: (id: string) => Promise<void>;
    renameSession: (id: string, title: string) => Promise<void>;
    createProject: (name: string) => Promise<Project>;
    updateProject: (id: string, partial: Partial<Pick<Project, "name" | "instructions" | "params">>) => Promise<void>;
    deleteProject: (id: string) => Promise<void>;
}

const SessionsContext = createContext<SessionsContextValue | undefined>(undefined);

export function SessionsProvider({ children }: { children: React.ReactNode }) {
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [sessionsLocked, setSessionsLocked] = useState(false);
    const hasApi = typeof window !== "undefined" && !!window.api;

    const refresh = useCallback(async () => {
        if (!hasApi) {
            setLoading(false);
            return;
        }
        const status = await window.api.encryption.status();
        if (status.enabled && !status.unlocked) {
            // Projects aren't encrypted (only sessions/cases share the case-
            // encryption gate), so they still load normally even while locked.
            setProjects(await window.api.projects.list());
            setSessions([]);
            setSessionsLocked(true);
            setLoading(false);
            return;
        }
        try {
            const [sessionList, projectList] = await Promise.all([window.api.sessions.list(), window.api.projects.list()]);
            setSessions(sessionList);
            setProjects(projectList);
            setSessionsLocked(false);
        } catch {
            // A lock could still race in between the status check above and
            // this call (e.g. auto-lock firing mid-refresh) — treat any
            // failure to list sessions the same as a known-locked state
            // rather than surfacing a raw error.
            setSessions([]);
            setSessionsLocked(true);
        }
        setLoading(false);
    }, [hasApi]);

    useEffect(() => {
        // Intentional fetch-on-mount: sessions/projects live in the main process
        // and must be loaded once the provider mounts, not derived from props/state.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refresh();
    }, [refresh]);

    useEffect(() => {
        window.addEventListener(CASE_LOCKED_EVENT, refresh);
        window.addEventListener(ENCRYPTION_STATUS_CHANGED_EVENT, refresh);
        return () => {
            window.removeEventListener(CASE_LOCKED_EVENT, refresh);
            window.removeEventListener(ENCRYPTION_STATUS_CHANGED_EVENT, refresh);
        };
    }, [refresh]);

    const createSession = useCallback(
        async (model: string | null, projectId?: string | null) => {
            const session = await window.api.sessions.create(model, projectId ?? null);
            await refresh();
            return session;
        },
        [refresh]
    );

    const deleteSession = useCallback(
        async (id: string) => {
            await window.api.sessions.delete(id);
            await refresh();
        },
        [refresh]
    );

    const renameSession = useCallback(
        async (id: string, title: string) => {
            await window.api.sessions.update(id, { title });
            await refresh();
        },
        [refresh]
    );

    const createProject = useCallback(
        async (name: string) => {
            const project = await window.api.projects.create(name);
            await refresh();
            return project;
        },
        [refresh]
    );

    const updateProjectFn = useCallback(
        async (id: string, partial: Partial<Pick<Project, "name" | "instructions" | "params">>) => {
            await window.api.projects.update(id, partial);
            await refresh();
        },
        [refresh]
    );

    const deleteProjectFn = useCallback(
        async (id: string) => {
            await window.api.projects.delete(id);
            await refresh();
        },
        [refresh]
    );

    return (
        <SessionsContext.Provider
            value={{
                sessions,
                projects,
                loading,
                hasApi,
                sessionsLocked,
                refresh,
                createSession,
                deleteSession,
                renameSession,
                createProject,
                updateProject: updateProjectFn,
                deleteProject: deleteProjectFn,
            }}
        >
            {children}
        </SessionsContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components -- context + hook co-location is the standard pattern here
export function useSessions() {
    const ctx = useContext(SessionsContext);
    if (ctx === undefined) throw new Error("useSessions must be used within SessionsProvider");
    return ctx;
}
