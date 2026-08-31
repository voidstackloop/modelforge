import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as sessionsStore from "../sessions-store";
import * as projectsStore from "../projects-store";
import * as scheduledTasksStore from "../scheduled-tasks-store";
import * as scheduler from "../scheduler";
import { requireString } from "../app-state";

export function registerSessionsIpc(): void {
    ipcMain.handle("sessions:list", () => sessionsStore.listSessions());
    ipcMain.handle("sessions:get", (_event: IpcMainInvokeEvent, id: string) =>
        sessionsStore.getSession(requireString(id, "session id"))
    );
    ipcMain.handle(
        "sessions:create",
        (_event: IpcMainInvokeEvent, { model, projectId }: { model: string | null; projectId?: string | null }) =>
            sessionsStore.createSession(model, projectId ?? null)
    );
    ipcMain.handle("sessions:update", (_event: IpcMainInvokeEvent, { id, partial }) =>
        sessionsStore.updateSession(requireString(id, "session id"), partial)
    );
    ipcMain.handle("sessions:delete", (_event: IpcMainInvokeEvent, id: string) =>
        sessionsStore.deleteSession(requireString(id, "session id"))
    );
    ipcMain.handle("sessions:clearAll", () => sessionsStore.clearAll());
    // Same configuration-boundary pattern as patientCases:listBackends —
    // exposes only a backend's public identity (name/label/scope), never
    // connection details/credentials.
    ipcMain.handle("sessions:listBackends", () => ({
        active: sessionsStore.getSessionsBackend().name,
        backends: sessionsStore.listSessionsBackends(),
    }));

    ipcMain.handle("scheduledTasks:list", () => scheduledTasksStore.listTasks());

    ipcMain.handle(
        "scheduledTasks:create",
        async (
            _event: IpcMainInvokeEvent,
            {
                name,
                prompt,
                model,
                intervalMinutes,
            }: { name: string; prompt: string; model: string; intervalMinutes: number }
        ) => {
            requireString(name, "task name");
            requireString(prompt, "task prompt");
            requireString(model, "task model");
            // Each task gets a dedicated chat session it appends results to —
            // created here so the task always has somewhere to write to.
            const session = await sessionsStore.createSession(model);
            await sessionsStore.updateSession(session.id, { title: name });
            const task = scheduledTasksStore.createTask({
                name,
                prompt,
                model,
                targetSessionId: session.id,
                intervalMinutes: Math.max(1, intervalMinutes || 60),
            });
            scheduler.rescheduleAll();
            return task;
        }
    );

    ipcMain.handle(
        "scheduledTasks:update",
        (_event: IpcMainInvokeEvent, { id, partial }: { id: string; partial: Record<string, unknown> }) => {
            requireString(id, "task id");
            const updated = scheduledTasksStore.updateTask(id, partial);
            scheduler.rescheduleAll();
            return updated;
        }
    );

    ipcMain.handle("scheduledTasks:delete", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "task id");
        scheduledTasksStore.deleteTask(id);
        scheduler.rescheduleAll();
    });

    ipcMain.handle("scheduledTasks:runNow", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "task id");
        return scheduler.runTask(id);
    });

    ipcMain.handle("projects:list", () => projectsStore.listProjects());
    ipcMain.handle("projects:create", (_event: IpcMainInvokeEvent, name: string) =>
        projectsStore.createProject(requireString(name, "project name"))
    );
    ipcMain.handle("projects:update", (_event: IpcMainInvokeEvent, { id, partial }) =>
        projectsStore.updateProject(requireString(id, "project id"), partial)
    );
    ipcMain.handle("projects:delete", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "project id");
        sessionsStore.unassignProject(id);
        projectsStore.deleteProject(id);
    });
}
