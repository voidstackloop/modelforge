import { describe, it, expect, vi } from "vitest";
import * as scheduler from "./scheduler";
import * as scheduledTasksStore from "./scheduled-tasks-store";
import * as sessionsStore from "./sessions-store";

describe("scheduler.runTask", () => {
    it("appends the prompt and response to the task's target session on success", async () => {
        const session = sessionsStore.createSession("ollama:llama3.1:8b");
        const task = scheduledTasksStore.createTask({
            name: "Test task",
            prompt: "How's it going?",
            model: "ollama:llama3.1:8b",
            targetSessionId: session.id,
            intervalMinutes: 30,
        });

        scheduler.init(async () => "All good.");
        await scheduler.runTask(task.id);

        const updatedSession = sessionsStore.getSession(session.id);
        expect(updatedSession?.messages).toEqual([
            { role: "user", content: "How's it going?" },
            { role: "assistant", content: "All good." },
        ]);
        const updatedTask = scheduledTasksStore.getTask(task.id);
        expect(updatedTask?.lastRunAt).not.toBeNull();
        expect(updatedTask?.lastError).toBeNull();
    });

    it("records the error and leaves the session untouched when the prompt fails", async () => {
        const session = sessionsStore.createSession("ollama:llama3.1:8b");
        const task = scheduledTasksStore.createTask({
            name: "Failing task",
            prompt: "Do the thing.",
            model: "ollama:llama3.1:8b",
            targetSessionId: session.id,
            intervalMinutes: 30,
        });

        scheduler.init(async () => {
            throw new Error("model unavailable");
        });
        await scheduler.runTask(task.id);

        const updatedSession = sessionsStore.getSession(session.id);
        expect(updatedSession?.messages).toEqual([]);
        const updatedTask = scheduledTasksStore.getTask(task.id);
        expect(updatedTask?.lastError).toBe("model unavailable");
        expect(updatedTask?.lastRunAt).not.toBeNull();
    });

    it("does nothing for an unknown task id", async () => {
        const runPrompt = vi.fn(async () => "unused");
        scheduler.init(runPrompt);
        await scheduler.runTask("nonexistent");
        expect(runPrompt).not.toHaveBeenCalled();
    });

    it("records an error for a malformed model reference instead of throwing", async () => {
        const session = sessionsStore.createSession("bad-model-ref");
        const task = scheduledTasksStore.createTask({
            name: "Bad model",
            prompt: "p",
            model: "no-colon-here",
            targetSessionId: session.id,
            intervalMinutes: 30,
        });
        scheduler.init(async () => "unused");
        await scheduler.runTask(task.id);
        expect(scheduledTasksStore.getTask(task.id)?.lastError).toMatch(/Invalid model reference/);
    });
});
