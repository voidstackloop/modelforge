import { memo, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
    Send,
    Sparkles,
    Paperclip,
    FolderOpen,
    X,
    Square,
    Copy,
    Check,
    Pencil,
    RotateCcw,
    SlidersHorizontal,
    ArrowDown,
    RotateCw,
    FileDown,
    BookMarked,
    Database,
    Loader2,
    Image as ImageIcon,
    Bot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { useSessions } from "@/lib/sessions-context";
import { useI18n } from "@/lib/i18n";
import { OPENAI_MODELS, ANTHROPIC_MODELS, formatModelRef, parseModelRef } from "@/lib/providers";
import { estimateCost, formatCost } from "@/lib/pricing";
import type {
    ChatMessage,
    OllamaModel,
    AppSettings,
    AttachedFile,
    ImageAttachment,
    TextAttachment,
    ProviderId,
    ChatOptions,
    UsageInfo,
    ToolCall,
} from "@/types/electron";

type Attachment = AttachedFile & { folder?: string };

interface RagFolder {
    folderPath: string;
    folderName: string;
    indexId: string;
    chunkCount: number;
}

const CUSTOM_SENTINEL = "__custom__";
// Above this combined size, index the folder for retrieval instead of dumping
// every file's full content into the prompt (which would blow out context on
// smaller models and waste tokens on larger ones).
const RAG_THRESHOLD_CHARS = 20_000;
// Read-only tools are safe to let the model call repeatedly without a fresh
// click each time — write_file and run_command always require explicit
// per-call approval since they have real, potentially irreversible effects.
const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "search_files"]);
// Caps how many automatic tool-result -> model-continuation round trips can
// happen for a single user turn, so a model that keeps calling tools without
// ever producing a final answer can't loop indefinitely.
const AGENT_MAX_STEPS = 25;

