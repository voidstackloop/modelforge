import { net, protocol } from "electron";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";

interface ViewerGatewaySession {
    token: string;
    upstreamBaseUrl: string;
    expiresAt: number;
}

const sessions = new Map<string, ViewerGatewaySession>();

export function registerOhifSchemes(): void {
    protocol.registerSchemesAsPrivileged([
        { scheme: "modelforge-ohif", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
        { scheme: "modelforge-dicom", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    ]);
}

function ohifRoot(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, "ohif-dist")
        : path.join(__dirname, "..", "vendor", "ohif-dist");
}

const appConfig = `window.config = {
  routerBasename: '/',
  showStudyList: false,
  disableEditing: false,
  investigationalUseDialog: { option: 'never' },
  extensions: [],
  modes: [],
  dataSources: [{
    namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
    sourceName: 'modelforgeDicomweb',
    configuration: {
      friendlyName: 'ModelForge scoped viewer session',
      name: 'ModelForge',
      qidoRoot: 'modelforge-dicom://gateway/unconfigured',
      wadoRoot: 'modelforge-dicom://gateway/unconfigured',
      wadoUriRoot: 'modelforge-dicom://gateway/unconfigured',
      qidoSupportsIncludeField: false,
      imageRendering: 'wadouri',
      thumbnailRendering: 'wadouri',
      enableStudyLazyLoad: false,
      supportsFuzzyMatching: false,
      supportsWildcard: false,
      onConfiguration: (configuration, options) => {
        const session = options.query.mfSession;
        const root = 'modelforge-dicom://gateway/' + encodeURIComponent(session);
        return { ...configuration, qidoRoot: root, wadoRoot: root, wadoUriRoot: root + '/wado' };
      }
    }
  }],
  defaultDataSourceName: 'modelforgeDicomweb'
};`;

export function installOhifProtocols(): void {
    protocol.handle("modelforge-ohif", (request) => {
        const url = new URL(request.url);
        let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
        if (relative === "app-config.js") return new Response(appConfig, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
        const root = path.resolve(ohifRoot());
        let target = path.resolve(root, relative);
        if (!path.relative(root, target).startsWith("..") && !path.isAbsolute(path.relative(root, target))) {
            // Client-side OHIF routes such as /basic have no physical file.
            if (!path.extname(target)) target = path.join(root, "index.html");
            return net.fetch(pathToFileURL(target).toString());
        }
        return new Response("Not found", { status: 404 });
    });

    protocol.handle("modelforge-dicom", async (request) => {
        const url = new URL(request.url);
        const [sessionId, ...parts] = url.pathname.replace(/^\/+/, "").split("/");
        const session = sessions.get(decodeURIComponent(sessionId));
        if (!session || session.expiresAt <= Date.now()) {
            if (session) sessions.delete(sessionId);
            return new Response(JSON.stringify({ error: "invalid_or_expired_viewer_gateway" }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
        const upstream = `${session.upstreamBaseUrl}/${parts.map(encodeURIComponent).join("/")}${url.search}`;
        const headers = new Headers(request.headers);
        headers.set("Authorization", `Bearer ${session.token}`);
        headers.delete("Origin");
        headers.delete("Referer");
        const response = await fetch(upstream, {
            method: request.method,
            headers,
            body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
            // Redirects are followed by hand below, never automatically.
            redirect: "manual",
        });

        // When the server has CloudFront delivery enabled it answers a WADO
        // request with 307 to a short-lived signed CDN URL
        // (server/src/imaging/content-delivery.ts). That URL carries its own
        // authorization in the signature, so the follow-up request must be
        // made with NO viewer token: sending `Authorization` to the CDN
        // would hand this session's bearer credential to a third-party edge
        // host and put it in its access logs.
        //
        // Node's fetch would strip `Authorization` on a cross-origin
        // redirect on its own, but that is implicit spec behavior guarding a
        // PHI-bearing credential — done explicitly here so the property is
        // visible, reviewable, and covered by a test.
        if (response.status === 307 || response.status === 302 || response.status === 303) {
            const location = response.headers.get("location");
            if (!location) return new Response("Bad gateway", { status: 502 });
            const target = new URL(location, upstream);
            if (target.protocol !== "https:") {
                // Never follow a redirect that would downgrade PHI in flight.
                return new Response("Bad gateway", { status: 502 });
            }
            return fetch(target, { method: "GET" });
        }
        return response;
    });
}

export function createOhifLaunch(input: { token: string; dicomwebBaseUrl: string; studyInstanceUid: string; expiresAt: string }): { viewerUrl: string; expiresAt: string } {
    const sessionId = randomBytes(24).toString("base64url");
    const expiresAt = Date.parse(input.expiresAt);
    sessions.set(sessionId, { token: input.token, upstreamBaseUrl: input.dicomwebBaseUrl.replace(/\/$/, ""), expiresAt });
    const query = new URLSearchParams({ StudyInstanceUIDs: input.studyInstanceUid, mfSession: sessionId });
    return { viewerUrl: `modelforge-ohif://viewer/basic?${query.toString()}`, expiresAt: input.expiresAt };
}

export function closeOhifLaunch(viewerUrl: string): void {
    try {
        const url = new URL(viewerUrl);
        if (url.protocol !== "modelforge-ohif:") return;
        const sessionId = url.searchParams.get("mfSession");
        if (sessionId) sessions.delete(sessionId);
    } catch {
        // An invalid/untrusted renderer value cannot widen access; there is
        // simply no matching gateway session to remove.
    }
}
