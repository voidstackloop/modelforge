import { Check, Loader2, ShieldQuestion, SquarePen, Wrench, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ds";
import { canAlwaysAllow } from "@/lib/tool-approval";
import { computeLineDiff, type DiffLine } from "@/lib/diff";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ToolCall } from "@/types/electron";

const MAX_RENDERED_DIFF_LINES = 400;

// apply_patch's argument is already a unified diff — no need to run it
// through computeLineDiff (that's for turning two full texts into a diff);
// this just re-tags each line by its existing +/-/context prefix so it can
// share the same colored <pre> rendering as write_file/replace_in_file.
function parseUnifiedPatch(patch: string): DiffLine[] {
    return patch.split("\n").map((line): DiffLine => {
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
            return { type: "same", text: line };
        }
        if (line.startsWith("+")) return { type: "add", text: line.slice(1) };
        if (line.startsWith("-")) return { type: "remove", text: line.slice(1) };
        return { type: "same", text: line.startsWith(" ") ? line.slice(1) : line };
    });
}

function DiffPreview({ lines }: { lines: DiffLine[] }) {
    return (
        <pre className="max-h-64 overflow-auto rounded border border-border bg-background p-2 font-mono text-xs">
            {lines.slice(0, MAX_RENDERED_DIFF_LINES).map((line, idx) => (
                <div
                    key={idx}
                    className={cn(
                        "whitespace-pre-wrap",
                        line.type === "add" && "bg-success/15 text-success",
                        line.type === "remove" && "bg-destructive/15 text-destructive"
                    )}
                >
                    {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                    {line.text}
                </div>
            ))}
            {lines.length > MAX_RENDERED_DIFF_LINES && (
                <div className="text-muted-foreground">… {lines.length - MAX_RENDERED_DIFF_LINES} more lines</div>
            )}
        </pre>
    );
}

/** A pending agent-tool-call awaiting the user's decision: what operation is
 * requested, its risk level, and Allow/Deny/Always-allow — extracted from
 * Chat.tsx's inline JSX (formerly ~113 lines duplicated across the checkpoint
 * and normal-tool-call branches) so the two card layouts share one place. */
export function ToolApprovalCard({
    call,
    writeDiffPreview,
    onRespond,
    onRespondCheckpoint,
    onAlwaysAllow,
}: {
    call: ToolCall;
    writeDiffPreview?: { oldContent: string | null };
    onRespond: (call: ToolCall, approve: boolean) => void;
    onRespondCheckpoint: (call: ToolCall, shouldContinue: boolean) => void;
    onAlwaysAllow: (call: ToolCall) => void;
}) {
    const { t } = useI18n();

    if (call.name === "request_checkpoint") {
        const summary = String(call.arguments.summary ?? "");
        const question = call.arguments.question ? String(call.arguments.question) : null;
        return (
            <div className="flex max-w-[85%] flex-col gap-2.5 self-start rounded-lg border border-primary/30 bg-primary/5 p-3.5 text-sm">
                <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                    <ShieldQuestion className="size-3.5" /> {t.agentCheckpoint}
                </div>
                <p>{summary}</p>
                {question && <p className="text-muted-foreground">{question}</p>}
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => onRespondCheckpoint(call, true)} className="gap-1.5">
                        <Check className="size-3.5" /> {t.continueAgent}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onRespondCheckpoint(call, false)} className="gap-1.5">
                        <X className="size-3.5" /> {t.stopAgent}
                    </Button>
                </div>
            </div>
        );
    }

    const isWrite = call.name === "write_file";
    const isReplace = call.name === "replace_in_file";
    const isPatch = call.name === "apply_patch";
    const modifiesFiles = isWrite || isReplace || isPatch;

    const newContent = String(call.arguments.content ?? "");
    const writeDiffLines = isWrite && writeDiffPreview ? computeLineDiff(writeDiffPreview.oldContent ?? "", newContent) : null;
    const replaceDiffLines = isReplace
        ? computeLineDiff(String(call.arguments.old_text ?? ""), String(call.arguments.new_text ?? ""))
        : null;
    const patchDiffLines = isPatch ? parseUnifiedPatch(String(call.arguments.patch ?? "")) : null;
    const isNewFile = isWrite && writeDiffPreview?.oldContent === null;

    return (
        <div className="flex max-w-[85%] flex-col gap-2.5 self-start rounded-lg border border-border bg-muted/50 p-3.5 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
                {modifiesFiles ? <SquarePen className="size-3.5 text-warning" /> : <Wrench className="size-3.5 text-muted-foreground" />}
                <span className="font-mono text-xs font-medium">{call.name}</span>
                {modifiesFiles && <StatusBadge tone="warning">{t.modifiesFiles}</StatusBadge>}
                {isNewFile && <StatusBadge tone="info">{t.newFile}</StatusBadge>}
            </div>

            {isWrite ? (
                <div className="flex flex-col gap-1.5">
                    <p className="truncate font-mono text-xs text-muted-foreground">{String(call.arguments.path ?? "")}</p>
                    {writeDiffLines ? <DiffPreview lines={writeDiffLines} /> : <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                </div>
            ) : isReplace ? (
                <div className="flex flex-col gap-1.5">
                    <p className="truncate font-mono text-xs text-muted-foreground">
                        {String(call.arguments.path ?? "")}
                        {call.arguments.replace_all ? ` · ${t.replaceAllOccurrences}` : ""}
                    </p>
                    <DiffPreview lines={replaceDiffLines!} />
                </div>
            ) : isPatch ? (
                <DiffPreview lines={patchDiffLines!} />
            ) : (
                <p className="truncate font-mono text-xs text-muted-foreground">
                    {Object.entries(call.arguments)
                        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                        .join(", ")}
                </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => onRespond(call, true)} className="gap-1.5">
                    <Check className="size-3.5" /> {t.allow}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onRespond(call, false)} className="gap-1.5">
                    <X className="size-3.5" /> {t.deny}
                </Button>
                {canAlwaysAllow(call.name) && (
                    <Button size="sm" variant="ghost" onClick={() => onAlwaysAllow(call)} className="text-xs text-muted-foreground">
                        {t.alwaysAllowThisSession}
                    </Button>
                )}
            </div>
        </div>
    );
}
