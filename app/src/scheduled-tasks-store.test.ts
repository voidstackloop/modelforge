import { describe, it, expect } from "vitest";
import { listTasks, getTask, createTask, updateTask, deleteTask } from "./scheduled-tasks-store";

describe("scheduled-tasks-store", () => {
    it("starts with no tasks", () => {
        expect(listTasks()).toEqual([]);
    });

    it("creates a task with sensible defaults", () => {
        const task = createTask({
            name: "Check something",
            prompt: "Summarize the latest changes.",
            model: "ollama:llama3.1:8b",
            targetSessionId: "session-1",
            intervalMinutes: 30,
        });
        expect(task.enabled).toBe(true);
        expect(task.lastRunAt).toBeNull();
        expect(task.lastError).toBeNull();
        expect(getTask(task.id)).toEqual(task);
    });

    it("updates a task in place", () => {
        const task = createTask({
            name: "A",
            prompt: "p",
            model: "ollama:m",
            targetSessionId: "s",
            intervalMinutes: 10,
        });
        const updated = updateTask(task.id, { enabled: false, lastError: "boom" });
        expect(updated?.enabled).toBe(false);
        expect(updated?.lastError).toBe("boom");
        expect(getTask(task.id)?.enabled).toBe(false);
    });

    it("returns null when updating a task that doesn't exist", () => {
        expect(updateTask("nonexistent", { enabled: false })).toBeNull();
    });

    it("deletes a task", () => {
        const task = createTask({
            name: "B",
            prompt: "p",
            model: "ollama:m",
            targetSessionId: "s",
            intervalMinutes: 10,
        });
        deleteTask(task.id);
        expect(getTask(task.id)).toBeNull();
    });
});
