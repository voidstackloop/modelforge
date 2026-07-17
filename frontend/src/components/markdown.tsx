import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import "highlight.js/styles/github-dark.css";

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

export function Markdown({ content }: { content: string }) {
    return (
        <div className="prose-chat">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
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
                        return <CodeBlock className={className}>{children}</CodeBlock>;
                    },
                    a: ({ className, ...props }) => (
                        <a className={cn(className, "underline underline-offset-2")} target="_blank" rel="noreferrer" {...props} />
                    ),
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
