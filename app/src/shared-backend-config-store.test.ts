import { describe, it, expect, afterEach } from "vitest";
import { getSharedBackendConfig, setSharedBackendConfig } from "./shared-backend-config-store";

describe("shared-backend-config-store", () => {
    afterEach(() => setSharedBackendConfig(null));

    it("returns null when nothing has been configured", () => {
        expect(getSharedBackendConfig()).toBeNull();
    });

    it("round-trips a full configuration", () => {
        const config = {
            baseUrl: "https://iam.example-hospital.test",
            issuer: "https://idp.example-hospital.test/realms/clinical",
            clientId: "modelforge-desktop",
            audience: "modelforge-iam-server",
            organizationId: "org-123",
        };
        setSharedBackendConfig(config);
        expect(getSharedBackendConfig()).toEqual(config);
    });

    it("setSharedBackendConfig(null) removes the configuration", () => {
        setSharedBackendConfig({ baseUrl: "https://x", issuer: "https://y", clientId: "z" });
        setSharedBackendConfig(null);
        expect(getSharedBackendConfig()).toBeNull();
    });
});
