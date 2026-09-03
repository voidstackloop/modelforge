import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMllpServer, startMllpServer, type MllpServerOptions } from "./mllp-server.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

function frame(message: string): Buffer {
    return Buffer.concat([Buffer.from([VT]), Buffer.from(message, "utf8"), Buffer.from([FS, CR])]);
}

/** Collects complete MLLP-framed replies from a socket's data stream. */
function replyCollector(socket: net.Socket): { next: () => Promise<string> } {
    let buffer = Buffer.alloc(0);
    const pending: string[] = [];
    const waiters: Array<(value: string) => void> = [];
    socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            const start = buffer.indexOf(VT);
            if (start === -1) return;
            const end = buffer.indexOf(Buffer.from([FS, CR]), start + 1);
            if (end === -1) return;
            const text = buffer.subarray(start + 1, end).toString("utf8");
            buffer = buffer.subarray(end + 2);
            const waiter = waiters.shift();
            if (waiter) waiter(text);
            else pending.push(text);
        }
    });
    return {
        next: () => new Promise<string>((resolve) => {
            const value = pending.shift();
            if (value !== undefined) resolve(value);
            else waiters.push(resolve);
        }),
    };
}

async function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });
}

describe("MLLP server", () => {
    let cleanup: (() => Promise<void>) | undefined;

    afterEach(async () => {
        await cleanup?.();
        cleanup = undefined;
    });

    async function start(overrides: Partial<MllpServerOptions> = {}): Promise<{ port: number; handler: ReturnType<typeof vi.fn> }> {
        const handler = vi.fn(async (raw: string) => `ACK-FOR:${raw}`);
        const { close, server } = await startMllpServer({ handler, port: 0, host: "127.0.0.1", ...overrides });
        cleanup = close;
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected a TCP address");
        return { port: address.port, handler };
    }

    it("frames a single message, calls the handler with the unframed text, and returns a correctly-framed reply", async () => {
        const { port, handler } = await start();
        const socket = await connect(port);
        const replies = replyCollector(socket);
        socket.write(frame("MSH|test-message-1"));
        expect(await replies.next()).toBe("ACK-FOR:MSH|test-message-1");
        expect(handler).toHaveBeenCalledWith("MSH|test-message-1");
        socket.destroy();
    });

    it("handles two messages sent back to back in the same write, replying to each in order", async () => {
        const { port } = await start();
        const socket = await connect(port);
        const replies = replyCollector(socket);
        socket.write(Buffer.concat([frame("first"), frame("second")]));
        expect(await replies.next()).toBe("ACK-FOR:first");
        expect(await replies.next()).toBe("ACK-FOR:second");
        socket.destroy();
    });

    it("reassembles a message split across multiple TCP writes (a frame arriving in chunks)", async () => {
        const { port } = await start();
        const socket = await connect(port);
        const replies = replyCollector(socket);
        const whole = frame("split-message");
        socket.write(whole.subarray(0, 5));
        await new Promise((r) => setTimeout(r, 20));
        socket.write(whole.subarray(5));
        expect(await replies.next()).toBe("ACK-FOR:split-message");
        socket.destroy();
    });

    it("preserves ACK order even when the handler resolves out of order across messages", async () => {
        const order = ["slow", "fast"];
        const handler = vi.fn(async (raw: string) => {
            if (raw === "slow") await new Promise((r) => setTimeout(r, 30));
            return `ACK:${raw}`;
        });
        const { close, server } = await startMllpServer({ handler, port: 0, host: "127.0.0.1" });
        cleanup = close;
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("expected a TCP address");
        const socket = await connect(address.port);
        const replies = replyCollector(socket);
        socket.write(Buffer.concat([frame(order[0]), frame(order[1])]));
        expect(await replies.next()).toBe("ACK:slow");
        expect(await replies.next()).toBe("ACK:fast");
        socket.destroy();
    });

    it("drops a connection that exceeds maxMessageBytes without ever completing a frame", async () => {
        const onError = vi.fn();
        const { port } = await start({ maxMessageBytes: 100, onError });
        const socket = await connect(port);
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        // Never send FS/CR — an unterminated, oversized frame.
        socket.write(Buffer.concat([Buffer.from([VT]), Buffer.alloc(200, 0x41)]));
        await closed;
        expect(onError).toHaveBeenCalled();
    });

    it("refuses a new connection once maxConcurrentConnections is reached", async () => {
        const { port } = await start({ maxConcurrentConnections: 1 });
        const first = await connect(port);
        const second = await connect(port);
        const secondClosed = new Promise<void>((resolve) => second.once("close", resolve));
        await secondClosed;
        first.destroy();
    });

    it("createMllpServer builds a server without starting it (caller controls listen)", () => {
        const server = createMllpServer({ handler: async () => "x", port: 0 });
        expect(server.listening).toBe(false);
        server.close();
    });
});
