import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryAiProviderRegistryStore } from "./in-memory-ai-provider-registry-store.js";

const actor = { userId: "user-1", externalSubject: "subject-1" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("inference artifact registry", () => {
    it("keeps immutable artifact identity separate from operational deployment state", async () => {
        const store = new InMemoryAiProviderRegistryStore();
        const provider = await store.createProvider({ name: "On-prem inference", kind: "on-premises" }, actor);
        const model = await store.createProviderModel({ providerId: provider.id, modelId: "approved-model", modelVersion: "1", intendedUse: "Synthetic test", supportedDataTypes: ["text"], maxContextTokens: 4096, hostingRegion: "local", processingLocation: "local" }, actor);
        const artifact = await store.createModelArtifact({ providerModelId: model.id, runtime: "vllm", format: "safetensors", sourceUri: "hf://publisher/model", sourceRevision: "revision", sha256: digest("artifact"), configurationHash: digest("config"), licenseId: "apache-2.0", licenseAccepted: true, capabilities: { chat: true, streaming: true, tools: false, structuredOutput: false, embeddings: false, tokenCounting: true }, trustRemoteCode: false, status: "verified" }, actor);
        const deployment = await store.createInferenceDeployment({ artifactId: artifact.id, name: "GPU pool", endpointUrl: "https://inference.example/v1", servedModelName: "approved-model", credentialRef: "env:INFERENCE_KEY", tlsMode: "required", poolId: "11111111-1111-4111-8111-111111111111", maxConcurrency: 8, priority: 10, operationalStatus: "disabled" }, actor);
        const verified = await store.recordInferenceDeploymentVerification(deployment.id, { healthy: true, runtimeVersion: "0.25.1" }, actor);
        expect(verified).toMatchObject({ artifactId: artifact.id, operationalStatus: "active", runtimeVersion: "0.25.1" });
        await expect(store.listModelArtifacts({ providerModelId: model.id, status: "verified" })).resolves.toEqual([artifact]);
    });
});
