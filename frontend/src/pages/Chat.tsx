import { memo, useEffect, useMemo, useRef, useState } from "react";
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
    Volume2,
    Mic,
    Undo2,
    FlaskConical,
    Wand2,
    Wrench,
    MonitorSmartphone,
    Frame,
    ScanText,
    Pin,
    GitFork,
    CheckCircle2,
    Circle,
    ListChecks,
    ShieldQuestion,
    AlertTriangle,
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
import { OPENAI_MODELS, ANTHROPIC_MODELS, GEMINI_MODELS, LOCAL_PROVIDERS, formatModelRef, formatCustomModelRef, parseModelRef } from "@/lib/providers";
import { estimateCost, formatCost } from "@/lib/pricing";
import { extractVariables, fillTemplate } from "@/lib/prompt-templates";
import { PromptVariableDialog } from "@/components/prompt-variable-dialog";
import { ScreenshotPickerDialog } from "@/components/screenshot-picker-dialog";
import { speakText, stopSpeaking } from "@/lib/tts";
import { computeLineDiff } from "@/lib/diff";
import { useToast } from "@/components/toast";
import { isTransientError } from "@/lib/transient-errors";
import {
    COMPACTION_BUDGET_TOKENS,
    COMPACTION_KEEP_RECENT,
    buildSummarizationPrompt,
    planCompaction,
    shouldCompact,
} from "@/lib/context-compaction";
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
    PromptPreset,
    ProjectScripts,
    LocalGgufModel,
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
// Mounting every message in a very long chat is what actually causes scroll
// jank (each one runs a Markdown parse) — so past this many messages, only
// the most recent window renders by default, with older ones revealed a
// window at a time on request rather than all at once.
const RENDER_WINDOW_SIZE = 60;
// Read-only tools are safe to let the model call repeatedly without a fresh
// click each time — write_file and run_command always require explicit
// per-call approval since they have real, potentially irreversible effects.
interface PlanStep {
    text: string;
    done: boolean;
}

const READ_ONLY_TOOLS = new Set([
    "read_file",
    "find_files",
    "file_info",
    "list_dir",
    "search_files",
    "git_status",
    "git_diff",
    "git_log",
    "web_search",
    "fetch_url",
    "read_notes",
    "github_list_repositories",
    "github_repository_tree",
    "github_read_file",
    "get_background_output",
    "list_background_commands",
    "capture_page_screenshot",
    "find_symbol_references",
]);

// Vision models can already reason over any attached image — these just save
// re-typing a good prompt for the common "I attached a diagram/wireframe"
// case. Selecting one fills the composer; the user can still edit before sending.
interface DiagramPromptPreset {
    id: string;
    labelKey: "analyzeDescribeUI" | "analyzeToMermaid" | "analyzeToCode" | "analyzeListComponents" | "analyzeFindIssues";
    prompt: string;
}
const DIAGRAM_PROMPT_PRESETS: DiagramPromptPreset[] = [
    {
        id: "describe",
        labelKey: "analyzeDescribeUI",
        prompt: "Describe this UI/wireframe in detail: overall layout, every visible component, and how they're organized/hierarchical.",
    },
    {
        id: "mermaid",
        labelKey: "analyzeToMermaid",
        prompt: "Convert this diagram into a Mermaid diagram definition (pick whichever Mermaid diagram type — flowchart, sequence, class, etc. — best fits what's shown).",
    },
    {
        id: "code",
        labelKey: "analyzeToCode",
        prompt: "Generate React + Tailwind CSS code that reproduces this UI mockup/wireframe as closely as possible.",
    },
    {
        id: "components",
        labelKey: "analyzeListComponents",
        prompt: "List every distinct UI component visible in this image, grouped by type (buttons, inputs, navigation, cards, etc.).",
    },
    {
        id: "issues",
        labelKey: "analyzeFindIssues",
        prompt: "Review this UI/wireframe for usability or accessibility issues and suggest concrete improvements.",
    },
];
// Caps how many automatic tool-result -> model-continuation round trips can
// happen for a single user turn, so a model that keeps calling tools without
// ever producing a final answer can't loop indefinitely.
const DEFAULT_AGENT_MAX_STEPS = 25;

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

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

