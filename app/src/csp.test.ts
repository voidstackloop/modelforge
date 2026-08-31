import { describe, it, expect, beforeEach, vi } from "vitest";

// Local minimal electron mock — same rationale as ipc/trusted-sender.test.ts:
// nothing else in this codebase unit-tests against a real `session`, and
// this file's whole point is testing what onHeadersReceived's callback
// actually adds to the response headers.
type HeadersCallback = (response: { responseHeaders?: Record<string, string[]> }) => void;
type HeadersListener = (details: { responseHeaders?: Record<string, string[]> }, callback: HeadersCallback) => void;

const fake = vi.hoisted(() => {
    let registered: HeadersListener | null = null;
    return {
        session: {
            defaultSession: {
                webRequest: {
                    onHeadersReceived: (listener: HeadersListener) => {
                        registered = listener;
                    },
                },
            },
        },
        getRegistered: () => registered,
    };
});

vi.mock("electron", () => ({ session: fake.session }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { installContentSecurityPolicy, _resetForTests } from "./csp";

function invoke(existingHeaders?: Record<string, string[]>): Promise<Record<string, string[]> | undefined> {
    return new Promise((resolve) => {
        fake.getRegistered()!({ responseHeaders: existingHeaders }, (response) => resolve(response.responseHeaders));
    });
}

describe("installContentSecurityPolicy", () => {
    beforeEach(() => {
        _resetForTests();
    });

    it("sets Content-Security-Policy-Report-Only (report-only mode), never the enforcing header, on the strength of static analysis alone", async () => {
        installContentSecurityPolicy();
        const headers = await invoke();

        expect(headers).toBeDefined();
        expect(headers!["Content-Security-Policy-Report-Only"]).toBeDefined();
        expect(headers!["Content-Security-Policy"]).toBeUndefined();
    });

    it("the policy blocks remote script/style sources, objects, framing, form posts, and renderer-initiated network connections", async () => {
        installContentSecurityPolicy();
        const headers = await invoke();
        const policy = headers!["Content-Security-Policy-Report-Only"][0];

        expect(policy).toContain("default-src 'self'");
        expect(policy).toContain("object-src 'none'");
        expect(policy).toContain("base-uri 'none'");
        expect(policy).toContain("frame-src 'none'");
        expect(policy).toContain("form-action 'none'");
        expect(policy).toContain("connect-src 'none'");
        // script/style allow 'unsafe-inline' — see csp.ts's own doc comment
        // on why (the single-file-inlined production build) — still 'self'
        // scoped, so a remote <script src="https://evil.example/x.js"> is
        // not covered by 'unsafe-inline' and remains blocked.
        expect(policy).toContain("script-src 'self' 'unsafe-inline'");
        expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    });

    it("preserves any existing response headers rather than replacing them", async () => {
        installContentSecurityPolicy();
        const headers = await invoke({ "X-Existing-Header": ["some-value"] });

        expect(headers!["X-Existing-Header"]).toEqual(["some-value"]);
        expect(headers!["Content-Security-Policy-Report-Only"]).toBeDefined();
    });

    it("only registers one onHeadersReceived listener even if called twice", () => {
        const spy = vi.spyOn(fake.session.defaultSession.webRequest, "onHeadersReceived");
        installContentSecurityPolicy();
        installContentSecurityPolicy();
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
