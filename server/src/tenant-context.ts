import type { FastifyRequest } from "fastify";
import type { Organization } from "./domain/types.js";
import type { IamStore } from "./store/iam-store.js";
import type { Pool } from "pg";
import type { AuditActor } from "./store/audit-store.js";
import type { Group, Policy, PolicyDocument, User } from "./domain/types.js";

export interface TenantContext {
    readonly organizationId: string;
    readonly schemaName: string;
    readonly issuer: string;
    readonly subject: string;
}

const TENANT_SCHEMA_PATTERN = /^tenant_[a-f0-9]{32}$/;

export function schemaNameForTenant(organizationId: string): string {
    const compact = organizationId.replaceAll("-", "").toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(compact)) throw new Error("Organization id cannot be mapped to a tenant schema.");
    return `tenant_${compact}`;
}

export function createTenantContext(organization: Organization, request: FastifyRequest): TenantContext {
    const auth = request.auth;
    if (!auth) throw new Error("Authenticated request is required to create tenant context.");
    const schemaName = organization.tenantSchema ?? schemaNameForTenant(organization.id);
    if (!TENANT_SCHEMA_PATTERN.test(schemaName)) throw new Error("Tenant directory returned an invalid schema identifier.");
    return Object.freeze({ organizationId: organization.id, schemaName, issuer: auth.issuer, subject: auth.subject });
}

export interface TenantDirectory {
    provision(organization: Organization): Promise<Organization>;
    resolve(organizationId: string): Promise<Organization | null>;
}

export class StoreTenantDirectory implements TenantDirectory {
    constructor(private readonly store: IamStore) {}

    async provision(organization: Organization): Promise<Organization> {
        return { ...organization, tenantSchema: organization.tenantSchema ?? schemaNameForTenant(organization.id) };
    }

    resolve(organizationId: string): Promise<Organization | null> {
        return this.store.getOrganization(organizationId);
    }
}

export class PostgresTenantDirectory implements TenantDirectory {
    constructor(private readonly pool: Pool) {}

    async provision(organization: Organization): Promise<Organization> {
        const result = await this.pool.query<{ provision_tenant_clinical_schema: string }>(
            "SELECT provision_tenant_clinical_schema($1)",
            [organization.id]
        );
        const schemaName = result.rows[0]?.provision_tenant_clinical_schema;
        if (!schemaName || !TENANT_SCHEMA_PATTERN.test(schemaName)) throw new Error("Tenant schema provisioning returned an invalid identifier.");
        return { ...organization, tenantSchema: schemaName };
    }

    async resolve(organizationId: string): Promise<Organization | null> {
        const result = await this.pool.query<{ id: string; name: string; tenant_schema: string | null; created_at: Date }>(
            "SELECT id, name, tenant_schema, created_at FROM organizations WHERE id = $1",
            [organizationId]
        );
        const row = result.rows[0];
        if (!row) return null;
        const organization: Organization = {
            id: row.id,
            name: row.name,
            tenantSchema: row.tenant_schema ?? undefined,
            createdAt: row.created_at.toISOString(),
        };
        return organization.tenantSchema ? organization : this.provision(organization);
    }
}

export interface TenantIamRepository {
    readonly context: TenantContext;
    getOrganization(): Promise<Organization | null>;
    createUser(input: Omit<Parameters<IamStore["createUser"]>[0], "organizationId">, actor: AuditActor): Promise<User>;
    getUser(id: string): Promise<User | null>;
    findUserByExternalSubject(subject: string): Promise<User | null>;
    listUsers(): Promise<User[]>;
    updateUser(id: string, partial: Parameters<IamStore["updateUser"]>[1], actor: AuditActor): Promise<User | null>;
    createGroup(input: { name: string; policyIds?: string[] }, actor: AuditActor): Promise<Group>;
    getGroup(id: string): Promise<Group | null>;
    listGroups(): Promise<Group[]>;
    updateGroup(id: string, partial: Partial<Pick<Group, "name" | "policyIds">>, actor: AuditActor): Promise<Group | null>;
    createPolicy(input: { name: string; description?: string; document: PolicyDocument; builtin?: boolean }, actor: AuditActor): Promise<Policy>;
    getPolicy(id: string): Promise<Policy | null>;
    listPolicies(): Promise<Policy[]>;
    updatePolicy(id: string, partial: Partial<Pick<Policy, "name" | "description" | "document">>, actor: AuditActor): Promise<Policy | null>;
    deletePolicy(id: string, actor: AuditActor): Promise<boolean>;
    setBreakGlassPolicy(policyId: string | null, actor: AuditActor): Promise<Policy | null>;
    getBreakGlassPolicy(): Promise<Policy | null>;
    resolveEffectivePolicies(userId: string): Promise<Policy[]>;
}

/**
 * The only IAM interface route handlers receive after tenant resolution.
 * Organization ids are absent from every method, so accidental cross-tenant
 * access is not expressible at an application call site. The legacy store
 * remains the bootstrap/discovery adapter underneath this boundary.
 */
export function bindTenantIamStore(store: IamStore, context: TenantContext): TenantIamRepository {
    if (store.bindTenant) return store.bindTenant(context);
    const inTenant = <T extends { organizationId: string }>(value: T | null): T | null =>
        value?.organizationId === context.organizationId ? value : null;

    const repository: TenantIamRepository = {
        context,
        getOrganization: async () => {
            const value = await store.getOrganization(context.organizationId);
            return value?.id === context.organizationId ? value : null;
        },
        createUser: (input, actor) => store.createUser({ ...input, organizationId: context.organizationId }, actor),
        getUser: async (id) => inTenant(await store.getUser(id)),
        findUserByExternalSubject: (subject) => store.findUserByExternalSubject(context.organizationId, subject),
        listUsers: () => store.listUsersByOrganization(context.organizationId),
        updateUser: async (id, partial, actor) => {
            if (!inTenant(await store.getUser(id))) return null;
            return inTenant(await store.updateUser(id, partial, actor));
        },
        createGroup: (input, actor) => store.createGroup({ ...input, organizationId: context.organizationId }, actor),
        getGroup: async (id) => inTenant(await store.getGroup(id)),
        listGroups: () => store.listGroupsByOrganization(context.organizationId),
        updateGroup: async (id, partial, actor) => {
            if (!inTenant(await store.getGroup(id))) return null;
            return inTenant(await store.updateGroup(id, partial, actor));
        },
        createPolicy: (input, actor) => store.createPolicy({ ...input, organizationId: context.organizationId }, actor),
        getPolicy: async (id) => inTenant(await store.getPolicy(id)),
        listPolicies: () => store.listPoliciesByOrganization(context.organizationId),
        updatePolicy: async (id, partial, actor) => {
            if (!inTenant(await store.getPolicy(id))) return null;
            return inTenant(await store.updatePolicy(id, partial, actor));
        },
        deletePolicy: async (id, actor) => (inTenant(await store.getPolicy(id)) ? store.deletePolicy(id, actor) : false),
        setBreakGlassPolicy: (policyId, actor) => store.setBreakGlassPolicy(context.organizationId, policyId, actor),
        getBreakGlassPolicy: () => store.getBreakGlassPolicy(context.organizationId),
        resolveEffectivePolicies: async (userId) => {
            if (!inTenant(await store.getUser(userId))) return [];
            return (await store.resolveEffectivePolicies(userId)).filter((policy) => policy.organizationId === context.organizationId);
        },
    };
    return Object.freeze(repository);
}
