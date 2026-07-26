import * as path from "node:path";
import * as ollama from "./ollama-manager";
import * as settingsStore from "./settings-store";
import * as secretsStore from "./secrets-store";
import * as llamacpp from "./llamacpp-manager";
import * as localServers from "./local-server-manager";
import * as powerMonitor from "./power-monitor";
import * as openaiProvider from "./providers/openai";
import * as anthropicProvider from "./providers/anthropic";
import * as geminiProvider from "./providers/gemini";
import { createOpenAiCompatibleChat } from "./providers/openai-compatible";
import type { ChatMessage, ChatChunk, ChatOptions, ProviderId, ToolDefinition } from "./providers/types";
import { PROVIDER_SECRET_KEYS, customProviderSecretKey, getLlamaCppModelsDir, getEnergyMonitorSettings } from "./app-state";

// Shared by chat:send (renderer-driven, streams tokens back over IPC) and
// the scheduled-task runner (background, wants the full text once done) —
// same provider dispatch and error handling either way.
export async function dispatchChat(
    provider: ProviderId,
    model: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal,
    tools?: ToolDefinition[]
): Promise<void> {
    const currentSettings = settingsStore.getSettings();
    const customLocal = provider === "custom"
        && currentSettings.customProviders?.find((item) => model.startsWith(`${item.id}::`))?.localGpuBackend;
    const localProvider = ["ollama", "llamacpp", "mlx", "rocm", "vllm"].includes(provider) || !!customLocal;
    const energySettings = getEnergyMonitorSettings();
    energySettings.enabled = energySettings.enabled && localProvider;
    const backend = provider === "llamacpp"
        ? currentSettings.llamaCppGpuBackend ?? "auto"
        : provider === "rocm" ? "rocm" : provider;
    const initialPromptTokens = Math.max(1, Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4));
    const activity = powerMonitor.beginRequest(provider, model, backend, energySettings, initialPromptTokens);
    const downstreamToken = onToken;
    onToken = (chunk) => {
        activity.onChunk(chunk);
        downstreamToken(chunk);
    };
    try {
    if (provider === "ollama") {
        await ollama.chat(model, messages, options, onToken, signal, tools);
    } else if (provider === "llamacpp") {
        // Same containment rule as the rocm branch below: the model ref is a
        // renderer-supplied relative path (may include subfolders), and
        // path.join would happily walk ".." segments out of the models dir.
        const root = path.resolve(getLlamaCppModelsDir());
        const modelPath = path.resolve(root, model);
        if (modelPath === root || !modelPath.startsWith(root + path.sep)) {
            throw new Error(`Model file "${model}" is outside the models directory.`);
        }
        await llamacpp.chat(modelPath, messages, options, onToken, signal, tools);
    } else if (provider === "mlx" || provider === "rocm" || provider === "vllm") {
        const settings = settingsStore.getSettings();
        // ROCm serves the same GGUF files as the llama.cpp backend, so the
        // model ref is a filename that must stay inside the models dir; MLX
        // models are HF repo ids the server resolves itself.
        let serverModel = model;
        if (provider === "rocm") {
            const root = path.resolve(getLlamaCppModelsDir());
            const resolved = path.resolve(root, model);
            // Was `resolved !== root && !startsWith(...)` (AND) — that only
            // threw when BOTH conditions held, so a ref resolving to exactly
            // the models dir itself (e.g. "rocm:.") satisfied neither and
            // slipped through, handing the whole directory to llama-server
            // -m as if it were a single model file.
            if (resolved === root || !resolved.startsWith(root + path.sep)) {
                throw new Error(`Model file "${model}" is outside the models directory.`);
            }
            serverModel = resolved;
        }
        const lease = await localServers.acquireServer(provider, serverModel, {
            mlxPythonPath: settings.mlxPythonPath,
            rocmServerPath: settings.rocmServerPath,
            vllmCommand: settings.vllmCommand,
        });
        try {
            // Managed runtimes are local and unauthenticated; the key is a
            // compatibility placeholder for their OpenAI-shaped APIs.
            const providerLabel = provider === "mlx" ? "MLX" : provider === "vllm" ? "vLLM" : "ROCm llama-server";
            await createOpenAiCompatibleChat(`${lease.baseUrl}/v1`, providerLabel)(
                "local",
                model,
                messages,
                options,
                onToken,
                signal,
                tools
            );
        } finally {
            lease.release();
        }
    } else if (provider === "custom") {
        // model is "<customProviderId>::<actual model id>" — see
        // frontend/src/lib/providers.ts's formatCustomModelRef.
        const sep = model.indexOf("::");
        if (sep === -1) throw new Error(`Malformed custom model reference: ${model}`);
        const customProviderId = model.slice(0, sep);
        const actualModel = model.slice(sep + 2);
        const config = settingsStore.getSettings().customProviders?.find((p) => p.id === customProviderId);
        if (!config) throw new Error(`Custom provider "${customProviderId}" is no longer configured.`);
        const apiKey = secretsStore.getSecret(customProviderSecretKey(customProviderId));
        if (!apiKey && !config.localGpuBackend) throw new Error(`No API key set for ${config.name}. Add one in Settings.`);
        await createOpenAiCompatibleChat(config.baseUrl, config.name)(
            apiKey ?? "local-gpu-backend",
            actualModel,
            messages,
            options,
            onToken,
            signal,
            tools
        );
    } else {
        const secretKey = PROVIDER_SECRET_KEYS[provider];
        const apiKey = secretsStore.getSecret(secretKey);
        if (!apiKey) throw new Error(`No API key set for ${provider}. Add one in Settings.`);
        const providerFn =
            provider === "openai" ? openaiProvider.chat : provider === "anthropic" ? anthropicProvider.chat : geminiProvider.chat;
        await providerFn(apiKey, model, messages, options, onToken, signal, tools);
    }
    } finally {
        await activity.finish();
    }
}

// Runs a single-turn prompt to completion and returns the full text —
// what the scheduled-task runner needs, as opposed to chat:send's
// token-by-token streaming back to the renderer.
export async function completePrompt(provider: ProviderId, model: string, prompt: string): Promise<string> {
    let text = "";
    await dispatchChat(provider, model, [{ role: "user", content: prompt }], undefined, (chunk) => {
        text += chunk.message?.content ?? "";
    });
    return text;
}
