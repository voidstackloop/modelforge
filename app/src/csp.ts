import { session } from "electron";
import { logger } from "./logger";

/**
 * Content-Security-Policy for the packaged renderer —
 * docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md P0 item 20 / trust boundary 2
 * ("a stricter renderer CSP"). Applied only when `app.isPackaged` (see
 * main.ts's call site): dev mode loads from the Vite dev server, which
 * needs 'unsafe-eval' and a WebSocket connection for HMR — a real security
 * boundary for the *shipped* app, not something worth relaxing/verifying
 * for a developer-only mode that never reaches a user.
 *
 * `script-src`/`style-src` allow 'unsafe-inline' rather than being pinned to
 * a content hash. That's a deliberate, disclosed gap, not an oversight:
 * frontend's production build uses vite-plugin-singlefile, which inlines
 * the *entire* JS/CSS bundle directly into index.html as a single
 * `<script>`/`<style>` tag — confirmed by inspecting the real build output
 * (frontend/dist/index.html, ~5.3MB). A naive regex extraction of that
 * inline script's content to hash it was tried and rejected: the bundle
 * itself contains string literals that look like `<script...>`/`</script>`
 * (from a bundled sanitizer/parser library), so a regex-based extraction
 * can grab the wrong boundary and hash the wrong bytes — silently
 * mismatching the real CSP hash browsers compute via proper HTML parsing.
 * Getting this right needs a real HTML parser at build time (extracting
 * the parsed script/style node's exact text, then either injecting a
 * `'sha256-...'` value into a build-generated CSP or emitting a per-build
 * nonce) — a real follow-up, not attempted here given no way to verify a
 * packaged Electron launch in the environment this was built in (see
 * reference_modelforge_dev_env memory: no xvfb, apt-get hangs). Every
 * *other* directive here is still meaningfully restrictive: no remote
 * script/style source, no object/embed, no framing, no form posts, no
 * renderer-initiated network connections (this app's renderer never calls
 * fetch()/WebSocket directly — see docs/ARCHITECTURE.md's "the renderer
 * never talks to a remote service directly" principle; everything crosses
 * through the IPC bridge to the main process instead, which CSP doesn't
 * govern at all).
 *
 * Shipped in **report-only** mode (`REPORT_ONLY = true`) for the same
 * reason: this was written and reasoned through carefully, and the "no
 * connect-src, no external images" analysis is based on a static grep of
 * frontend/src (no fetch/WebSocket/EventSource/external-URL usage found)
 * rather than an exhaustive audit of every one of the ~4800 modules the
 * production bundle transitively includes. Report-only mode logs any
 * violation to the packaged app's DevTools console without blocking
 * anything — the safe way to find out if that static analysis missed
 * something real, without risking a blank white window on every launch.
 * Once a real launch shows zero violations, flip REPORT_ONLY to false.
 */
const REPORT_ONLY = true;

const POLICY = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "connect-src 'none'",
].join("; ");

let installed = false;

export function installContentSecurityPolicy(): void {
    if (installed) return;
    installed = true;

    const headerName = REPORT_ONLY ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
    logger.info(`csp: installed in ${REPORT_ONLY ? "report-only" : "enforcing"} mode.`);

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                [headerName]: [POLICY],
            },
        });
    });
}

/** Test-only — see ipc/trusted-sender.ts's identical _resetForTests for why:
 * lets each test in csp.test.ts start from a clean, uninstalled state
 * instead of inheriting whatever an earlier test in the same file already
 * installed. Never called from production code. */
export function _resetForTests(): void {
    installed = false;
}
