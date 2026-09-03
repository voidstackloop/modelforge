import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSmartConfiguration, SmartDiscoveryError } from "./discovery.js";

const FHIR_BASE = "https://ehr.example-hospital.test/fhir";

describe("resolveSmartConfiguration", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("resolves authorization/token endpoints from a well-formed smart-configuration document", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                expect(url).toBe(`${FHIR_BASE}/.well-known/smart-configuration`);
                return new Response(JSON.stringify({ authorization_endpoint: "https://ehr.example-hospital.test/auth", token_endpoint: "https://ehr.example-hospital.test/token" }), { status: 200 });
            })
        );
        await expect(resolveSmartConfiguration(FHIR_BASE)).resolves.toEqual({ authorizationEndpoint: "https://ehr.example-hospital.test/auth", tokenEndpoint: "https://ehr.example-hospital.test/token" });
    });

    it("strips a trailing slash from the FHIR base before appending the discovery path", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                expect(url).toBe(`${FHIR_BASE}/.well-known/smart-configuration`);
                return new Response(JSON.stringify({ authorization_endpoint: "a", token_endpoint: "b" }), { status: 200 });
            })
        );
        await resolveSmartConfiguration(`${FHIR_BASE}/`);
    });

    it("rejects with SmartDiscoveryError on a non-2xx response", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
        await expect(resolveSmartConfiguration(FHIR_BASE)).rejects.toBeInstanceOf(SmartDiscoveryError);
    });

    it("rejects with SmartDiscoveryError on malformed JSON", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
        await expect(resolveSmartConfiguration(FHIR_BASE)).rejects.toBeInstanceOf(SmartDiscoveryError);
    });

    it("rejects with SmartDiscoveryError when authorization_endpoint is missing", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token_endpoint: "b" }), { status: 200 })));
        await expect(resolveSmartConfiguration(FHIR_BASE)).rejects.toThrow(/authorization_endpoint/);
    });

    it("rejects with SmartDiscoveryError when token_endpoint is missing", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ authorization_endpoint: "a" }), { status: 200 })));
        await expect(resolveSmartConfiguration(FHIR_BASE)).rejects.toThrow(/token_endpoint/);
    });

    it("rejects with a clear error, not a hang, on discovery timeout", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    const err = new Error("This operation was aborted");
                    err.name = "TimeoutError";
                    reject(err);
                });
            }))
        );
        await expect(resolveSmartConfiguration(FHIR_BASE, 50)).rejects.toThrow(/timed out after 50ms/);
    });
});
