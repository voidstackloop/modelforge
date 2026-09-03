import { createPrivateKey, randomUUID, sign } from "node:crypto";
import type { McpApprovalRequest } from "@modelforge/contracts";

export interface McpApprovalTicketIssuer {
    issue(request: McpApprovalRequest, nowEpochSeconds?: number): Promise<string>;
}

export class McpApprovalIssuerUnavailableError extends Error {}

export class UnconfiguredMcpApprovalTicketIssuer implements McpApprovalTicketIssuer {
    async issue(): Promise<string> {
        throw new McpApprovalIssuerUnavailableError("MCP approval signing is not configured.");
    }
}

function encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export class Rs256McpApprovalTicketIssuer implements McpApprovalTicketIssuer {
    private readonly key;

    constructor(privateKeyPem: string, private readonly issuer: string, private readonly audience: string) {
        if (!issuer || !audience) throw new Error("MCP approval issuer and audience are required.");
        this.key = createPrivateKey(privateKeyPem);
    }

    async issue(request: McpApprovalRequest, nowEpochSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
        if (request.status !== "confirmed") throw new Error("Only confirmed MCP approval requests can be signed.");
        const requestedExpiry = Math.floor(new Date(request.expiresAt).getTime() / 1000);
        const exp = Math.min(requestedExpiry, nowEpochSeconds + 300);
        if (exp <= nowEpochSeconds) throw new Error("The MCP approval request has expired.");
        const header = encode({ alg: "RS256", typ: "JWT" });
        const payload = encode({
            iss: this.issuer,
            aud: this.audience,
            sub: request.subjectId,
            azp: request.clientId,
            tool: request.toolName,
            digest: request.operationDigest,
            jti: randomUUID(),
            iat: nowEpochSeconds,
            exp,
        });
        const signingInput = `${header}.${payload}`;
        const signature = sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), this.key).toString("base64url");
        return `${signingInput}.${signature}`;
    }
}
