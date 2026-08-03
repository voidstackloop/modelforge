import * as path from "node:path";
import { classifyLoadError, type NativeCapabilityReport } from "./native-capability";

// Same Rust addon as native-downloader.ts (lib/, built by `npm run
// build:native` into app/native/) — these are the JSON-store primitives
// (`json-store.ts`) and the audit log's per-event SHA-256 hashing
// (`audit-log-store.ts`), moved to Rust because that pair sits on the hot
// path of every case/session/audit read and write. See native-downloader.ts
// for why the addon is a plain filesystem artifact rather than an npm
// dependency, and why the path is resolved relative to dist/.
interface NativeAddon {
    readJsonFileNative(path: string): string | null;
    writeJsonFileAtomicNative(path: string, contents: string): void;
    sha256HexNative(input: string): string;
    appendJsonArrayElementNative(path: string, elementJson: string): boolean;
}

let nativeAddon: NativeAddon | undefined;
// Distinct from `nativeAddon === undefined` (not yet attempted) — once a
// load has failed, every caller should get the same fast, quiet fallback
// instead of re-attempting (and re-logging) the same failing `require` on
// every single store read/write for the rest of the process's life.
let loadFailed = false;
let capabilityReport: NativeCapabilityReport = { available: false };

function getNativeAddon(): NativeAddon | null {
    if (loadFailed) return null;
    if (!nativeAddon) {
        try {
            nativeAddon = require(path.join(__dirname, "..", "native")) as NativeAddon;
            capabilityReport = { available: true };
        } catch (err) {
            loadFailed = true;
            capabilityReport = {
                available: false,
                reason: classifyLoadError(err),
                detail: err instanceof Error ? err.message : String(err),
            };
            return null;
        }
    }
    return nativeAddon;
}

/**
 * Reads a JSON "database" file whole via the Rust addon. Returns `undefined`
 * (distinct from the file's own `null` for "missing") when the addon isn't
 * available at all, so `json-store.ts` can tell "use the pure-Node
 * fallback" apart from "the file legitimately doesn't exist yet" (`null`).
 */
export function readJsonFileNative(filePath: string): string | null | undefined {
    const addon = getNativeAddon();
    if (!addon) return undefined;
    return addon.readJsonFileNative(filePath);
}

/**
 * Atomically writes `contents` to `filePath` via the Rust addon. Returns
 * `false` (never throws) when the addon isn't available, so the caller
 * falls back to the pure-Node implementation instead of the whole write
 * failing outright.
 */
export function writeJsonFileAtomicNative(filePath: string, contents: string): boolean {
    const addon = getNativeAddon();
    if (!addon) return false;
    addon.writeJsonFileAtomicNative(filePath, contents);
    return true;
}

/**
 * SHA-256 hex digest via the Rust addon, or `undefined` if it isn't
 * available — `audit-log-store.ts` falls back to Node's `crypto` module in
 * that case. Never partially-hashes or throws.
 */
export function sha256HexNative(input: string): string | undefined {
    const addon = getNativeAddon();
    if (!addon) return undefined;
    return addon.sha256HexNative(input);
}

/**
 * O(1) append of `elementJson` onto an existing JSON array file — see
 * `datastore::append_json_array_element` in the Rust addon for why this
 * exists (it's what makes `audit-log-store.ts`'s `recordEvent` avoid a full
 * read-modify-write of the whole growing array on every call). Returns
 * `undefined` when the addon is unavailable, or the addon's own `boolean`
 * (whether the fast path actually applied to this file) otherwise — the
 * caller falls back to a full rewrite in both the `undefined` and `false`
 * cases, just for different reasons.
 */
export function appendJsonArrayElementNative(filePath: string, elementJson: string): boolean | undefined {
    const addon = getNativeAddon();
    if (!addon) return undefined;
    return addon.appendJsonArrayElementNative(filePath, elementJson);
}

/**
 * Whether the Rust addon loaded successfully at all. `audit-log-store.ts`
 * uses this to decide, up front, whether maintaining its in-memory
 * hash/count cache is worthwhile — without the addon there's no fast append
 * to use it for, so consulting it would only add a second read on top of
 * the existing full read-modify-write path instead of replacing it.
 */
export function isNativeDatastoreAvailable(): boolean {
    return getNativeAddon() !== null;
}

/**
 * Diagnostic detail on *why* the datastore addon isn't available, when it
 * isn't — distinguishing "not built" (expected in dev/test/E2E) from an ABI
 * or platform mismatch or a load-time error (both of which usually mean a
 * packaged build shipped a binary that doesn't match the machine running
 * it, worth surfacing rather than silently swallowing). Never changes
 * fallback behavior — every caller above already falls back the same way
 * regardless of which reason applies; this exists purely for logs and
 * support diagnostics.
 */
export function getNativeCapabilityReport(): NativeCapabilityReport {
    getNativeAddon(); // ensure a load has actually been attempted at least once
    return capabilityReport;
}