interface MessageBubbleProps {
    message: ChatMessage;
    index: number;
    isLastAssistant: boolean;
    isStreaming: boolean;
    copied: boolean;
    speaking: boolean;
    provider: ProviderId | undefined;
    modelId: string | undefined;
    onCopy: (text: string, index: number) => void;
    onEdit: (index: number) => void;
    onRegenerate: () => void;
    onToggleSpeak: (index: number, text: string) => void;
    onTogglePin: (index: number) => void;
    onFork: (index: number) => void;
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
    speaking,
    provider,
    modelId,
    onCopy,
    onEdit,
    onRegenerate,
    onToggleSpeak,
    onTogglePin,
    onFork,
}: MessageBubbleProps) {
    const { t } = useI18n();

    if (m.role === "tool") {
        // Tool failures get a visually distinct card — an agent run that hit
        // an error mid-way should be scannable at a glance, not require
        // reading every result body to find where things went wrong.
        const isError = m.content.startsWith("Error:") || m.content === "The user denied this tool call.";
        return (
            <div className="flex flex-col items-start">
                <div
                    className={cn(
                        "max-w-[85%] rounded-lg border px-3 py-2 font-mono text-xs text-muted-foreground",
                        isError ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/50"
                    )}
                >
                    <div className={cn("mb-1 font-sans font-medium", isError ? "text-destructive" : "text-foreground")}>
                        {isError ? "⚠️" : "🔧"} {m.toolName} {isError ? t.toolFailed : t.toolResult}
                    </div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{m.content}</pre>
                </div>
            </div>
        );
    }

    return (
        <div
            data-message-index={i}
            className={cn("group flex flex-col", m.role === "user" ? "items-end" : "items-start")}
        >
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
                        "max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm sm:max-w-[75%]",
                        m.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : "surface-glass rounded-bl-md border border-border/60 text-foreground"
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
                    {m.content ? (
                        <Markdown content={m.content} isStreaming={isStreaming && isLastAssistant} />
                    ) : isStreaming && isLastAssistant ? (
                        "…"
                    ) : (
                        ""
                    )}
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
                {m.role === "assistant" && m.content && !isStreaming && (
                    <button
                        onClick={() => onToggleSpeak(i, m.content)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={speaking ? "Stop reading aloud" : "Read message aloud"}
                    >
                        {speaking ? <Square className="size-3.5 fill-current" /> : <Volume2 className="size-3.5" />}
                    </button>
                )}
                <button
                    onClick={() => onTogglePin(i)}
                    className={cn(
                        "rounded p-1 hover:bg-muted hover:text-foreground",
                        m.pinned ? "text-primary" : "text-muted-foreground"
                    )}
                    aria-label={m.pinned ? "Unpin message" : "Pin message"}
                >
                    <Pin className={cn("size-3.5", m.pinned && "fill-current")} />
                </button>
                {i > 0 && !isStreaming && (
                    <button
                        onClick={() => onFork(i)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Fork conversation from here"
                    >
                        <GitFork className="size-3.5" />
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
    prev.speaking === next.speaking &&
    prev.provider === next.provider &&
    prev.modelId === next.modelId &&
    prev.message.pinned === next.message.pinned
);

function formatUsage(usage: UsageInfo, provider: ProviderId | undefined, modelId: string | undefined): string {
    const total = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    const tokenLabel = `${total.toLocaleString()} tokens`;
    const speed =
        usage.completionTokens && usage.elapsedMs && usage.elapsedMs > 0
            ? `${(usage.completionTokens / (usage.elapsedMs / 1000)).toFixed(1)} tok/s`
            : null;
    const withSpeed = (label: string) => (speed ? `${label} · ${speed}` : label);
    if (provider && LOCAL_PROVIDERS.includes(provider)) return withSpeed(`${tokenLabel} · local`);
    const cost = modelId ? estimateCost(modelId, usage.promptTokens, usage.completionTokens) : null;
    return withSpeed(cost !== null ? `${tokenLabel} · ~${formatCost(cost)}` : tokenLabel);
}

export default function Chat() {
    const { sessionId } = useParams();
    const navigate = useNavigate();
    const { sessions, projects, loading, hasApi, createSession, refresh } = useSessions();
    const { t } = useI18n();
    const toast = useToast();

    const [models, setModels] = useState<OllamaModel[]>([]);
    const [ollamaRunning, setOllamaRunning] = useState<boolean | null>(null);
    const [llamaCppModels, setLlamaCppModels] = useState<LocalGgufModel[]>([]);
    const [model, setModel] = useState<string>("");
    const [pendingCustomProvider, setPendingCustomProvider] = useState<ProviderId | null>(null);
    const [customModelInput, setCustomModelInput] = useState("");
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const agentMaxSteps = Math.max(5, Math.min(settings?.agentMaxSteps ?? DEFAULT_AGENT_MAX_STEPS, 100));
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [ragFolders, setRagFolders] = useState<RagFolder[]>([]);
    const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
    const [showScreenshotPicker, setShowScreenshotPicker] = useState(false);
    const [screenshotError, setScreenshotError] = useState<string | null>(null);
    const [showFigmaInput, setShowFigmaInput] = useState(false);
    const [figmaUrlInput, setFigmaUrlInput] = useState("");
    const [figmaFetching, setFigmaFetching] = useState(false);
    const [figmaError, setFigmaError] = useState<string | null>(null);
    const [ocrRunningPath, setOcrRunningPath] = useState<string | null>(null);
    const [ocrError, setOcrError] = useState<string | null>(null);
    const [indexingFolder, setIndexingFolder] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
    const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [voiceError, setVoiceError] = useState<string | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const [params, setParams] = useState<ChatOptions>({});
    const [sessionSystemPrompt, setSessionSystemPrompt] = useState<string | null>(null);
    const [agentMode, setAgentMode] = useState(false);
    const [agentWorkspace, setAgentWorkspace] = useState<string | null>(null);
    const [pendingToolCalls, setPendingToolCalls] = useState<ToolCall[]>([]);
    const [pendingVariablePreset, setPendingVariablePreset] = useState<PromptPreset | null>(null);
    const [agentStepCount, setAgentStepCount] = useState(0);
    const [autoApprovedTools, setAutoApprovedTools] = useState<Set<string>>(new Set());
    const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
    const [contextSummary, setContextSummary] = useState<string | null>(null);
    const [contextSummaryThroughIndex, setContextSummaryThroughIndex] = useState(0);
    const [renderLimit, setRenderLimit] = useState(RENDER_WINDOW_SIZE);
    const [projectScripts, setProjectScripts] = useState<ProjectScripts>({});
    const [quickActionRunning, setQuickActionRunning] = useState(false);
    const [undoMessage, setUndoMessage] = useState<string | null>(null);
    const [writeDiffPreviews, setWriteDiffPreviews] = useState<Record<string, { oldContent: string | null }>>({});
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
        window.api.llamacpp.listModels().then(setLlamaCppModels);
    }, [hasApi]);

    useEffect(() => {
        if (!hasApi || !agentWorkspace) {
            // Intentional: resets state derived from a prop/param change (workspace
            // cleared), not state computed from the render itself.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setProjectScripts({});
            return;
        }
        window.api.agent.detectScripts(agentWorkspace).then(setProjectScripts);
    }, [hasApi, agentWorkspace]);

    // Fetch the pre-edit content of any newly-pending write_file calls so the
    // approval card can show a real diff instead of a raw JSON blob.
    useEffect(() => {
        if (!agentWorkspace) return;
        const writes = pendingToolCalls.filter((c) => c.name === "write_file" && !(c.id in writeDiffPreviews));
        if (writes.length === 0) return;
        (async () => {
            for (const call of writes) {
                const filePath = String(call.arguments.path ?? "");
                const res = await window.api.agent.executeTool(agentWorkspace, "read_file", { path: filePath });
                setWriteDiffPreviews((prev) => ({
                    ...prev,
                    [call.id]: { oldContent: res.error ? null : String(res.result ?? "") },
                }));
            }
        })();
    }, [agentWorkspace, pendingToolCalls, writeDiffPreviews]);

    // Only checked while an Ollama model is selected — the banner's render
    // condition also gates on the provider, so a stale value from a previous
    // Ollama selection can never show for a cloud model.
    useEffect(() => {
        if (!hasApi || parseModelRef(model)?.provider !== "ollama") return;
        window.api.ollama.status().then(setOllamaRunning);
    }, [hasApi, model]);

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
            setPlanSteps(session.planSteps ?? []);
            setContextSummary(session.contextSummary ?? null);
            setContextSummaryThroughIndex(session.contextSummaryThroughIndex ?? 0);
            setRenderLimit(RENDER_WINDOW_SIZE);
            setAutoApprovedTools(new Set());
            setWriteDiffPreviews({});
            setUndoMessage(null);
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

    async function undoLastEdit() {
        if (!agentWorkspace) return;
        const result = await window.api.agent.rollbackLastWrite(agentWorkspace);
        setUndoMessage(
            result
                ? `${result.restoredContent ? t.restoredFile : t.deletedNewFile} ${result.path}`
                : t.nothingToUndo
        );
        setTimeout(() => setUndoMessage(null), 4000);
    }

    // Quick actions run a fixed, already-known-safe command directly (bypassing
    // the model/approval loop entirely, since the user themselves chose to run
    // it) and drop the result into the chat as a tool-style message for context.
    async function runQuickAction(command: string) {
        if (!agentWorkspace || quickActionRunning) return;
        setQuickActionRunning(true);
        const res = await window.api.agent.executeTool(agentWorkspace, "run_command", { command });
        const resultText = res.error ? `Error: ${res.error}` : String(res.result ?? "");
        setMessages((m) => {
            const next: ChatMessage[] = [
                ...m,
                { role: "tool", content: resultText, toolCallId: crypto.randomUUID(), toolName: "run_command" },
            ];
            if (sessionId) window.api.sessions.update(sessionId, { messages: next });
            return next;
        });
        setQuickActionRunning(false);
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

    async function runOcr(img: ImageAttachment) {
        if (ocrRunningPath) return;
        setOcrRunningPath(img.path);
        setOcrError(null);
        const res = await window.api.ocr.recognize(img.dataBase64);
        if (res.error || res.text === undefined) {
            setOcrError(res.error ?? "OCR failed.");
            setTimeout(() => setOcrError(null), 6000);
        } else if (!res.text) {
            setOcrError(t.ocrNoTextFound);
            setTimeout(() => setOcrError(null), 6000);
        } else {
            setInput((prev) => (prev ? `${prev}\n\n${res.text}` : res.text!));
            textareaRef.current?.focus();
        }
        setOcrRunningPath(null);
    }

    function applyDiagramPreset(prompt: string) {
        setInput(prompt);
        textareaRef.current?.focus();
    }

    async function captureScreenshot(sourceId: string) {
        setScreenshotError(null);
        const res = await window.api.screen.capture(sourceId);
        if (res.error || !res.dataBase64) {
            setScreenshotError(res.error ?? "Screenshot capture failed.");
            setTimeout(() => setScreenshotError(null), 5000);
            return;
        }
        const path = `screenshot-${Date.now()}`;
        setImageAttachments((prev) => [
            ...prev,
            { kind: "image", name: "Screenshot.png", path, mimeType: res.mimeType ?? "image/png", dataBase64: res.dataBase64! },
        ]);
    }

    async function fetchFigmaFrame() {
        const url = figmaUrlInput.trim();
        if (!url || figmaFetching) return;
        setFigmaFetching(true);
        setFigmaError(null);
        const res = await window.api.figma.fetchFrame(url);
        if (res.error || !res.result) {
            setFigmaError(res.error ?? "Failed to fetch that Figma frame.");
        } else {
            setImageAttachments((prev) => [
                ...prev,
                {
                    kind: "image",
                    name: res.result!.name,
                    path: `figma-${Date.now()}`,
                    mimeType: res.result!.mimeType,
                    dataBase64: res.result!.dataBase64,
                },
            ]);
            setFigmaUrlInput("");
            setShowFigmaInput(false);
        }
        setFigmaFetching(false);
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
            gpuLayers: params.gpuLayers ?? project?.params?.gpuLayers ?? settings?.gpuLayers,
            seed: params.seed ?? project?.params?.seed ?? settings?.seed,
            topK: params.topK ?? project?.params?.topK ?? settings?.topK,
            repeatPenalty: params.repeatPenalty ?? project?.params?.repeatPenalty ?? settings?.repeatPenalty,
            stop: params.stop ?? project?.params?.stop ?? settings?.stop,
        };
    }

    async function handleExportChat() {
        if (sessionId) await window.api.data.exportSession(sessionId);
    }

    async function handleExportChatMarkdown() {
        if (sessionId) await window.api.data.exportSessionMarkdown(sessionId);
    }

    async function handleCopyChatMarkdown() {
        if (!sessionId) return;
        const markdown = await window.api.data.getSessionMarkdown(sessionId);
        if (markdown) {
            await navigator.clipboard.writeText(markdown);
            toast.success(t.copiedAsMarkdown);
        }
    }

    async function startOllamaFromBanner() {
        const result = await window.api.ollama.start();
        setOllamaRunning(!result.error);
        if (result.error === "not-installed") {
            toast.error(t.toastOllamaNotInstalled);
        } else if (result.error) {
            toast.error(`${t.toastOllamaStartFailed}: ${result.error}`);
        }
    }

    // A plain, non-streaming-to-the-UI completion used only to produce a
    // compaction summary — same provider/model/agentMode:false, but its
    // tokens are accumulated locally instead of touching message state.
    async function summarizeText(prompt: string): Promise<string | null> {
        const parsed = parseModelRef(model);
        if (!parsed) return null;
        let text = "";
        const { promise } = window.api.chat.send(
            parsed.provider,
            parsed.modelId,
            [{ role: "user", content: prompt }],
            {},
            (chunk) => {
                text += chunk.message?.content ?? "";
            },
            false
        );
        const result = await promise;
        return result.error ? null : text.trim() || null;
    }

    // Folds everything but the most recent messages into a running summary
    // once the unfolded portion gets too large to keep sending verbatim —
    // otherwise a long conversation eventually fails outright (or gets
    // silently truncated by the provider) once it outgrows the model's
    // context window. Returns null when no compaction was needed, in which
    // case the caller sends its already-built history unchanged.
    async function maybeCompactHistory(baseMessages: ChatMessage[]): Promise<ChatMessage[] | null> {
        // Editing/forking/regenerating can shorten the message list after a
        // fold point was recorded — clamp so a stale index never causes the
        // "kept" slice to come up empty and silently drop recent context.
        const alreadyFolded = Math.min(contextSummaryThroughIndex, baseMessages.length);
        if (!shouldCompact(baseMessages, alreadyFolded, COMPACTION_KEEP_RECENT, COMPACTION_BUDGET_TOKENS)) {
            return null;
        }
        const { toFold, kept, foldEndIndex } = planCompaction(baseMessages, alreadyFolded, COMPACTION_KEEP_RECENT);
        if (toFold.length === 0) return null;

        const summary = await summarizeText(buildSummarizationPrompt(contextSummary, toFold));
        // Summarization itself failed (network blip, provider error) — fall
        // back to sending the full uncompacted history rather than losing
        // context or blocking the user's message.
        if (!summary) return null;

        setContextSummary(summary);
        setContextSummaryThroughIndex(foldEndIndex);
        if (sessionId) {
            window.api.sessions.update(sessionId, { contextSummary: summary, contextSummaryThroughIndex: foldEndIndex });
        }
        toast.info(t.contextCompacted);
        return [
            ...buildSystemMessages(),
            { role: "system", content: `Summary of earlier conversation:\n${summary}` },
            ...kept,
        ];
    }

    async function runCompletion(
        history: ChatMessage[],
        baseMessages: ChatMessage[],
        opts: { isFirstMessage: boolean; titleSource: string; attempt?: number }
    ) {
        const parsed = parseModelRef(model);
        if (!parsed || !sessionId) return;

        const compactedHistory = await maybeCompactHistory(baseMessages);
        const requestHistory = compactedHistory ?? history;

        // Timing an in-flight network stream, not computing render output —
        // the react-hooks purity rule can't tell this closure only runs once
        // per user-initiated send, not during render.
        // eslint-disable-next-line react-hooks/purity
        const streamStartedAt = Date.now();

        setMessages([...baseMessages, { role: "assistant", content: "" }]);
        setIsStreaming(true);
        // Called directly (not via a useEffect) so it still fires even if this
        // component unmounts mid-stream — e.g. the user navigates to Settings
        // while a response is generating. An effect tied to component state
        // would never get to report "done" in that case, leaving the main
        // process thinking a generation is still in flight forever.
        window.api.app.setBusy(true);

        // Models often emit many tiny chunks per second. Updating React for
        // every token makes Markdown parsing and layout dominate the UI thread,
        // so coalesce chunks into a steady ~30 FPS stream instead.
        let pendingText = "";
        let pendingUsage: UsageInfo | undefined;
        let pendingToolCalls: ToolCall[] = [];
        let flushTimer: number | null = null;
        const flushStream = () => {
            flushTimer = null;
            if (!pendingText && !pendingUsage && pendingToolCalls.length === 0) return;
            const text = pendingText;
            const usage = pendingUsage;
            const toolCalls = pendingToolCalls;
            pendingText = "";
            pendingUsage = undefined;
            pendingToolCalls = [];
            setMessages((current) => {
                const next = [...current];
                const last = next[next.length - 1];
                next[next.length - 1] = {
                    role: "assistant",
                    content: last.content + text,
                    usage: usage
                        ? {
                              promptTokens: usage.promptTokens ?? last.usage?.promptTokens,
                              completionTokens: usage.completionTokens ?? last.usage?.completionTokens,
                              elapsedMs: Date.now() - streamStartedAt,
                          }
                        : last.usage,
                    toolCalls: toolCalls.length > 0 ? [...(last.toolCalls ?? []), ...toolCalls] : last.toolCalls,
                };
                return next;
            });
        };
        const scheduleFlush = () => {
            if (flushTimer === null) flushTimer = window.setTimeout(flushStream, 32);
        };

        const { requestId, promise } = window.api.chat.send(
            parsed.provider,
            parsed.modelId,
            requestHistory,
            effectiveOptions(),
            (chunk) => {
                const piece = chunk.message?.content ?? "";
                if (!piece && !chunk.usage && !chunk.toolCalls) return;
                pendingText += piece;
                if (chunk.usage) pendingUsage = { ...pendingUsage, ...chunk.usage };
                if (chunk.toolCalls) pendingToolCalls.push(...chunk.toolCalls);
                scheduleFlush();
            },
            agentMode && !!agentWorkspace
        );
        setActiveRequestId(requestId);
        const result = await promise;
        if (flushTimer !== null) window.clearTimeout(flushTimer);
        flushStream();
        setActiveRequestId(null);

        // One silent retry for errors that usually clear on their own
        // (network blips, rate limits, 5xx) — but never for a user-initiated
        // stop, and never more than once, so a genuinely down provider still
        // fails fast instead of looping.
        if (result.error && !result.aborted && (opts.attempt ?? 0) === 0 && isTransientError(result.error)) {
            toast.info(t.transientErrorRetrying);
            setIsStreaming(false);
            window.api.app.setBusy(false);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return runCompletion(history, baseMessages, { ...opts, attempt: 1 });
        }

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
            const toolCalls = !result.error && last?.role === "assistant" ? (last.toolCalls ?? []) : [];
            const planCalls = toolCalls.filter((c) => c.name === "set_plan");
            const otherCalls = toolCalls.filter((c) => c.name !== "set_plan");

            if (toolCalls.length > 0) {
                // set_plan is a pure UI signal, applied immediately without a
                // confirmation click — everything else still needs one.
                setPendingToolCalls(otherCalls);
                for (const call of planCalls) applyPlan(call);
                // Tools the user already trusted this session skip the
                // confirmation card and resolve themselves immediately.
                // request_checkpoint always needs an explicit user choice.
                for (const call of otherCalls) {
                    if (call.name !== "request_checkpoint" && autoApprovedTools.has(call.name)) respondToToolCall(call, true);
                }
            } else if (settings?.ttsAutoRead && !result.error && last?.role === "assistant" && last.content) {
                const lastIndex = finalMessages.length - 1;
                setSpeakingIndex(lastIndex);
                speakText(last.content, settings.ttsVoiceURI, () => setSpeakingIndex((i) => (i === lastIndex ? null : i)));
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
        if (agentStepCount >= agentMaxSteps) {
            setMessages((m) => [
                ...m,
                {
                    role: "assistant",
                    content: `⚠️ Reached the agent step limit (${agentMaxSteps}) for this turn. Send another message to let it continue.`,
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

    // Shared tail for every way a pending tool call can resolve (approved,
    // denied, executed, or — for the client-only tools — answered without
    // ever touching the workspace bridge): records the result and, once
    // nothing else from this turn is still pending, hands control back to
    // the model.
    function resolveToolCall(call: ToolCall, resultText: string) {
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
        resolveToolCall(call, resultText);
    }

    // set_plan never shows a confirmation card — it's just the model telling
    // the UI what its checklist looks like right now, so it's applied the
    // instant the call arrives.
    function applyPlan(call: ToolCall) {
        const raw = Array.isArray(call.arguments.steps) ? call.arguments.steps : [];
        const steps: PlanStep[] = raw.map((s) => ({
            text: String((s as { text?: unknown })?.text ?? ""),
            done: Boolean((s as { done?: unknown })?.done),
        }));
        setPlanSteps(steps);
        if (sessionId) window.api.sessions.update(sessionId, { planSteps: steps });
        resolveToolCall(call, "Plan updated.");
    }

    // request_checkpoint pauses the agent loop until the user picks one of
    // these — unlike a normal tool call, "approve" and "deny" both continue
    // the conversation, just with a different message back to the model.
    function respondToCheckpoint(call: ToolCall, shouldContinue: boolean) {
        resolveToolCall(
            call,
            shouldContinue
                ? "The user reviewed this checkpoint and approved continuing."
                : "The user asked to pause here rather than continue — stop and wait for further instructions."
        );
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

    // Presets with {{variables}} need values filled in before they're usable
    // as a system prompt — presets without any apply immediately as before.
    function selectPromptPreset(preset: PromptPreset) {
        const variables = extractVariables(preset.prompt);
        if (variables.length === 0) {
            applyPromptPreset(preset.prompt);
        } else {
            setPendingVariablePreset(preset);
        }
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
        const now = new Date().toISOString();
        const preset: PromptPreset = { id: crypto.randomUUID(), name, prompt, versions: [], createdAt: now, updatedAt: now };
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
        setPlanSteps([]);
        window.api.sessions.update(sessionId, { planSteps: [] });
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

    function toggleSpeak(index: number, text: string) {
        if (speakingIndex === index) {
            stopSpeaking();
            setSpeakingIndex(null);
            return;
        }
        setSpeakingIndex(index);
        speakText(text, settings?.ttsVoiceURI, () => setSpeakingIndex((i) => (i === index ? null : i)));
    }

    function togglePinMessage(index: number) {
        setMessages((prev) => {
            const next = prev.map((m, i) => (i === index ? { ...m, pinned: !m.pinned } : m));
            if (sessionId) window.api.sessions.update(sessionId, { messages: next });
            return next;
        });
    }

    function scrollToMessage(index: number) {
        // The target may be outside the current render window (an older
        // message than what's mounted) — widen it enough to include the
        // target before the DOM node can be found at all.
        if (index < visibleStartIndex) {
            setRenderLimit(messages.length - index + RENDER_WINDOW_SIZE);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    viewportRef.current
                        ?.querySelector(`[data-message-index="${index}"]`)
                        ?.scrollIntoView({ behavior: "smooth", block: "center" });
                });
            });
            return;
        }
        const el = viewportRef.current?.querySelector(`[data-message-index="${index}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    async function forkFromMessage(index: number) {
        const forked = messages.slice(0, index + 1).map((m) => ({ ...m, pinned: false }));
        const session = await createSession(model, getCurrentProject()?.id ?? null);
        await window.api.sessions.update(session.id, {
            messages: forked,
            model,
            params,
            systemPrompt: sessionSystemPrompt,
            title: deriveTitle(forked[forked.length - 1]?.content ?? "Forked chat"),
        });
        await refresh();
        navigate(`/chat/${session.id}`);
    }

    async function startRecording() {
        setVoiceError(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream);
            audioChunksRef.current = [];
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };
            recorder.onstop = async () => {
                stream.getTracks().forEach((track) => track.stop());
                if (audioChunksRef.current.length === 0) return;
                const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
                setIsTranscribing(true);
                const base64 = await blobToBase64(blob);
                const result = await window.api.audio.transcribe(base64, recorder.mimeType);
                setIsTranscribing(false);
                if (result.text) {
                    setInput((prev) => (prev.trim() ? `${prev.trim()} ${result.text}` : result.text!));
                } else if (result.error) {
                    setVoiceError(result.error);
                }
            };
            recorder.start();
            mediaRecorderRef.current = recorder;
            setIsRecording(true);
        } catch {
            setVoiceError("Couldn't access the microphone — check your OS microphone permissions for this app.");
        }
    }

    function stopRecording() {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
    }

    // Interrupt: discard the in-progress recording instead of transcribing it.
    function cancelRecording() {
        const recorder = mediaRecorderRef.current;
        if (recorder) {
            recorder.onstop = null;
            recorder.stream.getTracks().forEach((track) => track.stop());
            if (recorder.state !== "inactive") recorder.stop();
        }
        audioChunksRef.current = [];
        setIsRecording(false);
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }

    const parsedModel = useMemo(() => parseModelRef(model), [model]);
    const { individualAttachments, folderGroups } = useMemo(() => {
        const individual = attachments.filter((file) => !file.folder);
        const counts = new Map<string, number>();
        for (const file of attachments) {
            if (file.folder) counts.set(file.folder, (counts.get(file.folder) ?? 0) + 1);
        }
        return {
            individualAttachments: individual,
            folderGroups: [...counts].map(([folder, count]) => ({ folder, count })),
        };
    }, [attachments]);
    const lastAssistantIndex = useMemo(() => messages.findLastIndex((message) => message.role === "assistant"), [messages]);
    const visibleStartIndex = messages.length > renderLimit ? messages.length - renderLimit : 0;
    const hiddenMessageCount = visibleStartIndex;
    const sessionCost = useMemo(
        () =>
            parsedModel && parsedModel.provider !== "ollama" && parsedModel.provider !== "llamacpp"
                ? messages.reduce((sum, message) => {
                      if (message.role !== "assistant" || !message.usage) return sum;
                      return sum + (estimateCost(parsedModel.modelId, message.usage.promptTokens, message.usage.completionTokens) ?? 0);
                  }, 0)
                : 0,
        [messages, parsedModel]
    );

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Chat features are only available when this page is running inside the Electron
                app, not a plain browser tab.
            </div>
        );
    }

    const currentProject = getCurrentProject();

    return (
        <div className="flex h-full flex-col bg-background/35">
            <div className="surface-glass flex min-h-14 flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2.5 pl-14 shadow-sm md:pl-4">
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
                        {llamaCppModels.length > 0 && (
                            <SelectGroup>
                                <SelectLabel>llama.cpp (local)</SelectLabel>
                                {llamaCppModels.map((m) => (
                                    <SelectItem key={m.name} value={formatModelRef("llamacpp", m.name)}>
                                        {m.name}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        )}
                        {(settings?.mlxModels ?? []).length > 0 && (
                            <SelectGroup>
                                <SelectLabel>MLX (Apple Silicon)</SelectLabel>
                                {settings!.mlxModels!.map((id) => (
                                    <SelectItem key={id} value={formatModelRef("mlx", id)}>
                                        {id}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        )}
                        {llamaCppModels.length > 0 && (
                            <SelectGroup>
                                <SelectLabel>ROCm (AMD)</SelectLabel>
                                {llamaCppModels.map((m) => (
                                    <SelectItem key={m.name} value={formatModelRef("rocm", m.name)}>
                                        {m.name}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        )}
                        {(settings?.vllmModels ?? []).length > 0 && (
                            <SelectGroup>
                                <SelectLabel>vLLM (managed)</SelectLabel>
                                {settings!.vllmModels!.map((id) => (
                                    <SelectItem key={id} value={formatModelRef("vllm", id)}>
                                        {id}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        )}
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
                        <SelectGroup>
                            <SelectLabel>Gemini</SelectLabel>
                            {GEMINI_MODELS.map((m) => (
                                <SelectItem key={m.id} value={formatModelRef("gemini", m.id)}>
                                    {m.label}
                                </SelectItem>
                            ))}
                            <SelectItem value={formatModelRef("gemini", CUSTOM_SENTINEL)}>Custom model ID...</SelectItem>
                        </SelectGroup>
                        {(settings?.customProviders ?? []).map((provider) => (
                            <SelectGroup key={provider.id}>
                                <SelectLabel>{provider.name}</SelectLabel>
                                {provider.modelIds.map((modelId) => (
                                    <SelectItem key={modelId} value={formatCustomModelRef(provider.id, modelId)}>
                                        {modelId}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        ))}
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
                        {t.agentStep} {agentStepCount}/{agentMaxSteps}
                    </span>
                )}
                {agentMode && agentWorkspace && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={undoLastEdit}
                        className="gap-1.5 text-xs text-muted-foreground"
                        title={t.undoLastEdit}
                    >
                        <Undo2 className="size-3.5" />
                        {t.undoLastEdit}
                    </Button>
                )}
                {agentMode && agentWorkspace && projectScripts.test && (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={quickActionRunning}
                        onClick={() => runQuickAction(projectScripts.test!)}
                        className="gap-1.5 text-xs text-muted-foreground"
                    >
                        <FlaskConical className="size-3.5" />
                        {t.runTests}
                    </Button>
                )}
                {agentMode && agentWorkspace && projectScripts.lint && (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={quickActionRunning}
                        onClick={() => runQuickAction(projectScripts.lint!)}
                        className="gap-1.5 text-xs text-muted-foreground"
                    >
                        <Wrench className="size-3.5" />
                        {t.runLint}
                    </Button>
                )}
                {agentMode && agentWorkspace && projectScripts.format && (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={quickActionRunning}
                        onClick={() => runQuickAction(projectScripts.format!)}
                        className="gap-1.5 text-xs text-muted-foreground"
                    >
                        <Wand2 className="size-3.5" />
                        {t.runFormat}
                    </Button>
                )}
                {undoMessage && <span className="text-xs text-muted-foreground">{undoMessage}</span>}

                {messages.some((m) => m.pinned) && (
                    <Popover>
                        <PopoverTrigger
                            render={
                                <Button size="sm" variant="ghost" className="gap-1.5 text-xs text-muted-foreground">
                                    <Pin className="size-3.5" /> {t.pinnedMessages} ({messages.filter((m) => m.pinned).length})
                                </Button>
                            }
                        />
                        <PopoverContent align="start" className="w-80">
                            <p className="mb-2 text-xs font-medium">{t.pinnedMessages}</p>
                            <div className="flex max-h-72 flex-col gap-1.5 overflow-auto">
                                {messages.map((m, i) =>
                                    m.pinned ? (
                                        <button
                                            key={i}
                                            onClick={() => scrollToMessage(i)}
                                            className="rounded-md border border-border p-2 text-left text-xs hover:bg-muted"
                                        >
                                            <span className="mb-0.5 block text-[10px] text-muted-foreground">
                                                {m.role === "user" ? t.you : t.assistant}
                                            </span>
                                            <span className="line-clamp-2">{m.content || `[${m.toolName ?? "tool"}]`}</span>
                                        </button>
                                    ) : null
                                )}
                            </div>
                        </PopoverContent>
                    </Popover>
                )}

                {sessionCost > 0 && (
                    <span className="ml-auto text-xs text-muted-foreground" title="Estimated session cost">
                        ~{formatCost(sessionCost)}
                    </span>
                )}

                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                size="icon"
                                variant="outline"
                                className={sessionCost > 0 ? "" : "ml-auto"}
                                aria-label="Export chat"
                            >
                                <FileDown className="size-4" />
                            </Button>
                        }
                    />
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={handleExportChatMarkdown}>{t.exportAsMarkdown}</DropdownMenuItem>
                        <DropdownMenuItem onClick={handleCopyChatMarkdown}>{t.copyAsMarkdown}</DropdownMenuItem>
                        <DropdownMenuItem onClick={handleExportChat}>{t.exportAsJson}</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>

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
                                            onClick={() => selectPromptPreset(preset)}
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
                                <label className="text-xs text-muted-foreground">
                                    {t.gpuLayers}
                                    {parsedModel?.provider !== "ollama" ? " (Ollama only)" : ""}
                                </label>
                                <Input
                                    type="number"
                                    min={0}
                                    step={1}
                                    placeholder={t.gpuLayersAuto}
                                    title={t.gpuLayersHelp}
                                    value={params.gpuLayers ?? currentProject?.params?.gpuLayers ?? settings?.gpuLayers ?? ""}
                                    onChange={(e) =>
                                        updateParam({ gpuLayers: e.target.value === "" ? undefined : Number(e.target.value) })
                                    }
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
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">
                                    {t.seed}
                                    {parsedModel?.provider === "anthropic" ? " (not supported by Claude)" : ""}
                                </label>
                                <Input
                                    type="number"
                                    step={1}
                                    placeholder={t.seedRandom}
                                    title={t.seedHelp}
                                    value={params.seed ?? currentProject?.params?.seed ?? settings?.seed ?? ""}
                                    onChange={(e) => updateParam({ seed: e.target.value === "" ? undefined : Number(e.target.value) })}
                                    disabled={parsedModel?.provider === "anthropic"}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">
                                    {t.topK}
                                    {parsedModel?.provider === "openai" ? " (not supported by ChatGPT)" : ""}
                                </label>
                                <Input
                                    type="number"
                                    min={1}
                                    step={1}
                                    title={t.topKHelp}
                                    value={params.topK ?? currentProject?.params?.topK ?? settings?.topK ?? ""}
                                    onChange={(e) => updateParam({ topK: e.target.value === "" ? undefined : Number(e.target.value) })}
                                    disabled={parsedModel?.provider === "openai"}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">
                                    {t.repeatPenalty}
                                    {parsedModel?.provider !== "ollama" ? " (Ollama only)" : ""}
                                </label>
                                <Input
                                    type="number"
                                    min={0}
                                    step={0.05}
                                    title={t.repeatPenaltyHelp}
                                    value={params.repeatPenalty ?? currentProject?.params?.repeatPenalty ?? settings?.repeatPenalty ?? ""}
                                    onChange={(e) =>
                                        updateParam({ repeatPenalty: e.target.value === "" ? undefined : Number(e.target.value) })
                                    }
                                    disabled={parsedModel?.provider !== "ollama"}
                                    className="h-8 text-xs"
                                />
                            </div>
                        </div>
                        <div className="mt-3 flex flex-col gap-1">
                            <label className="text-xs text-muted-foreground">{t.stopSequences}</label>
                            <Input
                                placeholder={t.stopSequencesPlaceholder}
                                value={(params.stop ?? currentProject?.params?.stop ?? settings?.stop ?? []).join(", ")}
                                onChange={(e) =>
                                    updateParam({
                                        stop: e.target.value
                                            .split(",")
                                            .map((s) => s.trim())
                                            .filter(Boolean),
                                    })
                                }
                                className="h-8 text-xs"
                            />
                        </div>
                    </PopoverContent>
                </Popover>
            </div>

            {parsedModel?.provider === "ollama" && ollamaRunning === false && (
                <div className="flex items-center gap-2 border-b border-border bg-destructive/5 px-4 py-2 text-xs">
                    <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                    <span className="flex-1">{t.ollamaOfflineBanner}</span>
                    <Button size="sm" variant="outline" onClick={startOllamaFromBanner}>
                        {t.start}
                    </Button>
                </div>
            )}

            {planSteps.length > 0 && (
                <div className="border-b border-border bg-muted/30 px-4 py-2">
                    <div className="mx-auto flex max-w-3xl flex-col gap-1 2xl:max-w-4xl">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <ListChecks className="size-3.5" /> {t.agentPlan}
                        </p>
                        {planSteps.map((step, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs">
                                {step.done ? (
                                    <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
                                ) : (
                                    <Circle className="size-3.5 shrink-0 text-muted-foreground" />
                                )}
                                <span className={cn(step.done && "text-muted-foreground line-through")}>{step.text}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="relative flex-1 overflow-hidden">
            <ScrollArea viewportRef={viewportRef} className="h-full">
                <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 2xl:max-w-4xl">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center gap-4 py-20 text-center">
                            <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-sm"><Sparkles className="size-7" /></div>
                            <div><h2 className="text-xl font-semibold tracking-tight">What would you like to build?</h2><p className="mt-1 text-sm text-muted-foreground">{t.startConversationWith(parsedModel?.modelId || "a model")}</p></div>
                            <div className="mt-3 grid w-full max-w-xl gap-2 sm:grid-cols-3">
                                {["Analyze my GitHub repository", "Review and improve my code", "Plan a new application"].map((suggestion) => (
                                    <button key={suggestion} onClick={() => setInput(suggestion)} className="surface-glass rounded-xl border border-border/70 p-3 text-left text-xs font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-primary/5 hover:shadow-md">{suggestion}</button>
                                ))}
                            </div>
                        </div>
                    )}
                    {hiddenMessageCount > 0 && (
                        <button
                            onClick={() => setRenderLimit((n) => n + RENDER_WINDOW_SIZE)}
                            className="mx-auto rounded-full border border-border bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
                        >
                            {t.showEarlierMessages(hiddenMessageCount)}
                        </button>
                    )}
                    {messages.slice(visibleStartIndex).map((m, localIndex) => {
                        const i = visibleStartIndex + localIndex;
                        return (
                            <MessageBubble
                                key={i}
                                message={m}
                                index={i}
                                isLastAssistant={m.role === "assistant" && i === lastAssistantIndex}
                                isStreaming={isStreaming}
                                copied={copiedIndex === i}
                                speaking={speakingIndex === i}
                                provider={parsedModel?.provider}
                                modelId={parsedModel?.modelId}
                                onCopy={handleCopyMessage}
                                onEdit={handleEditUserMessage}
                                onRegenerate={handleRegenerate}
                                onToggleSpeak={toggleSpeak}
                                onTogglePin={togglePinMessage}
                                onFork={forkFromMessage}
                            />
                        );
                    })}
                    {pendingToolCalls.map((call) => {
                        if (call.name === "request_checkpoint") {
                            const summary = String(call.arguments.summary ?? "");
                            const question = call.arguments.question ? String(call.arguments.question) : null;
                            return (
                                <div
                                    key={call.id}
                                    className="flex max-w-[85%] flex-col gap-2 self-start rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
                                >
                                    <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                                        <ShieldQuestion className="size-3.5" /> {t.agentCheckpoint}
                                    </div>
                                    <p>{summary}</p>
                                    {question && <p className="text-muted-foreground">{question}</p>}
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Button size="sm" onClick={() => respondToCheckpoint(call, true)} className="gap-1.5">
                                            <Check className="size-3.5" /> {t.continueAgent}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => respondToCheckpoint(call, false)}
                                            className="gap-1.5"
                                        >
                                            <Square className="size-3.5" /> {t.stopAgent}
                                        </Button>
                                    </div>
                                </div>
                            );
                        }
                        const isWrite = call.name === "write_file";
                        const preview = writeDiffPreviews[call.id];
                        const newContent = String(call.arguments.content ?? "");
                        const diffLines =
                            isWrite && preview ? computeLineDiff(preview.oldContent ?? "", newContent) : null;
                        const MAX_RENDERED_LINES = 400;
                        return (
                            <div
                                key={call.id}
                                className="flex max-w-[85%] flex-col gap-2 self-start rounded-lg border border-border bg-muted/50 p-3 text-sm"
                            >
                                {isWrite ? (
                                    <div className="flex flex-col gap-1.5">
                                        <div className="font-mono text-xs text-muted-foreground">
                                            🔧 <span className="font-medium text-foreground">write_file</span>{" "}
                                            {String(call.arguments.path ?? "")}
                                            {preview?.oldContent === null && (
                                                <span className="ml-1.5 rounded bg-primary/15 px-1 text-primary">
                                                    {t.newFile}
                                                </span>
                                            )}
                                        </div>
                                        {diffLines ? (
                                            <pre className="max-h-64 overflow-auto rounded border border-border bg-background p-2 font-mono text-xs">
                                                {diffLines.slice(0, MAX_RENDERED_LINES).map((line, idx) => (
                                                    <div
                                                        key={idx}
                                                        className={cn(
                                                            "whitespace-pre-wrap",
                                                            line.type === "add" &&
                                                                "bg-green-500/15 text-green-700 dark:text-green-400",
                                                            line.type === "remove" &&
                                                                "bg-red-500/15 text-red-700 dark:text-red-400"
                                                        )}
                                                    >
                                                        {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                                                        {line.text}
                                                    </div>
                                                ))}
                                                {diffLines.length > MAX_RENDERED_LINES && (
                                                    <div className="text-muted-foreground">
                                                        … {diffLines.length - MAX_RENDERED_LINES} more lines
                                                    </div>
                                                )}
                                            </pre>
                                        ) : (
                                            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                                        )}
                                    </div>
                                ) : (
                                    <div className="font-mono text-xs text-muted-foreground">
                                        🔧 <span className="font-medium text-foreground">{call.name}</span>(
                                        {Object.entries(call.arguments)
                                            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                                            .join(", ")}
                                        )
                                    </div>
                                )}
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button size="sm" onClick={() => respondToToolCall(call, true)} className="gap-1.5">
                                        <Check className="size-3.5" /> {t.allow}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => respondToToolCall(call, false)}
                                        className="gap-1.5"
                                    >
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
                        );
                    })}
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

            <div className="surface-glass border-t border-border/70 p-3 shadow-[0_-12px_36px_rgb(0_0_0/0.04)] sm:p-4">
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
                                        onClick={() => runOcr(img)}
                                        disabled={ocrRunningPath === img.path}
                                        className="text-muted-foreground hover:text-foreground"
                                        aria-label={`${t.extractTextOcr} ${img.name}`}
                                        title={t.extractTextOcr}
                                    >
                                        {ocrRunningPath === img.path ? (
                                            <Loader2 className="size-3 animate-spin" />
                                        ) : (
                                            <ScanText className="size-3" />
                                        )}
                                    </button>
                                    <button
                                        onClick={() => removeImageAttachment(img.path)}
                                        className="text-muted-foreground hover:text-destructive"
                                        aria-label={`Remove ${img.name}`}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </div>
                            ))}
                            {imageAttachments.length > 0 && (
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        render={
                                            <button className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
                                                <Sparkles className="size-3" />
                                                {t.analyzeAs}
                                            </button>
                                        }
                                    />
                                    <DropdownMenuContent>
                                        {DIAGRAM_PROMPT_PRESETS.map((preset) => (
                                            <DropdownMenuItem key={preset.id} onClick={() => applyDiagramPreset(preset.prompt)}>
                                                {t[preset.labelKey]}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}
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
                    {voiceError && (
                        <p className="mb-1.5 text-xs text-destructive">{voiceError}</p>
                    )}
                    {screenshotError && (
                        <p className="mb-1.5 text-xs text-destructive">{screenshotError}</p>
                    )}
                    {figmaError && <p className="mb-1.5 text-xs text-destructive">{figmaError}</p>}
                    {ocrError && <p className="mb-1.5 text-xs text-destructive">{ocrError}</p>}
                    <div className="flex items-end gap-2 rounded-2xl border border-border/80 bg-background/75 p-2 shadow-soft focus-within:border-primary/35 focus-within:ring-3 focus-within:ring-primary/10">
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
                                <DropdownMenuItem onClick={() => setShowScreenshotPicker(true)}>
                                    <MonitorSmartphone className="mr-1" /> {t.captureScreenshot}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setShowFigmaInput(true)}>
                                    <Frame className="mr-1" /> {t.attachFigmaFrame}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <ScreenshotPickerDialog
                            open={showScreenshotPicker}
                            onOpenChange={setShowScreenshotPicker}
                            onCapture={captureScreenshot}
                        />
                        {showFigmaInput && (
                            <div className="flex items-center gap-1.5">
                                <Input
                                    autoFocus
                                    value={figmaUrlInput}
                                    onChange={(e) => setFigmaUrlInput(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && fetchFigmaFrame()}
                                    placeholder={t.figmaUrlPlaceholder}
                                    className="h-9 w-64 text-xs"
                                />
                                <Button size="sm" variant="outline" disabled={figmaFetching} onClick={fetchFigmaFrame}>
                                    {figmaFetching ? <Loader2 className="size-3.5 animate-spin" /> : t.figmaFetch}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setShowFigmaInput(false)}>
                                    {t.cancel}
                                </Button>
                            </div>
                        )}
                        {isTranscribing ? (
                            <Button size="icon" variant="outline" disabled className="rounded-xl" aria-label={t.transcribing}>
                                <Loader2 className="animate-spin" />
                            </Button>
                        ) : isRecording ? (
                            <>
                                <Button
                                    onClick={stopRecording}
                                    size="icon"
                                    variant="destructive"
                                    className="rounded-xl animate-pulse"
                                    aria-label={t.stopRecording}
                                >
                                    <Mic />
                                </Button>
                                <Button
                                    onClick={cancelRecording}
                                    size="icon"
                                    variant="outline"
                                    className="rounded-xl"
                                    aria-label={t.cancelRecording}
                                >
                                    <X />
                                </Button>
                            </>
                        ) : (
                            <Button
                                onClick={startRecording}
                                disabled={isStreaming}
                                size="icon"
                                variant="outline"
                                className="rounded-xl"
                                aria-label={t.startRecording}
                            >
                                <Mic />
                            </Button>
                        )}
                        <Textarea
                            ref={textareaRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={t.sendMessage}
                            className="min-h-11 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
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
            <PromptVariableDialog
                open={pendingVariablePreset !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingVariablePreset(null);
                }}
                variables={pendingVariablePreset ? extractVariables(pendingVariablePreset.prompt) : []}
                onSubmit={(values) => {
                    if (pendingVariablePreset) applyPromptPreset(fillTemplate(pendingVariablePreset.prompt, values));
                }}
            />
        </div>
    );
}
