import { describe, it, expect, vi, afterEach } from "vitest";
import * as settingsStore from "./settings-store";
import * as secretsStore from "./secrets-store";
import * as mcpClient from "./mcp-client";
import * as agentTools from "./agent-tools";
import * as medicalSafety from "./medical-safety";
import {
    agentToolArgsSchemas,
    appSettingsSchema,
    mcpServerConfigSchema,
    mcpToolArgsSchema,
    medicationConflictCheckInputSchema,
    parseOrThrow,
    secretsSetInputSchema,
} from "./schemas";

// main.ts has no unit-testable seam of its own — its handlers are thin
// `ipcMain.handle(channel, (event, input) => { const validated =
// parseOrThrow(schema, input, label); ...store/tool call using validated... })`
// bodies, and importing main.ts directly would pull in real Electron
// (BrowserWindow, dialog, desktopCapturer) and every backend manager it
// wires up on app.whenReady(). Rather than build a second Electron mock just
// to exercise those four call sites, these tests replicate each handler's
// validate-then-call body verbatim (matching app/src/main.ts's settings:save,
// secrets:set, mcp:connect, and tools:execute handlers) and assert the store
// or tool function is never reached when the input is malformed — proving
// the rejection happens at the IPC boundary, not several layers deep inside
// store/tool code.

afterEach(() => {
    vi.restoreAllMocks();
});

describe("settings:save validation gate", () => {
    it("rejects a malformed patch before settingsStore.saveSettings runs", () => {
        const spy = vi.spyOn(settingsStore, "saveSettings");
        const malformed = { temperature: "not-a-number" };

        expect(() => {
            const partial = parseOrThrow(appSettingsSchema, malformed, "settings");
            settingsStore.saveSettings(partial);
        }).toThrow(/Invalid settings: temperature/);

        expect(spy).not.toHaveBeenCalled();
    });

    it("still saves a well-formed patch", () => {
        const partial = parseOrThrow(appSettingsSchema, { temperature: 0.4 }, "settings");
        const saved = settingsStore.saveSettings(partial);
        expect(saved.temperature).toBe(0.4);
    });
});

describe("secrets:set validation gate", () => {
    it("rejects a missing key before secretsStore.setSecret runs", () => {
        const spy = vi.spyOn(secretsStore, "setSecret");
        const malformed = { value: "sk-leaked" };

        expect(() => {
            const { key, value } = parseOrThrow(secretsSetInputSchema, malformed, "secrets:set arguments");
            secretsStore.setSecret(key, value ?? "");
        }).toThrow(/Invalid secrets:set arguments: key/);

        expect(spy).not.toHaveBeenCalled();
    });

    it("still sets a well-formed secret", () => {
        const { key, value } = parseOrThrow(secretsSetInputSchema, { key: "openai_api_key", value: "sk-1" }, "secrets:set arguments");
        secretsStore.setSecret(key, value ?? "");
        expect(secretsStore.getSecret("openai_api_key")).toBe("sk-1");
    });
});

describe("mcp:connect validation gate", () => {
    it("rejects a config missing transport/enabled before mcpClient.connectServer runs", async () => {
        const spy = vi.spyOn(mcpClient, "connectServer");
        const malformed = { id: "s1", name: "Server", command: "npx" }; // no transport, no enabled

        expect(() => parseOrThrow(mcpServerConfigSchema, malformed, "MCP server config")).toThrow(
            /Invalid MCP server config: (transport|enabled)/
        );
        expect(spy).not.toHaveBeenCalled();
    });

    it("rejects a config whose args contains a non-string entry", () => {
        const spy = vi.spyOn(mcpClient, "connectServer");
        const malformed = { id: "s1", name: "Server", transport: "stdio", enabled: true, command: "npx", args: ["-y", 42] };

        expect(() => parseOrThrow(mcpServerConfigSchema, malformed, "MCP server config")).toThrow();
        expect(spy).not.toHaveBeenCalled();
    });
});

