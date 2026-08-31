import { randomUUID } from "node:crypto";
import type { AiCitation, AiConsent, AiDataTransformation, AiOutput, AiProvider, AiProviderModel, AiRequestEnvelope, AiReview, DeidentificationJob } from "@modelforge/contracts";
import { authorizedRequest, SharedBackendClientError } from "./shared-backend-client";
import { getSharedBackendConfig } from "./shared-backend-config-store";

export interface ClinicalAiModelOption { provider: AiProvider; model: AiProviderModel; enabled: boolean; phiAllowed: boolean; }
export interface ClinicalAiImagingOption { studyId: string; modalities: string[]; numberOfSeries: number; numberOfInstances: number; job: DeidentificationJob; }
export interface ClinicalAiRequestDetail {
    request: AiRequestEnvelope;
    inputs: Array<{ id: string; requestId: string; resourceType: string; resourceId: string; includedInPrompt: boolean }>;
    transformations: AiDataTransformation[];
    outputs: Array<{ output: AiOutput; citations: AiCitation[]; review: AiReview | null }>;
}
export interface ClinicalAiSubmitInput {
    providerModelId: string;
    purposeOfUse: AiRequestEnvelope["purposeOfUse"];
    requestedCategories: string[];
    selectedDeidentificationJobIds: string[];
    maxTokens?: number;
}

function organizationId(): string { const id=getSharedBackendConfig()?.organizationId; if(!id) throw new SharedBackendClientError("Select a shared-backend organization before using Clinical AI."); return id; }
async function json<T>(response:Response,action:string):Promise<T>{if(!response.ok){let detail=`HTTP ${response.status}`;try{const body=await response.json() as {message?:string;error?:string};detail=body.message??body.error??detail;}catch{}throw new SharedBackendClientError(`${action} failed: ${detail}`);}return response.json() as Promise<T>;}
function path(value:string):string{return encodeURIComponent(value);}

export async function listClinicalAiModels():Promise<ClinicalAiModelOption[]>{
    const org=organizationId();
    const {providers}=await json<{providers:AiProvider[]}>(await authorizedRequest(`/organizations/${path(org)}/ai-providers`),"Loading AI providers");
    const rows=await Promise.all(providers.map(async provider=>{
        const {models}=await json<{models:AiProviderModel[]}>(await authorizedRequest(`/organizations/${path(org)}/ai-providers/${path(provider.id)}/models`),"Loading AI models");
        return Promise.all(models.map(async model=>{
            const response=await authorizedRequest(`/organizations/${path(org)}/ai-provider-models/${path(model.id)}/tenant-settings`);
            const setting=response.status===404?null:await json<{enabled:boolean;phiAllowed:boolean}|null>(response,"Loading model approval");
            return {provider,model,enabled:setting?.enabled??false,phiAllowed:setting?.phiAllowed??false};
        }));
    }));
    return rows.flat().filter(item=>item.enabled&&item.provider.operationalStatus==="active"&&!item.provider.killSwitchEngaged&&!item.model.retiredAt&&item.model.safetyStatus!=="disabled");
}

export async function listClinicalAiConsents(caseId:string):Promise<AiConsent[]>{const org=organizationId();return (await json<{consents:AiConsent[]}>(await authorizedRequest(`/organizations/${path(org)}/cases/${path(caseId)}/ai-consents`),"Loading AI consents")).consents;}
export async function createClinicalAiConsent(caseId:string,input:{purpose:AiConsent["purpose"];dataCategories:string[];expiresAt?:string}):Promise<AiConsent>{const org=organizationId();return json(await authorizedRequest(`/organizations/${path(org)}/cases/${path(caseId)}/ai-consents`,{method:"POST",body:JSON.stringify(input)}),"Creating AI consent");}
export async function revokeClinicalAiConsent(caseId:string,consentId:string,reason:string):Promise<AiConsent>{const org=organizationId();return json(await authorizedRequest(`/organizations/${path(org)}/cases/${path(caseId)}/ai-consents/${path(consentId)}/revoke`,{method:"POST",body:JSON.stringify({reason})}),"Revoking AI consent");}
export async function listClinicalAiImagingOptions(caseId:string):Promise<ClinicalAiImagingOption[]>{const org=organizationId();return (await json<{options:ClinicalAiImagingOption[]}>(await authorizedRequest(`/organizations/${path(org)}/cases/${path(caseId)}/ai-imaging-options`),"Loading approved imaging options")).options;}
export async function previewClinicalAiRequest(caseId:string,input:ClinicalAiSubmitInput):Promise<unknown>{const org=organizationId();return json(await authorizedRequest(`/organizations/${path(org)}/cases/${path(caseId)}/ai-requests/preview`,{method:"POST",body:JSON.stringify(input)}),"Previewing AI request");}
export async function submitClinicalAiRequest(caseId:string,input:ClinicalAiSubmitInput):Promise<unknown>{const org=organizationId();return json(await authorizedRequest(`/organizations/${path(org)}/cases/${path(caseId)}/ai-requests`,{method:"POST",headers:{"Idempotency-Key":randomUUID()},body:JSON.stringify(input)}),"Submitting AI request");}
export async function listClinicalAiActivity(caseId:string):Promise<ClinicalAiRequestDetail[]>{const org=organizationId();const {requests}=await json<{requests:AiRequestEnvelope[]}>(await authorizedRequest(`/organizations/${path(org)}/cases/${path(caseId)}/ai-requests`),"Loading AI activity");return Promise.all(requests.map(async request=>json<ClinicalAiRequestDetail>(await authorizedRequest(`/organizations/${path(org)}/ai-requests/${path(request.id)}`),"Loading AI request details")));}
export async function reviewClinicalAiOutput(outputId:string,input:{decision:AiReview["decision"];correctedText?:string;escalationReason?:string}):Promise<AiReview>{const org=organizationId();return json(await authorizedRequest(`/organizations/${path(org)}/ai-outputs/${path(outputId)}/review`,{method:"POST",body:JSON.stringify(input)}),"Recording clinician review");}
