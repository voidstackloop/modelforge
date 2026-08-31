import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRuntimeProbe, buildServerCommand, classifyRuntimeError, describeSpawnFailure, identityMatches, explainStartupFailure, normalizeStartupConfig, parseRuntimeCommandCapabilities, validateRuntimeModel } from "./local-server-manager";
import type { GpuInfo } from "./system-specs";

const nvidia0: GpuInfo = { name: "RTX 4090", vramGB: 24, vendor: "nvidia", id: "nvidia:uuid-0", index: 0 };
const nvidia1: GpuInfo = { name: "RTX 4090", vramGB: 24, vendor: "nvidia", id: "nvidia:uuid-1", index: 1 };
const amd0: GpuInfo = { name: "Radeon RX 7900", vramGB: 24, vendor: "amd", id: "amd:unique-0", index: 0 };

describe("buildServerCommand", () => {
    it("builds an mlx_lm.server invocation with the default python", () => {
        const { command, args } = buildServerCommand("mlx", "mlx-community/Llama-3.2-3B-Instruct-4bit", {}, "darwin", 49151);
        expect(command).toBe("python3");
        expect(args).toContain("mlx_lm.server");
        expect(args).toContain("mlx-community/Llama-3.2-3B-Instruct-4bit");
        expect(args).toContain("--host");
        expect(args).toContain("127.0.0.1");
    });

    it("respects a custom python interpreter path", () => {
        const { command } = buildServerCommand("mlx", "some/model", { mlxPythonPath: "/opt/python/bin/python3.12" }, "darwin", 49151);
        expect(command).toBe("/opt/python/bin/python3.12");
    });

    it("uses advertised automatic memory fitting without encoding Auto as 999 layers", () => {
        const capabilities = parseRuntimeCommandCapabilities("rocm", "--n-gpu-layers --fit --fit-target --ctx-size --threads --flash-attn --tensor-split --split-mode --main-gpu");
        const { command, args } = buildServerCommand("rocm", "/models/llama.gguf", {
            rocmServerPath: "/opt/rocm-llama/llama-server",
        }, "linux", 49152, {}, [], capabilities);
        expect(command).toBe("/opt/rocm-llama/llama-server");
        expect(args).toEqual(expect.arrayContaining(["-m", "/models/llama.gguf", "--fit", "on", "--fit-target", "1024"]));
        expect(args).not.toContain("999");
    });

    it("adds only supported startup arguments", () => {
        const rocm = buildServerCommand("rocm", "/models/llama.gguf", {}, "linux", 49152, { contextLength: 8192, gpuLayers: 42, cpuThreads: 8, flashAttention: true });
        expect(rocm.args).toEqual(expect.arrayContaining(["--ctx-size", "8192", "--n-gpu-layers", "42", "--threads", "8", "--flash-attn", "on"]));
        const vllm = buildServerCommand("vllm", "org/model", {}, "linux", 49153, { contextLength: 16384, gpuMemoryUtilization: 0.8, tensorParallelSize: 2 });
        expect(vllm.args).toEqual(expect.arrayContaining(["--max-model-len", "16384", "--gpu-memory-utilization", "0.8", "--tensor-parallel-size", "2"]));
    });

    it("falls back to PATH lookup when no rocm binary path is configured", () => {
        const { command } = buildServerCommand("rocm", "/models/llama.gguf", {}, "linux", 49152);
        expect(command).toBe("llama-server");
    });

    it("uses the dynamically allocated port supplied to each backend", () => {
        const mlx = buildServerCommand("mlx", "m", {}, "darwin", 49151);
        const rocm = buildServerCommand("rocm", "m", {}, "linux", 49152);
        const vllm = buildServerCommand("vllm", "m", {}, "linux", 49153);
        const portOf = (args: string[]) => args[args.indexOf("--port") + 1];
        expect(portOf(mlx.args)).not.toBe(portOf(rocm.args));
        expect(new Set([portOf(mlx.args), portOf(rocm.args), portOf(vllm.args)]).size).toBe(3);
    });

    it("builds a managed vLLM OpenAI server command", () => {
        const { command, args } = buildServerCommand("vllm", "meta-llama/Llama-3.1-8B-Instruct", {}, "linux", 49153);
        expect(command).toBe("vllm");
        expect(args).toEqual(
            expect.arrayContaining(["serve", "meta-llama/Llama-3.1-8B-Instruct", "--host", "127.0.0.1"])
        );
    });

    it("passes generated credentials through runtime-specific environment variables", () => {
        const vllm = buildServerCommand("vllm", "org/model", {}, "linux", 49153, {}, [], undefined, "vllm-secret");
        const llamacpp = buildServerCommand("rocm", "/models/model.gguf", {}, "linux", 49154, {}, [], undefined, "llama-secret");
        expect(vllm.env).toMatchObject({ VLLM_API_KEY: "vllm-secret" });
        expect(llamacpp.env).toMatchObject({ LLAMA_API_KEY: "llama-secret" });
        expect(vllm.args.join(" ")).not.toContain("vllm-secret");
        expect(llamacpp.args.join(" ")).not.toContain("llama-secret");
    });

    it("allows a vLLM command override without requiring one", () => {
        const { command } = buildServerCommand("vllm", "some/model", { vllmCommand: "/opt/vllm/bin/vllm" }, "linux", 49153);
        expect(command).toBe("/opt/vllm/bin/vllm");
    });

    it("launches vLLM through WSL automatically on Windows", () => {
        const { command, args } = buildServerCommand("vllm", "some/model", {}, "win32", 49153);
        expect(command).toBe("wsl.exe");
        expect(args.slice(0, 4)).toEqual(["--", "vllm", "serve", "some/model"]);
    });

    it("sets no GPU visibility env when no GPUs are resolved (auto/CPU, unchanged behavior)", () => {
        const { env } = buildServerCommand("vllm", "org/model", {}, "linux", 49153, {}, []);
        expect(env).toEqual({});
    });

    it("builds CUDA_VISIBLE_DEVICES for a resolved multi-GPU vLLM selection", () => {
        const { env, args } = buildServerCommand("vllm", "org/model", {}, "linux", 49153, { tensorParallelSize: 2 }, [nvidia0, nvidia1]);
        expect(env).toEqual({ CUDA_VISIBLE_DEVICES: "uuid-0,uuid-1" });
        expect(args).toEqual(expect.arrayContaining(["--tensor-parallel-size", "2"]));
    });

    it("rejects a vLLM tensor-parallel size larger than the resolved GPU group", () => {
        expect(() => buildServerCommand("vllm", "org/model", {}, "linux", 49153, { tensorParallelSize: 4 }, [nvidia0, nvidia1])).toThrow(/exceeds/);
    });

    it("rejects a mixed NVIDIA+AMD selection for vLLM", () => {
        expect(() => buildServerCommand("vllm", "org/model", {}, "linux", 49153, {}, [nvidia0, amd0])).toThrow(/vendor/);
    });

    it("adds --tensor-split/--split-mode/--main-gpu for a multi-GPU ROCm llama-server selection", () => {
        const { args, env } = buildServerCommand("rocm", "/models/llama.gguf", {}, "linux", 49152, { splitMode: "tensor", mainGpuId: "nvidia:uuid-1" }, [nvidia0, nvidia1]);
        expect(env).toEqual({ CUDA_VISIBLE_DEVICES: "uuid-0,uuid-1" });
        expect(args).toContain("--tensor-split");
        expect(args[args.indexOf("--tensor-split") + 1].split(",")).toHaveLength(2);
        expect(args).toEqual(expect.arrayContaining(["--split-mode", "row", "--main-gpu", "1"]));
    });

    it("auto-generates a VRAM-proportional tensor split when none is supplied", () => {
        const { args } = buildServerCommand("rocm", "/models/llama.gguf", {}, "linux", 49152, {}, [
            { ...nvidia0, vramGB: 24 },
            { ...nvidia1, vramGB: 8 },
        ]);
        const split = args[args.indexOf("--tensor-split") + 1].split(",").map(Number);
        expect(split[0]).toBeGreaterThan(split[1]);
    });

    it("rejects a user-supplied tensor split whose length doesn't match the selected GPUs", () => {
        expect(() => buildServerCommand("rocm", "/models/llama.gguf", {}, "linux", 49152, { tensorSplit: [1] }, [nvidia0, nvidia1])).toThrow(/GPU/);
    });

    it("still pins --main-gpu for a single resolved ROCm GPU without requiring a split", () => {
        const { args } = buildServerCommand("rocm", "/models/llama.gguf", {}, "linux", 49152, {}, [nvidia1]);
        expect(args).toEqual(expect.arrayContaining(["--main-gpu", "0"]));
        expect(args).not.toContain("--tensor-split");
    });
});

