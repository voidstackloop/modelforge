import { logger } from "./logger";
import * as scheduledTasksStore from "./scheduled-tasks-store";
import * as sessionsStore from "./sessions-store";
import type { ChatMessage } from "./providers/types";

// This is app-open scheduling, not a real background service: timers only
// run while Modelforge is running, and stop the moment it's closed — there
// is no OS-level task registration. Good enough for "check on something
// periodically while I'm using the app", not for "run this even when my
// computer is asleep".
type RunPrompt = (provider: string, model: string, prompt: string) => Promise<string>;

let runPrompt: RunPrompt | null = null;
const timers = new Map<string, NodeJS.Timeout>();

export function init(fn: RunPrompt): void {
    runPrompt = fn;
    rescheduleAll();
}

export function rescheduleAll(): void {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    for (const task of scheduledTasksStore.listTasks()) {
        if (task.enabled) scheduleTimer(task);
    }
}

function scheduleTimer(task: scheduledTasksStore.ScheduledTask): void {
    const ms = Math.max(1, task.intervalMinutes) * 60_000;
    timers.set(
        task.id,
        setInterval(() => {
            void runTask(task.id);
        }, ms)
    );
}

function parseModelRef(ref: string): { provider: string; modelId: string } | null {
    const sep = ref.indexOf(":");
    if (sep === -1) return null;
    return { provider: ref.slice(0, sep), modelId: ref.slice(sep + 1) };
}

export async function runTask(id: string): Promise<void> {
    const task = scheduledTasksStore.getTask(id);
    if (!task || !runPrompt) return;
    const parsed = parseModelRef(task.model);
    if (!parsed) {
        scheduledTasksStore.updateTask(id, { lastError: `Invalid model reference: ${task.model}` });
        return;
    }

    try {
        const text = await runPrompt(parsed.provider, parsed.modelId, task.prompt);
        const session = sessionsStore.getSession(task.targetSessionId);
        const userMessage: ChatMessage = { role: "user", content: task.prompt };
        const assistantMessage: ChatMessage = { role: "assistant", content: text };
        if (session) {
            sessionsStore.updateSession(task.targetSessionId, {
                messages: [...session.messages, userMessage, assistantMessage],
            });
        }
        scheduledTasksStore.updateTask(id, { lastRunAt: new Date().toISOString(), lastError: null });
    } catch (err) {
        const message = (err as Error).message;
        logger.error(`Scheduled task "${task.name}" failed: ${message}`);
        scheduledTasksStore.updateTask(id, { lastRunAt: new Date().toISOString(), lastError: message });
    }
}
