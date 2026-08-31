import { randomUUID } from "node:crypto";
import * as os from "node:os";

/**
 * ClinicalAiGateway step 9 / item: "Integrate all AI work with the existing
 * CPU/GPU/RAM resource orchestrator." That orchestrator
 * (app/src/resource-orchestrator.ts) lives in the single-user Electron
 * desktop app and has no tenant concept at all — it cannot be imported into
 * this multi-tenant Fastify server (different runtime, different process,
 * no `organizationId` anywhere in its model). This module is a genuinely
 * new, server-side admission-control component, built to the *same design*
 * (priority-ranked queue, granted/queued/rejected decisions, leases with
 * TTL-based reclamation) so the two systems are conceptually one pattern
 * applied in two places, not two unrelated inventions. See
 * docs/CLINICAL_AI_GATEWAY.md for the full disclosure.
 *
 * Deliberately simpler than the Electron orchestrator in one respect: there
 * is no server-side GPU/hardware-detection module today (system-specs.ts is
 * app/-only). VRAM budgeting here is a configured ceiling
 * (`AiAdmissionOptions.vramBudgetMB`, defaulting to 0 — meaning "no local-
 * GPU inference admission control is enforced" until a deployment
 * configures a real budget), never auto-detected. A deployment running
 * fully-local models ON this server machine must set that budget
 * explicitly; this is disclosed, not silently assumed to be safe.
 */

export type AiAdmissionPriority =
    | "interactive" | "imaging-inference" | "background-summary"
    | "indexing" | "deidentification" | "evaluation" | "administrative";

export const AI_ADMISSION_PRIORITY_RANK: Readonly<Record<AiAdmissionPriority, number>> = {
    interactive: 700,
    "imaging-inference": 600,
    "background-summary": 400,
    indexing: 300,
    deidentification: 300,
    evaluation: 200,
    administrative: 100,
};

export interface AiAdmissionRequirements {
    cpuThreads?: number;
    ramMB?: number;
    vramMB?: number;
}

export interface AiAdmissionRequest {
    requestId?: string;
    organizationId: string;
    priority: AiAdmissionPriority;
    requirements?: AiAdmissionRequirements;
    queueIfUnavailable?: boolean;
}

export type AiAdmissionDecisionStatus = "granted" | "queued" | "rejected-tenant-quota" | "rejected-insufficient-resources";

export interface AiAdmissionLease {
    leaseId: string;
    requestId: string;
    organizationId: string;
    priority: AiAdmissionPriority;
    grantedAt: number;
    expiresAt: number;
}

interface ActiveLease {
    lease: AiAdmissionLease;
    requirements: Required<AiAdmissionRequirements>;
}

export class AiAdmissionError extends Error {
    constructor(public readonly status: Extract<AiAdmissionDecisionStatus, "rejected-tenant-quota" | "rejected-insufficient-resources">, public readonly reasons: string[]) {
        super(reasons.join(" "));
        this.name = "AiAdmissionError";
    }
}

export interface AiAdmissionOptions {
    /** Defaults to os.cpus().length - 1 (leave one thread for the process
     * itself/other traffic), same reserve-a-thread reasoning as the
     * Electron orchestrator's own captureHardwareSnapshot(). */
    cpuThreads?: number;
    ramMB?: number;
    /** 0 = no local-GPU admission control enforced; see this file's own
     * top doc comment. */
    vramBudgetMB?: number;
    maxConcurrentPerTenant?: number;
    leaseTtlMs?: number;
    now?: () => number;
    idGenerator?: () => string;
}

interface PendingEntry {
    request: Required<Pick<AiAdmissionRequest, "organizationId" | "priority">> & { requestId: string; requirements: Required<AiAdmissionRequirements>; queueIfUnavailable: boolean };
    sequence: number;
    resolve: (lease: AiAdmissionLease) => void;
    reject: (error: Error) => void;
}

/** Tenant-aware, priority-ranked admission control for AI inference jobs —
 * see this module's own top doc comment for what it deliberately does and
 * does not attempt relative to app/'s Electron orchestrator. */
export class AiInferenceAdmission {
    private readonly cpuThreads: number;
    private readonly ramMB: number;
    private readonly vramBudgetMB: number;
    private readonly maxConcurrentPerTenant: number;
    private readonly leaseTtlMs: number;
    private readonly now: () => number;
    private readonly idGenerator: () => string;
    private readonly active = new Map<string, ActiveLease>();
    private readonly pending: PendingEntry[] = [];
    private sequence = 0;
    private draining = false;

