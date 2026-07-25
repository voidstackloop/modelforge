import { describe, it, expect } from "vitest";
import { buildRuntimeProbe, buildServerCommand, describeSpawnFailure, identityMatches, explainStartupFailure } from "./local-server-manager";

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

    it("builds a llama-server invocation with full GPU offload for rocm", () => {
        const { command, args } = buildServerCommand("rocm", "/models/llama.gguf", {
            rocmServerPath: "/opt/rocm-llama/llama-server",
        }, "linux", 49152);
        expect(command).toBe("/opt/rocm-llama/llama-server");
        expect(args).toEqual(
            expect.arrayContaining(["-m", "/models/llama.gguf", "--n-gpu-layers", "999"])
        );
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

    it("allows a vLLM command override without requiring one", () => {
        const { command } = buildServerCommand("vllm", "some/model", { vllmCommand: "/opt/vllm/bin/vllm" }, "linux", 49153);
        expect(command).toBe("/opt/vllm/bin/vllm");
    });

    it("launches vLLM through WSL automatically on Windows", () => {
        const { command, args } = buildServerCommand("vllm", "some/model", {}, "win32", 49153);
        expect(command).toBe("wsl.exe");
        expect(args.slice(0, 4)).toEqual(["--", "vllm", "serve", "some/model"]);
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
