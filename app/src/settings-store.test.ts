import { describe, it, expect } from "vitest";
import { getSettings, saveSettings } from "./settings-store";

describe("settings-store", () => {
    it("returns sensible defaults before anything has been saved", () => {
        const settings = getSettings();
        expect(settings.ollamaHost).toBe("http://127.0.0.1:11434");
        expect(settings.theme).toBe("system");
        expect(settings.language).toBe("en");
    });

    it("merges a partial save on top of the existing settings", () => {
        saveSettings({ temperature: 0.3 });
        saveSettings({ theme: "dark" });

        const settings = getSettings();
        expect(settings.temperature).toBe(0.3);
        expect(settings.theme).toBe("dark");
        // untouched fields keep their previous/default values
        expect(settings.ollamaHost).toBe("http://127.0.0.1:11434");
    });

    it("defaults GPU selection mode to automatic", () => {
        expect(getSettings().defaultGpuSelectionMode).toBe("auto");
    });

    it("persists a per-runtime GPU selection and split config across saves", () => {
        saveSettings({
            runtimeGpuConfigs: {
                vllm: { selection: { mode: "group", deviceIds: ["nvidia:uuid-1", "nvidia:uuid-2"] }, tensorParallelSize: 2 },
                rocm: { selection: { mode: "single", deviceIds: ["amd:unique-1"] }, tensorSplit: [1] },
            },
        });
        const settings = getSettings();
        expect(settings.runtimeGpuConfigs?.vllm?.selection?.deviceIds).toEqual(["nvidia:uuid-1", "nvidia:uuid-2"]);
        expect(settings.runtimeGpuConfigs?.vllm?.tensorParallelSize).toBe(2);
        expect(settings.runtimeGpuConfigs?.rocm?.tensorSplit).toEqual([1]);
        // A save that doesn't touch runtimeGpuConfigs must not drop it.
        saveSettings({ theme: "light" });
        expect(getSettings().runtimeGpuConfigs?.vllm?.selection?.mode).toBe("group");
    });
});