    constructor(options: AiAdmissionOptions = {}) {
        this.cpuThreads = options.cpuThreads ?? Math.max(1, os.cpus().length - 1);
        this.ramMB = options.ramMB ?? Math.floor(os.totalmem() / 1024 / 1024 * 0.7);
        this.vramBudgetMB = options.vramBudgetMB ?? 0;
        this.maxConcurrentPerTenant = options.maxConcurrentPerTenant ?? 5;
        this.leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? 120_000);
        this.now = options.now ?? Date.now;
        this.idGenerator = options.idGenerator ?? randomUUID;
    }

    acquire(request: AiAdmissionRequest): Promise<AiAdmissionLease> {
        const normalized = {
            requestId: request.requestId?.trim() || this.idGenerator(),
            organizationId: request.organizationId,
            priority: request.priority,
            requirements: {
                cpuThreads: request.requirements?.cpuThreads ?? 1,
                ramMB: request.requirements?.ramMB ?? 0,
                vramMB: request.requirements?.vramMB ?? 0,
            },
            queueIfUnavailable: request.queueIfUnavailable ?? true,
        };
        return new Promise((resolve, reject) => {
            this.pending.push({ request: normalized, sequence: this.sequence++, resolve, reject });
            this.drain();
        });
    }

    async withLease<T>(request: AiAdmissionRequest, task: (lease: AiAdmissionLease) => Promise<T>): Promise<T> {
        const lease = await this.acquire(request);
        try {
            return await task(lease);
        } finally {
            this.release(lease.leaseId);
        }
    }

    release(leaseId: string): boolean {
        const removed = this.active.delete(leaseId);
        if (removed) this.drain();
        return removed;
    }

    /** Reclaims any lease past its TTL — the crash-safety net: a caller
     * that never releases (process crash mid-inference) does not
     * permanently consume tenant quota or capacity. */
    sweepExpired(): string[] {
        const now = this.now();
        const expired: string[] = [];
        for (const [id, entry] of this.active) {
            if (entry.lease.expiresAt <= now) {
                this.active.delete(id);
                expired.push(id);
            }
        }
        if (expired.length > 0) this.drain();
        return expired;
    }

    getSnapshot(): { active: AiAdmissionLease[]; queuedCount: number; capacity: { cpuThreads: number; ramMB: number; vramBudgetMB: number } } {
        return {
            active: [...this.active.values()].map((entry) => entry.lease),
            queuedCount: this.pending.length,
            capacity: { cpuThreads: this.cpuThreads, ramMB: this.ramMB, vramBudgetMB: this.vramBudgetMB },
        };
    }

    private drain(): void {
        if (this.draining) return;
        this.draining = true;
        try {
            let progressed = true;
            while (progressed) {
                progressed = false;
                for (const entry of this.sortedPending()) {
                    if (!this.pending.includes(entry)) continue;
                    const result = this.evaluate(entry.request);
                    if (result.kind === "wait") {
                        if (!entry.request.queueIfUnavailable) {
                            this.remove(entry);
                            entry.reject(new AiAdmissionError("rejected-insufficient-resources", result.reasons));
                            progressed = true;
                        }
                        continue;
                    }
                    if (result.kind === "reject") {
                        this.remove(entry);
                        entry.reject(new AiAdmissionError(result.status, result.reasons));
                        progressed = true;
                        continue;
                    }
                    this.remove(entry);
                    const now = this.now();
                    const lease: AiAdmissionLease = {
                        leaseId: this.idGenerator(), requestId: entry.request.requestId, organizationId: entry.request.organizationId,
                        priority: entry.request.priority, grantedAt: now, expiresAt: now + this.leaseTtlMs,
                    };
                    this.active.set(lease.leaseId, { lease, requirements: entry.request.requirements });
                    entry.resolve(lease);
                    progressed = true;
                }
            }
        } finally {
            this.draining = false;
        }
    }

    private evaluate(request: PendingEntry["request"]): { kind: "grant" } | { kind: "wait"; reasons: string[] } | { kind: "reject"; status: Extract<AiAdmissionDecisionStatus, "rejected-tenant-quota" | "rejected-insufficient-resources">; reasons: string[] } {
        if (request.requirements.ramMB > this.ramMB) {
            return { kind: "reject", status: "rejected-insufficient-resources", reasons: [`Requested ${request.requirements.ramMB}MB RAM, but this server budgets ${this.ramMB}MB total.`] };
        }
        if (request.requirements.vramMB > 0 && this.vramBudgetMB === 0) {
            return { kind: "reject", status: "rejected-insufficient-resources", reasons: ["No VRAM budget is configured on this server — local-GPU inference admission is not enabled."] };
        }
        if (request.requirements.vramMB > this.vramBudgetMB) {
            return { kind: "reject", status: "rejected-insufficient-resources", reasons: [`Requested ${request.requirements.vramMB}MB VRAM, but this server budgets ${this.vramBudgetMB}MB total.`] };
        }

        const activeEntries = [...this.active.values()];
        const tenantActive = activeEntries.filter((e) => e.lease.organizationId === request.organizationId);
        if (tenantActive.length >= this.maxConcurrentPerTenant) {
            return { kind: "reject", status: "rejected-tenant-quota", reasons: [`This organization already has ${tenantActive.length} concurrent AI requests (limit ${this.maxConcurrentPerTenant}).`] };
        }

        // CPU/RAM/VRAM already-committed accounting, same shape as the
        // Electron orchestrator's own evaluate() — sum what every active
        // lease actually declared, not a flat per-lease count.
        const reservedCpu = activeEntries.reduce((sum, e) => sum + e.requirements.cpuThreads, 0);
        const reservedRam = activeEntries.reduce((sum, e) => sum + e.requirements.ramMB, 0);
        const reservedVram = activeEntries.reduce((sum, e) => sum + e.requirements.vramMB, 0);
        if (request.requirements.cpuThreads + reservedCpu > this.cpuThreads) {
            return { kind: "wait", reasons: ["All CPU admission capacity is currently in use."] };
        }
        if (request.requirements.ramMB + reservedRam > this.ramMB) {
            return { kind: "wait", reasons: ["All RAM admission capacity is currently in use."] };
        }
        if (request.requirements.vramMB + reservedVram > this.vramBudgetMB) {
            return { kind: "wait", reasons: ["All VRAM admission capacity is currently in use."] };
        }

        return { kind: "grant" };
    }

    private sortedPending(): PendingEntry[] {
        return [...this.pending].sort((a, b) => AI_ADMISSION_PRIORITY_RANK[b.request.priority] - AI_ADMISSION_PRIORITY_RANK[a.request.priority] || a.sequence - b.sequence);
    }

    private remove(entry: PendingEntry): void {
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
    }
}

export const mainAiInferenceAdmission = new AiInferenceAdmission();
