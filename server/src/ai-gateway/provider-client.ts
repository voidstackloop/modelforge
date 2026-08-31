import { readFileSync } from "node:fs";
import type { AiInferenceDeployment, AiModelArtifact } from "@modelforge/contracts";
import type { AiProviderRegistryStore } from "../store/ai-provider-registry-store.js";

/**
 * ClinicalAiGateway's only boundary to an actual model. Every adapter here
 * receives exactly a `AiProviderInvocationRequest` — already minimized,
 * already redacted, already content-scanned by the gateway
 * (server/src/ai-gateway/gateway.ts) — and nothing else. No adapter is ever
 * handed a database handle, a tenant credential, a permanent object URL, or
 * unrestricted DICOMweb access; that is the whole point of routing every
 * model call through this one interface instead of letting a route or a
 * plugin reach a provider directly.
 */

export interface AiProviderInvocationRequest {
    systemPrompt?: string;
    sections: Array<{ category: string; text: string }>;
    purposeOfUse: string;
    maxTokens?: number;
    signal?: AbortSignal;
    tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean } }>;
    responseFormat?: { type: "json_object" } | { type: "json_schema"; json_schema: Record<string, unknown> };
}

export interface AiProviderInvocationResponse {
    rawText: string;
    modelVersion: string;
    usage?: { promptTokens?: number; completionTokens?: number };
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface AiProviderEmbeddingResponse { vectors: number[][]; modelVersion: string }

export interface AiProviderClient {
    invoke(request: AiProviderInvocationRequest): Promise<AiProviderInvocationResponse>;
    healthCheck(): Promise<boolean>;
    embed?(input: string | string[]): Promise<AiProviderEmbeddingResponse>;
}

function composePrompt(request: AiProviderInvocationRequest): string {
    const body = request.sections.map((s) => `### ${s.category}\n${s.text}`).join("\n\n");
    return request.systemPrompt ? `${request.systemPrompt}\n\n${body}` : body;
}

function authorization(apiKey: string): Record<string, string> { return { Authorization: `Bearer ${apiKey}` }; }

function modelIdentityMatches(payload: unknown, expected: string): boolean {
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) return false;
    return ((payload as { data: Array<{ id?: unknown }> }).data).some((item) => String(item.id ?? "") === expected);
}

/** Provider-neutral OpenAI-compatible client used for authenticated vLLM
 * and llama-server deployments. It never logs or returns provider response
 * bodies on errors because those bodies may echo clinical input. */
export class OpenAiCompatibleInferenceClient implements AiProviderClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly modelId: string,
        private readonly modelVersion: string,
        private readonly timeoutMs = 10 * 60_000
    ) {
        const url = new URL(baseUrl);
        if (!url.pathname.endsWith("/v1") && !url.pathname.endsWith("/v1/")) throw new Error("Inference endpoint must end with /v1");
        if (!apiKey) throw new Error("Inference endpoint credential resolved to an empty value");
    }

    async invoke(request: AiProviderInvocationRequest): Promise<AiProviderInvocationResponse> {
        const messages = [
            ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
            { role: "user", content: composePrompt({ ...request, systemPrompt: undefined }) },
        ];
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authorization(this.apiKey) },
            body: JSON.stringify({ model: this.modelId, messages, stream: false, max_tokens: request.maxTokens, tools: request.tools, response_format: request.responseFormat }),
            signal,
            redirect: "error",
        });
        if (!response.ok) throw new Error(`Inference provider returned HTTP ${response.status}`);
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const message = data.choices?.[0]?.message;
        return {
            rawText: message?.content ?? "",
            modelVersion: this.modelVersion,
            usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
            toolCalls: message?.tool_calls?.map((call) => ({ id: call.id ?? "", name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" })),
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, { headers: authorization(this.apiKey), signal: AbortSignal.timeout(5_000), redirect: "error" });
            return response.ok && modelIdentityMatches(await response.json(), this.modelId);
        } catch {
            return false;
        }
    }

    async embed(input: string | string[]): Promise<AiProviderEmbeddingResponse> {
        const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
            method: "POST", headers: { "Content-Type": "application/json", ...authorization(this.apiKey) },
            body: JSON.stringify({ model: this.modelId, input }), signal: AbortSignal.timeout(this.timeoutMs), redirect: "error",
        });
        if (!response.ok) throw new Error(`Inference embedding provider returned HTTP ${response.status}`);
        const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
        const vectors = payload.data?.map((item) => item.embedding).filter((value): value is number[] => Array.isArray(value)) ?? [];
        const expected = Array.isArray(input) ? input.length : 1;
        if (vectors.length !== expected || vectors.some((vector) => vector.length === 0 || vector.some((value) => !Number.isFinite(value)))) throw new Error("Inference provider returned an invalid embedding response");
        return { vectors, modelVersion: this.modelVersion };
    }
}

