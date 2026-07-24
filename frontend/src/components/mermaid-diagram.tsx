import { useEffect, useId, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTheme } from "@/components/theme-provider";

// Loaded lazily and cached: mermaid is a large library that most sessions
// never touch a diagram in, so it shouldn't add to every app boot's parse
// and eval cost — only fetched the first time a ```mermaid block is seen.
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
    if (!mermaidPromise) mermaidPromise = import("mermaid");
    return mermaidPromise;
}

function useIsDark() {
    const { theme } = useTheme();
    const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

    useEffect(() => {
        const mql = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => setSystemDark(mql.matches);
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    return theme === "system" ? systemDark : theme === "dark";
}

// Only invoked once a fenced ```mermaid block's content has stopped changing
// (see markdown.tsx) — mermaid.render() throws on the truncated/invalid
// syntax a diagram has while it's still streaming in token by token, and on
// error it also injects a stray error SVG into document.body, not just the
// target element, so we validate with parse() first and never call render()
// on text we know is incomplete.
export function MermaidDiagram({ code }: { code: string }) {
    const rawId = useId();
    const diagramId = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
    const isDark = useIsDark();
    const [svg, setSvg] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            const { default: mermaid } = await loadMermaid();
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: "strict",
                fontFamily: "inherit",
                theme: isDark ? "dark" : "default",
            });

            const valid = await mermaid.parse(code, { suppressErrors: true });
            if (!valid) {
                if (!cancelled) setError("Couldn't parse this as a Mermaid diagram.");
                return;
            }
            try {
                const { svg: rendered } = await mermaid.render(diagramId, code);
                if (!cancelled) {
                    setSvg(rendered);
                    setError(null);
                }
            } catch {
                if (!cancelled) setError("Couldn't render this Mermaid diagram.");
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [code, diagramId, isDark]);

    if (error) {
        return (
            <div className="my-2 flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="size-3.5 shrink-0" /> {error}
            </div>
        );
    }

    if (!svg) {
        return <div className="my-2 h-24 animate-pulse rounded-lg bg-muted/50" />;
    }

    // Mermaid's own sanitized SVG output — safe under securityLevel: "strict",
    // which strips script tags and dangerous attributes before we get here.
    return <div className="mermaid-diagram my-2 overflow-x-auto rounded-lg border border-border bg-background p-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}
