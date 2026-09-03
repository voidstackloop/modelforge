import type {
    AiCitation, AiConsent, AiDataTransformation, AiGatewayChange, AiOutput, AiProviderTenantSettings,
    AiRequestEnvelope, AiRequestInput, AiReview, AiSafetyEvent,
} from "@modelforge/contracts";
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "../tenant-context.js";
import { insertAuditEntry, type AuditActor } from "./audit-store.js";
import type { AiGatewayStore, CreateAiConsentInput, CreateAiOutputInput, CreateAiRequestInput, TenantAiGatewayRepository } from "./ai-gateway-store.js";

type Row = Record<string, unknown>;
function iso(value: unknown): string { return (value as Date).toISOString(); }
function maybeIso(value: unknown): string | undefined { return value ? iso(value) : undefined; }
function schemaName(value: string): string { if (!/^tenant_[a-f0-9]{32}$/.test(value)) throw new Error("Unsafe tenant schema identifier."); return `"${value}"`; }

function settings(r: Row): AiProviderTenantSettings { return { id:r.id as string,providerModelId:r.provider_model_id as string,enabled:r.enabled as boolean,phiAllowed:r.phi_allowed as boolean,allowedRoles:r.allowed_roles as string[],approvedByUserId:r.approved_by_user_id as string,approvedAt:iso(r.approved_at),notes:(r.notes as string|null)??undefined }; }
function consent(r: Row): AiConsent { return { id:r.id as string,patientCaseId:r.patient_case_id as string,version:r.version as number,purpose:r.purpose as AiConsent["purpose"],dataCategories:r.data_categories as string[],status:r.status as AiConsent["status"],grantedByUserId:r.granted_by_user_id as string,grantedAt:iso(r.granted_at),expiresAt:maybeIso(r.expires_at),revokedByUserId:(r.revoked_by_user_id as string|null)??undefined,revokedAt:maybeIso(r.revoked_at),revokedReason:(r.revoked_reason as string|null)??undefined }; }
function request(r: Row): AiRequestEnvelope { return { id:r.id as string,patientCaseId:r.patient_case_id as string,requestedByUserId:r.requested_by_user_id as string,providerModelId:r.provider_model_id as string,purposeOfUse:r.purpose_of_use as AiRequestEnvelope["purposeOfUse"],consentId:r.consent_id as string,policySnapshotHash:r.policy_snapshot_hash as string,dataScope:r.data_scope as AiRequestEnvelope["dataScope"],deidentificationApplied:r.deidentification_applied as boolean,status:r.status as AiRequestEnvelope["status"],rejectionReason:(r.rejection_reason as string|null)??undefined,createdAt:iso(r.created_at),expiresAt:iso(r.expires_at),completedAt:maybeIso(r.completed_at) }; }
function requestInput(r: Row): AiRequestInput { return { id:r.id as string,requestId:r.request_id as string,resourceType:r.resource_type as string,resourceId:r.resource_id as string,resourceVersionHash:(r.resource_version_hash as string|null)??undefined,includedInPrompt:r.included_in_prompt as boolean }; }
function transformation(r: Row): AiDataTransformation { return { id:r.id as string,requestId:r.request_id as string,kind:r.kind as AiDataTransformation["kind"],appliedAt:iso(r.applied_at),details:(r.details as Record<string,unknown>|null)??undefined }; }
function output(r: Row): AiOutput { return { id:r.id as string,requestId:r.request_id as string,providerModelId:r.provider_model_id as string,modelVersion:r.model_version as string,promptVersion:r.prompt_version as string,generatedAt:iso(r.generated_at),summary:r.summary as string,evidence:r.evidence as string[],uncertainty:(r.uncertainty as string|null)??undefined,followUp:r.follow_up as string[],abstained:r.abstained as boolean,abstainReason:(r.abstain_reason as string|null)??undefined,confidence:r.confidence===null||r.confidence===undefined?undefined:Number(r.confidence),outputHash:r.output_hash as string,reviewStatus:r.review_status as AiOutput["reviewStatus"] }; }
function citation(r: Row): AiCitation { return { id:r.id as string,outputId:r.output_id as string,resourceType:r.resource_type as string,resourceId:r.resource_id as string,resourceVersionHash:(r.resource_version_hash as string|null)??undefined,locator:(r.locator as string|null)??undefined }; }
function review(r: Row): AiReview { return { id:r.id as string,outputId:r.output_id as string,reviewedByUserId:r.reviewed_by_user_id as string,decision:r.decision as AiReview["decision"],correctedText:(r.corrected_text as string|null)??undefined,escalationReason:(r.escalation_reason as string|null)??undefined,reviewedAt:iso(r.reviewed_at) }; }
function safetyEvent(r: Row): AiSafetyEvent { return { id:r.id as string,requestId:(r.request_id as string|null)??undefined,kind:r.kind as AiSafetyEvent["kind"],severity:r.severity as AiSafetyEvent["severity"],details:(r.details as string|null)??undefined,createdAt:iso(r.created_at) }; }

