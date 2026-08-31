import type { AiInferenceDeployment, AiModelArtifact, AiProvider, AiProviderModel } from "@modelforge/contracts";
import type { Pool, PoolClient } from "pg";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import type { AiProviderRegistryStore, CreateAiInferenceDeploymentInput, CreateAiModelArtifactInput, CreateAiProviderInput, CreateAiProviderModelInput } from "./ai-provider-registry-store.js";

type Row = Record<string, unknown>;

function date(value: unknown): string { return (value as Date).toISOString(); }
function optionalDate(value: unknown): string | undefined { return value ? date(value) : undefined; }
function optionalNumber(value: unknown): number | undefined { return value === null || value === undefined ? undefined : Number(value); }

function provider(row: Row): AiProvider {
    return {
        id: row.id as string, name: row.name as string, kind: row.kind as AiProvider["kind"],
        killSwitchEngaged: row.kill_switch_engaged as boolean,
        killSwitchReason: (row.kill_switch_reason as string | null) ?? undefined,
        operationalStatus: row.operational_status as AiProvider["operationalStatus"],
        createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    };
}

function model(row: Row): AiProviderModel {
    return {
        id: row.id as string, providerId: row.provider_id as string, modelId: row.model_id as string,
        modelVersion: row.model_version as string, apiVersion: (row.api_version as string | null) ?? undefined,
        intendedUse: row.intended_use as string, prohibitedUse: (row.prohibited_use as string | null) ?? undefined,
        supportedDataTypes: row.supported_data_types as AiProviderModel["supportedDataTypes"],
        maxContextTokens: row.max_context_tokens as number, hostingRegion: row.hosting_region as string,
        processingLocation: row.processing_location as string, phiPermitted: row.phi_permitted as boolean,
        retainsPrompts: row.retains_prompts as boolean, retainsOutputs: row.retains_outputs as boolean,
        trainingUseAllowed: row.training_use_allowed as boolean, zeroRetentionSupport: row.zero_retention_support as boolean,
        approvals: row.approvals as AiProviderModel["approvals"], encryptionInTransit: row.encryption_in_transit as boolean,
        encryptionAtRest: row.encryption_at_rest as boolean, validationStatus: row.validation_status as AiProviderModel["validationStatus"],
        safetyStatus: row.safety_status as AiProviderModel["safetyStatus"], approvedRoles: row.approved_roles as string[],
        rateLimitPerMinute: optionalNumber(row.rate_limit_per_minute), costPerInputTokenUsd: optionalNumber(row.cost_per_input_token_usd),
        costPerOutputTokenUsd: optionalNumber(row.cost_per_output_token_usd), cpuThreads: optionalNumber(row.cpu_threads),
        ramMB: optionalNumber(row.ram_mb), vramMB: optionalNumber(row.vram_mb), effectiveAt: date(row.effective_at),
        retiredAt: optionalDate(row.retired_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    };
}

function artifact(row: Row): AiModelArtifact {
    return {
        id: row.id as string, providerModelId: row.provider_model_id as string,
        runtime: row.runtime as AiModelArtifact["runtime"], format: row.format as AiModelArtifact["format"],
        sourceUri: row.source_uri as string, sourceRevision: row.source_revision as string,
        fileName: (row.file_name as string | null) ?? undefined, sha256: row.sha256 as string,
        configurationHash: row.configuration_hash as string, licenseId: row.license_id as string,
        licenseAccepted: row.license_accepted as boolean, capabilities: row.capabilities as AiModelArtifact["capabilities"],
        chatTemplate: (row.chat_template as string | null) ?? undefined,
        toolCallParser: (row.tool_call_parser as string | null) ?? undefined,
        trustRemoteCode: row.trust_remote_code as boolean, status: row.status as AiModelArtifact["status"],
        createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    };
}

function deployment(row: Row): AiInferenceDeployment {
    return {
        id: row.id as string, artifactId: row.artifact_id as string, name: row.name as string,
        endpointUrl: row.endpoint_url as string, servedModelName: row.served_model_name as string,
        credentialRef: row.credential_ref as string, tlsMode: row.tls_mode as AiInferenceDeployment["tlsMode"],
        poolId: row.pool_id as string, maxConcurrency: Number(row.max_concurrency), priority: Number(row.priority),
        operationalStatus: row.operational_status as AiInferenceDeployment["operationalStatus"],
        runtimeVersion: (row.runtime_version as string | null) ?? undefined, lastVerifiedAt: optionalDate(row.last_verified_at),
        createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    };
}

/** Durable, PHI-free global AI provider/model catalog. Patient-linked state
 * remains in PostgresAiGatewayStore's tenant schema. */
export class PostgresAiProviderRegistryStore implements AiProviderRegistryStore {
    constructor(private readonly pool: Pool) {}

    private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
        catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
    }

    async createProvider(input: CreateAiProviderInput, actor: AuditActor): Promise<AiProvider> {
        return this.tx(async (client) => {
            const result = await client.query(`INSERT INTO public.ai_providers (name,kind) VALUES ($1,$2) RETURNING *`, [input.name, input.kind]);
            const value = provider(result.rows[0]);
            await insertAuditEntry(client, { organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProvider.create", targetType: "aiProvider", targetId: value.id, details: { name: input.name, kind: input.kind } });
            return value;
        });
    }
    async getProvider(id: string): Promise<AiProvider | null> { const r = await this.pool.query(`SELECT * FROM public.ai_providers WHERE id=$1`, [id]); return r.rows[0] ? provider(r.rows[0]) : null; }
    async listProviders(): Promise<AiProvider[]> { const r = await this.pool.query(`SELECT * FROM public.ai_providers ORDER BY name,id`); return r.rows.map(provider); }

    async setProviderKillSwitch(id: string, engaged: boolean, reason: string | undefined, actor: AuditActor): Promise<AiProvider | null> {
        return this.tx(async (client) => {
            const r = await client.query(`UPDATE public.ai_providers SET kill_switch_engaged=$2,kill_switch_reason=$3,updated_at=now() WHERE id=$1 RETURNING *`, [id, engaged, engaged ? reason ?? null : null]);
            if (!r.rows[0]) return null;
            await insertAuditEntry(client, { organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: engaged ? "aiProvider.killSwitchEngaged" : "aiProvider.killSwitchDisengaged", targetType: "aiProvider", targetId: id, details: { reason } });
            return provider(r.rows[0]);
        });
    }
    async setProviderOperationalStatus(id: string, status: AiProvider["operationalStatus"], actor: AuditActor): Promise<AiProvider | null> {
        return this.tx(async (client) => {
            const r = await client.query(`UPDATE public.ai_providers SET operational_status=$2,updated_at=now() WHERE id=$1 RETURNING *`, [id, status]);
            if (!r.rows[0]) return null;
            await insertAuditEntry(client, { organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProvider.statusChanged", targetType: "aiProvider", targetId: id, details: { status } });
            return provider(r.rows[0]);
        });
    }

    async createProviderModel(input: CreateAiProviderModelInput, actor: AuditActor): Promise<AiProviderModel> {
        return this.tx(async (client) => {
            const r = await client.query(`INSERT INTO public.ai_provider_models (
                provider_id,model_id,model_version,api_version,intended_use,prohibited_use,supported_data_types,max_context_tokens,
                hosting_region,processing_location,phi_permitted,retains_prompts,retains_outputs,training_use_allowed,zero_retention_support,
                approvals,encryption_in_transit,encryption_at_rest,validation_status,approved_roles,rate_limit_per_minute,
                cost_per_input_token_usd,cost_per_output_token_usd,cpu_threads,ram_mb,vram_mb,effective_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,COALESCE($27,now())) RETURNING *`, [
                input.providerId,input.modelId,input.modelVersion,input.apiVersion ?? null,input.intendedUse,input.prohibitedUse ?? null,
                input.supportedDataTypes,input.maxContextTokens,input.hostingRegion,input.processingLocation,input.phiPermitted ?? false,
                input.retainsPrompts ?? false,input.retainsOutputs ?? false,input.trainingUseAllowed ?? false,input.zeroRetentionSupport ?? false,
                JSON.stringify(input.approvals ?? { baaSigned:false,dpaSigned:false,contractualApproval:false,securityReviewApproval:false }),
                input.encryptionInTransit ?? false,input.encryptionAtRest ?? false,input.validationStatus ?? "unvalidated",input.approvedRoles ?? [],
                input.rateLimitPerMinute ?? null,input.costPerInputTokenUsd ?? null,input.costPerOutputTokenUsd ?? null,input.cpuThreads ?? null,
                input.ramMB ?? null,input.vramMB ?? null,input.effectiveAt ? new Date(input.effectiveAt) : null,
            ]);
            const value = model(r.rows[0]);
            await insertAuditEntry(client, { organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProviderModel.create", targetType: "aiProviderModel", targetId: value.id, details: { providerId: input.providerId, modelId: input.modelId, modelVersion: input.modelVersion, phiPermitted: value.phiPermitted } });
            return value;
        });
    }
    async getProviderModel(id: string): Promise<AiProviderModel | null> { const r = await this.pool.query(`SELECT * FROM public.ai_provider_models WHERE id=$1`, [id]); return r.rows[0] ? model(r.rows[0]) : null; }
    async listProviderModels(filter?: { providerId?: string }): Promise<AiProviderModel[]> {
        const r = filter?.providerId ? await this.pool.query(`SELECT * FROM public.ai_provider_models WHERE provider_id=$1 ORDER BY created_at,id`, [filter.providerId]) : await this.pool.query(`SELECT * FROM public.ai_provider_models ORDER BY created_at,id`);
        return r.rows.map(model);
    }
    async setProviderModelSafetyStatus(id: string, status: AiProviderModel["safetyStatus"], actor: AuditActor): Promise<AiProviderModel | null> {
        return this.tx(async (client) => {
            const r = await client.query(`UPDATE public.ai_provider_models SET safety_status=$2,updated_at=now() WHERE id=$1 RETURNING *`, [id,status]);
            if (!r.rows[0]) return null;
            await insertAuditEntry(client, { organizationId: undefined, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProviderModel.safetyStatusChanged", targetType: "aiProviderModel", targetId:id, details:{status} });
            return model(r.rows[0]);
        });
    }
    async retireProviderModel(id: string, actor: AuditActor): Promise<AiProviderModel | null> {
        return this.tx(async (client) => {
            const r=await client.query(`UPDATE public.ai_provider_models SET validation_status='deprecated',retired_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[id]);
            if(!r.rows[0]) return null;
            await insertAuditEntry(client,{organizationId:undefined,actorUserId:actor.userId,actorExternalSubject:actor.externalSubject,action:"aiProviderModel.retired",targetType:"aiProviderModel",targetId:id});
            return model(r.rows[0]);
        });
    }

    async createModelArtifact(input: CreateAiModelArtifactInput, actor: AuditActor): Promise<AiModelArtifact> {
        return this.tx(async (client) => {
            const r = await client.query(`INSERT INTO public.ai_model_artifacts
                (provider_model_id,runtime,format,source_uri,source_revision,file_name,sha256,configuration_hash,license_id,license_accepted,capabilities,chat_template,tool_call_parser,trust_remote_code,status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [
                input.providerModelId,input.runtime,input.format,input.sourceUri,input.sourceRevision,input.fileName ?? null,input.sha256,input.configurationHash,
                input.licenseId,input.licenseAccepted,JSON.stringify(input.capabilities),input.chatTemplate ?? null,input.toolCallParser ?? null,input.trustRemoteCode,input.status,
            ]);
            const value = artifact(r.rows[0]);
            await insertAuditEntry(client,{organizationId:undefined,actorUserId:actor.userId,actorExternalSubject:actor.externalSubject,action:"aiModelArtifact.create",targetType:"aiModelArtifact",targetId:value.id,details:{providerModelId:input.providerModelId,runtime:input.runtime,sha256:input.sha256}});
            return value;
        });
    }
    async getModelArtifact(id: string): Promise<AiModelArtifact | null> { const r=await this.pool.query(`SELECT * FROM public.ai_model_artifacts WHERE id=$1`,[id]); return r.rows[0]?artifact(r.rows[0]):null; }
    async listModelArtifacts(filter?: { providerModelId?: string; status?: AiModelArtifact["status"] }): Promise<AiModelArtifact[]> {
        const r=await this.pool.query(`SELECT * FROM public.ai_model_artifacts WHERE ($1::uuid IS NULL OR provider_model_id=$1) AND ($2::text IS NULL OR status=$2) ORDER BY created_at,id`,[filter?.providerModelId ?? null,filter?.status ?? null]);
        return r.rows.map(artifact);
    }
    async setModelArtifactStatus(id:string,status:AiModelArtifact["status"],actor:AuditActor):Promise<AiModelArtifact|null>{
        return this.tx(async(client)=>{const r=await client.query(`UPDATE public.ai_model_artifacts SET status=$2,updated_at=now() WHERE id=$1 RETURNING *`,[id,status]);if(!r.rows[0])return null;await insertAuditEntry(client,{organizationId:undefined,actorUserId:actor.userId,actorExternalSubject:actor.externalSubject,action:"aiModelArtifact.statusChanged",targetType:"aiModelArtifact",targetId:id,details:{status}});return artifact(r.rows[0]);});
    }
    async createInferenceDeployment(input: CreateAiInferenceDeploymentInput, actor: AuditActor): Promise<AiInferenceDeployment> {
        return this.tx(async (client) => {
            const r=await client.query(`INSERT INTO public.ai_inference_deployments
                (artifact_id,name,endpoint_url,served_model_name,credential_ref,tls_mode,pool_id,max_concurrency,priority,operational_status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[input.artifactId,input.name,input.endpointUrl,input.servedModelName,input.credentialRef,input.tlsMode,input.poolId,input.maxConcurrency,input.priority,input.operationalStatus]);
            const value=deployment(r.rows[0]);
            await insertAuditEntry(client,{organizationId:undefined,actorUserId:actor.userId,actorExternalSubject:actor.externalSubject,action:"aiInferenceDeployment.create",targetType:"aiInferenceDeployment",targetId:value.id,details:{artifactId:input.artifactId,endpointUrl:input.endpointUrl,poolId:input.poolId}});
            return value;
        });
    }
    async getInferenceDeployment(id: string): Promise<AiInferenceDeployment | null> { const r=await this.pool.query(`SELECT * FROM public.ai_inference_deployments WHERE id=$1`,[id]); return r.rows[0]?deployment(r.rows[0]):null; }
    async listInferenceDeployments(filter?: { artifactId?: string; operationalStatus?: AiInferenceDeployment["operationalStatus"] }): Promise<AiInferenceDeployment[]> {
        const r=await this.pool.query(`SELECT * FROM public.ai_inference_deployments WHERE ($1::uuid IS NULL OR artifact_id=$1) AND ($2::text IS NULL OR operational_status=$2) ORDER BY priority,created_at,id`,[filter?.artifactId ?? null,filter?.operationalStatus ?? null]);
        return r.rows.map(deployment);
    }
    async setInferenceDeploymentStatus(id: string,status: AiInferenceDeployment["operationalStatus"],actor: AuditActor): Promise<AiInferenceDeployment | null> {
        return this.tx(async(client)=>{const r=await client.query(`UPDATE public.ai_inference_deployments SET operational_status=$2,updated_at=now() WHERE id=$1 RETURNING *`,[id,status]);if(!r.rows[0])return null;await insertAuditEntry(client,{organizationId:undefined,actorUserId:actor.userId,actorExternalSubject:actor.externalSubject,action:"aiInferenceDeployment.statusChanged",targetType:"aiInferenceDeployment",targetId:id,details:{status}});return deployment(r.rows[0]);});
    }
    async recordInferenceDeploymentVerification(id:string,result:{runtimeVersion?:string;healthy:boolean},actor:AuditActor):Promise<AiInferenceDeployment|null>{
        return this.tx(async(client)=>{const r=await client.query(`UPDATE public.ai_inference_deployments SET runtime_version=COALESCE($2,runtime_version),last_verified_at=now(),operational_status=$3,updated_at=now() WHERE id=$1 RETURNING *`,[id,result.runtimeVersion ?? null,result.healthy?"active":"degraded"]);if(!r.rows[0])return null;await insertAuditEntry(client,{organizationId:undefined,actorUserId:actor.userId,actorExternalSubject:actor.externalSubject,action:"aiInferenceDeployment.verified",targetType:"aiInferenceDeployment",targetId:id,details:{healthy:result.healthy,runtimeVersion:result.runtimeVersion}});return deployment(r.rows[0]);});
    }
}