function buildMessageContent(text: string, attachments: Attachment[], ragContent = "") {
    const fileBlocks = attachments
        .map((f) => `File: ${f.name}${f.truncated ? " (truncated)" : ""}\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n");
    const combined = [ragContent.trim(), fileBlocks].filter(Boolean).join("\n\n");
    if (!combined) return text;
    return text ? `${combined}\n\n${text}` : combined;
}

function deriveTitle(text: string) {
    const trimmed = text.trim().replace(/\s+/g, " ");
    return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

interface MessageBubbleProps {
    message: ChatMessage;
    index: number;
    isLastAssistant: boolean;
    isStreaming: boolean;
    copied: boolean;
    provider: ProviderId | undefined;
    modelId: string | undefined;
    onCopy: (text: string, index: number) => void;
    onEdit: (index: number) => void;
    onRegenerate: () => void;
}

// Memoized so a token arriving mid-stream (which only replaces the last
// message in the array) doesn't force every prior message — including its
// markdown parse/highlight pass — to re-render on every chunk. `message`
// keeps referential equality for all but the actively-streaming entry, so
// the default shallow-prop comparison already does the right thing here.
const MessageBubble = memo(function MessageBubble({
    message: m,
    index: i,
    isLastAssistant,
    isStreaming,
    copied,
    provider,
    modelId,
    onCopy,
    onEdit,
    onRegenerate,
}: MessageBubbleProps) {
    const { t } = useI18n();

    if (m.role === "tool") {
        return (
            <div className="flex flex-col items-start">
                <div className="max-w-[85%] rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
                    <div className="mb-1 font-sans font-medium text-foreground">
                        🔧 {m.toolName} {t.toolResult}
                    </div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{m.content}</pre>
                </div>
            </div>
        );
    }

    return (
        <div className={cn("group flex flex-col", m.role === "user" ? "items-end" : "items-start")}>
            {m.toolCalls && m.toolCalls.length > 0 && (
                <div className="mb-1 flex max-w-[75%] flex-col gap-1">
                    {m.toolCalls.map((tc) => (
                        <div
                            key={tc.id}
                            className="rounded-lg border border-border bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground"
                        >
                            🔧 {tc.name}({Object.entries(tc.arguments).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")})
                        </div>
                    ))}
                </div>
            )}
            {(m.content || (isStreaming && isLastAssistant) || !m.toolCalls?.length) && (
                <div
                    className={cn(
                        "max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                        m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    )}
                >
                    {m.images && m.images.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                            {m.images.map((img, imgIdx) => (
                                <img
                                    key={imgIdx}
                                    src={`data:${img.mimeType};base64,${img.data}`}
                                    alt="attachment"
                                    className="h-20 w-20 rounded-lg object-cover"
                                />
                            ))}
                        </div>
                    )}
                    {m.content ? <Markdown content={m.content} /> : isStreaming && isLastAssistant ? "…" : ""}
                </div>
            )}
            <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                    onClick={() => onCopy(m.content, i)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Copy message"
                >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </button>
                {m.role === "user" && !isStreaming && (
                    <button
                        onClick={() => onEdit(i)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Edit message"
                    >
                        <Pencil className="size-3.5" />
                    </button>
                )}
                {isLastAssistant && !isStreaming && (
                    <button
                        onClick={onRegenerate}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Regenerate response"
                    >
                        <RotateCcw className="size-3.5" />
                    </button>
                )}
                {m.role === "assistant" && m.usage && (
                    <span className="self-center px-1 text-xs text-muted-foreground">
                        {formatUsage(m.usage, provider, modelId)}
                    </span>
                )}
            </div>
        </div>
    );
},
// Custom comparator: onCopy/onEdit/onRegenerate are plain function
// declarations on the parent that get a new identity every render, but they
// only run on click — comparing them would defeat the whole point of
// memoizing (they'd "change" every render even though the message didn't).
(prev, next) =>
    prev.message === next.message &&
    prev.index === next.index &&
    prev.isLastAssistant === next.isLastAssistant &&
    prev.isStreaming === next.isStreaming &&
    prev.copied === next.copied &&
    prev.provider === next.provider &&
    prev.modelId === next.modelId
);

function formatUsage(usage: UsageInfo, provider: ProviderId | undefined, modelId: string | undefined): string {
    const total = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    const tokenLabel = `${total.toLocaleString()} tokens`;
    if (provider === "ollama") return `${tokenLabel} · local`;
    const cost = modelId ? estimateCost(modelId, usage.promptTokens, usage.completionTokens) : null;
    return cost !== null ? `${tokenLabel} · ~${formatCost(cost)}` : tokenLabel;
}

export default function Chat() {
    const { sessionId } = useParams();
    const navigate = useNavigate();
    const { sessions, projects, loading, hasApi, createSession, refresh } = useSessions();
    const { t } = useI18n();

    const [models, setModels] = useState<OllamaModel[]>([]);
    const [model, setModel] = useState<string>("");
    const [pendingCustomProvider, setPendingCustomProvider] = useState<ProviderId | null>(null);
    const [customModelInput, setCustomModelInput] = useState("");
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [ragFolders, setRagFolders] = useState<RagFolder[]>([]);
    const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
    const [indexingFolder, setIndexingFolder] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
    const [params, setParams] = useState<ChatOptions>({});
    const [sessionSystemPrompt, setSessionSystemPrompt] = useState<string | null>(null);
    const [agentMode, setAgentMode] = useState(false);
    const [agentWorkspace, setAgentWorkspace] = useState<string | null>(null);
    const [pendingToolCalls, setPendingToolCalls] = useState<ToolCall[]>([]);
    const [agentStepCount, setAgentStepCount] = useState(0);
    const [autoApprovedTools, setAutoApprovedTools] = useState<Set<string>>(new Set());
    const [newPresetName, setNewPresetName] = useState("");
    const [autoScroll, setAutoScroll] = useState(true);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);

    // No session selected yet: pick the most recent one, or create a new one.
    useEffect(() => {
        if (!hasApi || loading || sessionId) return;
        (async () => {
            if (sessions.length > 0) {
                navigate(`/chat/${sessions[0].id}`, { replace: true });
            } else {
                const s = await createSession(null);
                navigate(`/chat/${s.id}`, { replace: true });
            }
        })();
    }, [hasApi, loading, sessionId, sessions, navigate, createSession]);

    useEffect(() => {
        if (!hasApi) return;
        window.api.settings.get().then(setSettings);
        window.api.ollama.listModels().then(setModels);
    }, [hasApi]);

    useEffect(() => {
        if (!hasApi || !sessionId) return;
        window.api.sessions.get(sessionId).then((session) => {
            if (!session) return;
            setMessages(session.messages);
            if (session.model) setModel(session.model);
            setParams(session.params ?? {});
            setSessionSystemPrompt(session.systemPrompt ?? null);
            setAgentMode(session.agentMode ?? false);
            setAgentWorkspace(session.agentWorkspace ?? null);
            setPendingToolCalls([]);
            setAgentStepCount(0);
            setAutoApprovedTools(new Set());
            setAutoScroll(true);
            setShowScrollButton(false);
        });
    }, [hasApi, sessionId]);

    useEffect(() => {
        // Intentional: seeds the model once models/settings finish loading, without
        // clobbering a value the user (or the loaded session) already set.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setModel((current) => current || settings?.defaultModel || (models[0] ? formatModelRef("ollama", models[0].name) : ""));
    }, [models, settings]);

    useEffect(() => {
        if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, autoScroll]);

    // Track whether the user has scrolled away from the bottom so streaming
    // tokens don't yank them back down while they're reading earlier messages.
    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        function onScroll() {
            const distanceFromBottom = viewport!.scrollHeight - viewport!.scrollTop - viewport!.clientHeight;
            const nearBottom = distanceFromBottom < 80;
            setAutoScroll(nearBottom);
            setShowScrollButton(!nearBottom);
        }
        viewport.addEventListener("scroll", onScroll);
        return () => viewport.removeEventListener("scroll", onScroll);
    }, [sessionId]);

    function scrollToBottom() {
        setAutoScroll(true);
        setShowScrollButton(false);
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }

    const currentSessionTitle = sessions.find((s) => s.id === sessionId)?.title;
    useEffect(() => {
        document.title = currentSessionTitle ? `${currentSessionTitle} · Modelforge` : "Modelforge";
    }, [currentSessionTitle]);

    // Escape stops an in-flight generation.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape" && isStreaming && activeRequestId) {
                window.api.chat.cancel(activeRequestId);
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isStreaming, activeRequestId]);

    function handleModelChange(value: string | null) {
        if (!value) return;
        const parsed = parseModelRef(value);
        if (parsed && parsed.modelId === CUSTOM_SENTINEL) {
            setPendingCustomProvider(parsed.provider);
            setCustomModelInput("");
            return;
        }
        setModel(value);
    }

    function updateParam(partial: Partial<ChatOptions>) {
        const next = { ...params, ...partial };
        setParams(next);
        if (sessionId) window.api.sessions.update(sessionId, { params: next });
    }

    function resetParams() {
        setParams({});
        if (sessionId) window.api.sessions.update(sessionId, { params: {} });
    }

    async function toggleAgentMode() {
        if (!sessionId) return;
        if (!agentMode && !agentWorkspace) {
            // Turning agent mode on for the first time in this chat: require a
            // workspace folder up front rather than letting tool calls fail later.
            const folder = await window.api.agent.pickWorkspace();
            if (!folder) return;
            setAgentWorkspace(folder);
            setAgentMode(true);
            window.api.sessions.update(sessionId, { agentMode: true, agentWorkspace: folder });
            return;
        }
        const next = !agentMode;
        setAgentMode(next);
        window.api.sessions.update(sessionId, { agentMode: next });
    }

    async function changeAgentWorkspace() {
        if (!sessionId) return;
        const folder = await window.api.agent.pickWorkspace();
        if (!folder) return;
        setAgentWorkspace(folder);
        window.api.sessions.update(sessionId, { agentWorkspace: folder });
    }

    function confirmCustomModel() {
        const id = customModelInput.trim();
        if (pendingCustomProvider && id) {
            setModel(formatModelRef(pendingCustomProvider, id));
        }
        setPendingCustomProvider(null);
        setCustomModelInput("");
    }

    async function handleAttachFiles() {
        const files = await window.api.files.openAndRead();
        if (files.length === 0) return;
        setAttachments((prev) => {
            const existing = new Set(prev.map((f) => f.path));
            return [...prev, ...files.filter((f) => !existing.has(f.path))];
        });
    }

    async function handleAttachMedia() {
        const items = await window.api.files.openMedia();
        if (items.length === 0) return;

        const images = items.filter((i): i is ImageAttachment => i.kind === "image");
        const texts = items.filter((i): i is TextAttachment => i.kind === "text");

        if (images.length > 0) {
            setImageAttachments((prev) => {
                const existing = new Set(prev.map((f) => f.path));
                return [...prev, ...images.filter((f) => !existing.has(f.path))];
            });
        }
        if (texts.length > 0) {
            setAttachments((prev) => {
                const existing = new Set(prev.map((f) => f.path));
                return [...prev, ...texts.filter((f) => !existing.has(f.path))];
            });
        }
    }

    function removeImageAttachment(path: string) {
        setImageAttachments((prev) => prev.filter((f) => f.path !== path));
    }

    async function handleAttachFolder() {
        const result = await window.api.files.openFolderAndRead();
        if (!result || result.files.length === 0) return;

        const totalChars = result.files.reduce((sum, f) => sum + f.content.length, 0);
        if (totalChars > RAG_THRESHOLD_CHARS) {
            setIndexingFolder(true);
            const indexResult = await window.api.rag.indexFiles(result.files);
            setIndexingFolder(false);
            if (indexResult.embedded) {
                setRagFolders((prev) => [
                    ...prev,
                    {
                        folderPath: result.folderPath,
                        folderName: result.folderName,
                        indexId: indexResult.indexId,
                        chunkCount: indexResult.chunkCount,
                    },
                ]);
                return;
            }
            // No embedding model available (e.g. nomic-embed-text isn't pulled) —
            // fall through to the old full-dump behavior rather than failing.
        }

        setAttachments((prev) => {
            const existing = new Set(prev.map((f) => f.path));
            const tagged = result.files
                .filter((f) => !existing.has(f.path))
                .map((f) => ({ ...f, folder: result.folderName }));
            return [...prev, ...tagged];
        });
    }

    function removeAttachment(path: string) {
        setAttachments((prev) => prev.filter((f) => f.path !== path));
    }

    function removeRagFolder(folderPath: string) {
        setRagFolders((prev) => prev.filter((f) => f.folderPath !== folderPath));
    }

    function removeFolder(folder: string) {
        setAttachments((prev) => prev.filter((f) => f.folder !== folder));
    }

    function getCurrentProject() {
        const currentProjectId = sessions.find((s) => s.id === sessionId)?.projectId;
        return currentProjectId ? projects.find((p) => p.id === currentProjectId) : undefined;
    }

    // Fallback chain: this chat's own override -> its project's default -> the global default.
    function effectiveOptions(): ChatOptions {
        const project = getCurrentProject();
        return {
            temperature: params.temperature ?? project?.params?.temperature ?? settings?.temperature,
            topP: params.topP ?? project?.params?.topP ?? settings?.topP,
            maxTokens: params.maxTokens ?? project?.params?.maxTokens ?? settings?.maxTokens,
            frequencyPenalty:
                params.frequencyPenalty ?? project?.params?.frequencyPenalty ?? settings?.frequencyPenalty,
            presencePenalty: params.presencePenalty ?? project?.params?.presencePenalty ?? settings?.presencePenalty,
            contextLength: params.contextLength ?? project?.params?.contextLength ?? settings?.contextLength,
        };
    }

    async function handleExportChat() {
        if (sessionId) await window.api.data.exportSession(sessionId);
    }

    async function runCompletion(
        history: ChatMessage[],
        baseMessages: ChatMessage[],
        opts: { isFirstMessage: boolean; titleSource: string }
    ) {
        const parsed = parseModelRef(model);
        if (!parsed || !sessionId) return;

        setMessages([...baseMessages, { role: "assistant", content: "" }]);
        setIsStreaming(true);
        // Called directly (not via a useEffect) so it still fires even if this
        // component unmounts mid-stream — e.g. the user navigates to Settings
        // while a response is generating. An effect tied to component state
        // would never get to report "done" in that case, leaving the main
        // process thinking a generation is still in flight forever.
        window.api.app.setBusy(true);

        const { requestId, promise } = window.api.chat.send(
            parsed.provider,
            parsed.modelId,
            history,
            effectiveOptions(),
            (chunk) => {
                const piece = chunk.message?.content ?? "";
                if (!piece && !chunk.usage && !chunk.toolCalls) return;
                setMessages((m) => {
                    const next = [...m];
                    const last = next[next.length - 1];
                    next[next.length - 1] = {
                        role: "assistant",
                        content: last.content + piece,
                        usage: chunk.usage
                            ? {
                                  promptTokens: chunk.usage.promptTokens ?? last.usage?.promptTokens,
                                  completionTokens: chunk.usage.completionTokens ?? last.usage?.completionTokens,
                              }
                            : last.usage,
                        toolCalls: chunk.toolCalls ? [...(last.toolCalls ?? []), ...chunk.toolCalls] : last.toolCalls,
                    };
                    return next;
                });
            },
            agentMode && !!agentWorkspace
        );
        setActiveRequestId(requestId);
        const result = await promise;
        setActiveRequestId(null);

        if (result.error) {
            setMessages((m) => {
                const next = [...m];
                next[next.length - 1] = { role: "assistant", content: `⚠️ ${result.error}` };
                return next;
            });
        }

        setIsStreaming(false);
        window.api.app.setBusy(false);
        setMessages((finalMessages) => {
            const last = finalMessages[finalMessages.length - 1];
            if (!result.error && last?.role === "assistant" && last.toolCalls && last.toolCalls.length > 0) {
                setPendingToolCalls(last.toolCalls);
                // Tools the user already trusted this session skip the
                // confirmation card and resolve themselves immediately.
                for (const call of last.toolCalls) {
                    if (autoApprovedTools.has(call.name)) respondToToolCall(call, true);
                }
            }
            window.api.sessions
                .update(sessionId, {
                    messages: finalMessages,
                    model,
                    params,
                    ...(opts.isFirstMessage ? { title: deriveTitle(opts.titleSource) } : {}),
                })
                .then(() => refresh());
            return finalMessages;
        });
    }

    // Runs after every tool call from one assistant turn has been approved or
    // denied — feeds the tool results back to the model so it can continue
    // (e.g. read a file, then act on what it found) without the user having
    // to prompt again.
    function continueAfterTools(updatedMessages: ChatMessage[]) {
        if (agentStepCount >= AGENT_MAX_STEPS) {
            setMessages((m) => [
                ...m,
                {
                    role: "assistant",
                    content: `⚠️ Reached the agent step limit (${AGENT_MAX_STEPS}) for this turn. Send another message to let it continue.`,
                },
            ]);
            return;
        }
        setAgentStepCount((c) => c + 1);
        const history: ChatMessage[] = [...buildSystemMessages(), ...updatedMessages];
        runCompletion(history, updatedMessages, { isFirstMessage: false, titleSource: "" });
    }

    function alwaysAllowTool(call: ToolCall) {
        setAutoApprovedTools((prev) => new Set(prev).add(call.name));
        respondToToolCall(call, true);
    }

    async function respondToToolCall(call: ToolCall, approve: boolean) {
        let resultText: string;
        if (!approve) {
            resultText = "The user denied this tool call.";
        } else if (!agentWorkspace) {
            resultText = "Error: no workspace folder is set for this chat.";
        } else {
            const res = await window.api.agent.executeTool(agentWorkspace, call.name, call.arguments);
            resultText = res.error
                ? `Error: ${res.error}`
                : typeof res.result === "string"
                  ? res.result
                  : JSON.stringify(res.result, null, 2);
        }

        setPendingToolCalls((prev) => {
            const remaining = prev.filter((c) => c.id !== call.id);
            setMessages((m) => {
                const next: ChatMessage[] = [
                    ...m,
                    { role: "tool", content: resultText, toolCallId: call.id, toolName: call.name },
                ];
                if (remaining.length === 0) continueAfterTools(next);
                return next;
            });
            return remaining;
        });
    }

    function buildSystemMessages(): ChatMessage[] {
        const project = getCurrentProject();
        const effectivePrompt = sessionSystemPrompt ?? settings?.systemPrompt;
        const parts = [project?.instructions?.trim(), effectivePrompt?.trim()].filter(Boolean);
        return parts.length > 0 ? [{ role: "system" as const, content: parts.join("\n\n") }] : [];
    }

    function applyPromptPreset(prompt: string) {
        setSessionSystemPrompt(prompt);
        if (sessionId) window.api.sessions.update(sessionId, { systemPrompt: prompt });
    }

    function resetPromptToDefault() {
        setSessionSystemPrompt(null);
        if (sessionId) window.api.sessions.update(sessionId, { systemPrompt: null });
    }

    function updateSessionPromptText(value: string) {
        setSessionSystemPrompt(value);
        if (sessionId) window.api.sessions.update(sessionId, { systemPrompt: value });
    }

    async function saveCurrentAsPreset() {
        if (!settings) return;
        const name = newPresetName.trim();
        const prompt = sessionSystemPrompt ?? settings.systemPrompt;
        if (!name || !prompt.trim()) return;
        const preset = { id: crypto.randomUUID(), name, prompt };
        const updated = await window.api.settings.save({ promptPresets: [...settings.promptPresets, preset] });
        setSettings(updated);
        setNewPresetName("");
    }

    async function queryRagFolders(queryText: string): Promise<string> {
        if (ragFolders.length === 0) return "";
        const blocks: string[] = [];
        for (const folder of ragFolders) {
            const chunks = await window.api.rag.query(folder.indexId, queryText || folder.folderName, 8);
            for (const chunk of chunks) {
                blocks.push(`File: ${chunk.source} (from ${folder.folderName})\n\`\`\`\n${chunk.text}\n\`\`\``);
            }
        }
        return blocks.join("\n\n");
    }

    async function handleSend() {
        const text = input.trim();
        const parsed = parseModelRef(model);
        const hasAnything =
            text || attachments.length > 0 || ragFolders.length > 0 || imageAttachments.length > 0;
        if (!hasAnything || !parsed || isStreaming || !sessionId || pendingToolCalls.length > 0) {
            return;
        }

        const ragContent = await queryRagFolders(text);
        const content = buildMessageContent(text, attachments, ragContent);
        const titleSource =
            text || attachments[0]?.name || ragFolders[0]?.folderName || imageAttachments[0]?.name || "New chat";
        const images = imageAttachments.map((img) => ({ mimeType: img.mimeType, data: img.dataBase64 }));
        const baseMessages: ChatMessage[] = [
            ...messages,
            { role: "user", content, ...(images.length > 0 ? { images } : {}) },
        ];
        const history: ChatMessage[] = [...buildSystemMessages(), ...baseMessages];

        const isFirstMessage = messages.length === 0;
        setInput("");
        setAttachments([]);
        setRagFolders([]);
        setImageAttachments([]);
        setAgentStepCount(0);
        await runCompletion(history, baseMessages, { isFirstMessage, titleSource });
    }

    async function handleRegenerate() {
        if (isStreaming || messages.length === 0 || pendingToolCalls.length > 0) return;
        const lastIsAssistant = messages[messages.length - 1].role === "assistant";
        const baseMessages = lastIsAssistant ? messages.slice(0, -1) : messages;
        if (baseMessages.length === 0 || baseMessages[baseMessages.length - 1].role !== "user") return;

        const history: ChatMessage[] = [...buildSystemMessages(), ...baseMessages];
        await runCompletion(history, baseMessages, { isFirstMessage: false, titleSource: "" });
    }

    function handleEditUserMessage(index: number) {
        if (isStreaming || pendingToolCalls.length > 0) return;
        const msg = messages[index];
        if (msg.role !== "user") return;
        setInput(msg.content);
        setMessages(messages.slice(0, index));
        textareaRef.current?.focus();
    }

    function handleStop() {
        if (activeRequestId) window.api.chat.cancel(activeRequestId);
    }

    async function handleCopyMessage(text: string, index: number) {
        await navigator.clipboard.writeText(text);
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex((i) => (i === index ? null : i)), 1500);
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Chat features are only available when this page is running inside the Electron
                app, not a plain browser tab.
            </div>
        );
    }

    const parsedModel = parseModelRef(model);
    const individualAttachments = attachments.filter((f) => !f.folder);
    const folderGroups = Array.from(new Set(attachments.filter((f) => f.folder).map((f) => f.folder!))).map(
        (folder) => ({ folder, count: attachments.filter((f) => f.folder === folder).length })
    );
    const lastAssistantIndex = [...messages].map((m) => m.role).lastIndexOf("assistant");
    const currentProject = getCurrentProject();

    const sessionCost =
        parsedModel && parsedModel.provider !== "ollama"
            ? messages.reduce((sum, m) => {
                  if (m.role !== "assistant" || !m.usage) return sum;
                  const cost = estimateCost(parsedModel.modelId, m.usage.promptTokens, m.usage.completionTokens);
                  return sum + (cost ?? 0);
              }, 0)
            : 0;

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                {currentProject && (
                    <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                        {currentProject.name}
                    </span>
                )}
                <span className="text-sm text-muted-foreground">{t.model}</span>
                <Select value={model} onValueChange={handleModelChange}>
                    <SelectTrigger size="sm">
                        <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectLabel>Ollama (local)</SelectLabel>
                            {models.map((m) => (
                                <SelectItem key={m.name} value={formatModelRef("ollama", m.name)}>
                                    {m.name}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                        <SelectGroup>
                            <SelectLabel>ChatGPT</SelectLabel>
                            {OPENAI_MODELS.map((m) => (
                                <SelectItem key={m.id} value={formatModelRef("openai", m.id)}>
                                    {m.label}
                                </SelectItem>
                            ))}
                            <SelectItem value={formatModelRef("openai", CUSTOM_SENTINEL)}>Custom model ID...</SelectItem>
                        </SelectGroup>
                        <SelectGroup>
                            <SelectLabel>Claude</SelectLabel>
                            {ANTHROPIC_MODELS.map((m) => (
                                <SelectItem key={m.id} value={formatModelRef("anthropic", m.id)}>
                                    {m.label}
                                </SelectItem>
                            ))}
                            <SelectItem value={formatModelRef("anthropic", CUSTOM_SENTINEL)}>Custom model ID...</SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>

                {pendingCustomProvider && (
                    <div className="flex items-center gap-1.5">
                        <Input
                            autoFocus
                            value={customModelInput}
                            onChange={(e) => setCustomModelInput(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && confirmCustomModel()}
                            placeholder="exact model id..."
                            className="h-7 w-44 text-xs"
                        />
                        <Button size="sm" variant="outline" onClick={confirmCustomModel}>
                            Use
                        </Button>
                    </div>
                )}

                {models.length === 0 && (
                    <span className="text-xs text-muted-foreground">{t.noOllamaModelsInstalled}</span>
                )}

                <Button
                    size="sm"
                    variant={agentMode ? "default" : "outline"}
                    onClick={toggleAgentMode}
                    className="gap-1.5"
                    aria-pressed={agentMode}
                    title={agentWorkspace ? `Workspace: ${agentWorkspace}` : t.agentModeTooltip}
                >
                    <Bot className="size-3.5" />
                    {t.agentMode}
                    {agentMode && agentWorkspace ? ` · ${agentWorkspace.split(/[\\/]/).pop()}` : ""}
                </Button>
                {agentMode && (
                    <Button size="sm" variant="ghost" onClick={changeAgentWorkspace} className="text-xs text-muted-foreground">
                        {t.changeFolder}
                    </Button>
                )}
                {agentStepCount > 0 && (
                    <span className="text-xs text-muted-foreground" title={t.agentStepTooltip}>
                        {t.agentStep} {agentStepCount}/{AGENT_MAX_STEPS}
                    </span>
                )}

                {sessionCost > 0 && (
                    <span className="ml-auto text-xs text-muted-foreground" title="Estimated session cost">
                        ~{formatCost(sessionCost)}
                    </span>
                )}

                <Button
                    size="icon"
                    variant="outline"
                    className={sessionCost > 0 ? "" : "ml-auto"}
                    onClick={handleExportChat}
                    aria-label="Export chat"
                >
                    <FileDown className="size-4" />
                </Button>

                <Popover>
                    <PopoverTrigger
                        render={
                            <Button size="icon" variant="outline" className="relative" aria-label={t.promptLibrary}>
                                <BookMarked className="size-4" />
                                {sessionSystemPrompt !== null && (
                                    <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
                                )}
                            </Button>
                        }
                    />
                    <PopoverContent align="end" className="w-96">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">{t.promptLibrary}</span>
                            {sessionSystemPrompt !== null && (
                                <button
                                    onClick={resetPromptToDefault}
                                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                >
                                    <RotateCw className="size-3" /> {t.resetToDefault}
                                </button>
                            )}
                        </div>
                        {sessionSystemPrompt !== null && (
                            <p className="text-xs text-muted-foreground">{t.usingCustomPrompt}</p>
                        )}

                        <Textarea
                            value={sessionSystemPrompt ?? settings?.systemPrompt ?? ""}
                            onChange={(e) => updateSessionPromptText(e.target.value)}
                            className="mt-2 min-h-20 text-xs"
                            placeholder={t.systemPrompt}
                        />

                        {settings && settings.promptPresets.length > 0 && (
                            <div className="mt-3 flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">{t.promptLibrary}</label>
                                <div className="flex flex-col gap-1">
                                    {settings.promptPresets.map((preset) => (
                                        <button
                                            key={preset.id}
                                            onClick={() => applyPromptPreset(preset.prompt)}
                                            className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                                        >
                                            <span className="truncate font-medium">{preset.name}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="mt-3 flex gap-1.5">
                            <Input
                                value={newPresetName}
                                onChange={(e) => setNewPresetName(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && saveCurrentAsPreset()}
                                placeholder={t.presetName}
                                className="h-8 text-xs"
                            />
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={saveCurrentAsPreset}
                                disabled={!newPresetName.trim()}
                                className="shrink-0 whitespace-nowrap"
                            >
                                {t.save}
                            </Button>
                        </div>
                    </PopoverContent>
                </Popover>

                <Popover>
                    <PopoverTrigger
                        render={
                            <Button size="icon" variant="outline" aria-label="Model parameters">
                                <SlidersHorizontal className="size-4" />
                            </Button>
                        }
                    />
                    <PopoverContent align="end">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">Parameters</span>
                            <button
                                onClick={resetParams}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                            >
                                <RotateCw className="size-3" /> Reset
                            </button>
                        </div>
                        <p className="text-xs text-muted-foreground">Overrides for this chat only.</p>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Temperature</label>
                                <Input
                                    type="number"
                                    min={0}
                                    max={2}
                                    step={0.1}
                                    value={params.temperature ?? currentProject?.params?.temperature ?? settings?.temperature ?? ""}
                                    onChange={(e) => updateParam({ temperature: Number(e.target.value) })}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Top P</label>
                                <Input
                                    type="number"
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    value={params.topP ?? currentProject?.params?.topP ?? settings?.topP ?? ""}
                                    onChange={(e) => updateParam({ topP: Number(e.target.value) })}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Max tokens</label>
                                <Input
                                    type="number"
                                    min={1}
                                    step={1}
                                    value={params.maxTokens ?? currentProject?.params?.maxTokens ?? settings?.maxTokens ?? ""}
                                    onChange={(e) => updateParam({ maxTokens: Number(e.target.value) })}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">
                                    Context length{parsedModel?.provider !== "ollama" ? " (Ollama only)" : ""}
                                </label>
                                <Input
                                    type="number"
                                    min={512}
                                    step={512}
                                    value={params.contextLength ?? currentProject?.params?.contextLength ?? settings?.contextLength ?? ""}
                                    onChange={(e) => updateParam({ contextLength: Number(e.target.value) })}
                                    disabled={parsedModel?.provider !== "ollama"}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Freq. penalty</label>
                                <Input
                                    type="number"
                                    min={-2}
                                    max={2}
                                    step={0.1}
                                    value={params.frequencyPenalty ?? currentProject?.params?.frequencyPenalty ?? settings?.frequencyPenalty ?? ""}
                                    onChange={(e) => updateParam({ frequencyPenalty: Number(e.target.value) })}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Presence penalty</label>
                                <Input
                                    type="number"
                                    min={-2}
                                    max={2}
                                    step={0.1}
                                    value={params.presencePenalty ?? currentProject?.params?.presencePenalty ?? settings?.presencePenalty ?? ""}
                                    onChange={(e) => updateParam({ presencePenalty: Number(e.target.value) })}
                                    className="h-8 text-xs"
                                />
                            </div>
                        </div>
                    </PopoverContent>
                </Popover>
            </div>

            <div className="relative flex-1 overflow-hidden">
            <ScrollArea viewportRef={viewportRef} className="h-full">
                <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6 2xl:max-w-4xl">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center gap-2 py-24 text-center text-muted-foreground">
                            <Sparkles className="size-6" />
                            <p className="text-sm">{t.startConversationWith(parsedModel?.modelId || "a model")}</p>
                        </div>
                    )}
                    {messages.map((m, i) => (
                        <MessageBubble
                            key={i}
                            message={m}
                            index={i}
                            isLastAssistant={m.role === "assistant" && i === lastAssistantIndex}
                            isStreaming={isStreaming}
                            copied={copiedIndex === i}
                            provider={parsedModel?.provider}
                            modelId={parsedModel?.modelId}
                            onCopy={handleCopyMessage}
                            onEdit={handleEditUserMessage}
                            onRegenerate={handleRegenerate}
                        />
                    ))}
                    {pendingToolCalls.map((call) => (
                        <div
                            key={call.id}
                            className="flex max-w-[85%] flex-col gap-2 self-start rounded-lg border border-border bg-muted/50 p-3 text-sm"
                        >
                            <div className="font-mono text-xs text-muted-foreground">
                                🔧 <span className="font-medium text-foreground">{call.name}</span>(
                                {Object.entries(call.arguments)
                                    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                                    .join(", ")}
                                )
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button size="sm" onClick={() => respondToToolCall(call, true)} className="gap-1.5">
                                    <Check className="size-3.5" /> {t.allow}
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => respondToToolCall(call, false)} className="gap-1.5">
                                    <X className="size-3.5" /> {t.deny}
                                </Button>
                                {READ_ONLY_TOOLS.has(call.name) && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => alwaysAllowTool(call)}
                                        className="text-xs text-muted-foreground"
                                    >
                                        {t.alwaysAllowThisSession}
                                    </Button>
                                )}
                            </div>
                        </div>
                    ))}
                    <div ref={bottomRef} />
                </div>
            </ScrollArea>
            {showScrollButton && (
                <button
                    onClick={scrollToBottom}
                    className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs shadow-md hover:bg-muted"
                >
                    <ArrowDown className="size-3.5" /> Scroll to latest
                </button>
            )}
            </div>

            <div className="border-t border-border p-4">
                <div className="mx-auto max-w-3xl 2xl:max-w-4xl">
                    {(individualAttachments.length > 0 ||
                        folderGroups.length > 0 ||
                        ragFolders.length > 0 ||
                        imageAttachments.length > 0 ||
                        indexingFolder) && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                            {imageAttachments.map((img) => (
                                <div
                                    key={img.path}
                                    className="flex items-center gap-1.5 rounded-md bg-muted py-1 pr-2 pl-1 text-xs text-muted-foreground"
                                >
                                    <img
                                        src={`data:${img.mimeType};base64,${img.dataBase64}`}
                                        alt={img.name}
                                        className="size-5 rounded object-cover"
                                    />
                                    <span className="max-w-[140px] truncate">{img.name}</span>
                                    <button
                                        onClick={() => removeImageAttachment(img.path)}
                                        className="text-muted-foreground hover:text-destructive"
                                        aria-label={`Remove ${img.name}`}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </div>
                            ))}
                            {indexingFolder && (
                                <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                                    <Loader2 className="size-3 animate-spin" />
                                    Indexing folder...
                                </div>
                            )}
                            {ragFolders.map((f) => (
                                <div
                                    key={f.folderPath}
                                    className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                                    title={`Retrieval-indexed: ${f.chunkCount} chunks. Only the most relevant parts are sent per message.`}
                                >
                                    <Database className="size-3" />
                                    <span className="max-w-[160px] truncate">
                                        {f.folderName} ({f.chunkCount} chunks)
                                    </span>
                                    <button
                                        onClick={() => removeRagFolder(f.folderPath)}
                                        className="text-muted-foreground hover:text-destructive"
                                        aria-label={`Remove ${f.folderName}`}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </div>
                            ))}
                            {folderGroups.map(({ folder, count }) => (
                                <div
                                    key={folder}
                                    className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                                >
                                    <FolderOpen className="size-3" />
                                    <span className="max-w-[160px] truncate">
                                        {folder} ({count} files)
                                    </span>
                                    <button
                                        onClick={() => removeFolder(folder)}
                                        className="text-muted-foreground hover:text-destructive"
                                        aria-label={`Remove ${folder}`}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </div>
                            ))}
                            {individualAttachments.map((f) => (
                                <div
                                    key={f.path}
                                    className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                                >
                                    <Paperclip className="size-3" />
                                    <span className="max-w-[160px] truncate">{f.name}</span>
                                    <button
                                        onClick={() => removeAttachment(f.path)}
                                        className="text-muted-foreground hover:text-destructive"
                                        aria-label={`Remove ${f.name}`}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="flex items-end gap-2">
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={
                                    <Button
                                        disabled={isStreaming || indexingFolder}
                                        size="icon"
                                        variant="outline"
                                        className="rounded-xl"
                                        aria-label="Attach"
                                    >
                                        <Paperclip />
                                    </Button>
                                }
                            />
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem onClick={handleAttachFiles}>
                                    <Paperclip className="mr-1" /> {t.attachFiles}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={handleAttachFolder}>
                                    <FolderOpen className="mr-1" /> {t.attachProjectFolder}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={handleAttachMedia}>
                                    <ImageIcon className="mr-1" /> Attach photo, video, or PDF
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Textarea
                            ref={textareaRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={t.sendMessage}
                            className="min-h-11 flex-1 resize-none rounded-xl"
                            disabled={isStreaming}
                        />
                        {isStreaming ? (
                            <Button onClick={handleStop} size="icon" variant="outline" className="rounded-xl" aria-label="Stop generating">
                                <Square className="size-3.5 fill-current" />
                            </Button>
                        ) : (
                            <Button
                                onClick={handleSend}
                                disabled={
                                    (!input.trim() &&
                                        attachments.length === 0 &&
                                        ragFolders.length === 0 &&
                                        imageAttachments.length === 0) ||
                                    !parsedModel
                                }
                                size="icon"
                                className="rounded-xl"
                                aria-label="Send message"
                            >
                                <Send />
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
