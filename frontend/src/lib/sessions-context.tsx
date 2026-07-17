import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ChatSession, Project } from "@/types/electron";

interface SessionsContextValue {
    sessions: ChatSession[];
    projects: Project[];
    loading: boolean;
    hasApi: boolean;
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
    const hasApi = typeof window !== "undefined" && !!window.api;

    const refresh = useCallback(async () => {
        if (!hasApi) {
            setLoading(false);
            return;
        }
        const [sessionList, projectList] = await Promise.all([window.api.sessions.list(), window.api.projects.list()]);
        setSessions(sessionList);
        setProjects(projectList);
        setLoading(false);
    }, [hasApi]);

    useEffect(() => {
        // Intentional fetch-on-mount: sessions/projects live in the main process
        // and must be loaded once the provider mounts, not derived from props/state.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refresh();
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
