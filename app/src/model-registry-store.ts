import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { readJsonWithSchema, writeJson } from "./json-store";
import { modelRegistryFileSchema } from "./schemas";
import type { z } from "zod";

// A local, admin-curated allowlist of models approved for clinical use —
// "admin" here means whoever manages this install's Settings, since this
// app has no separate identity/RBAC system yet (see
// docs/ENTERPRISE_READINESS_ASSESSMENT.md's model-governance gap). The
// registry is opt-in by construction: empty (the default) means no
// restriction at all, preserving today's behavior. The moment one entry
// exists, `isApproved()` starts gating — see Chat.tsx's send-time check.
export interface ApprovedModel {
    id: string;
    provider: string;
    modelId: string;
    approvedUseCases: string[];
    approvedBy?: string;
    approvedAt: string;
    retiredAt?: string;
}

function filePath(): string {
    return path.join(app.getPath("userData"), "model-registry.json");
}

function readAll(): ApprovedModel[] {
    return readJsonWithSchema<ApprovedModel[]>(filePath(), [], modelRegistryFileSchema as unknown as z.ZodType<ApprovedModel[]>);
}

function writeAll(models: ApprovedModel[]): void {
    writeJson(filePath(), models);
}

export function listApprovedModels(): ApprovedModel[] {
    return readAll().sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
}

export function approveModel(
    provider: string,
    modelId: string,
    approvedUseCases: string[],
    approvedBy?: string
): ApprovedModel {
    const all = readAll();
    // Re-approving an existing (possibly retired) entry updates it in place
    // rather than accumulating duplicate rows for the same provider+model.
    const existingIdx = all.findIndex((m) => m.provider === provider && m.modelId === modelId);
    const entry: ApprovedModel = {
        id: existingIdx === -1 ? randomUUID() : all[existingIdx].id,
        provider,
        modelId,
        approvedUseCases,
        approvedBy,
        approvedAt: new Date().toISOString(),
    };
    if (existingIdx === -1) all.push(entry);
    else all[existingIdx] = entry;
    writeAll(all);
    return entry;
}

export function retireModel(id: string): void {
    const all = readAll();
    const idx = all.findIndex((m) => m.id === id);
    if (idx === -1) return;
    all[idx] = { ...all[idx], retiredAt: new Date().toISOString() };
    writeAll(all);
}

export function removeModel(id: string): void {
    writeAll(readAll().filter((m) => m.id !== id));
}

/** Whether the registry is currently enforcing anything at all — empty (no
 * entries ever approved) means "no restriction", not "nothing approved". */
export function isRegistryActive(): boolean {
    return readAll().some((m) => !m.retiredAt);
}

export function isApproved(provider: string, modelId: string): boolean {
    return readAll().some((m) => m.provider === provider && m.modelId === modelId && !m.retiredAt);
}
