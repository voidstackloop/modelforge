import { createHash, randomUUID } from "node:crypto";
import { patientCaseSchema, type MigrationPreview, type MigrationSession, type PatientCase } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import type { AuditActor, AuditStore } from "./audit-store.js";
import { InMemoryAuditStore } from "./audit-store.js";
import { MigrationStateError, type CaseMigrationStore, type TenantCaseMigrationRepository } from "./case-migration-store.js";
import type { TenantCaseRepository } from "./case-store.js";

interface StagedItem { itemKey: string; patientCase: unknown; hash: string; status: "pending" | "accepted" | "invalid" | "collision"; errors: string[] }
interface State { session: MigrationSession; items: Map<string, StagedItem>; activated: Map<string, string> }
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class InMemoryCaseMigrationStore implements CaseMigrationStore {
    private readonly byOrg = new Map<string, Map<string, State>>();
    constructor(private readonly audit: AuditStore = new InMemoryAuditStore()) {}
    private sessions(org: string): Map<string, State> { let value = this.byOrg.get(org); if (!value) { value = new Map(); this.byOrg.set(org, value); } return value; }

    forTenant(context: TenantContext, cases: TenantCaseRepository): TenantCaseMigrationRepository {
        const sessions = this.sessions(context.organizationId);
        const update = (state: State, partial: Partial<MigrationSession>): MigrationSession => {
            state.session = { ...state.session, ...partial, updatedAt: new Date().toISOString() };
            return state.session;
        };
        const requireState = (id: string): State => { const state = sessions.get(id); if (!state) throw Object.assign(new Error("Migration not found."), { statusCode: 404 }); return state; };
        return {
            start: async (input, actor) => {
                const existing = [...sessions.values()].find((state) => state.session.sourceFingerprint === input.sourceFingerprint && state.session.status !== "rolled-back");
                if (existing) return existing.session;
                const now = new Date().toISOString();
                const session: MigrationSession = { id: randomUUID(), organizationId: context.organizationId, status: "staging", sourceFingerprint: input.sourceFingerprint, totalItems: input.totalItems, acceptedItems: 0, createdAt: now, updatedAt: now };
                sessions.set(session.id, { session, items: new Map(), activated: new Map() });
                await this.audit.record({ organizationId: context.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "caseMigration.start", targetType: "caseMigration", targetId: session.id });
                return session;
            },
            get: async (id) => sessions.get(id)?.session ?? null,
            upload: async (id, items, actor) => {
                const state = requireState(id); if (state.session.status !== "staging") throw new MigrationStateError("Migration is not accepting batches.");
                for (const item of items) {
                    const hash = digest(item.patientCase); const existing = state.items.get(item.itemKey);
                    if (existing && existing.hash !== hash) throw new MigrationStateError(`Item key ${item.itemKey} was reused with different data.`);
                    if (!existing) state.items.set(item.itemKey, { ...item, hash, status: "pending", errors: [] });
                }
                await this.audit.record({ organizationId: context.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "caseMigration.upload", targetType: "caseMigration", targetId: id, details: { itemCount: items.length } });
                return update(state, {});
            },
            validate: async (id, actor) => {
                const state = requireState(id); if (state.session.status !== "staging" && state.session.status !== "validated") throw new MigrationStateError("Migration cannot be validated in its current state.");
                const previewItems: MigrationPreview["items"] = [];
                for (const item of state.items.values()) {
                    const parsed = patientCaseSchema.safeParse(item.patientCase);
                    if (!parsed.success) { item.status = "invalid"; item.errors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`); previewItems.push({ caseId: typeof (item.patientCase as { id?: unknown })?.id === "string" ? (item.patientCase as { id: string }).id : item.itemKey, status: item.status, errors: item.errors }); continue; }
                    const collision = await cases.getOne(parsed.data.id);
                    item.status = collision ? "collision" : "accepted"; item.errors = collision ? ["A case with this id already exists in the destination tenant."] : [];
                    previewItems.push({ caseId: parsed.data.id, status: item.status, errors: item.errors });
                }
                const preview: MigrationPreview = { total: state.items.size, valid: previewItems.filter((item) => item.status === "accepted").length, invalid: previewItems.filter((item) => item.status === "invalid").length, collisions: previewItems.filter((item) => item.status === "collision").length, items: previewItems };
                update(state, { status: "validated", acceptedItems: preview.valid, preview });
                await this.audit.record({ organizationId: context.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "caseMigration.validate", targetType: "caseMigration", targetId: id, details: { valid: preview.valid, invalid: preview.invalid, collisions: preview.collisions } });
                return preview;
            },
            activate: async (id, actor) => {
                const state = requireState(id); if (state.session.status !== "validated" || !state.session.preview || state.session.preview.invalid > 0 || state.session.preview.collisions > 0 || state.items.size !== state.session.totalItems) throw new MigrationStateError("Migration must be complete and valid before activation.");
                // Unlike the Postgres store (one database transaction covers
                // the whole batch), there is no ambient transaction here —
                // writeOne applies immediately per item. A collision partway
                // through must not leave the earlier items in this same
                // attempt permanently live: status only flips to "active"
                // after the loop finishes, so a failure here would otherwise
                // strand them with no rollback() path (it requires status
                // "active") and no record of them in state.activated either.
                // Compensate explicitly so activate() keeps the same
                // all-or-nothing behavior the Postgres store gets for free.
                const activatedThisAttempt = new Map<string, string>();
                try {
                    for (const item of state.items.values()) {
                        const patientCase: PatientCase = patientCaseSchema.parse(item.patientCase);
                        const resource = { organizationId: context.organizationId, caseId: patientCase.id, patientId: patientCase.patientId ?? patientCase.id, ownerUserId: actor.userId!, workspaceId: patientCase.workspaceId, departmentId: patientCase.departmentId, assignedUserIds: patientCase.assignedUserIds ?? [], activeConsentScopes: patientCase.consentRecords.filter((record) => !record.revokedAt).map((record) => record.scope) };
                        const result = await cases.writeOne(patientCase, null, actor, resource);
                        if ("conflict" in result) throw new MigrationStateError(`Case ${patientCase.id} collided during activation.`);
                        activatedThisAttempt.set(patientCase.id, result.version);
                    }
                } catch (err) {
                    for (const [caseId, version] of activatedThisAttempt) await cases.deleteOne(caseId, version, actor).catch(() => {});
                    throw err;
                }
                for (const [caseId, version] of activatedThisAttempt) state.activated.set(caseId, version);
                await this.audit.record({ organizationId: context.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "caseMigration.activate", targetType: "caseMigration", targetId: id });
                return update(state, { status: "active" });
            },
            rollback: async (id, actor) => {
                const state = requireState(id); if (state.session.status !== "active") throw new MigrationStateError("Only an active migration can be rolled back.");
                // Deleted from state.activated as each one lands, not only at
                // the end: unlike activate() above, "undoing a delete" would
                // mean resurrecting a case, which is worse than just leaving
                // a retry to resume from whatever's left. A conflict (someone
                // else modified the case since activation) stops the loop
                // rather than deleting out from under that edit; a
                // known-already-gone case is treated as success, since that
                // is rollback's own goal for it.
                for (const [caseId, version] of [...state.activated]) {
                    const result = await cases.deleteOne(caseId, version, actor);
                    if ("conflict" in result) throw new MigrationStateError(`Case ${caseId} was modified since activation and could not be rolled back automatically.`);
                    state.activated.delete(caseId);
                }
                await this.audit.record({ organizationId: context.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "caseMigration.rollback", targetType: "caseMigration", targetId: id });
                return update(state, { status: "rolled-back" });
            },
        };
    }
}
