import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";

export interface ScheduledTask {
    id: string;
    name: string;
    prompt: string;
    // "provider:modelId", same format used everywhere else in the app.
    model: string;
    // Every run appends to this one chat session (created alongside the
    // task) rather than starting a fresh chat each time — a running log of
    // results is far more useful than a new sidebar entry every interval.
    targetSessionId: string;
    intervalMinutes: number;
    enabled: boolean;
    lastRunAt: string | null;
    lastError: string | null;
    createdAt: string;
}

function filePath(): string {
    return path.join(app.getPath("userData"), "scheduled-tasks.json");
}

export function listTasks(): ScheduledTask[] {
    return readJson<ScheduledTask[]>(filePath(), []);
}

export function getTask(id: string): ScheduledTask | null {
    return listTasks().find((t) => t.id === id) ?? null;
}

export function createTask(
    partial: Pick<ScheduledTask, "name" | "prompt" | "model" | "targetSessionId" | "intervalMinutes">
): ScheduledTask {
    const task: ScheduledTask = {
        id: randomUUID(),
        enabled: true,
        lastRunAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        ...partial,
    };
    const all = listTasks();
    all.push(task);
    writeJson(filePath(), all);
    return task;
}

export function updateTask(
    id: string,
    partial: Partial<
        Pick<ScheduledTask, "name" | "prompt" | "model" | "intervalMinutes" | "enabled" | "lastRunAt" | "lastError">
    >
): ScheduledTask | null {
    const all = listTasks();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...partial };
    writeJson(filePath(), all);
    return all[idx];
}

export function deleteTask(id: string): void {
    writeJson(filePath(), listTasks().filter((t) => t.id !== id));
}