describe("tools:execute validation gate", () => {
    it("rejects run_command with a non-string command before agentTools.executeTool runs", async () => {
        const spy = vi.spyOn(agentTools, "executeTool");
        const schema = agentToolArgsSchemas.run_command;

        expect(() => parseOrThrow(schema, { command: { rm: "-rf" } }, 'arguments for tool "run_command"')).toThrow(
            /Invalid arguments for tool "run_command": command/
        );
        expect(spy).not.toHaveBeenCalled();
    });

    it("rejects write_file missing content before it can reach the filesystem", () => {
        const spy = vi.spyOn(agentTools, "writeFile");
        const schema = agentToolArgsSchemas.write_file;

        expect(() => parseOrThrow(schema, { path: "notes.txt" }, 'arguments for tool "write_file"')).toThrow(
            /Invalid arguments for tool "write_file": content/
        );
        expect(spy).not.toHaveBeenCalled();
    });

    it("rejects a non-object args payload for an MCP-provided tool", () => {
        expect(() => parseOrThrow(mcpToolArgsSchema, "drop table users;", 'arguments for tool "mcp__x__y"')).toThrow(
            /Invalid arguments for tool "mcp__x__y"/
        );
    });

    it("an unknown tool name is left to executeTool's own \"Unknown tool\" error rather than a schema mismatch", async () => {
        // No schema is registered for a name the model invented — main.ts's
        // handler passes args through unvalidated in that case, exactly as
        // agent-tools.test.ts already covers ("delete_everything" rejects
        // with /Unknown tool/, not a validation error).
        expect(agentToolArgsSchemas.delete_everything).toBeUndefined();
    });

    it("still dispatches a well-formed call", async () => {
        const schema = agentToolArgsSchemas.git_status;
        const validated = parseOrThrow(schema, {}, 'arguments for tool "git_status"');
        expect(validated).toEqual({});
    });
});

describe("patientCases:checkConflicts validation gate", () => {
    afterEach(() => vi.restoreAllMocks());

    it("rejects a payload where allergies is a string instead of an array, before checkMedicationConflicts runs", () => {
        const spy = vi.spyOn(medicalSafety, "checkMedicationConflicts");
        const malformed = { allergies: "penicillin", medications: [] };

        expect(() => parseOrThrow(medicationConflictCheckInputSchema, malformed, "patientCases:checkConflicts arguments")).toThrow(
            /Invalid patientCases:checkConflicts arguments: allergies/
        );
        expect(spy).not.toHaveBeenCalled();
    });

    it("rejects a medications array containing a non-string entry, before checkMedicationConflicts runs", () => {
        const spy = vi.spyOn(medicalSafety, "checkMedicationConflicts");
        const malformed = { allergies: [], medications: ["warfarin", { dose: "5mg" }] };

        expect(() => parseOrThrow(medicationConflictCheckInputSchema, malformed, "patientCases:checkConflicts arguments")).toThrow(
            /Invalid patientCases:checkConflicts arguments: medications/
        );
        expect(spy).not.toHaveBeenCalled();
    });

    it("rejects a completely malformed (non-object) payload", () => {
        expect(() => parseOrThrow(medicationConflictCheckInputSchema, "not an object", "patientCases:checkConflicts arguments")).toThrow(
            /Invalid patientCases:checkConflicts arguments/
        );
    });

    it("the validation error message names only the malformed field, never echoing the submitted allergy/medication values", () => {
        const malformed = { allergies: "SecretPatientAllergyXYZ", medications: [] };
        try {
            parseOrThrow(medicationConflictCheckInputSchema, malformed, "patientCases:checkConflicts arguments");
            expect.unreachable("expected parseOrThrow to throw");
        } catch (err) {
            expect((err as Error).message).not.toContain("SecretPatientAllergyXYZ");
        }
    });

    it("still dispatches a well-formed call", () => {
        const validated = parseOrThrow(medicationConflictCheckInputSchema, { allergies: ["penicillin"], medications: ["amoxicillin"] }, "patientCases:checkConflicts arguments");
        expect(validated).toEqual({ allergies: ["penicillin"], medications: ["amoxicillin"] });
    });
});
