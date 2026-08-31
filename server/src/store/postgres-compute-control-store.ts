import { randomUUID } from "node:crypto";
import {
    computeNodeSchema,
    computeResourceLeaseSchema,
    computeResourceRequestSchema,
    resourcePolicySchema,
    resourcePoolSchema,
    tenantComputeQuotaSchema,
    type ComputeNode,
    type ComputeNodeState,
    type ComputeResourceLease,
    type ComputeResourceRequest,
    type NodeHeartbeat,
    type ResourcePolicy,
    type ResourcePool,
    type TenantComputeQuota,
} from "@modelforge/contracts";
import type { Pool, PoolClient } from "pg";
import type { SchedulerDecision, SchedulerPlacement, SchedulerSnapshot } from "../compute/scheduler.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import type {
    ComputeControlStore,
    CreateResourcePolicyInput,
    CreateResourcePoolInput,
    RegisterComputeNodeInput,
    SubmitComputeRequestInput,
} from "./compute-control-store.js";

type Row = { document: unknown };

export class PostgresComputeControlStore implements ComputeControlStore {
    constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

    private async tenantTx<T>(organizationId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id',$1,true)", [organizationId]);
            const value = await fn(client);
            await client.query("COMMIT");
            return value;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    private async audit(client: PoolClient, organizationId: string, actor: AuditActor, action: string, targetType: string, targetId: string, details?: Record<string, unknown>): Promise<void> {
        await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action, targetType, targetId, details });
    }

    async registerNode(organizationId: string, input: RegisterComputeNodeInput, actor: AuditActor): Promise<ComputeNode> {
        return this.tenantTx(organizationId, async (client) => {
            const existing = await client.query<Row>("SELECT document FROM compute_nodes WHERE organization_id=$1 AND id=$2 FOR UPDATE", [organizationId, input.id]);
            const old = existing.rows[0] ? computeNodeSchema.parse(existing.rows[0].document) : undefined;
            const now = this.now().toISOString();
            const node = computeNodeSchema.parse({ ...input, organizationId, state: old?.state ?? "online", lastHeartbeatAt: now, createdAt: old?.createdAt ?? now, updatedAt: now });
            await client.query(
                `INSERT INTO compute_nodes(id,organization_id,region,state,certificate_fingerprint,inventory_version,last_heartbeat_at,document,created_at,updated_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT(id) DO UPDATE SET region=EXCLUDED.region,state=EXCLUDED.state,certificate_fingerprint=EXCLUDED.certificate_fingerprint,
                    inventory_version=EXCLUDED.inventory_version,last_heartbeat_at=EXCLUDED.last_heartbeat_at,document=EXCLUDED.document,updated_at=EXCLUDED.updated_at`,
                [node.id, organizationId, node.region, node.state, node.certificateFingerprint, node.inventoryVersion, node.lastHeartbeatAt, JSON.stringify(node), node.createdAt, node.updatedAt]
            );
            await client.query("DELETE FROM compute_accelerator_devices WHERE organization_id=$1 AND node_id=$2", [organizationId, node.id]);
            for (const device of node.devices) {
                await client.query(
                    `INSERT INTO compute_accelerator_devices(id,organization_id,node_id,health,vendor,total_vram_mb,free_vram_mb,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [device.id, organizationId, node.id, device.health, device.vendor, device.totalVramMB, device.freeVramMB, JSON.stringify(device)]
                );
            }
            await this.audit(client, organizationId, actor, old ? "computeNode.inventoryUpdated" : "computeNode.registered", "computeNode", node.id, { region: node.region, deviceCount: node.devices.length });
            return node;
        });
    }

    async heartbeat(organizationId: string, nodeId: string, heartbeat: NodeHeartbeat): Promise<ComputeNode | null> {
        return this.tenantTx(organizationId, async (client) => {
            const result = await client.query<Row>("SELECT document FROM compute_nodes WHERE organization_id=$1 AND id=$2 FOR UPDATE", [organizationId, nodeId]);
            if (!result.rows[0] || heartbeat.nodeId !== nodeId) return null;
            const existing = computeNodeSchema.parse(result.rows[0].document);
            const node = computeNodeSchema.parse({
                ...existing, freeCpuThreads: Math.min(existing.cpuThreads, heartbeat.freeCpuThreads), freeRamMB: Math.min(existing.totalRamMB, heartbeat.freeRamMB),
                devices: heartbeat.devices, inventoryVersion: heartbeat.inventoryVersion, lastHeartbeatAt: heartbeat.capturedAt,
                state: existing.state === "offline" ? "online" : existing.state, updatedAt: heartbeat.capturedAt,
            });
            await client.query("UPDATE compute_nodes SET state=$3,inventory_version=$4,last_heartbeat_at=$5,document=$6,updated_at=$5 WHERE organization_id=$1 AND id=$2", [organizationId, nodeId, node.state, node.inventoryVersion, node.lastHeartbeatAt, JSON.stringify(node)]);
            await client.query("DELETE FROM compute_accelerator_devices WHERE organization_id=$1 AND node_id=$2", [organizationId, nodeId]);
            for (const device of node.devices) await client.query(
                "INSERT INTO compute_accelerator_devices(id,organization_id,node_id,health,vendor,total_vram_mb,free_vram_mb,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
                [device.id, organizationId, nodeId, device.health, device.vendor, device.totalVramMB, device.freeVramMB, JSON.stringify(device)]
            );
            await client.query("INSERT INTO compute_node_heartbeats(organization_id,node_id,captured_at,document) VALUES($1,$2,$3,$4)", [organizationId, nodeId, heartbeat.capturedAt, JSON.stringify(heartbeat)]);
            return node;
        });
    }

    async markStaleNodes(olderThan: string): Promise<string[]> {
        const result = await this.pool.query<{ ids: string[] }>("SELECT sweep_stale_compute_nodes($1) AS ids", [olderThan]);
        return result.rows[0]?.ids ?? [];
    }

    async getNode(organizationId: string, nodeId: string): Promise<ComputeNode | null> { return this.tenantTx(organizationId, async (client) => { const r = await client.query<Row>("SELECT document FROM compute_nodes WHERE organization_id=$1 AND id=$2", [organizationId,nodeId]); return r.rows[0] ? computeNodeSchema.parse(r.rows[0].document) : null; }); }
    async listNodes(organizationId: string): Promise<ComputeNode[]> { return this.tenantTx(organizationId, async (client) => (await client.query<Row>("SELECT document FROM compute_nodes WHERE organization_id=$1 ORDER BY document->>'name',id",[organizationId])).rows.map((row) => computeNodeSchema.parse(row.document))); }

    async setNodeState(organizationId: string, nodeId: string, state: ComputeNodeState, actor: AuditActor): Promise<ComputeNode | null> {
        return this.tenantTx(organizationId, async (client) => {
            const r = await client.query<Row>("SELECT document FROM compute_nodes WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,nodeId]);
            if (!r.rows[0]) return null;
            const existing = computeNodeSchema.parse(r.rows[0].document);
            const updated = computeNodeSchema.parse({ ...existing, state, updatedAt: this.now().toISOString() });
            await client.query("UPDATE compute_nodes SET state=$3,document=$4,updated_at=$5 WHERE organization_id=$1 AND id=$2",[organizationId,nodeId,state,JSON.stringify(updated),updated.updatedAt]);
            await this.audit(client,organizationId,actor,"computeNode.stateChanged","computeNode",nodeId,{from:existing.state,to:state});
            return updated;
        });
    }

    async createPool(organizationId: string, input: CreateResourcePoolInput, actor: AuditActor): Promise<ResourcePool> {
        return this.tenantTx(organizationId, async (client) => {
            const nodes = await client.query<{id:string}>("SELECT id FROM compute_nodes WHERE organization_id=$1 AND id=ANY($2::uuid[])",[organizationId,input.nodeIds]);
            if (nodes.rows.length !== new Set(input.nodeIds).size) throw new Error("One or more compute nodes do not exist in this organization.");
            const now=this.now().toISOString();
            const pool=resourcePoolSchema.parse({...input,id:randomUUID(),organizationId,createdAt:now,updatedAt:now});
            await client.query("INSERT INTO compute_resource_pools(id,organization_id,region,status,document,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[pool.id,organizationId,pool.region,pool.status,JSON.stringify(pool),now,now]);
            for(const nodeId of pool.nodeIds) await client.query("INSERT INTO compute_pool_nodes(organization_id,pool_id,node_id) VALUES($1,$2,$3)",[organizationId,pool.id,nodeId]);
            await this.audit(client,organizationId,actor,"computePool.created","computePool",pool.id,{region:pool.region,nodeCount:pool.nodeIds.length});
            return pool;
        });
    }
    async getPool(organizationId:string,poolId:string):Promise<ResourcePool|null>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_pools WHERE organization_id=$1 AND id=$2",[organizationId,poolId]);return r.rows[0]?resourcePoolSchema.parse(r.rows[0].document):null;});}
    async listPools(organizationId:string):Promise<ResourcePool[]>{return this.tenantTx(organizationId,async(client)=>(await client.query<Row>("SELECT document FROM compute_resource_pools WHERE organization_id=$1 ORDER BY document->>'name',id",[organizationId])).rows.map((row)=>resourcePoolSchema.parse(row.document)));}

    async upsertQuota(organizationId:string,input:Omit<TenantComputeQuota,"organizationId"|"updatedAt">,actor:AuditActor):Promise<TenantComputeQuota>{
        return this.tenantTx(organizationId,async(client)=>{const now=this.now().toISOString();const quota=tenantComputeQuotaSchema.parse({...input,organizationId,updatedAt:now});await client.query(`INSERT INTO compute_tenant_quotas(organization_id,pool_id,document,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,pool_id) DO UPDATE SET document=EXCLUDED.document,updated_at=EXCLUDED.updated_at`,[organizationId,input.poolId,JSON.stringify(quota),now]);await this.audit(client,organizationId,actor,"computeQuota.updated","computePool",input.poolId,{borrowingEnabled:quota.borrowingEnabled,weight:quota.weight});return quota;});
    }
    async getQuota(organizationId:string,poolId:string):Promise<TenantComputeQuota|null>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_tenant_quotas WHERE organization_id=$1 AND pool_id=$2",[organizationId,poolId]);return r.rows[0]?tenantComputeQuotaSchema.parse(r.rows[0].document):null;});}

    async createPolicy(organizationId:string,input:CreateResourcePolicyInput,actor:AuditActor):Promise<ResourcePolicy>{
        return this.tenantTx(organizationId,async(client)=>{const v=await client.query<{version:number}>("SELECT COALESCE(MAX(version),0)+1 AS version FROM compute_resource_policies WHERE organization_id=$1 AND pool_id IS NOT DISTINCT FROM $2::uuid",[organizationId,input.poolId??null]);const policy=resourcePolicySchema.parse({...input,id:randomUUID(),organizationId,version:Number(v.rows[0]!.version),status:"draft",createdAt:this.now().toISOString()});await client.query("INSERT INTO compute_resource_policies(id,organization_id,pool_id,version,status,document,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[policy.id,organizationId,policy.poolId??null,policy.version,policy.status,JSON.stringify(policy),policy.createdAt]);await this.audit(client,organizationId,actor,"computePolicy.created","computePolicy",policy.id,{version:policy.version,poolId:policy.poolId});return policy;});
    }
    async activatePolicy(organizationId:string,policyId:string,actor:AuditActor):Promise<ResourcePolicy|null>{
        return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_policies WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,policyId]);if(!r.rows[0])return null;const policy=resourcePolicySchema.parse(r.rows[0].document);const active=resourcePolicySchema.parse({...policy,status:"active"});const previous=await client.query<{id:string;document:unknown}>("SELECT id,document FROM compute_resource_policies WHERE organization_id=$1 AND pool_id IS NOT DISTINCT FROM $2::uuid AND status='active' FOR UPDATE",[organizationId,policy.poolId??null]);for(const row of previous.rows){const retired=resourcePolicySchema.parse({...resourcePolicySchema.parse(row.document),status:"retired"});await client.query("UPDATE compute_resource_policies SET status='retired',document=$3 WHERE organization_id=$1 AND id=$2",[organizationId,row.id,JSON.stringify(retired)]);}await client.query("UPDATE compute_resource_policies SET status='active',document=$3 WHERE organization_id=$1 AND id=$2",[organizationId,policyId,JSON.stringify(active)]);await this.audit(client,organizationId,actor,"computePolicy.activated","computePolicy",policyId,{version:active.version,poolId:active.poolId});return active;});
    }
    async listPolicies(organizationId:string,poolId?:string):Promise<ResourcePolicy[]>{return this.tenantTx(organizationId,async(client)=>{const r=poolId===undefined?await client.query<Row>("SELECT document FROM compute_resource_policies WHERE organization_id=$1 ORDER BY version DESC",[organizationId]):await client.query<Row>("SELECT document FROM compute_resource_policies WHERE organization_id=$1 AND pool_id=$2 ORDER BY version DESC",[organizationId,poolId]);return r.rows.map((row)=>resourcePolicySchema.parse(row.document));});}

    async submitRequest(organizationId:string,input:SubmitComputeRequestInput,actor:AuditActor):Promise<ComputeResourceRequest>{return this.tenantTx(organizationId,async(client)=>{const now=this.now().toISOString();const request=computeResourceRequestSchema.parse({...input,id:randomUUID(),organizationId,state:"queued",queuedAt:now,updatedAt:now});await client.query("INSERT INTO compute_resource_requests(id,organization_id,pool_id,state,priority,document,queued_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[request.id,organizationId,request.poolId,request.state,request.priority,JSON.stringify(request),now,now]);await client.query("INSERT INTO compute_allocation_events(organization_id,request_id,event_type,details) VALUES($1,$2,'submitted',$3)",[organizationId,request.id,JSON.stringify({priority:request.priority,workloadKind:request.workloadKind})]);await this.audit(client,organizationId,actor,"computeRequest.submitted","computeRequest",request.id,{poolId:request.poolId,priority:request.priority,workloadKind:request.workloadKind});return request;});}
    async getRequest(organizationId:string,requestId:string):Promise<ComputeResourceRequest|null>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_requests WHERE organization_id=$1 AND id=$2",[organizationId,requestId]);return r.rows[0]?computeResourceRequestSchema.parse(r.rows[0].document):null;});}
    async listRequests(organizationId:string,filter?:{poolId?:string;state?:ComputeResourceRequest["state"]}):Promise<ComputeResourceRequest[]>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_requests WHERE organization_id=$1 AND ($2::uuid IS NULL OR pool_id=$2) AND ($3::text IS NULL OR state=$3) ORDER BY queued_at,id",[organizationId,filter?.poolId??null,filter?.state??null]);return r.rows.map((row)=>computeResourceRequestSchema.parse(row.document));});}
    async cancelRequest(organizationId:string,requestId:string,actor:AuditActor):Promise<ComputeResourceRequest|null>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_requests WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,requestId]);if(!r.rows[0])return null;const old=computeResourceRequestSchema.parse(r.rows[0].document);if(["completed","failed","cancelled"].includes(old.state))return null;const updated=computeResourceRequestSchema.parse({...old,state:"cancelled",updatedAt:this.now().toISOString()});await client.query("UPDATE compute_resource_requests SET state='cancelled',document=$3,updated_at=$4 WHERE organization_id=$1 AND id=$2",[organizationId,requestId,JSON.stringify(updated),updated.updatedAt]);await this.audit(client,organizationId,actor,"computeRequest.cancelled","computeRequest",requestId);return updated;});}

    async recordShadowDecision(organizationId: string, requestId: string, decision: SchedulerDecision, actor: AuditActor): Promise<void> {
        return this.tenantTx(organizationId, async (client) => {
            await client.query("INSERT INTO compute_allocation_events(organization_id,request_id,event_type,details) VALUES($1,$2,'shadow_decision',$3)", [organizationId, requestId, JSON.stringify(decision)]);
            await this.audit(client, organizationId, actor, "computeRequest.shadowDecision", "computeRequest", requestId, { decision });
        });
    }

    async getSchedulingSnapshot(organizationId:string,poolId:string,now:string):Promise<SchedulerSnapshot|null>{return this.tenantTx(organizationId,async(client)=>{const poolRow=await client.query<Row>("SELECT document FROM compute_resource_pools WHERE organization_id=$1 AND id=$2",[organizationId,poolId]);if(!poolRow.rows[0])return null;const pool=resourcePoolSchema.parse(poolRow.rows[0].document);const nodes=(await client.query<Row>("SELECT n.document FROM compute_nodes n JOIN compute_pool_nodes pn ON pn.node_id=n.id AND pn.organization_id=n.organization_id WHERE n.organization_id=$1 AND pn.pool_id=$2",[organizationId,poolId])).rows.map((row)=>computeNodeSchema.parse(row.document));const quotaRow=await client.query<Row>("SELECT document FROM compute_tenant_quotas WHERE organization_id=$1 AND pool_id=$2",[organizationId,poolId]);const policyRow=await client.query<Row>("SELECT document FROM compute_resource_policies WHERE organization_id=$1 AND pool_id IS NOT DISTINCT FROM $2::uuid AND status='active' AND (document->>'expiresAt')::timestamptz > $3::timestamptz ORDER BY version DESC LIMIT 1",[organizationId,poolId,now]);const leases=(await client.query<Row>("SELECT document FROM compute_resource_leases WHERE organization_id=$1 AND pool_id=$2 AND state=ANY($3::text[])",[organizationId,poolId,["offered","acknowledged","running"]])).rows.map((row)=>computeResourceLeaseSchema.parse(row.document));const requests=(await client.query<Row>("SELECT document FROM compute_resource_requests WHERE organization_id=$1 AND pool_id=$2 AND state=ANY($3::text[])",[organizationId,poolId,["assigned","running","preempting"]])).rows.map((row)=>computeResourceRequestSchema.parse(row.document));return{nodes,pool,quota:quotaRow.rows[0]?tenantComputeQuotaSchema.parse(quotaRow.rows[0].document):undefined,policy:policyRow.rows[0]?resourcePolicySchema.parse(policyRow.rows[0].document):undefined,activeLeases:leases,activeRequests:requests,now};});}

    async commitPlacement(organizationId:string,requestId:string,placement:SchedulerPlacement,policyVersion:number|undefined,actor:AuditActor):Promise<ComputeResourceLease|null>{return this.tenantTx(organizationId,async(client)=>{const rr=await client.query<Row>("SELECT document FROM compute_resource_requests WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,requestId]);if(!rr.rows[0])return null;const request=computeResourceRequestSchema.parse(rr.rows[0].document);if(request.state!=="queued")return null;await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[request.poolId]);for(const victimId of placement.preemptLeaseIds){const vr=await client.query<Row>("SELECT document FROM compute_resource_leases WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,victimId]);if(!vr.rows[0])continue;const victim=computeResourceLeaseSchema.parse(vr.rows[0].document);if(!["offered","acknowledged","running"].includes(victim.state))continue;const failed=computeResourceLeaseSchema.parse({...victim,state:"failed",updatedAt:this.now().toISOString()});await client.query("UPDATE compute_resource_leases SET state='failed',document=$3,updated_at=$4 WHERE organization_id=$1 AND id=$2",[organizationId,victimId,JSON.stringify(failed),failed.updatedAt]);}
        const now=this.now();const token=await client.query<{token:string}>("SELECT nextval('compute_fencing_token_seq')::text AS token");const lease=computeResourceLeaseSchema.parse({id:randomUUID(),requestId,organizationId,poolId:request.poolId,nodeId:placement.nodeId,acceleratorDeviceIds:placement.acceleratorDeviceIds,vramMBPerDevice:request.requirements.vramMBPerDevice,exclusiveAccelerators:request.requirements.exclusiveAccelerators,cpuThreads:request.requirements.cpuThreads,ramMB:request.requirements.ramMB,pinnedMemoryMB:request.requirements.pinnedMemoryMB,fencingToken:token.rows[0]!.token,state:"offered",acknowledgmentDeadlineAt:new Date(now.getTime()+15_000).toISOString(),renewalDeadlineAt:new Date(now.getTime()+30_000).toISOString(),expiresAt:new Date(now.getTime()+90_000).toISOString(),explanation:placement.explanation,effectivePolicyVersion:policyVersion,createdAt:now.toISOString(),updatedAt:now.toISOString()});await client.query("INSERT INTO compute_resource_leases(id,request_id,organization_id,pool_id,node_id,state,fencing_token,acknowledgment_deadline_at,renewal_deadline_at,expires_at,document,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[lease.id,requestId,organizationId,lease.poolId,lease.nodeId,lease.state,lease.fencingToken,lease.acknowledgmentDeadlineAt,lease.renewalDeadlineAt,lease.expiresAt,JSON.stringify(lease),lease.createdAt,lease.updatedAt]);const assigned=computeResourceRequestSchema.parse({...request,state:"assigned",assignedAt:lease.createdAt,updatedAt:lease.createdAt});await client.query("UPDATE compute_resource_requests SET state='assigned',document=$3,updated_at=$4 WHERE organization_id=$1 AND id=$2",[organizationId,requestId,JSON.stringify(assigned),assigned.updatedAt]);await client.query("INSERT INTO compute_allocation_events(organization_id,request_id,lease_id,event_type,details) VALUES($1,$2,$3,'allocated',$4)",[organizationId,requestId,lease.id,JSON.stringify(placement.explanation)]);await this.audit(client,organizationId,actor,"computeLease.allocated","computeLease",lease.id,{requestId,nodeId:lease.nodeId,acceleratorDeviceIds:lease.acceleratorDeviceIds,fencingToken:lease.fencingToken,preemptLeaseIds:placement.preemptLeaseIds});return lease;});}

    async getLease(organizationId:string,leaseId:string):Promise<ComputeResourceLease|null>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_leases WHERE organization_id=$1 AND id=$2",[organizationId,leaseId]);return r.rows[0]?computeResourceLeaseSchema.parse(r.rows[0].document):null;});}
    async listLeases(organizationId:string,filter?:{poolId?:string;nodeId?:string;state?:ComputeResourceLease["state"]}):Promise<ComputeResourceLease[]>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_leases WHERE organization_id=$1 AND ($2::uuid IS NULL OR pool_id=$2) AND ($3::uuid IS NULL OR node_id=$3) AND ($4::text IS NULL OR state=$4) ORDER BY created_at DESC",[organizationId,filter?.poolId??null,filter?.nodeId??null,filter?.state??null]);return r.rows.map((row)=>computeResourceLeaseSchema.parse(row.document));});}

    async acknowledgeLease(organizationId:string,leaseId:string,fencingToken:string,actor:AuditActor):Promise<ComputeResourceLease|null>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_leases WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,leaseId]);if(!r.rows[0])return null;const lease=computeResourceLeaseSchema.parse(r.rows[0].document);const now=this.now().toISOString();if(lease.fencingToken!==fencingToken||lease.state!=="offered"||lease.acknowledgmentDeadlineAt<now)return null;const updated=computeResourceLeaseSchema.parse({...lease,state:"running",acknowledgedAt:now,updatedAt:now});await client.query("UPDATE compute_resource_leases SET state='running',document=$3,updated_at=$4 WHERE organization_id=$1 AND id=$2",[organizationId,leaseId,JSON.stringify(updated),now]);const qr=await client.query<Row>("SELECT document FROM compute_resource_requests WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,lease.requestId]);if(qr.rows[0]){const request=computeResourceRequestSchema.parse({...computeResourceRequestSchema.parse(qr.rows[0].document),state:"running",updatedAt:now});await client.query("UPDATE compute_resource_requests SET state='running',document=$3,updated_at=$4 WHERE organization_id=$1 AND id=$2",[organizationId,request.id,JSON.stringify(request),now]);}await this.audit(client,organizationId,actor,"computeLease.acknowledged","computeLease",leaseId,{requestId:lease.requestId,nodeId:lease.nodeId});return updated;});}
    async renewLease(organizationId:string,leaseId:string,fencingToken:string):Promise<ComputeResourceLease|null>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_leases WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,leaseId]);if(!r.rows[0])return null;const lease=computeResourceLeaseSchema.parse(r.rows[0].document);const now=this.now();if(lease.fencingToken!==fencingToken||!["acknowledged","running"].includes(lease.state)||lease.expiresAt<=now.toISOString())return null;const updated=computeResourceLeaseSchema.parse({...lease,renewalDeadlineAt:new Date(now.getTime()+30_000).toISOString(),expiresAt:new Date(now.getTime()+90_000).toISOString(),updatedAt:now.toISOString()});await client.query("UPDATE compute_resource_leases SET renewal_deadline_at=$3,expires_at=$4,document=$5,updated_at=$6 WHERE organization_id=$1 AND id=$2",[organizationId,leaseId,updated.renewalDeadlineAt,updated.expiresAt,JSON.stringify(updated),updated.updatedAt]);return updated;});}
    async releaseLease(organizationId:string,leaseId:string,fencingToken:string,outcome:"completed"|"failed"|"cancelled",actor:AuditActor):Promise<ComputeResourceLease|null>{return this.tenantTx(organizationId,async(client)=>{const r=await client.query<Row>("SELECT document FROM compute_resource_leases WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,leaseId]);if(!r.rows[0])return null;const lease=computeResourceLeaseSchema.parse(r.rows[0].document);if(lease.fencingToken!==fencingToken||!["offered","acknowledged","running"].includes(lease.state))return null;const now=this.now().toISOString();const updated=computeResourceLeaseSchema.parse({...lease,state:outcome==="failed"?"failed":"released",updatedAt:now});await client.query("UPDATE compute_resource_leases SET state=$3,document=$4,updated_at=$5 WHERE organization_id=$1 AND id=$2",[organizationId,leaseId,updated.state,JSON.stringify(updated),now]);const qr=await client.query<Row>("SELECT document FROM compute_resource_requests WHERE organization_id=$1 AND id=$2 FOR UPDATE",[organizationId,lease.requestId]);if(qr.rows[0]){const request=computeResourceRequestSchema.parse({...computeResourceRequestSchema.parse(qr.rows[0].document),state:outcome,updatedAt:now});await client.query("UPDATE compute_resource_requests SET state=$3,document=$4,updated_at=$5 WHERE organization_id=$1 AND id=$2",[organizationId,request.id,outcome,JSON.stringify(request),now]);}await client.query("INSERT INTO compute_allocation_events(organization_id,request_id,lease_id,event_type,details) VALUES($1,$2,$3,'released',$4)",[organizationId,lease.requestId,leaseId,JSON.stringify({outcome})]);await this.audit(client,organizationId,actor,"computeLease.released","computeLease",leaseId,{outcome,requestId:lease.requestId,nodeId:lease.nodeId});return updated;});}
    async sweepExpired(now:string):Promise<string[]>{const result=await this.pool.query<{ids:string[]}>("SELECT reclaim_expired_compute_leases($1) AS ids",[now]);return result.rows[0]?.ids??[];}
}
