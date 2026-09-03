import net from "node:net";

/**
 * MLLP (Minimal Lower Layer Protocol) — the TCP framing real HL7 v2
 * transport almost always uses: `<VT>message<FS><CR>`, `VT`=0x0B (start
 * block), `FS`=0x1C, `CR`=0x0D (end block, two bytes together). This
 * module is transport/framing only — no HL7 parsing, no patient matching,
 * no IAM, no knowledge of ORU/ADT/anything — `options.handler` (supplied
 * by the caller, see hl7/mllp-handler.ts for the one this codebase wires
 * up) owns everything about what a message means and what to reply.
 *
 * Trust model, stated plainly because it differs from every other route in
 * this codebase: **a raw TCP connection carries no bearer token, no OIDC
 * identity, nothing IAM can check.** Real HL7 v2/MLLP predates OAuth and is
 * conventionally trusted at the network layer instead — a private network,
 * a VPN, an IP allowlist, or mutual TLS the deployment's own infrastructure
 * enforces (not this module, which speaks plain TCP with no TLS of its
 * own). This is why `host` defaults to loopback-only (`127.0.0.1`) and
 * requires an explicit opt-in override to bind anywhere reachable from
 * outside the host — see index.ts's own config-gating of this module for
 * the full posture (off unless explicitly configured, one specific
 * organization per listener, never a public bind by default).
 *
 * DoS-conscious by construction, not just by convention: bounded
 * accumulated-buffer size (a sender that never completes a frame, or
 * streams garbage, gets disconnected rather than growing memory
 * unboundedly), a per-connection idle timeout, and a cap on concurrent
 * connections.
 */

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const FRAME_END = Buffer.from([FS, CR]);

export interface MllpServerOptions {
    /** Called once per received message (already stripped of MLLP framing)
     * — must resolve to the raw HL7 v2 ACK/NACK message text to send back,
     * and must not itself throw (a thrown error is caught and logged via
     * `onError`, and the connection that triggered it is dropped without a
     * reply, rather than risking an unhandled rejection crashing the
     * process or an error's raw text — which could carry internal detail
     * never meant to cross this trust boundary — being sent over the
     * wire). */
    handler: (rawMessage: string) => Promise<string>;
    /** Defaults to "127.0.0.1" — see this file's own top doc comment on
     * why a wider bind is never the default. */
    host?: string;
    port: number;
    /** Defaults to 1 MiB. A real HL7 v2 message is always small (KBs);
     * anything accumulating past this on one connection without completing
     * a frame is treated as abusive or broken, and the connection is
     * dropped. */
    maxMessageBytes?: number;
    /** Defaults to 30s. An idle connection (no data, no frame completed)
     * past this is closed — bounds how many connections can sit open
     * doing nothing. */
    connectionIdleTimeoutMs?: number;
    /** Defaults to 50. A new connection past this count while at capacity
     * is refused immediately. */
    maxConcurrentConnections?: number;
    onError?: (err: Error) => void;
    onConnection?: (remoteAddress: string | undefined) => void;
}

/** Builds (but does not start listening — call `.listen(port, host)` or
 * use the `port`/`host` already on `options`, done for you by
 * `startMllpServer` below) an MLLP TCP server. */
export function createMllpServer(options: MllpServerOptions): net.Server {
    const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;
    const idleTimeoutMs = options.connectionIdleTimeoutMs ?? 30_000;
    const maxConnections = options.maxConcurrentConnections ?? 50;
    let activeConnections = 0;

    const server = net.createServer((socket) => {
        if (activeConnections >= maxConnections) {
            socket.destroy();
            return;
        }
        activeConnections++;
        options.onConnection?.(socket.remoteAddress);
        socket.setTimeout(idleTimeoutMs);

        let buffer = Buffer.alloc(0);
        // Serializes ACK replies in the order their messages were framed,
        // even though `options.handler` is async — without this, two
        // frames arriving in the same TCP chunk could resolve out of
        // order and confuse a sender expecting one ACK per message in
        // sequence.
        let queue: Promise<void> = Promise.resolve();

        function reply(ack: string): void {
            if (socket.writable) socket.write(Buffer.concat([Buffer.from([VT]), Buffer.from(ack, "utf8"), FRAME_END]));
        }

        function enqueue(rawMessage: string): void {
            queue = queue.then(async () => {
                try {
                    const ack = await options.handler(rawMessage);
                    reply(ack);
                } catch (err) {
                    // The handler contract says it shouldn't throw — this
                    // is a last-resort guard, not the normal error path
                    // (hl7/mllp-handler.ts's own handler always catches
                    // its own errors and returns a NACK string instead).
                    // Never echo the error's own message back over the
                    // wire; just drop this reply and log server-side.
                    options.onError?.(err instanceof Error ? err : new Error(String(err)));
                }
            });
        }

        socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > maxMessageBytes) {
                options.onError?.(new Error(`MLLP connection exceeded ${maxMessageBytes} bytes without completing a frame — dropping connection.`));
                socket.destroy();
                return;
            }
            for (;;) {
                const start = buffer.indexOf(VT);
                if (start === -1) {
                    buffer = Buffer.alloc(0);
                    return;
                }
                const end = buffer.indexOf(FRAME_END, start + 1);
                if (end === -1) {
                    // Incomplete frame — keep from the start marker
                    // onward (discarding any garbage that preceded it)
                    // and wait for more data.
                    buffer = start > 0 ? buffer.subarray(start) : buffer;
                    return;
                }
                enqueue(buffer.subarray(start + 1, end).toString("utf8"));
                buffer = buffer.subarray(end + FRAME_END.length);
            }
        });

        socket.on("timeout", () => socket.destroy());
        socket.on("error", (err) => options.onError?.(err));
        socket.on("close", () => {
            activeConnections--;
        });
    });

    server.on("error", (err) => options.onError?.(err));
    return server;
}

/** Convenience wrapper: builds and starts listening, defaulting `host` to
 * loopback. Returns the server plus a `close()` that resolves once fully
 * stopped (existing connections included) — index.ts uses this for a
 * clean shutdown. */
export async function startMllpServer(options: MllpServerOptions): Promise<{ server: net.Server; close: () => Promise<void> }> {
    const server = createMllpServer(options);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host ?? "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
    return {
        server,
        close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
}
