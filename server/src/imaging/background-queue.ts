/**
 * A small bounded-concurrency FIFO queue for server-side imaging background
 * work (today: thumbnail generation after ingestion).
 *
 * Item 19 of the spec asks for GPU/CPU/RAM-aware scheduling through "the
 * existing resource orchestrator" and prioritizing interactive viewing over
 * background jobs. That orchestrator (app/src/resource-orchestrator.ts,
 * WorkloadRequest/ResourceLease/withLease) lives in the Electron desktop
 * app package and exists to arbitrate GPU/VRAM contention for local model
 * inference on a user's own machine — it has no meaning in this Fastify
 * server process, which never touches a GPU and runs thumbnail generation
 * (pure-JS PNG encoding over already-decoded pixel data, see thumbnail.ts)
 * as cheap, short-lived CPU work. Importing an Electron-app module into the
 * server package would also cross a real package boundary for a resource
 * model that doesn't apply here.
 *
 * What item 19 *does* meaningfully require on this side — bounded
 * concurrency so a burst of uploads can't spawn unbounded parallel work,
 * background priority so thumbnailing never blocks the HTTP response the
 * interactive viewer is waiting on, and a failure in one job never taking
 * down another — is what this queue provides. If server-side GPU-bound
 * imaging work (e.g. an AI pre-read) is added later, that is the point to
 * revisit whether a heavier scheduler is warranted; today's only background
 * job does not need one.
 */
export class BoundedBackgroundQueue {
    private readonly maxConcurrent: number;
    private running = 0;
    private readonly queue: Array<() => Promise<void>> = [];

    constructor(maxConcurrent = 2) {
        this.maxConcurrent = Math.max(1, maxConcurrent);
    }

    /** Enqueues fire-and-forget work. Never throws — a failing task is
     * swallowed (imaging instances are already published without a
     * thumbnail; a thumbnail failure is soft, never a reason to fail or
     * retry-loop the request that queued it). */
    enqueue(task: () => Promise<void>): void {
        this.queue.push(task);
        this.drain();
    }

    private drain(): void {
        while (this.running < this.maxConcurrent && this.queue.length > 0) {
            const task = this.queue.shift()!;
            this.running += 1;
            task()
                .catch(() => {
                    // Intentionally swallowed — see class doc comment.
                })
                .finally(() => {
                    this.running -= 1;
                    this.drain();
                });
        }
    }

    /** Test/shutdown helper: current queued + in-flight count. */
    get pendingCount(): number {
        return this.queue.length + this.running;
    }
}

export const imagingBackgroundQueue = new BoundedBackgroundQueue(2);
