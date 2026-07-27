import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface OpenTerminal {
    id: string;
    name: string;
    alive: boolean;
}

// A human-facing interactive terminal panel — separate from the model's
// create_terminal/write_to_terminal/etc. tool calls (which poll instead of
// streaming; see terminal-manager.ts). Keeps exactly one xterm.js instance
// mounted and swaps which terminal's buffered + live output feeds into it
// when switching tabs, rather than keeping N instances mounted at once.
export function TerminalPanel({ workspaceRoot, onClose }: { workspaceRoot: string; onClose: () => void }) {
    const [terminals, setTerminals] = useState<OpenTerminal[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const activeIdRef = useRef<string | null>(null);
    // Full output ever seen per terminal, so switching tabs can replay it —
    // xterm itself only holds whatever's currently written to its one
    // mounted instance.
    const buffersRef = useRef<Map<string, string>>(new Map());

    useEffect(() => {
        if (!containerRef.current) return;
        const term = new XTerm({
            convertEol: true,
            fontSize: 13,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            theme: { background: "#00000000" },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        fit.fit();
        xtermRef.current = term;
        fitRef.current = fit;

        term.onData((data) => {
            if (activeIdRef.current) window.api.terminal.write(activeIdRef.current, data);
        });

        const resizeObserver = new ResizeObserver(() => {
            fit.fit();
            if (activeIdRef.current) window.api.terminal.resize(activeIdRef.current, term.cols, term.rows);
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
            term.dispose();
            xtermRef.current = null;
        };
        // Intentionally mount once — the panel keeps one xterm instance for
        // its whole lifetime and re-targets it on tab switches instead.
    }, []);

    function handleData(id: string, chunk: string) {
        buffersRef.current.set(id, (buffersRef.current.get(id) ?? "") + chunk);
        if (activeIdRef.current === id) xtermRef.current?.write(chunk);
    }

    function handleExit(id: string, exitCode: number) {
        setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, alive: false } : t)));
        const note = `\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`;
        buffersRef.current.set(id, (buffersRef.current.get(id) ?? "") + note);
        if (activeIdRef.current === id) xtermRef.current?.write(note);
    }

    function switchTo(id: string) {
        setActiveId(id);
        activeIdRef.current = id;
        xtermRef.current?.reset();
        const buffered = buffersRef.current.get(id);
        if (buffered) xtermRef.current?.write(buffered);
        if (fitRef.current) fitRef.current.fit();
    }

    async function createNewTerminal() {
        let id = "";
        const created = await window.api.terminal.create(
            workspaceRoot,
            {},
            (chunk) => handleData(id, chunk),
            (exitCode) => handleExit(id, exitCode)
        );
        id = created.id;
        buffersRef.current.set(id, "");
        setTerminals((prev) => [...prev, { id, name: created.name, alive: true }]);
        switchTo(id);
    }

    async function closeTerminalTab(id: string) {
        await window.api.terminal.close(id);
        buffersRef.current.delete(id);
        setTerminals((prev) => {
            const remaining = prev.filter((t) => t.id !== id);
            if (activeIdRef.current === id) {
                const next = remaining.at(-1);
                if (next) switchTo(next.id);
                else {
                    setActiveId(null);
                    activeIdRef.current = null;
                    xtermRef.current?.reset();
                }
            }
            return remaining;
        });
    }

    // Opens with one terminal already running rather than an empty panel.
    // Intentional one-shot on mount — createNewTerminal's own setState call
    // happens asynchronously after the IPC round-trip, not synchronously
    // within this effect, and it's deliberately not in the deps array since
    // this should run exactly once regardless of how `terminals` changes
    // afterward.
    /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
    useEffect(() => {
        if (terminals.length === 0) void createNewTerminal();
    }, []);
    /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

    return (
        <div className="flex h-64 flex-col border-t border-border/70 bg-card">
            <div className="flex items-center gap-1 border-b border-border/70 px-2 py-1.5">
                <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="flex flex-1 items-center gap-1 overflow-x-auto">
                    {terminals.map((t) => (
                        <button
                            key={t.id}
                            onClick={() => switchTo(t.id)}
                            className={cn(
                                "group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                                t.id === activeId ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"
                            )}
                        >
                            <span className={cn("size-1.5 rounded-full", t.alive ? "bg-emerald-500" : "bg-muted-foreground/50")} />
                            {t.name}
                            <X
                                className="size-3 opacity-0 hover:text-destructive group-hover:opacity-100"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void closeTerminalTab(t.id);
                                }}
                            />
                        </button>
                    ))}
                </div>
                <Button size="icon" variant="ghost" className="size-6" onClick={() => void createNewTerminal()} aria-label="New terminal">
                    <Plus className="size-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="size-6" onClick={onClose} aria-label="Close terminal panel">
                    <X className="size-3.5" />
                </Button>
            </div>
            <div ref={containerRef} className="min-h-0 flex-1 px-2 py-1" />
        </div>
    );
}