describe("runtime input safety", () => {
    it("normalizes bounded startup values", () => {
        expect(normalizeStartupConfig({ gpuLayers: 5_000, idleTimeoutMinutes: -1 }).gpuLayerMode).toBe("max");
        expect(normalizeStartupConfig({ gpuLayerMode: "manual", gpuLayers: 42 }).gpuLayers).toBe(42);
        expect(normalizeStartupConfig({}).gpuLayers).toBeUndefined();
        expect(normalizeStartupConfig({ gpuLayers: 5_000, idleTimeoutMinutes: -1 }).idleTimeoutMinutes).toBe(0);
        expect(() => normalizeStartupConfig({ gpuMemoryUtilization: 2 })).toThrow(/between/);
    });

    it("accepts a GGUF inside the approved root and rejects path escape", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-models-"));
        const model = path.join(root, "model.gguf"); fs.writeFileSync(model, "gguf");
        const outside = path.join(os.tmpdir(), `outside-${Date.now()}.gguf`); fs.writeFileSync(outside, "gguf");
        expect(validateRuntimeModel("rocm", model, root)).toBe(fs.realpathSync(model));
        expect(() => validateRuntimeModel("rocm", outside, root)).toThrow(/outside/);
        expect(() => validateRuntimeModel("vllm", "not a model id", root)).toThrow(/publisher\/model/);
        fs.rmSync(outside, { force: true });
    });

    it("classifies common failures with recovery advice", () => {
        expect(classifyRuntimeError("CUDA out of memory").category).toBe("insufficient_memory");
        expect(classifyRuntimeError("EACCES permission denied").category).toBe("permission");
        expect(classifyRuntimeError("health check timed out").recoveryAction).toBeTruthy();
    });
});

