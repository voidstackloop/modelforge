import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, registerSchemesAsPrivileged } = vi.hoisted(() => ({
    handlers: new Map<string, (request: Request) => Promise<Response> | Response>(),
    registerSchemesAsPrivileged: vi.fn(),
}));

vi.mock("electron", () => ({
    app: { isPackaged: false },
    protocol: {
        registerSchemesAsPrivileged,
        handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response> | Response) => handlers.set(scheme, handler)),
    },
    net: { fetch: vi.fn() },
}));

import { createOhifLaunch, installOhifProtocols, registerOhifSchemes } from "./ohif-viewer";

describe("OHIF secure protocol gateway", () => {
    beforeEach(() => {
        handlers.clear();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it("registers secure standard schemes before app readiness", () => {
        registerOhifSchemes();
        expect(registerSchemesAsPrivileged).toHaveBeenCalledOnce();
        expect(registerSchemesAsPrivileged.mock.calls[0][0].map((entry: { scheme: string }) => entry.scheme)).toEqual(["modelforge-ohif", "modelforge-dicom"]);
    });

    it("keeps the viewer bearer token out of the renderer URL and injects it only into the upstream Authorization header", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
        installOhifProtocols();
        const token = "secret-viewer-bearer-token";
        const launch = createOhifLaunch({
            token,
            dicomwebBaseUrl: "https://imaging.example.test/organizations/org/imaging/dicomweb",
            studyInstanceUid: "1.2.3.4",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(launch.viewerUrl).toMatch(/^modelforge-ohif:\/\/viewer\/basic\?/);
        expect(launch.viewerUrl).not.toContain(token);
        const sessionId = new URL(launch.viewerUrl).searchParams.get("mfSession")!;

        await handlers.get("modelforge-dicom")!(new Request(`modelforge-dicom://gateway/${sessionId}/studies?StudyInstanceUID=1.2.3.4`));

        expect(fetchMock).toHaveBeenCalledOnce();
        const [upstream, init] = fetchMock.mock.calls[0];
        expect(upstream).toBe("https://imaging.example.test/organizations/org/imaging/dicomweb/studies?StudyInstanceUID=1.2.3.4");
        expect((init?.headers as Headers).get("Authorization")).toBe(`Bearer ${token}`);
    });

    /**
     * With CloudFront delivery enabled the server answers WADO with a 307 to
     * a signed CDN URL. The signature is the authorization for that request,
     * so the viewer token must not travel with it — otherwise this session's
     * bearer credential lands in a third-party edge host's access logs.
     */
    describe("following a CDN redirect (CloudFront delivery enabled)", () => {
        async function driveRedirect(location: string, token = "secret-viewer-bearer-token") {
            const fetchMock = vi
                .spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location } }))
                .mockResolvedValueOnce(new Response("pixels", { status: 200 }));
            installOhifProtocols();
            const launch = createOhifLaunch({
                token,
                dicomwebBaseUrl: "https://imaging.example.test/organizations/org/imaging/dicomweb",
                studyInstanceUid: "1.2.3.4",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });
            const sessionId = new URL(launch.viewerUrl).searchParams.get("mfSession")!;
            const response = await handlers.get("modelforge-dicom")!(new Request(`modelforge-dicom://gateway/${sessionId}/wado/instances/abc`));
            return { fetchMock, response, token };
        }

        it("never sends the viewer bearer token to the CDN when following the redirect", async () => {
            const { fetchMock, response, token } = await driveRedirect("https://cdn.imaging.example.test/o/s/x.dcm?Signature=abc&Key-Pair-Id=K1");

            expect(response.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            // First hop carries the token to our own origin, as before.
            expect((fetchMock.mock.calls[0][1]?.headers as Headers).get("Authorization")).toBe(`Bearer ${token}`);

            // Second hop goes to the CDN with no headers at all.
            const [cdnTarget, cdnInit] = fetchMock.mock.calls[1];
            expect(String(cdnTarget)).toContain("cdn.imaging.example.test");
            expect(cdnInit?.headers).toBeUndefined();
            expect(JSON.stringify(cdnInit ?? {})).not.toContain(token);
        });

        it("asks the origin not to follow redirects itself, so the token can never ride along implicitly", async () => {
            const { fetchMock } = await driveRedirect("https://cdn.imaging.example.test/o/s/x.dcm?Signature=abc");
            expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
        });

        it("refuses to follow a redirect that would downgrade PHI to plaintext http", async () => {
            const { response, fetchMock } = await driveRedirect("http://evil.example.test/steal");
            expect(response.status).toBe(502);
            expect(fetchMock).toHaveBeenCalledOnce(); // never followed
        });

        it("fails closed on a redirect with no Location rather than returning a confusing empty body", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 307 }));
            installOhifProtocols();
            const launch = createOhifLaunch({
                token: "t",
                dicomwebBaseUrl: "https://imaging.example.test/organizations/org/imaging/dicomweb",
                studyInstanceUid: "1.2.3.4",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });
            const sessionId = new URL(launch.viewerUrl).searchParams.get("mfSession")!;
            const response = await handlers.get("modelforge-dicom")!(new Request(`modelforge-dicom://gateway/${sessionId}/wado/instances/abc`));
            expect(response.status).toBe(502);
        });
    });
});
