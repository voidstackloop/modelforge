import { describe,expect,it,vi } from "vitest";
import type { Pool } from "pg";
import { PostgresAiGatewayStore } from "./postgres-ai-gateway-store.js";
import { PostgresAiProviderRegistryStore } from "./postgres-ai-provider-registry-store.js";

vi.mock("./audit-store.js",async()=>{const actual=await vi.importActual<typeof import("./audit-store.js")>("./audit-store.js");return {...actual,insertAuditEntry:vi.fn(async()=>{})};});

const tenant={organizationId:"11111111-1111-4111-8111-111111111111",schemaName:"tenant_11111111111141118111111111111111",issuer:"test",subject:"test"};

describe("Postgres clinical AI stores",()=>{
    it("binds every tenant read to the validated tenant schema and transaction context",async()=>{
        const queries:Array<{text:string;values?:unknown[]}>=[];
        const client={query:vi.fn(async(text:string,values?:unknown[])=>{queries.push({text,values});if(text.includes("FROM \"tenant_11111111111141118111111111111111\".ai_consents"))return {rows:[{id:"22222222-2222-4222-8222-222222222222",patient_case_id:"case-1",version:1,purpose:"treatment",data_categories:["medications"],status:"active",granted_by_user_id:"33333333-3333-4333-8333-333333333333",granted_at:new Date("2026-01-01T00:00:00Z"),expires_at:null,revoked_by_user_id:null,revoked_at:null,revoked_reason:null}]};return {rows:[]};}),release:vi.fn()};
        const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
        const value=await new PostgresAiGatewayStore(pool).forTenant(tenant).getConsent("22222222-2222-4222-8222-222222222222");
        expect(value?.patientCaseId).toBe("case-1");expect(queries.some(q=>q.text.includes("set_config('app.tenant_id'")&&q.values?.[0]===tenant.organizationId)).toBe(true);expect(queries.some(q=>q.text.includes(tenant.schemaName)&&q.text.includes(".ai_consents"))).toBe(true);expect(client.release).toHaveBeenCalled();
    });
    it("rejects an untrusted dynamic schema identifier before querying",()=>{const pool={connect:vi.fn()} as unknown as Pool;expect(()=>new PostgresAiGatewayStore(pool).forTenant({...tenant,schemaName:'tenant_safe";DROP SCHEMA public;--'})).toThrow("Unsafe tenant schema identifier");expect(pool.connect).not.toHaveBeenCalled();});
    it("maps a durable provider create result",async()=>{
        const now=new Date("2026-01-01T00:00:00Z");const client={query:vi.fn(async(text:string)=>text.startsWith("INSERT INTO public.ai_providers")?{rows:[{id:"44444444-4444-4444-8444-444444444444",name:"Local",kind:"local",kill_switch_engaged:false,kill_switch_reason:null,operational_status:"active",created_at:now,updated_at:now}]}:{rows:[]}),release:vi.fn()};const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
        const value=await new PostgresAiProviderRegistryStore(pool).createProvider({name:"Local",kind:"local"},{externalSubject:"idp|admin"});expect(value).toMatchObject({name:"Local",killSwitchEngaged:false,operationalStatus:"active"});expect(client.query).toHaveBeenCalledWith("COMMIT");expect(client.release).toHaveBeenCalled();
    });
});
