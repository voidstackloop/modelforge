import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { app } from "electron";
import { getSettings, saveSettings, getRejectedPolicyKeys, __resetLegacyRuntimeSettingsMigrationForTests } from "./settings-store";
import * as policyStore from "./policy-store";
import type { PolicyPayload } from "./policy-store";

function settingsFilePath(): string {
    return path.join(app.getPath("userData"), "settings.json");
}

// Synthetic key/policy fixtures only.
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
        return sorted;
    }
    return value;
}
function signPolicy(dir: string, settings: PolicyPayload["settings"]) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const now = new Date();
    const payload: PolicyPayload = {
        version: 1,
        issuer: "Synthetic Test Health System",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        settings,
    };
    const payloadString = JSON.stringify(canonicalize(payload));
    const signatureHex = crypto.sign(null, Buffer.from(payloadString, "utf-8"), privateKey).toString("hex");
    fs.writeFileSync(path.join(dir, "trusted-public-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
    fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ payload: payloadString, signatureHex, algorithm: "ed25519" }));
}

describe("settings-store", () => {
    it("returns sensible defaults before anything has been saved", () => {
        const settings = getSettings();
        expect(settings.temperature).toBe(0.7);
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
        expect(settings.topP).toBe(1);
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

    // docs/LOCAL_INFERENCE_HARDENING_PLAN.md: Ollama removal. preferredRuntime
    // is a closed z.enum() — a settings.json predating this removal that still
    // has `preferredRuntime: "ollama"` would otherwise fail the *entire*
    // object's schema validation and get silently reset to defaults (see
    // migrateLegacyRuntimeSettings's own doc comment). This proves the
    // pre-pass actually prevents that, and doesn't touch unrelated fields.
    describe("legacy preferredRuntime/runtimeGpuConfigs.ollama migration", () => {
        beforeEach(() => {
            __resetLegacyRuntimeSettingsMigrationForTests();
        });

        it("rewrites preferredRuntime: \"ollama\" to \"automatic\" instead of wiping the whole settings file", () => {
            fs.writeFileSync(settingsFilePath(), JSON.stringify({
                preferredRuntime: "ollama",
                temperature: 0.42,
                theme: "dark",
            }));

            const settings = getSettings();

            expect(settings.preferredRuntime).toBe("automatic");
            // The critical assertion: sibling fields survived. Before the
            // migration pre-pass, the invalid enum value would have failed
            // schema validation for the whole object and reset everything
            // below to DEFAULTS.
            expect(settings.temperature).toBe(0.42);
            expect(settings.theme).toBe("dark");
        });

        it("drops a legacy runtimeGpuConfigs.ollama entry while preserving other backends' configs", () => {
            fs.writeFileSync(settingsFilePath(), JSON.stringify({
                runtimeGpuConfigs: {
                    ollama: { selection: { mode: "single", deviceIds: ["nvidia:uuid-old"] } },
                    llamacpp: { selection: { mode: "group", deviceIds: ["nvidia:uuid-1"] } },
                },
            }));

            const settings = getSettings();

            expect((settings.runtimeGpuConfigs as Record<string, unknown> | undefined)?.ollama).toBeUndefined();
            expect(settings.runtimeGpuConfigs?.llamacpp?.selection?.deviceIds).toEqual(["nvidia:uuid-1"]);
        });

        it("leaves a settings file with no legacy shapes completely untouched", () => {
            fs.writeFileSync(settingsFilePath(), JSON.stringify({ preferredRuntime: "llamacpp", temperature: 0.9 }));
            const before = fs.readFileSync(settingsFilePath(), "utf-8");

            getSettings();

            expect(fs.readFileSync(settingsFilePath(), "utf-8")).toBe(before);
        });

        it("only migrates once per process — a hand-edit back to \"ollama\" after the first getSettings() call isn't re-migrated", () => {
            fs.writeFileSync(settingsFilePath(), JSON.stringify({ preferredRuntime: "ollama", temperature: 0.42 }));
            getSettings(); // first call performs the migration and flips the guard

            fs.writeFileSync(settingsFilePath(), JSON.stringify({ preferredRuntime: "ollama", temperature: 0.42 }));
            // Without resetting the guard, this call skips the pre-pass, so
            // the raw invalid enum value reaches schema validation and
            // readJsonWithSchema's own (pre-existing, correct-for-corruption)
            // fallback resets the *entire* object to DEFAULTS — still safe
            // (no crash, no stale invalid value persists), just a coarser
            // recovery than the migration provides: `preferredRuntime` has no
            // DEFAULTS entry at all (undefined, not "automatic"), and the
            // sibling `temperature` value is lost too. This is the specific
            // gap the pre-pass exists to avoid on a normal (first) read.
            const settings = getSettings();
            expect(settings.preferredRuntime).toBeUndefined();
            expect(settings.temperature).toBe(0.7); // DEFAULTS value, not the 0.42 that was lost
        });
    });

    // getSettings()/saveSettings() are the single choke point every caller in
    // this app shares (agent-tools.ts's network-tool gate among them) — these
    // tests prove a verified organization policy actually governs reads and
    // writes through that real path, not just policy-store.ts in isolation.
    describe("organization policy integration", () => {
        let dir: string;
        const originalEnv = process.env.MODELFORGE_POLICY_DIR;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-settings-policy-test-"));
            process.env.MODELFORGE_POLICY_DIR = dir;
            policyStore.resetPolicyStateForTests();
        });

        afterEach(() => {
            if (originalEnv === undefined) delete process.env.MODELFORGE_POLICY_DIR;
            else process.env.MODELFORGE_POLICY_DIR = originalEnv;
            fs.rmSync(dir, { recursive: true, force: true });
            policyStore.resetPolicyStateForTests();
        });

        it("a policy-managed field always reads as the policy's value, regardless of what's saved locally", () => {
            saveSettings({ networkToolsEnabled: true });
            expect(getSettings().networkToolsEnabled).toBe(true);

            signPolicy(dir, { networkToolsEnabled: false });
            policyStore.reloadPolicy();

            expect(getSettings().networkToolsEnabled).toBe(false);
        });

        it("saving a policy-managed field has no effect — it's stripped before the write, not just hidden on read", () => {
            signPolicy(dir, { auditLogRetentionDays: 2555 });
            policyStore.reloadPolicy();

            saveSettings({ auditLogRetentionDays: 7, theme: "dark" });

            expect(getSettings().auditLogRetentionDays).toBe(2555); // policy's value, unchanged
            expect(getSettings().theme).toBe("dark"); // the non-managed field in the same call still saved
        });

        it("getRejectedPolicyKeys reports exactly the managed keys present in a given patch", () => {
            signPolicy(dir, { networkToolsEnabled: false, caseAutoLockMinutes: 5 });
            policyStore.reloadPolicy();

            expect(getRejectedPolicyKeys({ networkToolsEnabled: true, theme: "dark" })).toEqual(["networkToolsEnabled"]);
            expect(getRejectedPolicyKeys({ theme: "dark" })).toEqual([]);
        });

        it("a managed value stops being enforced once policy no longer manages that key", () => {
            signPolicy(dir, { networkToolsEnabled: false });
            policyStore.reloadPolicy();
            expect(getSettings().networkToolsEnabled).toBe(false);

            signPolicy(dir, {}); // republished policy no longer mentions this key
            policyStore.reloadPolicy();

            // Falls back to whatever's actually stored locally (the default,
            // since nothing local was ever successfully saved for it).
            expect(getSettings().networkToolsEnabled).toBe(true);
        });

        it("local settings are fully in control again once no policy is configured (unmanaged, not locked)", () => {
            saveSettings({ networkToolsEnabled: false });
            expect(getSettings().networkToolsEnabled).toBe(false);
            expect(policyStore.getPolicyStatus().state).toBe("unmanaged");

            saveSettings({ networkToolsEnabled: true });
            expect(getSettings().networkToolsEnabled).toBe(true);
        });
    });
});
