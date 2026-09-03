import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { McpApprovalRequest } from "@modelforge/contracts";
import { Rs256McpApprovalTicketIssuer } from "./mcp-approval-issuer.js";

describe("Rs256McpApprovalTicketIssuer", () => {
    it("binds a short-lived ticket to subject, client, tool, and operation digest", async () => {
        const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const issuer = new Rs256McpApprovalTicketIssuer(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "https://backend.test", "clinical-mcp");
        const request: McpApprovalRequest = {
            id: "10000000-0000-4000-8000-000000000001",
            organizationId: "10000000-0000-4000-8000-000000000002",
            registryEntryId: "10000000-0000-4000-8000-000000000003",
            subjectId: "clinician-1",
            clientId: "desktop-1",
            toolName: "clinical.record_review_decision",
            operationDigest: `sha256:${"a".repeat(64)}`,
            status: "confirmed",
            createdAt: new Date(1_000_000).toISOString(),
            confirmedAt: new Date(1_001_000).toISOString(),
            expiresAt: new Date(1_300_000).toISOString(),
        };
        const token = await issuer.issue(request, 1_000);
        const [header, payload, signature] = token.split(".");
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toMatchObject({
            iss: "https://backend.test", aud: "clinical-mcp", sub: "clinician-1", azp: "desktop-1",
            tool: "clinical.record_review_decision", digest: request.operationDigest, iat: 1_000, exp: 1_300,
        });
    });
});