export class PostgresAiGatewayStore implements AiGatewayStore {
    constructor(private readonly pool: Pool) {}

    forTenant(context: TenantContext): TenantAiGatewayRepository {
        const pool=this.pool; const schema=schemaName(context.schemaName);
        async function tx<T>(fn:(client:PoolClient)=>Promise<T>, isolation=false):Promise<T>{
            const client=await pool.connect();
            try { await client.query(isolation?"BEGIN ISOLATION LEVEL REPEATABLE READ":"BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)",[context.organizationId]); const value=await fn(client); await client.query("COMMIT"); return value; }
            catch(error){ await client.query("ROLLBACK"); throw error; } finally { client.release(); }
        }
        async function read<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>{ return tx(fn); }
        async function nextChange(client:PoolClient, resourceType:AiGatewayChange["resourceType"], resourceId:string, resource:unknown):Promise<void>{
            const n=await client.query<{sequence:string}>(`UPDATE ${schema}.ai_gateway_change_counter SET next_sequence=next_sequence+1 WHERE singleton=TRUE RETURNING next_sequence-1 AS sequence`);
            await client.query(`INSERT INTO ${schema}.ai_gateway_changes (sequence,kind,resource_type,resource_id,resource,changed_at) VALUES ($1,'upsert',$2,$3,$4,now())`,[n.rows[0].sequence,resourceType,resourceId,JSON.stringify(resource)]);
        }
        async function audit(client:PoolClient,actor:AuditActor,action:string,targetType:string,targetId:string,details?:Record<string,unknown>):Promise<void>{ await insertAuditEntry(client,{organizationId:context.organizationId,actorUserId:actor.userId,actorExternalSubject:actor.externalSubject,action,targetType,targetId,details}); }

        const repository: TenantAiGatewayRepository = {
            context,
            upsertProviderTenantSettings: (input,actor)=>tx(async client=>{
                const r=await client.query(`INSERT INTO ${schema}.ai_provider_tenant_settings (provider_model_id,enabled,phi_allowed,allowed_roles,approved_by_user_id,approved_at,notes) VALUES ($1,$2,$3,$4,$5,now(),$6) ON CONFLICT (provider_model_id) DO UPDATE SET enabled=EXCLUDED.enabled,phi_allowed=EXCLUDED.phi_allowed,allowed_roles=EXCLUDED.allowed_roles,approved_by_user_id=EXCLUDED.approved_by_user_id,approved_at=now(),notes=EXCLUDED.notes RETURNING *`,[input.providerModelId,input.enabled,input.phiAllowed,input.allowedRoles,input.approvedByUserId,input.notes??null]);
                const value=settings(r.rows[0]); await audit(client,actor,"aiProviderTenantSettings.upsert","aiProviderTenantSettings",value.id,{providerModelId:input.providerModelId,enabled:input.enabled,phiAllowed:input.phiAllowed}); return value;
            }),
            getProviderTenantSettings: providerModelId=>read(async c=>{const r=await c.query(`SELECT * FROM ${schema}.ai_provider_tenant_settings WHERE provider_model_id=$1`,[providerModelId]);return r.rows[0]?settings(r.rows[0]):null;}),
            listProviderTenantSettings: ()=>read(async c=>(await c.query(`SELECT * FROM ${schema}.ai_provider_tenant_settings ORDER BY approved_at DESC,id`)).rows.map(settings)),

            createConsent: (input:CreateAiConsentInput,actor)=>tx(async client=>{
                await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${context.organizationId}:ai-consent:${input.patientCaseId}`]);
                const v=await client.query<{version:number}>(`SELECT COALESCE(MAX(version),0)+1 AS version FROM ${schema}.ai_consents WHERE patient_case_id=$1`,[input.patientCaseId]);
                const r=await client.query(`INSERT INTO ${schema}.ai_consents (patient_case_id,version,purpose,data_categories,status,granted_by_user_id,granted_at,expires_at) VALUES ($1,$2,$3,$4,'active',$5,now(),$6) RETURNING *`,[input.patientCaseId,v.rows[0].version,input.purpose,input.dataCategories,input.grantedByUserId,input.expiresAt?new Date(input.expiresAt):null]);
                const value=consent(r.rows[0]); await nextChange(client,"consent",value.id,value); await audit(client,actor,"aiConsent.create","aiConsent",value.id,{patientCaseId:input.patientCaseId,purpose:input.purpose,version:value.version}); return value;
            }),
            getConsent:id=>read(async c=>{const r=await c.query(`SELECT * FROM ${schema}.ai_consents WHERE id=$1`,[id]);return r.rows[0]?consent(r.rows[0]):null;}),
            getActiveConsent:(patientCaseId,purpose)=>read(async c=>{const r=await c.query(`SELECT * FROM ${schema}.ai_consents WHERE patient_case_id=$1 AND purpose=$2 AND status='active' AND (expires_at IS NULL OR expires_at>now()) ORDER BY version DESC LIMIT 1`,[patientCaseId,purpose]);return r.rows[0]?consent(r.rows[0]):null;}),
            listConsentsForCase:patientCaseId=>read(async c=>(await c.query(`SELECT * FROM ${schema}.ai_consents WHERE patient_case_id=$1 ORDER BY version DESC`,[patientCaseId])).rows.map(consent)),
            revokeConsent:(id,revokedByUserId,reason,actor)=>tx(async client=>{
                const r=await client.query(`UPDATE ${schema}.ai_consents SET status='revoked',revoked_by_user_id=$2,revoked_at=now(),revoked_reason=$3 WHERE id=$1 AND status<>'revoked' RETURNING *`,[id,revokedByUserId,reason]);
                if(!r.rows[0]){const same=await client.query(`SELECT * FROM ${schema}.ai_consents WHERE id=$1`,[id]);return same.rows[0]?consent(same.rows[0]):null;}
                const value=consent(r.rows[0]);await nextChange(client,"consent",id,value);await audit(client,actor,"aiConsent.revoke","aiConsent",id,{reason});return value;
            }),
            expireStaleConsents:now=>tx(async client=>{
                const r=await client.query(`UPDATE ${schema}.ai_consents SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=$1 RETURNING *`,[new Date(now)]);
                for(const row of r.rows){const value=consent(row);await nextChange(client,"consent",value.id,value);} return r.rowCount??0;
            }),

            createRequest:(input:CreateAiRequestInput,actor)=>tx(async client=>{
                const r=await client.query(`INSERT INTO ${schema}.ai_requests (patient_case_id,requested_by_user_id,provider_model_id,purpose_of_use,consent_id,policy_snapshot_hash,data_scope,deidentification_applied,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9) RETURNING *`,[input.patientCaseId,input.requestedByUserId,input.providerModelId,input.purposeOfUse,input.consentId,input.policySnapshotHash,JSON.stringify(input.dataScope),input.deidentificationApplied??false,new Date(input.expiresAt)]);
                const value=request(r.rows[0]);await nextChange(client,"request",value.id,value);await audit(client,actor,"aiRequest.create","aiRequest",value.id,{patientCaseId:input.patientCaseId,providerModelId:input.providerModelId,purposeOfUse:input.purposeOfUse});return value;
            }),
            getRequest:id=>read(async c=>{const r=await c.query(`SELECT * FROM ${schema}.ai_requests WHERE id=$1`,[id]);return r.rows[0]?request(r.rows[0]):null;}),
            listRequestsForCase:patientCaseId=>read(async c=>(await c.query(`SELECT * FROM ${schema}.ai_requests WHERE patient_case_id=$1 ORDER BY created_at DESC,id`,[patientCaseId])).rows.map(request)),
            updateRequestStatus:(id,status,extra,actor)=>tx(async client=>{
                const r=await client.query(`UPDATE ${schema}.ai_requests SET status=$2,rejection_reason=COALESCE($3,rejection_reason),completed_at=COALESCE($4,completed_at) WHERE id=$1 RETURNING *`,[id,status,extra?.rejectionReason??null,extra?.completedAt?new Date(extra.completedAt):null]);if(!r.rows[0])return null;
                const value=request(r.rows[0]);await nextChange(client,"request",id,value);await audit(client,actor,"aiRequest.statusChange","aiRequest",id,{status});return value;
            }),
            addRequestInputs:(requestId,inputs)=>tx(async client=>{const values:AiRequestInput[]=[];for(const input of inputs){const r=await client.query(`INSERT INTO ${schema}.ai_request_inputs (request_id,resource_type,resource_id,resource_version_hash,included_in_prompt) VALUES ($1,$2,$3,$4,$5) RETURNING *`,[requestId,input.resourceType,input.resourceId,input.resourceVersionHash??null,input.includedInPrompt]);values.push(requestInput(r.rows[0]));}return values;}),
            listRequestInputs:requestId=>read(async c=>(await c.query(`SELECT * FROM ${schema}.ai_request_inputs WHERE request_id=$1 ORDER BY id`,[requestId])).rows.map(requestInput)),
            recordTransformation:input=>tx(async client=>{const r=await client.query(`INSERT INTO ${schema}.ai_data_transformations (request_id,kind,applied_at,details) VALUES ($1,$2,now(),$3) RETURNING *`,[input.requestId,input.kind,input.details?JSON.stringify(input.details):null]);return transformation(r.rows[0]);}),
            listTransformations:requestId=>read(async c=>(await c.query(`SELECT * FROM ${schema}.ai_data_transformations WHERE request_id=$1 ORDER BY applied_at,id`,[requestId])).rows.map(transformation)),

            createOutput:(input:CreateAiOutputInput,actor)=>tx(async client=>{
                const r=await client.query(`INSERT INTO ${schema}.ai_outputs (request_id,provider_model_id,model_version,prompt_version,summary,evidence,uncertainty,follow_up,abstained,abstain_reason,confidence,output_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[input.requestId,input.providerModelId,input.modelVersion,input.promptVersion,input.summary,input.evidence,input.uncertainty??null,input.followUp,input.abstained,input.abstainReason??null,input.confidence??null,input.outputHash]);
                const value=output(r.rows[0]);const citations:AiCitation[]=[];for(const item of input.citations){const cr=await client.query(`INSERT INTO ${schema}.ai_citations (output_id,resource_type,resource_id,resource_version_hash,locator) VALUES ($1,$2,$3,$4,$5) RETURNING *`,[value.id,item.resourceType,item.resourceId,item.resourceVersionHash??null,item.locator??null]);citations.push(citation(cr.rows[0]));}
                await nextChange(client,"output",value.id,value);await audit(client,actor,"aiOutput.create","aiOutput",value.id,{requestId:input.requestId,abstained:input.abstained,citationCount:citations.length});return {output:value,citations};
            }),
            getOutput:id=>read(async c=>{const r=await c.query(`SELECT * FROM ${schema}.ai_outputs WHERE id=$1`,[id]);return r.rows[0]?output(r.rows[0]):null;}),
            listOutputsForRequest:requestId=>read(async c=>(await c.query(`SELECT * FROM ${schema}.ai_outputs WHERE request_id=$1 ORDER BY generated_at,id`,[requestId])).rows.map(output)),
            // No index on (provider_model_id, generated_at) exists yet
            // (migration 018 only indexes ai_outputs(request_id) — this
            // query pattern is new, added for the production quality
            // monitor). Correct as-is; a real deployment with enough output
            // volume for this scan to matter should add one via a new
            // migration re-running provision_tenant_ai_gateway_tables's own
            // backfill pattern — not done here since this store has never
            // run against a live Postgres in this environment to verify
            // against (see docs/reference on local dev constraints).
            listOutputsForProviderModel:(providerModelId,since)=>read(async c=>(await c.query(`SELECT * FROM ${schema}.ai_outputs WHERE provider_model_id=$1${since?" AND generated_at>$2":""} ORDER BY generated_at,id`,since?[providerModelId,new Date(since)]:[providerModelId])).rows.map(output)),
            listCitationsForOutput:outputId=>read(async c=>(await c.query(`SELECT * FROM ${schema}.ai_citations WHERE output_id=$1 ORDER BY id`,[outputId])).rows.map(citation)),
            createReview:(input,actor)=>tx(async client=>{
                try {
                    const r=await client.query(`INSERT INTO ${schema}.ai_reviews (output_id,reviewed_by_user_id,decision,corrected_text,escalation_reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,[input.outputId,input.reviewedByUserId,input.decision,input.correctedText??null,input.escalationReason??null]);
                    const value=review(r.rows[0]);await client.query(`UPDATE ${schema}.ai_outputs SET review_status=$2 WHERE id=$1`,[input.outputId,input.decision]);await nextChange(client,"review",value.id,value);await audit(client,actor,"aiReview.create","aiReview",value.id,{outputId:input.outputId,decision:input.decision});return value;
                } catch(error){if((error as {code?:string}).code==="23505")throw new Error(`Output ${input.outputId} already has a review — reviews are immutable; create a new output/request to amend.`);throw error;}
            }),
            getReviewForOutput:outputId=>read(async c=>{const r=await c.query(`SELECT * FROM ${schema}.ai_reviews WHERE output_id=$1`,[outputId]);return r.rows[0]?review(r.rows[0]):null;}),
            recordSafetyEvent:(input,actor)=>tx(async client=>{const r=await client.query(`INSERT INTO ${schema}.ai_safety_events (request_id,kind,severity,details) VALUES ($1,$2,$3,$4) RETURNING *`,[input.requestId??null,input.kind,input.severity,input.details??null]);const value=safetyEvent(r.rows[0]);await audit(client,actor,"aiSafetyEvent.record","aiSafetyEvent",value.id,{kind:input.kind,severity:input.severity,requestId:input.requestId});return value;}),
            listSafetyEvents:filter=>read(async c=>{const clauses:string[]=[];const params:unknown[]=[];if(filter?.requestId){params.push(filter.requestId);clauses.push(`request_id=$${params.length}`);}if(filter?.severity){params.push(filter.severity);clauses.push(`severity=$${params.length}`);}const r=await c.query(`SELECT * FROM ${schema}.ai_safety_events${clauses.length?` WHERE ${clauses.join(" AND ")}`:""} ORDER BY created_at DESC,id`,params);return r.rows.map(safetyEvent);}),
            readChanges:cursor=>tx(async client=>{const high=await client.query<{value:string}>(`SELECT next_sequence-1 AS value FROM ${schema}.ai_gateway_change_counter WHERE singleton=TRUE`);const max=high.rows[0]?.value??"0";const since=cursor??"0";const rows=await client.query<{sequence:string;kind:"upsert"|"delete";resource_type:AiGatewayChange["resourceType"];resource_id:string;changed_at:Date}>(`SELECT sequence,kind,resource_type,resource_id,changed_at FROM ${schema}.ai_gateway_changes WHERE sequence>$1 AND sequence<=$2 ORDER BY sequence`,[since,max]);return {changes:rows.rows.map(r=>({change:{kind:r.kind,resourceType:r.resource_type,resourceId:r.resource_id,sequence:Number(r.sequence),occurredAt:r.changed_at.toISOString()}})),cursor:max};},true),
        };
        return Object.freeze(repository);
    }
}