export function resolveCredentialReference(reference: string, env: NodeJS.ProcessEnv = process.env): string {
    if (reference.startsWith("env:")) {
        const name = reference.slice(4);
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("Invalid inference credential environment reference");
        const value = env[name]?.trim();
        if (!value) throw new Error(`Inference credential ${name} is not configured`);
        return value;
    }
    if (reference.startsWith("file:/")) {
        const filePath = reference.slice(5);
        if (!filePath.startsWith("/") || filePath.includes("..")) throw new Error("Invalid inference credential file reference");
        const value = readFileSync(filePath, { encoding: "utf8" }).trim();
        if (!value || value.length > 16_384) throw new Error("Inference credential file is empty or too large");
        return value;
    }
    throw new Error("Inference credentials must use env:NAME or file:/absolute/path references");
}

export function clientForDeployment(deployment: AiInferenceDeployment, artifact: AiModelArtifact, modelVersion: string, env: NodeJS.ProcessEnv = process.env): OpenAiCompatibleInferenceClient {
    if (artifact.status !== "verified" || !artifact.licenseAccepted) throw new Error("Inference artifact is not verified and licensed");
    if (deployment.operationalStatus !== "active") throw new Error("Inference deployment is not active");
    const url = new URL(deployment.endpointUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error("Inference endpoint URLs cannot contain credentials, query parameters, or fragments");
    const allowlist = new Set((env.MODELFORGE_INFERENCE_HOST_ALLOWLIST ?? "localhost,127.0.0.1,::1,llama-server,vllm-nvidia,vllm-rocm")
        .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
    if (!allowlist.has(url.hostname.toLowerCase())) throw new Error(`Inference endpoint host ${url.hostname} is not in MODELFORGE_INFERENCE_HOST_ALLOWLIST`);
    if (deployment.tlsMode === "required" && url.protocol !== "https:") throw new Error("TLS-required inference deployment is not HTTPS");
    if (deployment.tlsMode === "private-network" && url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Private inference deployment must use HTTP or HTTPS");
    return new OpenAiCompatibleInferenceClient(deployment.endpointUrl, resolveCredentialReference(deployment.credentialRef, env), deployment.servedModelName, modelVersion);
}

export function createRegistryProviderResolver(registry: AiProviderRegistryStore, env: NodeJS.ProcessEnv = process.env) {
    return async (_provider: unknown, providerModel: { id: string; modelVersion: string }): Promise<AiProviderClient> => {
        const artifacts = await registry.listModelArtifacts({ providerModelId: providerModel.id, status: "verified" });
        for (const artifact of artifacts) {
            if (!artifact.licenseAccepted) continue;
            const deployments = await registry.listInferenceDeployments({ artifactId: artifact.id, operationalStatus: "active" });
            const selected = deployments[0];
            if (selected) return clientForDeployment(selected, artifact, providerModel.modelVersion, env);
        }
        throw new Error(`No verified active inference deployment is configured for provider model ${providerModel.id}`);
    };
}

/**
 * The "cloud"/"tenant-managed" provider kind — a generic OpenAI-chat-
 * completions-shaped adapter (the wire format the overwhelming majority of
 * approved-cloud-provider and self-hosted-gateway products speak). Built to
 * the real interface and real wire format; **not exercised against a real
 * paid external API in this environment** — no external provider
 * credentials or network egress are available here, exactly the same
 * disclosed-not-tested posture as imaging's own ProxyDicomwebAdapter
 * (server/src/imaging/dicomweb-adapter.ts). `apiKey` is expected to already
 * be a short-lived, scoped credential resolved by the caller (item: "short-
 * lived scoped service credentials") — this adapter never resolves a
 * secret itself, and never logs the key.
 */
export class HttpProviderClient implements AiProviderClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly modelId: string,
        private readonly modelVersion: string
    ) {}

    async invoke(request: AiProviderInvocationRequest): Promise<AiProviderInvocationResponse> {
        const messages = [
            ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
            { role: "user", content: composePrompt({ ...request, systemPrompt: undefined }) },
        ];
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.modelId, messages, max_tokens: request.maxTokens }),
        });
        if (!response.ok) {
            // Never include response body verbatim in the thrown error — a
            // provider error page can itself contain content this system
            // must not surface unfiltered (and must never include the key).
            throw new Error(`Provider returned HTTP ${response.status}`);
        }
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        return {
            rawText: data.choices?.[0]?.message?.content ?? "",
            modelVersion: this.modelVersion,
            usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
            return response.ok;
        } catch {
            return false;
        }
    }
}

/** Deterministic test double — what every gateway-lifecycle unit test
 * exercises instead of a real network call. */
export class TestAiProviderClient implements AiProviderClient {
    public lastRequest: AiProviderInvocationRequest | null = null;

    constructor(private readonly response: AiProviderInvocationResponse | (() => AiProviderInvocationResponse) = { rawText: "Test model output.", modelVersion: "test-1" }) {}

    async invoke(request: AiProviderInvocationRequest): Promise<AiProviderInvocationResponse> {
        this.lastRequest = request;
        return typeof this.response === "function" ? this.response() : this.response;
    }

    async healthCheck(): Promise<boolean> {
        return true;
    }
}