describe("runtime command capabilities", () => {
    it("parses only flags advertised by the installed runtime help", () => {
        const result = parseRuntimeCommandCapabilities("rocm", "--ctx-size N\n--fit [on|off]\n--list-devices", "ROCm0: Radeon RX 7900 XTX");
        expect(result.checked).toBe(true);
        expect(result.flags).toEqual(expect.arrayContaining(["--ctx-size", "--fit", "--list-devices"]));
        expect(result.flags).not.toContain("--flash-attn");
        expect(result.backendDeviceNames).toEqual(["ROCm0: Radeon RX 7900 XTX"]);
    });

    it("refuses a requested optional flag that help did not advertise", () => {
        const capabilities = parseRuntimeCommandCapabilities("vllm", "--max-model-len");
        expect(() => buildServerCommand("vllm", "org/model", {}, "linux", 49153, { gpuMemoryUtilization: 0.8 }, [nvidia0], capabilities)).toThrow(/does not advertise --gpu-memory-utilization/);
    });
});

describe("runtime identity health", () => {
    it("requires an OpenAI model list containing the expected model", () => {
        expect(identityMatches({ data: [{ id: "meta-llama/Llama-3.1-8B-Instruct" }] }, "meta-llama/Llama-3.1-8B-Instruct")).toBe(true);
        expect(identityMatches({ status: "ok" }, "meta-llama/Llama-3.1-8B-Instruct")).toBe(false);
        expect(identityMatches({ data: [{ id: "another-model" }] }, "meta-llama/Llama-3.1-8B-Instruct")).toBe(false);
    });

    it("turns common startup logs into actionable explanations", () => {
        expect(explainStartupFailure("vllm", ["CUDA out of memory"])).toMatch(/RAM or VRAM/);
        expect(explainStartupFailure("mlx", ["ModuleNotFoundError: No module named mlx_lm"])).toMatch(/pip install mlx-lm/);
    });
});

describe("describeSpawnFailure", () => {
    it("points mlx failures at the mlx-lm install", () => {
        expect(describeSpawnFailure("mlx")).toMatch(/mlx-lm/);
    });

    it("points rocm failures at the llama-server binary setting", () => {
        expect(describeSpawnFailure("rocm")).toMatch(/llama-server/);
    });

    it("points vLLM failures at installation rather than endpoint configuration", () => {
        expect(describeSpawnFailure("vllm")).toMatch(/pip install vllm/);
    });
});

describe("buildRuntimeProbe", () => {
    it("recognizes MLX only on Apple Silicon", () => {
        expect(buildRuntimeProbe("mlx", {}, "darwin", "arm64").compatible).toBe(true);
        expect(buildRuntimeProbe("mlx", {}, "linux", "x64").compatible).toBe(false);
    });

    it("checks vLLM through WSL on Windows", () => {
        const probe = buildRuntimeProbe("vllm", {}, "win32", "x64");
        expect(probe.compatible).toBe(true);
        expect(probe.command).toBe("wsl.exe");
        expect(probe.args).toEqual(["--", "vllm", "--version"]);
    });

    it("uses the configured ROCm runtime when supplied", () => {
        const probe = buildRuntimeProbe("rocm", { rocmServerPath: "/opt/rocm/llama-server" }, "win32", "x64");
        expect(probe.compatible).toBe(true);
        expect(probe.command).toBe("/opt/rocm/llama-server");
    });
});
