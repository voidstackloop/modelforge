import { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import "highlight.js/styles/github-dark.css";

// Hoisted to module scope: react-markdown rebuilds its unified processor
// whenever these array/object references change, so keeping them stable
// across renders avoids redoing that work on every streamed token.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
    const [copied, setCopied] = useState(false);
    const text = String(children).replace(/\n$/, "");
    const language = className?.replace("hljs language-", "").replace("language-", "").trim();

    async function handleCopy() {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <div className="my-2 overflow-hidden rounded-lg border border-border">
            <div className="flex items-center justify-between bg-muted px-3 py-1 text-xs text-muted-foreground">
                <span>{language || "text"}</span>
                <button onClick={handleCopy} className="flex items-center gap-1 hover:text-foreground">
                    {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
                <code className={className}>{children}</code>
            </pre>
        </div>
    );
}

// isStreaming gates Mermaid rendering: a ```mermaid block is invalid syntax
// for most of the time it's still being typed out token by token, so we show
// it as a plain code block until the message is done, then swap it for the
// live diagram — same pattern the agent write_file preview already uses for
// its diff view.
function createComponents(isStreaming: boolean): Components {
    return {
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
                return (
                    <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]" {...props}>
                        {children}
                    </code>
                );
            }
            const language = className?.replace("hljs language-", "").replace("language-", "").trim();
            if (language === "mermaid" && !isStreaming) {
                return <MermaidDiagram code={String(children).replace(/\n$/, "")} />;
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
        },
        a: ({ className, ...props }) => (
            <a
                className={cn(className, "underline underline-offset-2")}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
            />
        ),
    };
}

const STATIC_COMPONENTS = createComponents(false);

export const Markdown = memo(function Markdown({ content, isStreaming = false }: { content: string; isStreaming?: boolean }) {
    const components = useMemo(() => (isStreaming ? createComponents(true) : STATIC_COMPONENTS), [isStreaming]);
    return (
        <div className="prose-chat">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
                {content}
            </ReactMarkdown>
        </div>
    );
});
