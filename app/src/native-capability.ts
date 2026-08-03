// Shared by native-datastore.ts and native-downloader.ts. Both previously
// collapsed every reason `require(".../native")` could throw into a single
// "unavailable, fall back" boolean — correct for choosing a code path (the
// fallback is identical either way), but useless for a support report or a
// log line trying to answer "why doesn't this machine have the fast path,
// and is that expected?" This module classifies the thrown error into one
// of a small set of causes, purely for diagnostics — it never changes
// fallback *behavior*, only what gets reported about why the fallback is
// in use.

export type NativeUnavailableReason =
    /** No .node binary/index.js at the expected path — the normal state in
     * dev/test/E2E, which don't build the addon by default. */
    | "not-built"
    /** A binary exists but Node refused to load it — wrong Node ABI/version,
     * or a binary built for a different OS/CPU than this one. */
    | "abi-or-platform-mismatch"
    /** A binary exists, Node attempted to load it, and something failed
     * inside the addon's own initialization (a napi-rs panic during module
     * setup, a corrupted file that still passes Node's own format sniff). */
    | "load-error";

export interface NativeCapabilityReport {
    available: boolean;
    reason?: NativeUnavailableReason;
    /** The raw error message, kept for logs — never surfaced to end users as-is. */
    detail?: string;
}

/** Best-effort classification of a `require()` failure. Node's own error
 * shapes for these cases aren't a stable, documented contract — this is a
 * diagnostic aid, not something correctness should ever depend on. */
export function classifyLoadError(err: unknown): NativeUnavailableReason {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "MODULE_NOT_FOUND") return "not-built";

    const message = err instanceof Error ? err.message : String(err);
    if (/NODE_MODULE_VERSION|was compiled against a different|invalid ELF header|not a valid Win32 application|is not a valid Mach-O|wrong ELF class/i.test(message)) {
        return "abi-or-platform-mismatch";
    }
    return "load-error";
}
