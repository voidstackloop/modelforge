import { useEffect, useRef, useState } from "react";
import {
    Trash2,
    Loader2,
    Search,
    Check,
    FileDown,
    FileUp,
    FolderOpen,
    BookMarked,
    Settings2,
    Bug,
    Copy,
    RefreshCw,
    Pencil,
    History,
    Plug,
    Plus,
    ChevronDown,
    ChevronRight,
    Clock,
    Play,
    SlidersHorizontal,
    Boxes,
    MessageSquare,
    Volume2,
    Database,
    MemoryStick,
    UserRound,
    Cpu,
    Apple,
    Gauge,
    ExternalLink,
    Shield,
    ShieldAlert,
    Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, type StatusTone } from "@/components/ds";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingsSection, SettingsRow } from "@/components/settings-ui";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type {
    AppSettings,
    ModelRecommendations,
    RecommendedModel,
    SystemSpecs,
    PromptPreset,
    PromptVersion,
    McpServerConfig,
    McpServerStatus,
    LocalGgufModel,
    LlamaCppGpuBackend,
    GpuSelectionMode,
    HfModelSummary,
    HfGgufFile,
    GgufAssessment,
    ScheduledTask,
    AppActivity,
    LinkedAccount,
    LocalRuntimeStatus,
    SandboxCapabilities,
    BenchmarkResult,
    RagCollectionSummary,
} from "@/types/electron";
import { recommendGpuBackend, gpuBackendNote } from "@/lib/gpu";
import { useToast } from "@/components/toast";
import {
    DEFAULT_KEYBINDINGS,
    KEYBINDING_ACTIONS,
    eventToBindingString,
    formatBindingForDisplay,
    notifyKeybindingsChanged,
    type KeybindingAction,
} from "@/lib/keybindings";
import { OPENAI_MODELS, ANTHROPIC_MODELS, GEMINI_MODELS, GPU_LAYERS_FALLBACK_MAX, formatModelRef, parseModelRef, CUSTOM_PROVIDER_PRESETS } from "@/lib/providers";
import { MCP_SERVER_PRESETS, type McpServerPreset } from "@/lib/mcp-presets";
import { useSessions } from "@/lib/sessions-context";
import { useI18n } from "@/lib/i18n";
import type { Locale } from "@/lib/translations";
import { useTheme, COLOR_THEMES, type ColorTheme } from "@/components/theme-provider";
import { speakText } from "@/lib/tts";
import { cn } from "@/lib/utils";
import { ggufGroupFor, ggufGroupSize, groupGgufFiles } from "@/lib/gguf";

type SettingsTab = "general" | "models" | "accounts" | "integrations" | "chat" | "voice" | "automation" | "data";

const SETTINGS_SEARCH_ITEMS: { tab: SettingsTab; label: string; keywords: string }[] = [
    { tab: "general", label: "Appearance, density & motion", keywords: "theme color compact comfortable animation reduced motion language server gpu cache" },
    { tab: "models", label: "Models & hardware", keywords: "llama.cpp hugging face download vram recommendation gguf" },
    { tab: "accounts", label: "Connected accounts", keywords: "github hugging face account token profile repository" },
    { tab: "integrations", label: "Integrations & MCP", keywords: "api key custom gpu backend figma mcp openai claude gemini" },
    { tab: "chat", label: "Agent & tools", keywords: "prompt temperature context tokens agent steps tool calls sandbox verification" },
    { tab: "voice", label: "Voice & speech", keywords: "microphone transcription tts read aloud voice" },
    { tab: "automation", label: "Automation", keywords: "scheduled task interval prompt" },
    { tab: "data", label: "Usage, energy & diagnostics", keywords: "export import logs memory activity clear energy cost benchmark downloads storage" },
];

// Maps the backend's technical RecommendationOutcome (system-specs.ts) to a
// plain-language fit tier + semantic tone — the raw outcome string is still
// shown in the row's detail line, this is purely a friendlier headline.
const OUTCOME_TONE: Record<string, StatusTone> = {
    "Runs fully on GPU": "success",
    "Requires tensor parallelism": "success",
    "Runs with partial offload": "info",
    "CPU-only but usable": "warning",
    "Likely out of memory": "error",
};
const OUTCOME_LABEL_KEY = {
    "Runs fully on GPU": "fitBestFit",
    "Requires tensor parallelism": "fitBestFit",
    "Runs with partial offload": "fitRunsWell",
    "CPU-only but usable": "fitMaySlow",
    "Likely out of memory": "fitDoesNotFit",
} as const satisfies Record<string, "fitBestFit" | "fitRunsWell" | "fitMaySlow" | "fitDoesNotFit">;

const MANAGED_MODEL_CATALOG = [
    { backend: "mlx" as const, id: "mlx-community/Llama-3.2-3B-Instruct-4bit", label: "Llama 3.2 3B", note: "Fast · 4-bit · Apple Silicon" },
    { backend: "mlx" as const, id: "mlx-community/Qwen2.5-7B-Instruct-4bit", label: "Qwen 2.5 7B", note: "Balanced · 4-bit · Apple Silicon" },
    { backend: "vllm" as const, id: "Qwen/Qwen2.5-7B-Instruct", label: "Qwen 2.5 7B", note: "Efficient · CUDA / ROCm" },
    { backend: "vllm" as const, id: "meta-llama/Llama-3.1-8B-Instruct", label: "Llama 3.1 8B", note: "General purpose · CUDA / ROCm" },
] as const;

const RUNTIME_META = {
    rocm: { label: "ROCm", icon: Cpu, docs: "https://github.com/ggerganov/llama.cpp/blob/master/docs/build.md" },
    mlx: { label: "MLX", icon: Apple, docs: "https://github.com/ml-explore/mlx-lm" },
    vllm: { label: "vLLM", icon: Gauge, docs: "https://docs.vllm.ai/en/latest/getting_started/installation.html" },
} as const;

// Fixed previews stay recognizable while another palette is active. The first
// color is the surface, the second the primary accent, and the third a familiar
// supporting color from the palette.
const COLOR_THEME_SWATCHES: Record<ColorTheme, readonly [string, string, string]> = {
    default: ["#18181b", "#71717a", "#fafafa"],
    blue: ["#172554", "#3b82f6", "#dbeafe"],
    green: ["#14532d", "#22c55e", "#dcfce7"],
    purple: ["#3b0764", "#a855f7", "#f3e8ff"],
    orange: ["#431407", "#f97316", "#ffedd5"],
    rose: ["#4c0519", "#f43f5e", "#ffe4e6"],
    monokai: ["#272822", "#f92672", "#a6e22e"],
    dracula: ["#282a36", "#bd93f9", "#50fa7b"],
    nord: ["#2e3440", "#88c0d0", "#a3be8c"],
    solarized: ["#002b36", "#2aa198", "#b58900"],
    gruvbox: ["#282828", "#fe8019", "#b8bb26"],
    catppuccin: ["#1e1e2e", "#cba6f7", "#89b4fa"],
};

function formatBytes(bytes: number) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
}

export default function Settings() {
    const { t, locale, setLocale } = useI18n();
    const { theme, setTheme, colorTheme, setColorTheme } = useTheme();
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

    useEffect(() => {
        function loadVoices() {
            setVoices(window.speechSynthesis.getVoices());
        }
        loadVoices();
        window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
        return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
    }, []);
    const [specs, setSpecs] = useState<SystemSpecs | null>(null);
    const [recommendations, setRecommendations] = useState<ModelRecommendations | null>(null);
    const [ragCollections, setRagCollections] = useState<RagCollectionSummary[]>([]);
    const [ragCollectionsLocked, setRagCollectionsLocked] = useState(false);
    const [ragCollectionsError, setRagCollectionsError] = useState<string | null>(null);
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [hasApi, setHasApi] = useState(true);
    const [search, setSearch] = useState("");
    const [activeTab, setActiveTab] = useState<SettingsTab>("general");
    const [settingsQuery, setSettingsQuery] = useState("");
    const [openaiKeyInput, setOpenaiKeyInput] = useState("");
    const [anthropicKeyInput, setAnthropicKeyInput] = useState("");
    const [openaiKeySet, setOpenaiKeySet] = useState(false);
    const [anthropicKeySet, setAnthropicKeySet] = useState(false);
    const [figmaTokenInput, setFigmaTokenInput] = useState("");
    const [figmaTokenSet, setFigmaTokenSet] = useState(false);
    const [accountTokens, setAccountTokens] = useState<Record<"github" | "huggingface", string>>({ github: "", huggingface: "" });
    const [linkedAccounts, setLinkedAccounts] = useState<Record<"github" | "huggingface", LinkedAccount | null>>({ github: null, huggingface: null });
    const [accountConnecting, setAccountConnecting] = useState<"github" | "huggingface" | null>(null);
    const [geminiKeyInput, setGeminiKeyInput] = useState("");
    const [geminiKeySet, setGeminiKeySet] = useState(false);
    const [customKeySet, setCustomKeySet] = useState<Record<string, boolean>>({});
    const [customKeyInputs, setCustomKeyInputs] = useState<Record<string, string>>({});
    const [showAddCustomProvider, setShowAddCustomProvider] = useState(false);
    const [customDraftName, setCustomDraftName] = useState("");
    const [customDraftBaseUrl, setCustomDraftBaseUrl] = useState("");
    const [customDraftModelIds, setCustomDraftModelIds] = useState("");
    const [customDraftLocalGpu, setCustomDraftLocalGpu] = useState(false);
    const [appVersion, setAppVersion] = useState<string | null>(null);
    const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
    const [userDataPath, setUserDataPath] = useState<string | null>(null);
    const [activity, setActivity] = useState<AppActivity | null>(null);
    const [activityLoading, setActivityLoading] = useState(false);
    const [benchmarkModel, setBenchmarkModel] = useState("");
    const [benchmarkContext, setBenchmarkContext] = useState(8192);
    const [benchmarkCompare, setBenchmarkCompare] = useState(true);
    const [benchmarkRunning, setBenchmarkRunning] = useState(false);
    const [benchmarkRequestId, setBenchmarkRequestId] = useState<string | null>(null);
    const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkResult | null>(null);
    const [tariffName, setTariffName] = useState("");
    const [tariffStartHour, setTariffStartHour] = useState(17);
    const [tariffEndHour, setTariffEndHour] = useState(22);
    const [tariffPrice, setTariffPrice] = useState(0.3);
    const [keybindings, setKeybindings] = useState<Record<KeybindingAction, string>>(DEFAULT_KEYBINDINGS);
    const [localModelInput, setLocalModelInput] = useState("");
    const [localModelBackend, setLocalModelBackend] = useState<"mlx" | "vllm">("vllm");
    const [runtimeStatuses, setRuntimeStatuses] = useState<LocalRuntimeStatus[]>([]);
    const [runtimeRefreshing, setRuntimeRefreshing] = useState(false);
    const [recordingAction, setRecordingAction] = useState<KeybindingAction | null>(null);
    const [keybindingConflict, setKeybindingConflict] = useState<string | null>(null);
    const [importMessage, setImportMessage] = useState<string | null>(null);
    const [sandboxCapabilities, setSandboxCapabilities] = useState<SandboxCapabilities | null>(null);
    const [secretsEncrypted, setSecretsEncrypted] = useState<boolean | null>(null);
    const [newPresetName, setNewPresetName] = useState("");
    const [importPresetsMessage, setImportPresetsMessage] = useState<string | null>(null);
    const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
    const [editDraftName, setEditDraftName] = useState("");
    const [editDraftPrompt, setEditDraftPrompt] = useState("");
    const { refresh: refreshSessions } = useSessions();
    const toast = useToast();
    const loadedTabs = useRef(new Set<SettingsTab>());
    const hfSearchRequest = useRef(0);
    const hfFilesRequest = useRef(0);

    useEffect(() => {
        window.api.benchmark.getLast().then(setBenchmarkResult).catch(() => undefined);
    }, []);

    useEffect(() => {
        window.api.mcp.isMastervaultBuiltinAvailable().then(setMastervaultAvailable).catch(() => undefined);
    }, []);

    const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpServerStatus>>({});
    const [mcpConnecting, setMcpConnecting] = useState<Record<string, boolean>>({});
    const [showAddMcp, setShowAddMcp] = useState(false);
    const [mcpDraftName, setMcpDraftName] = useState("");
    const [mcpDraftTransport, setMcpDraftTransport] = useState<"stdio" | "http">("stdio");
    const [mcpDraftCommand, setMcpDraftCommand] = useState("");
    const [mcpDraftUrl, setMcpDraftUrl] = useState("");
    const [mcpDraftOAuth, setMcpDraftOAuth] = useState(false);
    const [mcpDraftPresetExtras, setMcpDraftPresetExtras] = useState<{ blockedTools?: string[]; warningBanner?: string } | null>(null);
    const [mcpOAuthTokensPresent, setMcpOAuthTokensPresent] = useState<Record<string, boolean>>({});
    const [mcpOAuthInProgress, setMcpOAuthInProgress] = useState<Record<string, boolean>>({});
    const [mastervaultAvailable, setMastervaultAvailable] = useState(false);
    const [mastervaultAdding, setMastervaultAdding] = useState(false);

    const [llamaCppModels, setLlamaCppModels] = useState<LocalGgufModel[]>([]);
    const [llamaCppGpuBackends, setLlamaCppGpuBackends] = useState<string[]>([]);
    const [changingLlamaCppDir, setChangingLlamaCppDir] = useState(false);

    const [hfResults, setHfResults] = useState<HfModelSummary[]>([]);
    const [hfSearching, setHfSearching] = useState(false);
    const [hfError, setHfError] = useState<string | null>(null);
    const [hfExpandedId, setHfExpandedId] = useState<string | null>(null);
    const [hfFiles, setHfFiles] = useState<HfGgufFile[]>([]);
    const [hfFilesLoading, setHfFilesLoading] = useState(false);
    const [hfDownloading, setHfDownloading] = useState<Record<string, number>>({});
    const [hfAssessments, setHfAssessments] = useState<Record<string, GgufAssessment>>({});
    const [hfAssessmentsLoading, setHfAssessmentsLoading] = useState(false);

    const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
    const [showAddTask, setShowAddTask] = useState(false);
    const [taskDraftName, setTaskDraftName] = useState("");
    const [taskDraftPrompt, setTaskDraftPrompt] = useState("");
    const [taskDraftModel, setTaskDraftModel] = useState("");
    const [taskDraftInterval, setTaskDraftInterval] = useState(60);

    useEffect(() => {
        if (!window.api) {
            // Intentional: one-time environment check (browser dev preview has no
            // Electron preload bridge), not state derived from props.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setHasApi(false);
            return;
        }
        window.api.system.getSpecs().then(setSpecs);
        window.api.system.getRecommendations().then(setRecommendations);
        window.api.rag
            .listCollections()
            .then((collections) => {
                setRagCollections(collections);
                setRagCollectionsLocked(false);
                setRagCollectionsError(null);
            })
            // rag-db.ts encrypts indexed content under the same passphrase
            // as Patient Cases (case-encryption.ts), so the most likely
            // cause of this rejecting is that it's currently locked — but
            // re-check rather than assume, so a genuinely different
            // failure (a corrupted index, disk I/O) shows as itself
            // instead of a fix ("unlock in Patient Cases") that won't help.
            .catch((err) => {
                window.api!.encryption.status().then((status) => {
                    if (status.enabled && !status.unlocked) {
                        setRagCollectionsLocked(true);
                        setRagCollectionsError(null);
                    } else {
                        setRagCollectionsLocked(false);
                        setRagCollectionsError((err as Error).message);
                    }
                });
            });
        window.api.settings.get().then((s) => {
            setSettings(s);
            setKeybindings({ ...DEFAULT_KEYBINDINGS, ...s.keybindings } as Record<KeybindingAction, string>);
        });
        window.api.llamacpp.listModels().then(setLlamaCppModels);
        window.api.llamacpp.getAvailableGpuBackends().then(setLlamaCppGpuBackends);
        refreshRuntimeStatuses();
        window.api.agent.getSandboxCapabilities().then(setSandboxCapabilities);
        window.api.secrets.isEncryptionAvailable().then(setSecretsEncrypted);
    }, []);

    useEffect(() => {
        if (!window.api || loadedTabs.current.has(activeTab)) return;
        if (activeTab === "integrations" && !settings) return;
        loadedTabs.current.add(activeTab);

        if (activeTab === "accounts") {
            Promise.all([window.api.accounts.status("github"), window.api.accounts.status("huggingface")]).then(
                ([github, huggingface]) => setLinkedAccounts({ github, huggingface })
            );
        } else if (activeTab === "integrations") {
            window.api.secrets.has("openai_api_key").then(setOpenaiKeySet);
            window.api.secrets.has("anthropic_api_key").then(setAnthropicKeySet);
            window.api.secrets.has("figma_token").then(setFigmaTokenSet);
            window.api.secrets.has("gemini_api_key").then(setGeminiKeySet);
            window.api.mcp.status().then(setMcpStatuses);
            for (const server of settings?.mcpServers ?? []) {
                if (server.auth?.type === "oauth2") {
                    window.api.mcp.hasOAuthTokens(server.id).then((has) => setMcpOAuthTokensPresent((prev) => ({ ...prev, [server.id]: has })));
                }
            }
            for (const provider of settings?.customProviders ?? []) {
                window.api.secrets.has(`custom_${provider.id}_api_key`).then((has) =>
                    setCustomKeySet((prev) => ({ ...prev, [provider.id]: has }))
                );
            }
        } else if (activeTab === "automation") {
            window.api.scheduledTasks.list().then(setScheduledTasks);
        } else if (activeTab === "data") {
            window.api.system.getActivity().then(setActivity);
            window.api.app.getVersion().then(setAppVersion);
            window.api.data.getUserDataPath().then(setUserDataPath);
        }
    }, [activeTab, settings]);

    // Debounced real Hugging Face Hub search — fires a bit after typing stops
    // rather than on every keystroke, since it's a network call.
    useEffect(() => {
        const query = search.trim();
        const requestId = ++hfSearchRequest.current;
        if (activeTab !== "models" || !hasApi || !query || /^https?:\/\//i.test(query) || /^hf\.co\//i.test(query)) {
            // Intentional: clears stale results when the search box empties or
            // looks like a direct tag/URL paste rather than a search query.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setHfResults([]);
            setHfError(null);
            setHfSearching(false);
            return;
        }
        setHfSearching(true);
        const timer = setTimeout(async () => {
            try {
                const res = await window.api.huggingface.search(query);
                if (hfSearchRequest.current !== requestId) return;
                setHfResults(res.results ?? []);
                setHfError(res.error ?? null);
            } catch (reason) {
                if (hfSearchRequest.current !== requestId) return;
                setHfResults([]);
                setHfError((reason as Error).message);
            } finally {
                if (hfSearchRequest.current === requestId) setHfSearching(false);
            }
        }, 400);
        return () => clearTimeout(timer);
    }, [activeTab, hasApi, search]);

    async function toggleHfExpanded(modelId: string) {
        const requestId = ++hfFilesRequest.current;
        if (hfExpandedId === modelId) {
            setHfExpandedId(null);
            setHfFiles([]);
            setHfAssessments({});
            setHfFilesLoading(false);
            setHfAssessmentsLoading(false);
            return;
        }
        setHfExpandedId(modelId);
        setHfFilesLoading(true);
        setHfFiles([]);
        setHfAssessments({});
        setHfAssessmentsLoading(false);
        try {
            const res = await window.api.huggingface.listFiles(modelId);
            if (hfFilesRequest.current !== requestId) return;
            if (res.error) throw new Error(res.error);
            const files = res.files ?? [];
            setHfFiles(files);
            setHfFilesLoading(false);
            if (files.length > 0) {
                setHfAssessmentsLoading(true);
                const assessments = await window.api.system.assessGgufFiles(groupGgufFiles(files).map((group) => ({ modelId, filename: group[0].path, sizeBytes: ggufGroupSize(group) })));
                if (hfFilesRequest.current !== requestId) return;
                setHfAssessments(Object.fromEntries(assessments.map((assessment) => [assessment.filename, assessment])));
            }
        } catch (reason) {
            if (hfFilesRequest.current !== requestId) return;
            setHfFiles([]);
            toast.error((reason as Error).message);
        } finally {
            if (hfFilesRequest.current === requestId) {
                setHfFilesLoading(false);
                setHfAssessmentsLoading(false);
            }
        }
    }

    async function downloadForLlamaCpp(modelId: string, filename: string) {
        const files = ggufGroupFor(hfFiles, filename);
        const keys = files.map((file) => `${modelId}/${file.path}`);
        setHfDownloading((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, 0])) }));
        try {
            await Promise.all(files.map((file) => window.api.downloads.create({ modelId, filename: file.path, expectedBytes: file.sizeBytes ?? 0, sha256: file.sha256 })));
            toast.success(files.length > 1
                ? (locale === "tr" ? `${files.length} parça İndirme Merkezine eklendi` : `${files.length} shards added to Download Center`)
                : (locale === "tr" ? "İndirme Merkezine eklendi" : "Added to Download Center"));
        } catch (reason) {
            toast.error((reason as Error).message);
        } finally {
            setHfDownloading((current) => {
                const next = { ...current };
                for (const key of keys) delete next[key];
                return next;
            });
        }
    }

    async function deleteLlamaCppModel(name: string) {
        await window.api.llamacpp.deleteModel(name);
        window.api.llamacpp.listModels().then(setLlamaCppModels);
    }

    async function changeLlamaCppGpuBackend(backend: LlamaCppGpuBackend) {
        await window.api.llamacpp.setGpuBackend(backend);
        const updated = await window.api.settings.get();
        setSettings(updated);
    }

    async function chooseLlamaCppModelsDir() {
        setChangingLlamaCppDir(true);
        const dir = await window.api.llamacpp.pickModelsDir();
        if (dir) {
            const updated = await window.api.settings.get();
            setSettings(updated);
            window.api.llamacpp.listModels().then(setLlamaCppModels);
        }
        setChangingLlamaCppDir(false);
    }

    async function createScheduledTask() {
        const name = taskDraftName.trim();
        const prompt = taskDraftPrompt.trim();
        if (!name || !prompt || !taskDraftModel) return;
        await window.api.scheduledTasks.create(name, prompt, taskDraftModel, taskDraftInterval);
        // Re-fetch rather than optimistically appending: the initial mount
        // fetch and this one can otherwise race (the mount fetch resolving
        // after creation, already containing the new task, followed by this
        // handler appending it again on top).
        window.api.scheduledTasks.list().then(setScheduledTasks);
        setTaskDraftName("");
        setTaskDraftPrompt("");
        setTaskDraftModel("");
        setTaskDraftInterval(60);
        setShowAddTask(false);
    }

    async function toggleScheduledTask(task: ScheduledTask) {
        const updated = await window.api.scheduledTasks.update(task.id, { enabled: !task.enabled });
        if (updated) setScheduledTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
    }

    async function deleteScheduledTask(id: string) {
        await window.api.scheduledTasks.delete(id);
        setScheduledTasks((prev) => prev.filter((t) => t.id !== id));
    }

    async function runScheduledTaskNow(id: string) {
        await window.api.scheduledTasks.runNow(id);
        window.api.scheduledTasks.list().then(setScheduledTasks);
    }

    // Encrypted automatically when case encryption is enabled — same
    // passphrase already protecting sessions.json (see data-transfer.ts). A
    // locked or wrong-passphrase state rejects with a message already
    // written for the user to read directly, same as other locked-store
    // toasts elsewhere in Settings.
    async function handleExportAll() {
        try {
            const result = await window.api.data.exportAll();
            if (result.success) toast.success(t.toastExportDone);
        } catch (reason) {
            toast.error((reason as Error).message);
        }
    }

    async function handleImport() {
        try {
            const result = await window.api.data.import();
            setImportMessage(
                result.imported > 0
                    ? `Imported ${result.imported} conversation${result.imported === 1 ? "" : "s"}.`
                    : "No conversations found in that file."
            );
            await refreshSessions();
            setTimeout(() => setImportMessage(null), 4000);
        } catch (reason) {
            toast.error((reason as Error).message);
        }
    }

    async function handleClearAll() {
        if (!confirm("Delete all conversations? This cannot be undone.")) return;
        await window.api.sessions.clearAll();
        await refreshSessions();
    }

    async function saveKeybindings(next: Record<KeybindingAction, string>) {
        setKeybindings(next);
        await window.api.settings.save({ keybindings: next });
        notifyKeybindingsChanged(next);
    }

    function withBinding(action: KeybindingAction, binding: string): Record<KeybindingAction, string> {
        const next = { ...keybindings };
        next[action] = binding;
        return next;
    }

    useEffect(() => {
        const action = recordingAction;
        if (!action) return;
        function onKeyDown(e: KeyboardEvent) {
            if (!action) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
                setRecordingAction(null);
                return;
            }
            const binding = eventToBindingString(e);
            if (!binding || !binding.includes("+")) return; // require at least one modifier
            const conflictingAction = KEYBINDING_ACTIONS.find((a) => a !== action && keybindings[a] === binding);
            if (conflictingAction) {
                setKeybindingConflict(binding);
                return;
            }
            setKeybindingConflict(null);
            saveKeybindings(withBinding(action, binding));
            setRecordingAction(null);
        }
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recordingAction, keybindings]);

    function resetKeybinding(action: KeybindingAction) {
        saveKeybindings(withBinding(action, DEFAULT_KEYBINDINGS[action]));
    }

    const keybindingLabels: Record<KeybindingAction, string> = {
        commandPalette: t.shortcutCommandPalette,
        newChat: t.shortcutNewChat,
        openSettings: t.shortcutSettings,
        showShortcuts: t.shortcutShowShortcuts,
    };

    async function refreshActivity() {
        setActivityLoading(true);
        try {
            setActivity(await window.api.system.getActivity());
        } finally {
            setActivityLoading(false);
        }
    }

    async function handleCopyDiagnostics() {
        const d = await window.api.app.getDiagnostics();
        const text = [
            `Modelforge ${d.appVersion}`,
            `Electron ${d.electron} / Chrome ${d.chrome} / Node ${d.node}`,
            `Platform: ${d.platform} (${d.arch})`,
            "",
            "--- recent log output ---",
            d.logTail || "(empty)",
        ].join("\n");
        await navigator.clipboard.writeText(text);
        setDiagnosticsCopied(true);
        setTimeout(() => setDiagnosticsCopied(false), 1500);
    }

    async function runHardwareBenchmark() {
        const parsed = parseModelRef(benchmarkModel);
        if (!parsed) {
            toast.error("Select a local model to benchmark.");
            return;
        }
        setBenchmarkRunning(true);
        const { requestId, promise } = window.api.benchmark.run({
            provider: parsed.provider,
            model: parsed.modelId,
            maxContextLength: benchmarkContext,
            outputTokens: 96,
            compareCpuGpu: benchmarkCompare,
        });
        setBenchmarkRequestId(requestId);
        try {
            const response = await promise;
            if (response.result) {
                setBenchmarkResult(response.result);
                toast.success("Benchmark completed.");
            } else if (response.error) {
                toast.error(response.error);
            }
        } finally {
            setBenchmarkRunning(false);
            setBenchmarkRequestId(null);
        }
    }

    async function cancelHardwareBenchmark() {
        if (benchmarkRequestId) await window.api.benchmark.cancel(benchmarkRequestId);
    }

    async function exportHardwareDiagnostic() {
        if (!benchmarkResult) return;
        const result = await window.api.benchmark.exportReport(benchmarkResult);
        if (result.success) toast.success("Diagnostic report exported.");
    }

    async function addTimeOfUseTariff() {
        if (!settings || !tariffName.trim() || tariffPrice < 0) return;
        await saveSettings({
            timeOfUseTariffs: [
                ...(settings.timeOfUseTariffs ?? []),
                {
                    name: tariffName.trim(),
                    startHour: Math.max(0, Math.min(24, tariffStartHour)),
                    endHour: Math.max(0, Math.min(24, tariffEndHour)),
                    pricePerKwh: tariffPrice,
                },
            ],
        });
        setTariffName("");
    }

    async function removeTimeOfUseTariff(index: number) {
        if (!settings) return;
        await saveSettings({ timeOfUseTariffs: (settings.timeOfUseTariffs ?? []).filter((_, itemIndex) => itemIndex !== index) });
    }

    async function saveOpenaiKey() {
        const value = openaiKeyInput.trim();
        await window.api.secrets.set("openai_api_key", value);
        setOpenaiKeySet(!!value);
        setOpenaiKeyInput("");
        toast.success(value ? t.toastApiKeySaved : t.toastApiKeyCleared);
    }

    async function saveAnthropicKey() {
        const value = anthropicKeyInput.trim();
        await window.api.secrets.set("anthropic_api_key", value);
        setAnthropicKeySet(!!value);
        setAnthropicKeyInput("");
        toast.success(value ? t.toastApiKeySaved : t.toastApiKeyCleared);
    }

    async function saveFigmaToken() {
        const value = figmaTokenInput.trim();
        await window.api.secrets.set("figma_token", value);
        setFigmaTokenSet(!!value);
        setFigmaTokenInput("");
        toast.success(value ? t.toastApiKeySaved : t.toastApiKeyCleared);
    }

    async function connectAccount(provider: "github" | "huggingface") {
        const token = accountTokens[provider].trim();
        if (!token) return;
        setAccountConnecting(provider);
        try {
            const account = await window.api.accounts.connect(provider, token);
            setLinkedAccounts((current) => ({ ...current, [provider]: account }));
            setAccountTokens((current) => ({ ...current, [provider]: "" }));
            toast.success(`${provider === "github" ? "GitHub" : "Hugging Face"} account linked as @${account.username}.`);
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setAccountConnecting(null);
        }
    }

    async function disconnectAccount(provider: "github" | "huggingface") {
        await window.api.accounts.disconnect(provider);
        setLinkedAccounts((current) => ({ ...current, [provider]: null }));
        toast.success(`${provider === "github" ? "GitHub" : "Hugging Face"} account disconnected.`);
    }

    async function saveGeminiKey() {
        const value = geminiKeyInput.trim();
        await window.api.secrets.set("gemini_api_key", value);
        setGeminiKeySet(!!value);
        setGeminiKeyInput("");
        toast.success(value ? t.toastApiKeySaved : t.toastApiKeyCleared);
    }

    function prefillCustomProviderPreset(preset: { name: string; baseUrl: string; modelIds: string[] }) {
        setCustomDraftName(preset.name);
        setCustomDraftBaseUrl(preset.baseUrl);
        setCustomDraftModelIds(preset.modelIds.join(", "));
        setCustomDraftLocalGpu(false);
        setShowAddCustomProvider(true);
    }

    // Prefills the same manual stdio form used for a hand-typed MCP server —
    // this never connects on its own. The user still reviews the command
    // (filling in any <placeholder> like a folder path) and clicks Add, same
    // as any other MCP server, so a preset is never a way to silently start
    // running a local binary the user didn't explicitly approve.
    function prefillMcpPreset(preset: McpServerPreset) {
        setMcpDraftName(preset.name);
        setMcpDraftTransport("stdio");
        setMcpDraftCommand(preset.commandTemplate);
        setMcpDraftPresetExtras(
            preset.blockedTools || preset.warningBanner
                ? { blockedTools: preset.blockedTools, warningBanner: preset.warningBanner }
                : null
        );
        setShowAddMcp(true);
    }

    async function addCustomProvider() {
        if (!settings) return;
        const name = customDraftName.trim();
        const baseUrl = customDraftBaseUrl.trim();
        const modelIds = customDraftModelIds
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (!name || !baseUrl || modelIds.length === 0) return;
        const provider = { id: crypto.randomUUID(), name, baseUrl, modelIds, localGpuBackend: customDraftLocalGpu };
        const updated = await window.api.settings.save({
            customProviders: [...(settings.customProviders ?? []), provider],
        });
        setSettings(updated);
        setCustomDraftName("");
        setCustomDraftBaseUrl("");
        setCustomDraftModelIds("");
        setCustomDraftLocalGpu(false);
        setShowAddCustomProvider(false);
        toast.success(`${name} — ${t.toastProviderAdded}`);
    }

    async function removeCustomProvider(id: string) {
        if (!settings) return;
        const updated = await window.api.settings.save({
            customProviders: (settings.customProviders ?? []).filter((p) => p.id !== id),
        });
        setSettings(updated);
        toast.success(t.toastProviderRemoved);
    }

    async function saveCustomProviderKey(id: string) {
        const value = (customKeyInputs[id] ?? "").trim();
        await window.api.secrets.set(`custom_${id}_api_key`, value);
        setCustomKeySet((prev) => ({ ...prev, [id]: !!value }));
        setCustomKeyInputs((prev) => ({ ...prev, [id]: "" }));
        toast.success(value ? t.toastApiKeySaved : t.toastApiKeyCleared);
    }

    // docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2.3: the curated MODEL_CATALOG's
    // `name` field is always an Ollama tag with no working pull mechanism at
    // all now that Ollama is removed (there never was one for the "vllm"/
    // "mlx" recommendedRuntime cases either — a curated catalog entry has no
    // real repo id for either of those). Every case routes to a real Hugging
    // Face search for the model's actual name instead of guessing at (and
    // potentially getting wrong) a specific repo/file — reuses the existing
    // debounced search below rather than adding new search UI. Not a perfect
    // fallback for "mlx" specifically (MLX models are safetensors under
    // mlx-community/, not GGUF, so the search results skew towards GGUF
    // quantizations) but still strictly better than a broken pull call.
    function downloadRecommendedModel(m: RecommendedModel) {
        setActiveTab("models");
        setSearch(m.huggingFaceSearchQuery);
    }

    async function deleteRagCollection(id: string) {
        await window.api.rag.deleteCollection(id);
        setRagCollections((prev) => prev.filter((c) => c.collectionId !== id));
    }

    async function saveSettings(partial: Partial<AppSettings>) {
        if (!settings) return;
        const merged = { ...settings, ...partial };
        setSettings(merged);
        await window.api.settings.save(partial);
        if (partial.uiDensity !== undefined || partial.reduceMotion !== undefined) {
            window.dispatchEvent(new CustomEvent("app:display-settings", { detail: merged }));
        }
    }

    async function addManagedModel(backend: "mlx" | "vllm", rawId: string = localModelInput) {
        const id = rawId.trim();
        if (!id || !settings) return;
        const key = backend === "mlx" ? "mlxModels" : "vllmModels";
        const existing = settings[key] ?? [];
        if (existing.includes(id)) return;
        await saveSettings({ [key]: [...existing, id] });
        setLocalModelInput("");
        toast.success(`${RUNTIME_META[backend].label} model added to your library.`);
    }

    async function removeManagedModel(backend: "mlx" | "vllm", id: string) {
        if (!settings) return;
        const key = backend === "mlx" ? "mlxModels" : "vllmModels";
        await saveSettings({ [key]: (settings[key] ?? []).filter((model) => model !== id) });
    }

    async function refreshRuntimeStatuses() {
        if (!window.api) return;
        setRuntimeRefreshing(true);
        try {
            setRuntimeStatuses(await window.api.localBackends.getStatuses());
        } finally {
            setRuntimeRefreshing(false);
        }
    }

    async function connectMcpServer(server: McpServerConfig) {
        setMcpConnecting((c) => ({ ...c, [server.id]: true }));
        const res = await window.api.mcp.connect(server);
        if (res.error) {
            setMcpStatuses((s) => ({ ...s, [server.id]: { connected: false, toolCount: 0, tools: [], error: res.error } }));
        } else {
            // Re-fetch full status rather than hand-building a partial one —
            // getServerStatuses() now also returns each tool's
            // name/description/annotations, needed for the trust-profile
            // picker below and the approval card's server-identity display.
            setMcpStatuses(await window.api.mcp.status());
        }
        setMcpConnecting((c) => ({ ...c, [server.id]: false }));
    }

    async function disconnectMcpServer(id: string) {
        await window.api.mcp.disconnect(id);
        setMcpStatuses((s) => ({ ...s, [id]: { connected: false, toolCount: 0, tools: [] } }));
    }

    // Persisted, per-tool, one-at-a-time — never a "trust this server"
    // toggle. Unchecking removes just that one tool name from the list;
    // everything else the server offers (including anything it adds later)
    // still prompts on every call.
    async function toggleMcpToolTrust(serverId: string, toolName: string, trusted: boolean) {
        if (!settings) return;
        const servers = settings.mcpServers ?? [];
        const nextServers = servers.map((s) => {
            if (s.id !== serverId) return s;
            const current = new Set(s.trustProfile?.autoApprovedTools ?? []);
            if (trusted) current.add(toolName);
            else current.delete(toolName);
            return { ...s, trustProfile: { autoApprovedTools: [...current] } };
        });
        const updated = await window.api.settings.save({ mcpServers: nextServers });
        setSettings(updated);
    }

    async function addMcpServer() {
        if (!settings) return;
        const name = mcpDraftName.trim();
        if (!name) return;
        const presetExtras = {
            ...(mcpDraftPresetExtras?.blockedTools ? { blockedTools: mcpDraftPresetExtras.blockedTools } : {}),
            ...(mcpDraftPresetExtras?.warningBanner ? { warningBanner: mcpDraftPresetExtras.warningBanner } : {}),
        };
        const server: McpServerConfig =
            mcpDraftTransport === "stdio"
                ? {
                      id: crypto.randomUUID(),
                      name,
                      transport: "stdio",
                      enabled: true,
                      command: mcpDraftCommand.trim().split(/\s+/)[0] ?? "",
                      args: mcpDraftCommand.trim().split(/\s+/).slice(1),
                      ...presetExtras,
                  }
                : {
                      id: crypto.randomUUID(),
                      name,
                      transport: "http",
                      enabled: true,
                      url: mcpDraftUrl.trim(),
                      ...(mcpDraftOAuth ? { auth: { type: "oauth2" as const } } : {}),
                      ...presetExtras,
                  };
        const updated = await window.api.settings.save({ mcpServers: [...(settings.mcpServers ?? []), server] });
        setSettings(updated);
        setMcpDraftName("");
        setMcpDraftCommand("");
        setMcpDraftUrl("");
        setMcpDraftOAuth(false);
        setMcpDraftPresetExtras(null);
        setShowAddMcp(false);
        // An OAuth-gated server needs a sign-in first — connecting
        // immediately would just fail with "requires authorization" (see
        // mcp-client.ts's UnauthorizedError handling), so skip the
        // auto-connect the plain-server path does and let the user hit
        // "Sign in" from the server row instead.
        if (!mcpDraftOAuth) connectMcpServer(server);
    }

    async function signInToMcpServer(server: McpServerConfig) {
        setMcpOAuthInProgress((s) => ({ ...s, [server.id]: true }));
        try {
            const res = await window.api.mcp.startOAuthFlow(server);
            if (res.authorized) {
                setMcpOAuthTokensPresent((s) => ({ ...s, [server.id]: true }));
                connectMcpServer(server);
            }
        } finally {
            setMcpOAuthInProgress((s) => ({ ...s, [server.id]: false }));
        }
    }

    async function clearMcpServerCredentials(serverId: string) {
        await window.api.mcp.clearOAuthCredentials(serverId);
        setMcpOAuthTokensPresent((s) => ({ ...s, [serverId]: false }));
    }

    // One-click add for the bundled MasterVault server: the folder picker is
    // the only per-user config it needs (everything else — command, args,
    // the ELECTRON_RUN_AS_NODE env var so it runs without a system Node.js —
    // is filled in on the main process side). Added exactly like any other
    // MCP server afterwards, so it's removable the same way (see
    // removeMcpServer below) — nothing about it is pinned or undeletable.
    async function addBuiltinMastervault() {
        if (!settings) return;
        setMastervaultAdding(true);
        try {
            const server = await window.api.mcp.pickMastervaultVault();
            if (!server) return;
            const updated = await window.api.settings.save({
                mcpServers: [...(settings.mcpServers ?? []).filter((s) => s.id !== server.id), server],
            });
            setSettings(updated);
            connectMcpServer(server);
        } finally {
            setMastervaultAdding(false);
        }
    }

    async function importManagedClinicalServers() {
        if (!settings) return;
        const result = await window.api.mcp.listManagedClinicalServers();
        if (result.error) {
            toast.error(result.error);
            return;
        }
        const discovered = result.servers ?? [];
        const discoveredIds = new Set(discovered.map((server) => server.id));
        const next = [...(settings.mcpServers ?? []).filter((server) => !discoveredIds.has(server.id)), ...discovered];
        const updated = await window.api.settings.save({ mcpServers: next });
        setSettings(updated);
        toast.success(discovered.length > 0 ? `${discovered.length} institutional clinical MCP server(s) added.` : "No active institutional clinical MCP servers were found.");
    }

    async function removeMcpServer(id: string) {
        if (!settings) return;
        await window.api.mcp.disconnect(id);
        const updated = await window.api.settings.save({
            mcpServers: (settings.mcpServers ?? []).filter((s) => s.id !== id),
        });
        setSettings(updated);
        setMcpStatuses((s) => {
            const next = { ...s };
            delete next[id];
            return next;
        });
    }

    const MAX_PRESET_VERSIONS = 10;

    async function handleSavePreset() {
        if (!settings) return;
        const name = newPresetName.trim();
        if (!name) return;
        const now = new Date().toISOString();
        const preset: PromptPreset = {
            id: crypto.randomUUID(),
            name,
            prompt: settings.systemPrompt,
            versions: [],
            createdAt: now,
            updatedAt: now,
        };
        await saveSettings({ promptPresets: [...settings.promptPresets, preset] });
        setNewPresetName("");
    }

    function applyPreset(prompt: string) {
        saveSettings({ systemPrompt: prompt });
    }

    function startEditPreset(preset: PromptPreset) {
        setEditingPresetId(preset.id);
        setEditDraftName(preset.name);
        setEditDraftPrompt(preset.prompt);
    }

    function cancelEditPreset() {
        setEditingPresetId(null);
    }

    async function saveEditedPreset(preset: PromptPreset) {
        if (!settings) return;
        const name = editDraftName.trim();
        if (!name) return;
        const now = new Date().toISOString();
        const promptChanged = preset.prompt !== editDraftPrompt;
        const updated: PromptPreset = {
            ...preset,
            name,
            prompt: editDraftPrompt,
            versions: promptChanged
                ? [{ prompt: preset.prompt, savedAt: preset.updatedAt ?? preset.createdAt ?? now }, ...(preset.versions ?? [])].slice(
                      0,
                      MAX_PRESET_VERSIONS
                  )
                : preset.versions,
            updatedAt: now,
        };
        await saveSettings({ promptPresets: settings.promptPresets.map((p) => (p.id === preset.id ? updated : p)) });
        setEditingPresetId(null);
    }

    async function restorePresetVersion(preset: PromptPreset, version: PromptVersion) {
        if (!settings) return;
        const now = new Date().toISOString();
        const updated: PromptPreset = {
            ...preset,
            prompt: version.prompt,
            versions: [{ prompt: preset.prompt, savedAt: preset.updatedAt ?? now }, ...(preset.versions ?? [])].slice(
                0,
                MAX_PRESET_VERSIONS
            ),
            updatedAt: now,
        };
        await saveSettings({ promptPresets: settings.promptPresets.map((p) => (p.id === preset.id ? updated : p)) });
    }

    function deletePreset(id: string) {
        if (!settings) return;
        saveSettings({ promptPresets: settings.promptPresets.filter((p) => p.id !== id) });
    }

    async function exportPresets() {
        if (!settings) return;
        await window.api.data.exportPromptPresets(settings.promptPresets);
    }

    async function importPresets() {
        if (!settings) return;
        const imported = await window.api.data.importPromptPresets();
        if (imported.length === 0) {
            setImportPresetsMessage(t.noPromptsImported);
        } else {
            const updated = await window.api.settings.save({ promptPresets: [...settings.promptPresets, ...imported] });
            setSettings(updated);
            setImportPresetsMessage(`${t.importedPromptsCount} ${imported.length}`);
        }
        setTimeout(() => setImportPresetsMessage(null), 4000);
    }

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Settings are only available when running inside the Electron app.
            </div>
        );
    }

    return (
        <ScrollArea className="h-full">
            <div className="mx-auto max-w-6xl px-4 pb-24 pt-16 sm:px-7 md:pt-9 2xl:max-w-7xl">
                <div className="mb-9 flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-3.5"><span className="flex size-11 items-center justify-center rounded-2xl border border-border bg-muted text-primary"><Settings2 className="size-5" /></span>
                    <div><p className="section-eyebrow mb-1">Workspace preferences</p><h1 className="text-[1.75rem] font-semibold tracking-[-0.035em]">{t.settings}</h1><p className="mt-1 text-xs text-muted-foreground">{t.settingsSubtitle}</p></div></div>
                    <div className="relative w-full sm:w-72">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input value={settingsQuery} onChange={(e) => setSettingsQuery(e.target.value)} placeholder={t.searchSettingsPlaceholder} className="h-11 rounded-2xl border-border/70 bg-card/75 pl-9 shadow-sm" aria-label={t.searchSettingsPlaceholder} />
                    </div>
                </div>

                {settingsQuery.trim() && (
                    <div className="mb-6 grid gap-2 rounded-2xl border border-border/70 bg-card p-3 shadow-sm sm:grid-cols-2">
                        {SETTINGS_SEARCH_ITEMS.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(settingsQuery.trim().toLowerCase())).map((item) => (
                            <button key={item.tab} onClick={() => { setActiveTab(item.tab); setSettingsQuery(""); }} className="rounded-xl border border-transparent p-3 text-left text-sm font-medium transition-colors hover:border-primary/20 hover:bg-primary/5">{item.label}<span className="mt-0.5 block text-xs font-normal text-muted-foreground">Open {item.tab} settings</span></button>
                        ))}
                    </div>
                )}

                <Tabs
                    value={activeTab}
                    onValueChange={(v) => setActiveTab(v as SettingsTab)}
                    orientation="vertical"
                    className="flex-col items-stretch gap-6 lg:flex-row lg:items-start lg:gap-9"
                >
                    <TabsList variant="line" className="sticky top-0 z-10 w-full shrink-0 flex-row overflow-x-auto rounded-2xl border border-border/65 bg-card p-1.5 lg:top-6 lg:w-56 lg:flex-col lg:p-2">
                        <TabsTrigger value="general" className="justify-start gap-2">
                            <SlidersHorizontal className="size-4 shrink-0" /> {t.settingsTabGeneral}
                        </TabsTrigger>
                        <TabsTrigger value="models" className="justify-start gap-2">
                            <Boxes className="size-4 shrink-0" /> {t.settingsTabModels}
                        </TabsTrigger>
                        <TabsTrigger value="accounts" className="justify-start gap-2">
                            <UserRound className="size-4 shrink-0" /> {t.settingsTabAccounts}
                        </TabsTrigger>
                        <TabsTrigger value="integrations" className="justify-start gap-2">
                            <Plug className="size-4 shrink-0" /> {t.settingsTabIntegrations}
                        </TabsTrigger>
                        <TabsTrigger value="chat" className="justify-start gap-2">
                            <MessageSquare className="size-4 shrink-0" /> {t.settingsTabChat}
                        </TabsTrigger>
                        <TabsTrigger value="voice" className="justify-start gap-2">
                            <Volume2 className="size-4 shrink-0" /> {t.settingsTabVoice}
                        </TabsTrigger>
                        <TabsTrigger value="automation" className="justify-start gap-2">
                            <Clock className="size-4 shrink-0" /> {t.settingsTabAutomation}
                        </TabsTrigger>
                        <TabsTrigger value="data" className="justify-start gap-2">
                            <Database className="size-4 shrink-0" /> {t.settingsTabData}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="general" className="min-w-0 flex-1 flex flex-col gap-8">
                    <div>
                        <SettingsSection title={t.ragEmbeddingModel} description={t.ragEmbeddingModelHint}>
                            <SettingsRow stacked>
                                <Select
                                    value={settings?.ragEmbeddingModel ?? ""}
                                    onValueChange={(v) => v && saveSettings({ ragEmbeddingModel: v })}
                                >
                                    <SelectTrigger size="sm" className="w-56">
                                        <SelectValue placeholder={t.ragEmbeddingModel} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {llamaCppModels.length > 0 ? (
                                            <SelectGroup>
                                                <SelectLabel>llama.cpp (local GGUF)</SelectLabel>
                                                {llamaCppModels.map((m) => (
                                                    <SelectItem key={m.name} value={formatModelRef("llamacpp", m.name)}>{m.label}</SelectItem>
                                                ))}
                                            </SelectGroup>
                                        ) : null}
                                    </SelectContent>
                                </Select>
                            </SettingsRow>
                        </SettingsSection>

                        <SettingsSection title={t.ragCollections} description={t.ragCollectionsHint} className="mt-8">
                            {ragCollectionsLocked ? (
                                <p className="text-xs text-muted-foreground">Case data is locked — unlock it in Patient Cases to see indexed folders.</p>
                            ) : ragCollectionsError ? (
                                <p className="text-xs text-destructive">Couldn't load indexed folders: {ragCollectionsError}</p>
                            ) : ragCollections.length === 0 ? (
                                <p className="text-xs text-muted-foreground">{t.ragCollectionsEmpty}</p>
                            ) : (
                                <div className="flex flex-col gap-2">
                                    {ragCollections.map((c) => (
                                        <div
                                            key={c.collectionId}
                                            className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
                                        >
                                            <div className="min-w-0">
                                                <div className="truncate font-medium">{c.name}</div>
                                                <div className="truncate text-xs text-muted-foreground">
                                                    {c.folderPath} · {t.ragCollectionMeta(c.documentCount, c.chunkCount)} · {c.embeddingModel}
                                                </div>
                                            </div>
                                            <Button size="sm" variant="ghost" className="shrink-0 text-xs text-destructive" onClick={() => deleteRagCollection(c.collectionId)}>
                                                {t.delete}
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </SettingsSection>

                        {settings && (
                            <SettingsSection title={t.llamaCppSection} description={t.llamaCppHint} className="mt-8">
                                <SettingsRow label={t.gpuBackend} description={t.gpuBackendHint} stacked>
                                    {(() => {
                                        const vendors = specs?.gpus.map((g) => g.vendor) ?? [];
                                        const recommended = recommendGpuBackend(vendors, llamaCppGpuBackends);
                                        const note = gpuBackendNote(vendors);
                                        const rec = (backend: string, label: string) =>
                                            backend === recommended ? `${label} (${t.gpuRecommended})` : label;
                                        return (
                                            <>
                                                <Select
                                                    value={settings.llamaCppGpuBackend ?? "auto"}
                                                    onValueChange={(v) => changeLlamaCppGpuBackend(v as LlamaCppGpuBackend)}
                                                >
                                                    <SelectTrigger size="sm" className="w-56">
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="auto">{t.gpuBackendAuto}</SelectItem>
                                                        {llamaCppGpuBackends.includes("cuda") && (
                                                            <SelectItem value="cuda">{rec("cuda", "CUDA (NVIDIA)")}</SelectItem>
                                                        )}
                                                        {llamaCppGpuBackends.includes("vulkan") && (
                                                            <SelectItem value="vulkan">{rec("vulkan", "Vulkan (NVIDIA / AMD / Intel)")}</SelectItem>
                                                        )}
                                                        {llamaCppGpuBackends.includes("metal") && (
                                                            <SelectItem value="metal">{rec("metal", "Metal (Apple)")}</SelectItem>
                                                        )}
                                                        <SelectItem value="cpu">{rec("cpu", t.gpuBackendCpu)}</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                                {specs && specs.gpus.length > 0 && (
                                                    <p className="text-xs text-muted-foreground">
                                                        {t.gpuDetected}: {specs.gpus.map((g) => g.name).join(", ")}
                                                    </p>
                                                )}
                                                {note === "amdViaVulkan" && (
                                                    <p className="text-xs text-muted-foreground">{t.gpuAmdRocmNote}</p>
                                                )}
                                                {note === "intelViaVulkan" && (
                                                    <p className="text-xs text-muted-foreground">{t.gpuIntelVulkanNote}</p>
                                                )}
                                                {note === "noGpuDetected" && (
                                                    <p className="text-xs text-muted-foreground">{t.gpuNoneDetectedNote}</p>
                                                )}
                                            </>
                                        );
                                    })()}
                                </SettingsRow>
                                <SettingsRow label={t.gpuSelectionModeLabel} description={t.gpuSelectionModeHint}>
                                    <Select
                                        value={settings.defaultGpuSelectionMode ?? "auto"}
                                        onValueChange={(v) => saveSettings({ defaultGpuSelectionMode: v as GpuSelectionMode })}
                                    >
                                        <SelectTrigger size="sm" className="w-56">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="auto">{t.gpuSelectionModeAuto}</SelectItem>
                                            <SelectItem value="single">{t.gpuSelectionModeSingle}</SelectItem>
                                            <SelectItem value="group">{t.gpuSelectionModeGroup}</SelectItem>
                                            <SelectItem value="all">{t.gpuSelectionModeAll}</SelectItem>
                                            <SelectItem value="cpu">{t.gpuSelectionModeCpu}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </SettingsRow>
                                <SettingsRow label={t.warmModelCache} description={t.warmModelCacheHint}>
                                    <Select value={String(settings.llamaCppMaxCachedModels ?? 2)} onValueChange={(v) => saveSettings({ llamaCppMaxCachedModels: Number(v) })}>
                                        <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="1">{t.warmModelCacheOption1}</SelectItem>
                                            <SelectItem value="2">{t.warmModelCacheOption2}</SelectItem>
                                            <SelectItem value="3">{t.warmModelCacheOption3}</SelectItem>
                                            <SelectItem value="4">{t.warmModelCacheOption4}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </SettingsRow>
                                <SettingsRow label="llama.cpp CPU threads" description="Blank uses node-llama-cpp's useful math-core count. A manual cap is shared across concurrent contexts.">
                                    <Input className="w-44" type="number" min={1} max={512} placeholder="Auto" value={settings.llamaCppMaxThreads ?? ""} onChange={(event) => saveSettings({ llamaCppMaxThreads: event.target.value === "" ? undefined : Number(event.target.value) })} />
                                </SettingsRow>
                                <SettingsRow label="Memory safety reserves" description="Reserved independently from automatic placement; never disables node-llama-cpp memory checks." stacked>
                                    <div className="grid max-w-md grid-cols-2 gap-3">
                                        <label className="text-xs text-muted-foreground">VRAM reserve (GB)<Input className="mt-1" type="number" min={0.25} max={64} step={0.25} placeholder="Runtime default" value={settings.llamaCppVramReserveGB ?? ""} onChange={(event) => saveSettings({ llamaCppVramReserveGB: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                        <label className="text-xs text-muted-foreground">RAM reserve (GB)<Input className="mt-1" type="number" min={0.5} max={256} step={0.5} placeholder="Runtime default" value={settings.llamaCppRamReserveGB ?? ""} onChange={(event) => saveSettings({ llamaCppRamReserveGB: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                    </div>
                                </SettingsRow>
                                <SettingsRow label="Context tuning" description="Context-only changes reuse loaded model weights; Flash Attention Auto is recommended." stacked>
                                    <div className="grid max-w-md grid-cols-2 gap-3">
                                        <label className="text-xs text-muted-foreground">Batch size<Input className="mt-1" type="number" min={1} max={65536} placeholder="Auto" value={settings.llamaCppBatchSize ?? ""} onChange={(event) => saveSettings({ llamaCppBatchSize: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                                        <label className="text-xs text-muted-foreground">Flash Attention<Select value={settings.llamaCppFlashAttention ?? "auto"} onValueChange={(value) => saveSettings({ llamaCppFlashAttention: value as AppSettings["llamaCppFlashAttention"] })}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">Auto</SelectItem><SelectItem value="on">On</SelectItem><SelectItem value="off">Off</SelectItem></SelectContent></Select></label>
                                    </div>
                                </SettingsRow>
                                <SettingsRow label={t.modelsDir} description={t.llamaCppModelsDirHint} stacked>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs">
                                            {settings.llamaCppModelsDir ?? t.llamaCppModelsDirDefault}
                                        </span>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={changingLlamaCppDir}
                                            onClick={chooseLlamaCppModelsDir}
                                            className="gap-1.5"
                                        >
                                            {changingLlamaCppDir ? (
                                                <Loader2 className="size-3.5 animate-spin" />
                                            ) : (
                                                <FolderOpen className="size-3.5" />
                                            )}
                                            {t.chooseFolder}
                                        </Button>
                                    </div>
                                </SettingsRow>
                                {llamaCppModels.map((m) => (
                                    <SettingsRow key={m.name} label={m.label} description={formatBytes(m.sizeBytes)}>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => deleteLlamaCppModel(m.name)}
                                            aria-label={`Delete ${m.label}`}
                                        >
                                            <Trash2 className="text-destructive" />
                                        </Button>
                                    </SettingsRow>
                                ))}
                                {llamaCppModels.length === 0 && (
                                    <p className="p-4 text-xs text-muted-foreground">{t.llamaCppNoModels}</p>
                                )}
                            </SettingsSection>
                        )}

                        {settings && (
                            <>
                                <SettingsSection
                                    title={t.localRuntimesTitle}
                                    description={t.localRuntimesHint}
                                    className="mt-8"
                                >
                                    <div className="grid gap-3 p-4 md:grid-cols-3">
                                        {(["rocm", "mlx", "vllm"] as const).map((backend) => {
                                            const meta = RUNTIME_META[backend];
                                            const Icon = meta.icon;
                                            const status = runtimeStatuses.find((item) => item.backend === backend);
                                            const stateLabel = status?.running
                                                ? t.runtimeStateRunning
                                                : status?.installed
                                                  ? t.runtimeStateReady
                                                  : status && !status.compatible
                                                    ? t.runtimeStateUnsupported
                                                    : status
                                                      ? t.runtimeStateNotInstalled
                                                      : t.runtimeStateChecking;
                                            return (
                                                <div key={backend} className="rounded-2xl border border-border/70 bg-card/70 p-4 shadow-sm">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                                            <Icon className="size-5" />
                                                        </span>
                                                        <Badge variant={status?.running || status?.installed ? "default" : "secondary"}>
                                                            {stateLabel}
                                                        </Badge>
                                                    </div>
                                                    <h3 className="mt-3 font-semibold">{meta.label}</h3>
                                                    <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">
                                                        {status?.detail ?? t.runtimeDetecting}
                                                    </p>
                                                    {status?.model && (
                                                        <p className="mt-2 truncate font-mono text-[11px] text-primary">
                                                            {status.model.split(/[/\\]/).pop()}
                                                        </p>
                                                    )}
                                                    <a
                                                        href={meta.docs}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                                    >
                                                        {t.setupGuide} <ExternalLink className="size-3" />
                                                    </a>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div className="flex justify-end border-t border-border/60 px-4 py-3">
                                        <Button size="sm" variant="outline" onClick={refreshRuntimeStatuses} disabled={runtimeRefreshing}>
                                            <RefreshCw className={cn("size-3.5", runtimeRefreshing && "animate-spin")} /> {t.refreshRuntimes}
                                        </Button>
                                    </div>
                                </SettingsSection>

                                <SettingsSection
                                    title={t.localModelLibraryTitle}
                                    description={t.localModelLibraryHint}
                                    className="mt-8"
                                >
                                    {((settings.mlxModels?.length ?? 0) + (settings.vllmModels?.length ?? 0)) > 0 ? (
                                        <div className="grid gap-2 p-4 sm:grid-cols-2">
                                            {[
                                                ...(settings.mlxModels ?? []).map((id) => ({ backend: "mlx" as const, id })),
                                                ...(settings.vllmModels ?? []).map((id) => ({ backend: "vllm" as const, id })),
                                            ].map(({ backend, id }) => (
                                                <div key={`${backend}:${id}`} className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-muted/25 p-3">
                                                    <Badge variant="outline" className="shrink-0">{RUNTIME_META[backend].label}</Badge>
                                                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{id}</span>
                                                    <Button size="icon" variant="ghost" onClick={() => removeManagedModel(backend, id)} aria-label={`Remove ${id}`}>
                                                        <Trash2 className="size-3.5 text-destructive" />
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="p-4 text-sm text-muted-foreground">{t.localModelLibraryEmpty}</p>
                                    )}
                                    <div className="border-t border-border/60 p-4">
                                        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            {t.recommendedForRuntimes}
                                        </p>
                                        <div className="grid gap-2 sm:grid-cols-2">
                                            {MANAGED_MODEL_CATALOG.map((model) => {
                                                const added = (settings[model.backend === "mlx" ? "mlxModels" : "vllmModels"] ?? []).includes(model.id);
                                                return (
                                                    <button
                                                        key={`${model.backend}:${model.id}`}
                                                        type="button"
                                                        disabled={added}
                                                        onClick={() => addManagedModel(model.backend, model.id)}
                                                        className="flex items-center gap-3 rounded-xl border border-border/70 p-3 text-left transition-colors hover:border-primary/30 hover:bg-primary/5 disabled:cursor-default disabled:opacity-60"
                                                    >
                                                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
                                                            {RUNTIME_META[model.backend].label}
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block text-sm font-medium">{model.label}</span>
                                                            <span className="block truncate text-xs text-muted-foreground">{model.note}</span>
                                                        </span>
                                                        {added ? <Check className="size-4 text-primary" /> : <Plus className="size-4" />}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        <div className="mt-4 flex flex-col gap-2 rounded-xl bg-muted/35 p-3 sm:flex-row">
                                            <Select value={localModelBackend} onValueChange={(value) => setLocalModelBackend(value as "mlx" | "vllm")}>
                                                <SelectTrigger size="sm" className="w-full sm:w-28">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="mlx">MLX</SelectItem>
                                                    <SelectItem value="vllm">vLLM</SelectItem>
                                                </SelectContent>
                                            </Select>
                                            <Input
                                                value={localModelInput}
                                                onChange={(event) => setLocalModelInput(event.target.value)}
                                                onKeyDown={(event) => event.key === "Enter" && addManagedModel(localModelBackend)}
                                                placeholder={t.hfModelIdPlaceholder}
                                                className="h-8 flex-1 text-xs"
                                            />
                                            <Button size="sm" onClick={() => addManagedModel(localModelBackend)} disabled={!localModelInput.trim()}>
                                                <Plus className="size-3.5" /> {t.addModelButton}
                                            </Button>
                                        </div>
                                    </div>
                                </SettingsSection>
                            </>
                        )}

                        <SettingsSection title={t.appearance} className="mt-8">
                            <SettingsRow label={t.colorMode}>
                                <Select value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
                                    <SelectTrigger size="sm" className="w-36">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="light">{t.colorModeLight}</SelectItem>
                                        <SelectItem value="dark">{t.colorModeDark}</SelectItem>
                                        <SelectItem value="system">{t.colorModeSystem}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </SettingsRow>
                            <SettingsRow label={t.colorTheme} description={t.colorThemeHint} stacked>
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                    {COLOR_THEMES.map((candidate) => (
                                        <button
                                            key={candidate}
                                            type="button"
                                            onClick={() => setColorTheme(candidate)}
                                            aria-label={t.colorThemeNames[candidate]}
                                            aria-pressed={colorTheme === candidate}
                                            className={cn(
                                                "flex min-h-11 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted",
                                                colorTheme === candidate
                                                    ? "border-primary bg-primary/8 text-foreground"
                                                    : "border-border text-muted-foreground"
                                            )}
                                        >
                                            <span className="flex shrink-0 -space-x-1" aria-hidden="true">
                                                {COLOR_THEME_SWATCHES[candidate].map((swatch) => (
                                                    <span
                                                        key={swatch}
                                                        className="size-4 rounded-full border border-white/30"
                                                        style={{ backgroundColor: swatch }}
                                                    />
                                                ))}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate font-medium">{t.colorThemeNames[candidate]}</span>
                                            {colorTheme === candidate && <Check className="size-3.5 shrink-0 text-primary" />}
                                        </button>
                                    ))}
                                </div>
                            </SettingsRow>
                            <SettingsRow label={t.interfaceDensity} description={t.interfaceDensityHint}>
                                <Select value={settings?.uiDensity ?? "comfortable"} onValueChange={(v) => saveSettings({ uiDensity: v as "comfortable" | "compact" })}>
                                    <SelectTrigger size="sm" className="w-40">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="comfortable">{t.densityComfortable}</SelectItem>
                                        <SelectItem value="compact">{t.densityCompact}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </SettingsRow>
                            <SettingsRow label={t.reduceMotionLabel} description={t.reduceMotionHint}>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={settings?.reduceMotion ?? false}
                                    aria-label={t.reduceMotionLabel}
                                    onClick={() => saveSettings({ reduceMotion: !(settings?.reduceMotion ?? false) })}
                                    className={cn("relative h-6 w-11 rounded-full transition-colors", settings?.reduceMotion ? "bg-primary" : "bg-muted")}
                                >
                                    <span
                                        className={cn(
                                            "absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform",
                                            settings?.reduceMotion ? "translate-x-5" : "translate-x-0.5"
                                        )}
                                    />
                                </button>
                            </SettingsRow>
                        </SettingsSection>

                        <SettingsSection title={t.language} className="mt-8">
                            <SettingsRow label={t.language}>
                                <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
                                    <SelectTrigger size="sm" className="w-36">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="en">English</SelectItem>
                                        <SelectItem value="tr">Türkçe</SelectItem>
                                    </SelectContent>
                                </Select>
                            </SettingsRow>
                        </SettingsSection>

                        <SettingsSection title={t.keybindings} description={t.keybindingsDescription} className="mt-8">
                            {KEYBINDING_ACTIONS.map((action) => (
                                <SettingsRow key={action} label={keybindingLabels[action]}>
                                    {recordingAction === action ? (
                                        <span className="text-sm text-muted-foreground italic">{t.pressAKey}</span>
                                    ) : (
                                        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                                            {formatBindingForDisplay(keybindings[action])}
                                        </kbd>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            setKeybindingConflict(null);
                                            setRecordingAction(action);
                                        }}
                                    >
                                        {recordingAction === action ? t.cancel : t.recordShortcut}
                                    </Button>
                                    {keybindings[action] !== DEFAULT_KEYBINDINGS[action] && (
                                        <Button size="sm" variant="ghost" onClick={() => resetKeybinding(action)}>
                                            {t.reset}
                                        </Button>
                                    )}
                                </SettingsRow>
                            ))}
                            {keybindingConflict && (
                                <p className="px-4 pb-3 text-xs text-destructive">
                                    {t.keybindingConflict.replace("{key}", formatBindingForDisplay(keybindingConflict))}
                                </p>
                            )}
                        </SettingsSection>

                        <div className="flex flex-col items-center gap-1.5 pt-2">
                            <p className="text-center text-xs text-muted-foreground">
                                {t.appName}{appVersion ? ` v${appVersion}` : ""}
                            </p>
                            <Button size="sm" variant="outline" onClick={() => window.api.app.checkForUpdates()} className="gap-1.5">
                                <RefreshCw className="size-3.5" /> {t.checkForUpdates}
                            </Button>
                        </div>
                    </div>
                    </TabsContent>

                    <TabsContent value="models" className="min-w-0 flex-1 flex flex-col gap-8">
                    <div>
                        {specs && (
                            <SettingsSection title={t.yourSystem}>
                                <SettingsRow label="RAM">
                                    <span className="text-sm text-muted-foreground">
                                        {specs.totalRAMGB} GB total ({specs.freeRAMGB} GB free)
                                    </span>
                                </SettingsRow>
                                <SettingsRow label="CPU">
                                    <span className="text-sm text-muted-foreground">
                                        {specs.cpuModel} ({specs.cpuCores} cores)
                                    </span>
                                </SettingsRow>
                                <SettingsRow label="Platform">
                                    <span className="text-sm text-muted-foreground">
                                        {specs.platform} / {specs.arch}
                                    </span>
                                </SettingsRow>
                                {specs.gpus.length > 0 ? (
                                    specs.gpus.map((gpu, i) => (
                                        <SettingsRow key={i} label={specs.gpus.length > 1 ? `GPU ${i + 1}` : "GPU"}>
                                            <span className="text-sm text-muted-foreground">
                                                {gpu.name}
                                                {gpu.vramGB ? ` (${gpu.vramGB} GB VRAM)` : ""}
                                            </span>
                                        </SettingsRow>
                                    ))
                                ) : (
                                    <SettingsRow label="GPU">
                                        <span className="text-sm text-muted-foreground">No dedicated GPU detected</span>
                                    </SettingsRow>
                                )}
                                {specs.gpus.length > 1 && specs.totalVramGB !== null && (
                                    <SettingsRow label="Total VRAM">
                                        <span className="text-sm text-muted-foreground">
                                            {specs.totalVramGB} GB across {specs.gpus.length} GPUs
                                        </span>
                                    </SettingsRow>
                                )}
                            </SettingsSection>
                        )}

                        <SettingsSection title={t.recommendationGoal} description={t.recommendationGoalHint} className="mt-8">
                            <SettingsRow label={t.recommendationGoal} stacked>
                                <Select
                                    value={settings?.recommendationGoal ?? "balanced"}
                                    onValueChange={async (v) => {
                                        await saveSettings({ recommendationGoal: v as AppSettings["recommendationGoal"] });
                                        window.api.system.getRecommendations().then(setRecommendations);
                                    }}
                                >
                                    <SelectTrigger size="sm" className="w-56">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="balanced">{t.recommendationGoalBalanced}</SelectItem>
                                        <SelectItem value="quality">{t.recommendationGoalQuality}</SelectItem>
                                        <SelectItem value="speed">{t.recommendationGoalSpeed}</SelectItem>
                                        <SelectItem value="memory">{t.recommendationGoalMemory}</SelectItem>
                                        <SelectItem value="energy">{t.recommendationGoalEnergy}</SelectItem>
                                        <SelectItem value="agent">{t.recommendationGoalAgent}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </SettingsRow>
                            <SettingsRow label={t.modelRuntime} description={t.modelRuntimeHint} stacked>
                                <Select
                                    value={settings?.preferredRuntime ?? "automatic"}
                                    onValueChange={async (v) => {
                                        await saveSettings({ preferredRuntime: v as AppSettings["preferredRuntime"] });
                                        window.api.system.getRecommendations().then(setRecommendations);
                                    }}
                                >
                                    <SelectTrigger size="sm" className="w-56">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="automatic">{t.modelRuntimeAutomatic}</SelectItem>
                                        <SelectItem value="llamacpp">{t.modelRuntimeLlamaCpp}</SelectItem>
                                        <SelectItem value="vllm">{t.modelRuntimeVllm}</SelectItem>
                                        <SelectItem value="mlx">{t.modelRuntimeMlx}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </SettingsRow>
                        </SettingsSection>

                        {recommendations && recommendations.models.length > 0 && (
                            <SettingsSection title={t.recommendedModelsSection} className="mt-8">
                                {recommendations.models.map((m) => {
                                    const tone = OUTCOME_TONE[m.outcome] ?? "neutral";
                                    const labelKey = OUTCOME_LABEL_KEY[m.outcome as keyof typeof OUTCOME_LABEL_KEY];
                                    return (
                                        <SettingsRow key={m.name} stacked>
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        <span className="text-sm font-medium">{m.label}</span>
                                                        <StatusBadge tone={tone}>{labelKey ? t[labelKey] : m.outcome}</StatusBadge>
                                                        {m.recommended && <Badge>{t.recommendedForYourPc}</Badge>}
                                                        {m.supportsTools && (
                                                            <Badge variant="secondary" className="gap-1" title="Reliable tool/function calling — a good fit for Agent mode">
                                                                <Wrench className="size-3" /> {t.toolCallingBadge}
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">{m.description}</p>
                                                    <p className="text-xs text-muted-foreground">{m.reason}</p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {m.quantization} · {t.recommendedRuntime}: {m.recommendedRuntime} · ~{m.estimatedTokensPerSecond} tok/s
                                                        {m.measuredTokensPerSecond !== undefined ? ` · ${t.measured} ${m.measuredTokensPerSecond} tok/s` : ""}
                                                    </p>
                                                    <details className="mt-1 text-xs text-muted-foreground">
                                                        <summary className="cursor-pointer select-none hover:text-foreground">{t.advancedDetails}</summary>
                                                        <p className="mt-1">
                                                            {t.outcomeRaw}: {m.outcome} · {t.estimatedWeight} {m.estimatedWeightGB} GB · {t.estimatedKvCache} {m.estimatedKvCacheGB} GB · {t.runtimeOverhead} {m.runtimeOverheadGB} GB · {m.expectedGpuOffloadPercent}% {t.gpuOffload}
                                                        </p>
                                                    </details>
                                                </div>
                                                <Button
                                                    size="icon"
                                                    variant="outline"
                                                    onClick={() => downloadRecommendedModel(m)}
                                                    aria-label={`Search Hugging Face for ${m.name}`}
                                                >
                                                    <Search />
                                                </Button>
                                            </div>
                                        </SettingsRow>
                                    );
                                })}
                            </SettingsSection>
                        )}

                        <SettingsSection title={t.huggingFaceResults} description={t.huggingFaceResultsHint} className="mt-8">
                            <div className="p-3">
                                <div className="relative">
                                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        placeholder="Search Hugging Face (a model name, or hf.co/user/repo)..."
                                        aria-label="Search models"
                                        className="pl-8"
                                    />
                                </div>
                                <p className="mt-1.5 px-1 text-xs text-muted-foreground">
                                    {t.huggingFaceHint}
                                </p>
                            </div>
                            {search.trim() && (
                                <>
                                {hfSearching && (
                                    <div className="flex items-center justify-center p-4">
                                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                                    </div>
                                )}
                                {hfError && <p className="p-4 text-xs text-destructive">{hfError}</p>}
                                {!hfSearching && !hfError && hfResults.length === 0 && (
                                    <p className="p-4 text-xs text-muted-foreground">{t.noHuggingFaceResults}</p>
                                )}
                                {hfResults.map((r) => (
                                    <div key={r.id} className="border-b border-border last:border-b-0">
                                        <button
                                            onClick={() => toggleHfExpanded(r.id)}
                                            className="flex w-full items-center justify-between gap-2 p-4 text-left hover:bg-muted/50"
                                        >
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-medium">{r.id}</p>
                                                <p className="text-xs text-muted-foreground">
                                                    {r.downloads.toLocaleString()} {t.downloads} · {r.likes.toLocaleString()} {t.likes}
                                                </p>
                                            </div>
                                            {hfExpandedId === r.id ? (
                                                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                                            ) : (
                                                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                                            )}
                                        </button>
                                        {hfExpandedId === r.id && (
                                            <div className="flex flex-col gap-1.5 px-4 pb-4">
                                                {hfFilesLoading ? (
                                                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                                                ) : hfFiles.length === 0 ? (
                                                    <p className="text-xs text-muted-foreground">{t.noGgufFiles}</p>
                                                ) : (
                                                    groupGgufFiles(hfFiles).map((group) => {
                                                        const f = group[0];
                                                        const key = `${r.id}/${f.path}`;
                                                        const progress = hfDownloading[key];
                                                        const assessment = hfAssessments[f.path];
                                                        const shardCount = group.length;
                                                        const downloadSize = ggufGroupSize(group);
                                                        const tone: StatusTone = !assessment || !assessment.canAssess ? "neutral" : OUTCOME_TONE[assessment.outcome] ?? "neutral";
                                                        const fitLabel = !assessment || !assessment.canAssess
                                                            ? (locale === "tr" ? "Boyut bekleniyor" : "Waiting for size")
                                                            : assessment.fits
                                                                ? (locale === "tr" ? "Bu bilgisayarda çalışır" : "Fits this computer")
                                                                : (locale === "tr" ? "Güvenli biçimde sığmaz" : "Does not fit safely");
                                                        return (
                                                            <div
                                                                key={f.path}
                                                                className={cn("rounded-xl border p-3 text-xs transition-colors", assessment?.fits === false ? "border-destructive/35 bg-destructive/[0.03]" : "border-border bg-card/60 hover:bg-muted/25")}
                                                            >
                                                                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="flex flex-wrap items-center gap-2">
                                                                            <p className="min-w-0 truncate font-mono font-medium" title={f.path}>{f.path}</p>
                                                                            {assessment && <Badge variant="outline">{assessment.quantization}</Badge>}
                                                                            {hfAssessmentsLoading && !assessment ? (
                                                                                <Badge variant="outline"><Loader2 className="mr-1 size-3 animate-spin" />{locale === "tr" ? "Analiz ediliyor" : "Analyzing"}</Badge>
                                                                            ) : <StatusBadge tone={tone}>{fitLabel}</StatusBadge>}
                                                                        </div>
                                                                        <p className="mt-1 text-muted-foreground">
                                                                            {downloadSize !== null ? formatBytes(downloadSize) : (locale === "tr" ? "Boyut bilinmiyor" : "Unknown size")}
                                                                            {shardCount > 1 ? ` · ${shardCount} ${locale === "tr" ? "parça" : "shards"}` : ""}
                                                                            {assessment?.estimatedParametersB !== null && assessment?.estimatedParametersB !== undefined ? ` · ~${assessment.estimatedParametersB}B parameters` : ""}
                                                                        </p>
                                                                    </div>
                                                                    <div className="flex shrink-0 flex-wrap gap-1.5">
                                                                        <Button size="sm" variant={assessment?.fits === false ? "outline" : "default"} disabled={progress !== undefined} onClick={() => downloadForLlamaCpp(r.id, f.path)}>
                                                                            {progress !== undefined ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <FileDown className="mr-1.5 size-3.5" />}
                                                                            {shardCount > 1 ? `${t.downloadForLlamaCpp} (${shardCount})` : t.downloadForLlamaCpp}
                                                                        </Button>
                                                                    </div>
                                                                </div>
                                                                {assessment?.canAssess && (
                                                                    <div className="mt-3 grid gap-2 border-t border-border/70 pt-3 sm:grid-cols-3">
                                                                        <div className="rounded-lg bg-muted/45 px-3 py-2">
                                                                            <p className="flex items-center gap-1 text-muted-foreground"><Gauge className="size-3.5" />{locale === "tr" ? "Tahmini hız" : "Estimated speed"}</p>
                                                                            <p className="mt-0.5 text-sm font-semibold tabular-nums">{assessment.estimatedTokensPerSecond === 0 ? "—" : `~${assessment.estimatedTokensPerSecond} tok/s`}</p>
                                                                        </div>
                                                                        <div className="rounded-lg bg-muted/45 px-3 py-2">
                                                                            <p className="flex items-center gap-1 text-muted-foreground"><MemoryStick className="size-3.5" />{locale === "tr" ? "Gerekli bellek" : "Memory required"}</p>
                                                                            <p className="mt-0.5 text-sm font-semibold tabular-nums">~{assessment.totalRequiredGB} GB</p>
                                                                        </div>
                                                                        <div className="rounded-lg bg-muted/45 px-3 py-2">
                                                                            <p className="flex items-center gap-1 text-muted-foreground"><Cpu className="size-3.5" />{locale === "tr" ? "GPU aktarımı" : "GPU offload"}</p>
                                                                            <p className="mt-0.5 text-sm font-semibold tabular-nums">{assessment.expectedGpuOffloadPercent}%</p>
                                                                        </div>
                                                                        <p className="text-muted-foreground sm:col-span-3">{assessment.reason} {locale === "tr" ? "Hız bir tahmindir; gerçek sonuç model mimarisi ve arka uç sürümüne göre değişir." : "Speed is an estimate; actual results vary with model architecture and runtime version."}</p>
                                                                    </div>
                                                                )}
                                                                {progress !== undefined && <Progress value={progress} className="mt-3 h-1.5" />}
                                                            </div>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                                </>
                            )}
                        </SettingsSection>
                    </div>
                    </TabsContent>

                    <TabsContent value="integrations" className="min-w-0 flex-1 flex flex-col gap-8">
                    <div>
                        <SettingsSection title={t.cloudProviders} description={secretsEncrypted === false ? undefined : t.keysEncryptedNote}>
                            {secretsEncrypted === false && (
                                <SettingsRow stacked>
                                    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                                        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                                        <span>{t.keysNotEncryptedWarning}</span>
                                    </div>
                                </SettingsRow>
                            )}
                            <SettingsRow label="ChatGPT (OpenAI)" stacked>
                                <div className="flex items-center gap-2">
                                    {openaiKeySet && (
                                        <Badge variant="secondary">
                                            <Check className="mr-1 size-3" /> Configured
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex gap-1.5">
                                    <Input
                                        type="password"
                                        value={openaiKeyInput}
                                        onChange={(e) => setOpenaiKeyInput(e.target.value)}
                                        placeholder={openaiKeySet ? "Replace API key..." : "sk-..."}
                                        aria-label="ChatGPT (OpenAI) API key"
                                        className="h-8 text-xs"
                                    />
                                    <Button size="sm" variant="outline" onClick={saveOpenaiKey} disabled={!openaiKeyInput.trim()}>
                                        {t.save}
                                    </Button>
                                </div>
                            </SettingsRow>
                            <SettingsRow label="Claude (Anthropic)" stacked>
                                <div className="flex items-center gap-2">
                                    {anthropicKeySet && (
                                        <Badge variant="secondary">
                                            <Check className="mr-1 size-3" /> Configured
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex gap-1.5">
                                    <Input
                                        type="password"
                                        value={anthropicKeyInput}
                                        onChange={(e) => setAnthropicKeyInput(e.target.value)}
                                        placeholder={anthropicKeySet ? "Replace API key..." : "sk-ant-..."}
                                        aria-label="Claude (Anthropic) API key"
                                        className="h-8 text-xs"
                                    />
                                    <Button size="sm" variant="outline" onClick={saveAnthropicKey} disabled={!anthropicKeyInput.trim()}>
                                        {t.save}
                                    </Button>
                                </div>
                            </SettingsRow>
                            <SettingsRow label="Gemini (Google)" stacked>
                                <div className="flex items-center gap-2">
                                    {geminiKeySet && (
                                        <Badge variant="secondary">
                                            <Check className="mr-1 size-3" /> Configured
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex gap-1.5">
                                    <Input
                                        type="password"
                                        value={geminiKeyInput}
                                        onChange={(e) => setGeminiKeyInput(e.target.value)}
                                        placeholder={geminiKeySet ? "Replace API key..." : "AIza..."}
                                        aria-label="Gemini (Google) API key"
                                        className="h-8 text-xs"
                                    />
                                    <Button size="sm" variant="outline" onClick={saveGeminiKey} disabled={!geminiKeyInput.trim()}>
                                        {t.save}
                                    </Button>
                                </div>
                            </SettingsRow>
                        </SettingsSection>

                        <SettingsSection title={t.customProvidersSection} description={t.customProvidersHint} className="mt-8">
                            {(settings?.customProviders ?? []).map((provider) => (
                                <SettingsRow key={provider.id} label={provider.name} description={provider.baseUrl} stacked>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {provider.localGpuBackend && <Badge variant="secondary">Local GPU backend</Badge>}
                                        {customKeySet[provider.id] && (
                                            <Badge variant="secondary">
                                                <Check className="mr-1 size-3" /> Configured
                                            </Badge>
                                        )}
                                        {!provider.localGpuBackend && <><Input
                                            type="password"
                                            value={customKeyInputs[provider.id] ?? ""}
                                            onChange={(e) =>
                                                setCustomKeyInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))
                                            }
                                            placeholder={customKeySet[provider.id] ? "Replace API key..." : "API key..."}
                                            aria-label={`${provider.name} API key`}
                                            className="h-8 w-40 text-xs"
                                        />
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => saveCustomProviderKey(provider.id)}
                                            disabled={!(customKeyInputs[provider.id] ?? "").trim()}
                                        >
                                            {t.save}
                                        </Button></>}
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => removeCustomProvider(provider.id)}
                                            aria-label={`Remove ${provider.name}`}
                                        >
                                            <Trash2 className="size-3.5 text-destructive" />
                                        </Button>
                                    </div>
                                </SettingsRow>
                            ))}
                            <SettingsRow stacked>
                                {showAddCustomProvider ? (
                                    <div className="flex flex-col gap-2">
                                        <Input
                                            value={customDraftName}
                                            onChange={(e) => setCustomDraftName(e.target.value)}
                                            placeholder={t.customProviderName}
                                            className="h-8 text-xs"
                                        />
                                        <Input
                                            value={customDraftBaseUrl}
                                            onChange={(e) => setCustomDraftBaseUrl(e.target.value)}
                                            placeholder={t.customProviderBaseUrl}
                                            className="h-8 text-xs"
                                        />
                                        <Input
                                            value={customDraftModelIds}
                                            onChange={(e) => setCustomDraftModelIds(e.target.value)}
                                            placeholder={t.customProviderModelIds}
                                            className="h-8 text-xs"
                                        />
                                        <label className="flex items-start gap-2 rounded-md border border-border p-2 text-xs text-muted-foreground">
                                            <input
                                                type="checkbox"
                                                checked={customDraftLocalGpu}
                                                onChange={(e) => setCustomDraftLocalGpu(e.target.checked)}
                                                className="mt-0.5"
                                            />
                                            <span><strong className="text-foreground">Local custom GPU backend</strong><br />Use an OpenAI-compatible local endpoint without requiring an API key (vLLM, LocalAI, TGI, or a custom llama-server build).</span>
                                        </label>
                                        <div className="flex gap-1.5">
                                            <Button
                                                size="sm"
                                                onClick={addCustomProvider}
                                                disabled={!customDraftName.trim() || !customDraftBaseUrl.trim() || !customDraftModelIds.trim()}
                                                className="gap-1.5"
                                            >
                                                <Plus className="size-3.5" /> {t.addCustomProvider}
                                            </Button>
                                            <Button size="sm" variant="outline" onClick={() => setShowAddCustomProvider(false)}>
                                                {t.cancel}
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-2">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => setShowAddCustomProvider(true)}
                                            className="w-fit gap-1.5"
                                        >
                                            <Plus className="size-3.5" /> {t.addCustomProvider}
                                        </Button>
                                        <div className="flex flex-wrap gap-1.5">
                                            {CUSTOM_PROVIDER_PRESETS.map((preset) => (
                                                <button
                                                    key={preset.name}
                                                    onClick={() => prefillCustomProviderPreset(preset)}
                                                    className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/70"
                                                >
                                                    + {preset.name}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </SettingsRow>
                        </SettingsSection>

                        <SettingsSection title={t.integrations} description={t.figmaTokenHint} className="mt-8">
                            <SettingsRow label="Figma" stacked>
                                <div className="flex items-center gap-2">
                                    {figmaTokenSet && (
                                        <Badge variant="secondary">
                                            <Check className="mr-1 size-3" /> Configured
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex gap-1.5">
                                    <Input
                                        type="password"
                                        value={figmaTokenInput}
                                        onChange={(e) => setFigmaTokenInput(e.target.value)}
                                        placeholder={figmaTokenSet ? "Replace token..." : "figd_..."}
                                        aria-label="Figma personal access token"
                                        className="h-8 text-xs"
                                    />
                                    <Button size="sm" variant="outline" onClick={saveFigmaToken} disabled={!figmaTokenInput.trim()}>
                                        {t.save}
                                    </Button>
                                </div>
                            </SettingsRow>
                        </SettingsSection>

                        {settings && (
                            <SettingsSection title={t.mcpServersSection} description={t.mcpServersHint} className="mt-8">
                                {(settings.mcpServers ?? []).map((server) => {
                                    const status = mcpStatuses[server.id];
                                    const connecting = mcpConnecting[server.id];
                                    return (
                                        <SettingsRow
                                            key={server.id}
                                            label={server.name}
                                            description={
                                                server.transport === "stdio"
                                                    ? `stdio · ${server.command} ${(server.args ?? []).join(" ")}`.trim()
                                                    : `http · ${server.url}`
                                            }
                                            stacked
                                        >
                                            {server.warningBanner && (
                                                <div className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning">
                                                    {server.warningBanner}
                                                </div>
                                            )}
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge variant={status?.connected ? "default" : "secondary"}>
                                                    {status?.connected
                                                        ? `${t.mcpConnected} · ${status.toolCount} ${t.mcpToolCount}`
                                                        : t.mcpNotConnected}
                                                </Badge>
                                                {status?.error && (
                                                    <span className="text-xs text-destructive">{status.error}</span>
                                                )}
                                                {server.auth?.type === "oauth2" && (
                                                    <>
                                                        <Badge variant={mcpOAuthTokensPresent[server.id] ? "default" : "secondary"}>
                                                            {mcpOAuthTokensPresent[server.id] ? "Signed in" : "Not signed in"}
                                                        </Badge>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            disabled={mcpOAuthInProgress[server.id]}
                                                            onClick={() => signInToMcpServer(server)}
                                                        >
                                                            {mcpOAuthInProgress[server.id] ? <Loader2 className="size-3.5 animate-spin" /> : null}
                                                            {mcpOAuthTokensPresent[server.id] ? "Re-authorize" : "Sign in"}
                                                        </Button>
                                                        {mcpOAuthTokensPresent[server.id] && (
                                                            <Button size="sm" variant="ghost" onClick={() => clearMcpServerCredentials(server.id)}>
                                                                Clear credentials
                                                            </Button>
                                                        )}
                                                    </>
                                                )}
                                                {status?.connected ? (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() => disconnectMcpServer(server.id)}
                                                    >
                                                        {t.mcpDisconnect}
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={connecting}
                                                        onClick={() => connectMcpServer(server)}
                                                    >
                                                        {connecting ? (
                                                            <Loader2 className="size-3.5 animate-spin" />
                                                        ) : (
                                                            <Plug className="size-3.5" />
                                                        )}
                                                        {connecting ? t.mcpConnecting : t.mcpConnect}
                                                    </Button>
                                                )}
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => removeMcpServer(server.id)}
                                                    aria-label={`${t.mcpRemove} ${server.name}`}
                                                >
                                                    <Trash2 className="size-3.5 text-destructive" />
                                                </Button>
                                            </div>
                                            {status?.connected && status.tools.length > 0 && (
                                                <div className="mt-2 flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-2.5">
                                                    <p className="text-[11px] text-muted-foreground">
                                                        Always-allow specific tools from this server (skips the approval
                                                        card for that tool only — pick read-only tools only):
                                                    </p>
                                                    {status.tools.map((tool) => {
                                                        const trusted = (server.trustProfile?.autoApprovedTools ?? []).includes(tool.name);
                                                        return (
                                                            <label key={tool.name} className="flex items-start gap-2 text-xs">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={trusted}
                                                                    onChange={(e) => toggleMcpToolTrust(server.id, tool.name, e.target.checked)}
                                                                    className="mt-0.5 size-3.5 accent-primary"
                                                                />
                                                                <span>
                                                                    <span className="font-mono">{tool.name}</span>
                                                                    {tool.readOnlyHint === false && (
                                                                        <span className="ml-1.5 text-warning">(not marked read-only)</span>
                                                                    )}
                                                                    {tool.description && (
                                                                        <span className="ml-1.5 text-muted-foreground">— {tool.description}</span>
                                                                    )}
                                                                </span>
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </SettingsRow>
                                    );
                                })}
                                {mastervaultAvailable && !(settings.mcpServers ?? []).some((s) => s.id === "mastervault-builtin") && (
                                    <SettingsRow label={t.mastervaultTitle} description={t.mastervaultHint} stacked>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={mastervaultAdding}
                                            onClick={addBuiltinMastervault}
                                            className="w-fit gap-1.5"
                                        >
                                            {mastervaultAdding ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                                            {t.mastervaultAdd}
                                        </Button>
                                    </SettingsRow>
                                )}
                                <SettingsRow stacked>
                                    {showAddMcp ? (
                                        <div className="flex flex-col gap-2">
                                            <Input
                                                value={mcpDraftName}
                                                onChange={(e) => setMcpDraftName(e.target.value)}
                                                placeholder={t.mcpServerName}
                                                className="h-8 text-xs"
                                            />
                                            <Select
                                                value={mcpDraftTransport}
                                                onValueChange={(v) => setMcpDraftTransport(v as "stdio" | "http")}
                                            >
                                                <SelectTrigger size="sm" className="w-36">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="stdio">stdio</SelectItem>
                                                    <SelectItem value="http">HTTP</SelectItem>
                                                </SelectContent>
                                            </Select>
                                            {mcpDraftTransport === "stdio" ? (
                                                <Input
                                                    value={mcpDraftCommand}
                                                    onChange={(e) => setMcpDraftCommand(e.target.value)}
                                                    placeholder={t.mcpCommandHint}
                                                    className="h-8 text-xs"
                                                />
                                            ) : (
                                                <>
                                                    <Input
                                                        value={mcpDraftUrl}
                                                        onChange={(e) => setMcpDraftUrl(e.target.value)}
                                                        placeholder={t.mcpUrlHint}
                                                        className="h-8 text-xs"
                                                    />
                                                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                                        <input
                                                            type="checkbox"
                                                            checked={mcpDraftOAuth}
                                                            onChange={(e) => setMcpDraftOAuth(e.target.checked)}
                                                            className="size-3.5 accent-primary"
                                                        />
                                                        Requires OAuth 2.1 sign-in (authorization code + PKCE)
                                                    </label>
                                                </>
                                            )}
                                            {mcpDraftPresetExtras?.warningBanner && (
                                                <div className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning">
                                                    {mcpDraftPresetExtras.warningBanner}
                                                </div>
                                            )}
                                            <div className="flex gap-2">
                                                <Button size="sm" onClick={addMcpServer} className="gap-1.5">
                                                    <Plus className="size-3.5" /> {t.mcpAdd}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => {
                                                        setShowAddMcp(false);
                                                        setMcpDraftPresetExtras(null);
                                                    }}
                                                >
                                                    {t.cancel}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => setShowAddMcp(true)}
                                                className="w-fit gap-1.5"
                                            >
                                                <Plus className="size-3.5" /> {t.addMcpServer}
                                            </Button>
                                            <Button size="sm" variant="outline" onClick={importManagedClinicalServers} className="w-fit gap-1.5">
                                                <Plug className="size-3.5" /> Add institutional clinical MCP
                                            </Button>
                                            <div className="flex flex-col gap-1.5">
                                                {MCP_SERVER_PRESETS.map((preset) => (
                                                    <div key={preset.name} className="flex flex-wrap items-center gap-2">
                                                        <button
                                                            onClick={() => prefillMcpPreset(preset)}
                                                            className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/70"
                                                        >
                                                            + {preset.name}
                                                        </button>
                                                        <a
                                                            href={preset.docsUrl}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="text-[11px] text-muted-foreground underline decoration-dotted"
                                                        >
                                                            docs
                                                        </a>
                                                        <span className="text-[11px] text-muted-foreground">{preset.setupHint}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </SettingsRow>
                            </SettingsSection>
                        )}
                    </div>
                    </TabsContent>

                    <TabsContent value="accounts" className="min-w-0 flex-1 flex flex-col gap-8">
                        <div>
                            <SettingsSection title={t.connectedAccountsTitle} description={t.connectedAccountsHint}>
                                {(["github", "huggingface"] as const).map((provider) => {
                                    const account = linkedAccounts[provider];
                                    const label = provider === "github" ? "GitHub" : "Hugging Face";
                                    return (
                                        <SettingsRow
                                            key={provider}
                                            label={label}
                                            description={provider === "huggingface" ? t.accountHuggingfaceHint : t.accountGithubHint}
                                            stacked
                                        >
                                            {account ? (
                                                <div className="flex flex-wrap items-center gap-2">
                                                    {account.avatarUrl && (
                                                        <img src={account.avatarUrl} alt="" className="size-8 rounded-full" loading="lazy" />
                                                    )}
                                                    <a href={account.profileUrl} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline">
                                                        @{account.username}
                                                    </a>
                                                    <Badge variant="secondary">
                                                        <Check className="mr-1 size-3" /> {t.accountConnected}
                                                    </Badge>
                                                    <Button size="sm" variant="outline" onClick={() => disconnectAccount(provider)}>
                                                        {t.accountDisconnect}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div className="flex flex-col gap-2">
                                                    <div className="flex gap-1.5">
                                                        <Input
                                                            type="password"
                                                            value={accountTokens[provider]}
                                                            onChange={(e) => setAccountTokens((current) => ({ ...current, [provider]: e.target.value }))}
                                                            placeholder={provider === "github" ? "github_pat_..." : "hf_..."}
                                                            aria-label={`${label} access token`}
                                                            className="h-8 text-xs"
                                                        />
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            onClick={() => connectAccount(provider)}
                                                            disabled={!accountTokens[provider].trim() || accountConnecting === provider}
                                                        >
                                                            {accountConnecting === provider && <Loader2 className="mr-1 size-3 animate-spin" />} {t.accountConnect}
                                                        </Button>
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">{t.accountTokenHint}</p>
                                                </div>
                                            )}
                                        </SettingsRow>
                                    );
                                })}
                            </SettingsSection>
                        </div>
                    </TabsContent>

                    <TabsContent value="voice" className="min-w-0 flex-1 flex flex-col gap-8">
                    <div>
                        {settings && (
                            <SettingsSection title={t.ttsSection}>
                                <SettingsRow label={t.ttsAutoRead}>
                                    <Button
                                        size="sm"
                                        variant={settings.ttsAutoRead ? "default" : "outline"}
                                        onClick={() => saveSettings({ ttsAutoRead: !settings.ttsAutoRead })}
                                        className="gap-1.5"
                                    >
                                        {settings.ttsAutoRead && <Check className="size-3.5" />}
                                        {settings.ttsAutoRead ? t.enabled : t.disabled}
                                    </Button>
                                </SettingsRow>
                                <SettingsRow label={t.ttsVoice} stacked>
                                    <div className="flex gap-1.5">
                                        <Select
                                            value={settings.ttsVoiceURI ?? "__default__"}
                                            onValueChange={(v) =>
                                                saveSettings({ ttsVoiceURI: !v || v === "__default__" ? undefined : v })
                                            }
                                        >
                                            <SelectTrigger size="sm" className="flex-1">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="__default__">{t.ttsVoiceDefault}</SelectItem>
                                                {voices.map((v) => (
                                                    <SelectItem key={v.voiceURI} value={v.voiceURI}>
                                                        {v.name} ({v.lang})
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                                speakText(
                                                    "This is what the selected voice sounds like.",
                                                    settings.ttsVoiceURI,
                                                    () => {}
                                                )
                                            }
                                        >
                                            {t.ttsVoiceTest}
                                        </Button>
                                    </div>
                                </SettingsRow>
                            </SettingsSection>
                        )}
                    </div>
                    </TabsContent>

                    <TabsContent value="automation" className="min-w-0 flex-1 flex flex-col gap-8">
                    <div>
                        <SettingsSection title={t.scheduledTasksSection} description={t.scheduledTasksHint}>
                            {scheduledTasks.map((task) => (
                                <SettingsRow
                                    key={task.id}
                                    label={task.name}
                                    description={`${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? "…" : ""} · ${t.every} ${task.intervalMinutes} ${t.minutes}${task.lastError ? ` · ${task.lastError}` : ""}`}
                                    stacked
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant={task.enabled ? "default" : "secondary"}>
                                            {task.enabled ? t.enabled : t.disabled}
                                        </Badge>
                                        <span className="text-xs text-muted-foreground">
                                            {t.lastRun}: {task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : t.never}
                                        </span>
                                        <Button size="sm" variant="outline" onClick={() => runScheduledTaskNow(task.id)} className="gap-1.5">
                                            <Play className="size-3.5" /> {t.runNow}
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={() => toggleScheduledTask(task)}>
                                            {task.enabled ? t.disable : t.enable}
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => deleteScheduledTask(task.id)}
                                            aria-label={`Delete ${task.name}`}
                                        >
                                            <Trash2 className="size-3.5 text-destructive" />
                                        </Button>
                                    </div>
                                </SettingsRow>
                            ))}
                            {scheduledTasks.length === 0 && (
                                <p className="p-4 text-xs text-muted-foreground">{t.noScheduledTasks}</p>
                            )}
                            <SettingsRow stacked>
                                {showAddTask ? (
                                    <div className="flex flex-col gap-2">
                                        <Input
                                            value={taskDraftName}
                                            onChange={(e) => setTaskDraftName(e.target.value)}
                                            placeholder={t.taskName}
                                            className="h-8 text-xs"
                                        />
                                        <Textarea
                                            value={taskDraftPrompt}
                                            onChange={(e) => setTaskDraftPrompt(e.target.value)}
                                            placeholder={t.taskPrompt}
                                            className="min-h-16 text-xs"
                                        />
                                        <Select value={taskDraftModel} onValueChange={(v) => setTaskDraftModel(v ?? "")}>
                                            <SelectTrigger size="sm" className="w-full">
                                                <SelectValue placeholder={t.taskModel} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectGroup>
                                                    <SelectLabel>llama.cpp (local)</SelectLabel>
                                                    {llamaCppModels.map((m) => (
                                                        <SelectItem key={m.name} value={formatModelRef("llamacpp", m.name)}>
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
                                                </SelectGroup>
                                                <SelectGroup>
                                                    <SelectLabel>Claude</SelectLabel>
                                                    {ANTHROPIC_MODELS.map((m) => (
                                                        <SelectItem key={m.id} value={formatModelRef("anthropic", m.id)}>
                                                            {m.label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                                <SelectGroup>
                                                    <SelectLabel>Gemini</SelectLabel>
                                                    {GEMINI_MODELS.map((m) => (
                                                        <SelectItem key={m.id} value={formatModelRef("gemini", m.id)}>
                                                            {m.label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                            </SelectContent>
                                        </Select>
                                        <div className="flex items-center gap-2">
                                            <label className="text-xs text-muted-foreground">{t.intervalMinutes}</label>
                                            <Input
                                                type="number"
                                                min={1}
                                                value={taskDraftInterval}
                                                onChange={(e) => setTaskDraftInterval(Number(e.target.value) || 60)}
                                                className="h-8 w-24 text-xs"
                                            />
                                        </div>
                                        <div className="flex gap-1.5">
                                            <Button
                                                size="sm"
                                                onClick={createScheduledTask}
                                                disabled={!taskDraftName.trim() || !taskDraftPrompt.trim() || !taskDraftModel}
                                                className="gap-1.5"
                                            >
                                                <Clock className="size-3.5" /> {t.createTask}
                                            </Button>
                                            <Button size="sm" variant="outline" onClick={() => setShowAddTask(false)}>
                                                {t.cancel}
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setShowAddTask(true)}
                                        className="w-fit gap-1.5"
                                    >
                                        <Plus className="size-3.5" /> {t.createTask}
                                    </Button>
                                )}
                            </SettingsRow>
                        </SettingsSection>
                    </div>
                    </TabsContent>

                    <TabsContent value="chat" className="min-w-0 flex-1 flex flex-col gap-8">
                    <div>
                        {settings && (
                            <>
                                <SettingsSection title={t.chatDefaults}>
                                    <SettingsRow label={t.defaultModel} stacked>
                                        <Select
                                            value={settings.defaultModel ?? ""}
                                            onValueChange={(v) => saveSettings({ defaultModel: v ?? "" })}
                                        >
                                            <SelectTrigger className="w-full">
                                                <SelectValue placeholder="Select a model" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectGroup>
                                                    <SelectLabel>llama.cpp (local)</SelectLabel>
                                                    {llamaCppModels.map((m) => (
                                                        <SelectItem key={m.name} value={formatModelRef("llamacpp", m.name)}>
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
                                                </SelectGroup>
                                                <SelectGroup>
                                                    <SelectLabel>Claude</SelectLabel>
                                                    {ANTHROPIC_MODELS.map((m) => (
                                                        <SelectItem key={m.id} value={formatModelRef("anthropic", m.id)}>
                                                            {m.label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                                <SelectGroup>
                                                    <SelectLabel>Gemini</SelectLabel>
                                                    {GEMINI_MODELS.map((m) => (
                                                        <SelectItem key={m.id} value={formatModelRef("gemini", m.id)}>
                                                            {m.label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                            </SelectContent>
                                        </Select>
                                    </SettingsRow>

                                    <SettingsRow label="Model parameters" description={t.penaltyClaudeNote} stacked>
                                        <div className="grid grid-cols-3 gap-3">
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-temperature" className="text-xs text-muted-foreground">{t.temperature}</label>
                                                <Input
                                                    id="setting-temperature"
                                                    type="number"
                                                    min={0}
                                                    max={2}
                                                    step={0.1}
                                                    value={settings.temperature}
                                                    onChange={(e) => saveSettings({ temperature: Number(e.target.value) })}
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-topP" className="text-xs text-muted-foreground">{t.topP}</label>
                                                <Input
                                                    id="setting-topP"
                                                    type="number"
                                                    min={0}
                                                    max={1}
                                                    step={0.05}
                                                    value={settings.topP}
                                                    onChange={(e) => saveSettings({ topP: Number(e.target.value) })}
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-maxTokens" className="text-xs text-muted-foreground">{t.maxTokens}</label>
                                                <Input
                                                    id="setting-maxTokens"
                                                    type="number"
                                                    min={1}
                                                    step={1}
                                                    value={settings.maxTokens}
                                                    onChange={(e) => saveSettings({ maxTokens: Number(e.target.value) })}
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-contextLength" className="text-xs text-muted-foreground">{t.contextLength}</label>
                                                <Input
                                                    id="setting-contextLength"
                                                    type="number"
                                                    min={512}
                                                    step={512}
                                                    value={settings.contextLength}
                                                    onChange={(e) => saveSettings({ contextLength: Number(e.target.value) })}
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label className="text-xs text-muted-foreground">{t.gpuLayers}</label>
                                                <Select value={settings.gpuLayerMode ?? "auto"} onValueChange={(value) => saveSettings({ gpuLayerMode: value as AppSettings["gpuLayerMode"], gpuLayers: value === "manual" ? settings.gpuLayers ?? 1 : undefined })}>
                                                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="auto">Automatic (recommended)</SelectItem>
                                                        <SelectItem value="cpu">CPU only</SelectItem>
                                                        <SelectItem value="max">All GPU layers (may fail)</SelectItem>
                                                        <SelectItem value="manual">Manual layer count</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                                {settings.gpuLayerMode === "manual" && (
                                                    <Input
                                                        id="setting-gpuLayers"
                                                        type="number"
                                                        min={0}
                                                        max={GPU_LAYERS_FALLBACK_MAX}
                                                        step={1}
                                                        title={t.gpuLayersHelp}
                                                        value={settings.gpuLayers ?? 1}
                                                        onChange={(e) => saveSettings({ gpuLayers: Math.max(0, Math.min(Math.trunc(Number(e.target.value)), GPU_LAYERS_FALLBACK_MAX)) })}
                                                    />
                                                )}
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-frequencyPenalty" className="text-xs text-muted-foreground">{t.frequencyPenalty}</label>
                                                <Input
                                                    id="setting-frequencyPenalty"
                                                    type="number"
                                                    min={-2}
                                                    max={2}
                                                    step={0.1}
                                                    value={settings.frequencyPenalty}
                                                    onChange={(e) => saveSettings({ frequencyPenalty: Number(e.target.value) })}
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-presencePenalty" className="text-xs text-muted-foreground">{t.presencePenalty}</label>
                                                <Input
                                                    id="setting-presencePenalty"
                                                    type="number"
                                                    min={-2}
                                                    max={2}
                                                    step={0.1}
                                                    value={settings.presencePenalty}
                                                    onChange={(e) => saveSettings({ presencePenalty: Number(e.target.value) })}
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-seed" className="text-xs text-muted-foreground">{t.seed}</label>
                                                <Input
                                                    id="setting-seed"
                                                    type="number"
                                                    step={1}
                                                    placeholder={t.seedRandom}
                                                    title={t.seedHelp}
                                                    value={settings.seed ?? ""}
                                                    onChange={(e) => saveSettings({ seed: e.target.value === "" ? undefined : Number(e.target.value) })}
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-topK" className="text-xs text-muted-foreground">{t.topK}</label>
                                                <Input
                                                    id="setting-topK"
                                                    type="number"
                                                    min={1}
                                                    step={1}
                                                    title={t.topKHelp}
                                                    value={settings.topK ?? ""}
                                                    onChange={(e) => saveSettings({ topK: e.target.value === "" ? undefined : Number(e.target.value) })}
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <label htmlFor="setting-repeatPenalty" className="text-xs text-muted-foreground">{t.repeatPenalty}</label>
                                                <Input
                                                    id="setting-repeatPenalty"
                                                    type="number"
                                                    min={0}
                                                    step={0.05}
                                                    title={t.repeatPenaltyHelp}
                                                    value={settings.repeatPenalty ?? ""}
                                                    onChange={(e) =>
                                                        saveSettings({ repeatPenalty: e.target.value === "" ? undefined : Number(e.target.value) })
                                                    }
                                                />
                                            </div>
                                        </div>
                                    </SettingsRow>

                                    <SettingsRow label={t.stopSequences} description={t.stopSequencesHelp} stacked>
                                        <Input
                                            placeholder={t.stopSequencesPlaceholder}
                                            value={(settings.stop ?? []).join(", ")}
                                            onChange={(e) =>
                                                saveSettings({
                                                    stop: e.target.value
                                                        .split(",")
                                                        .map((s) => s.trim())
                                                        .filter(Boolean),
                                                })
                                            }
                                        />
                                    </SettingsRow>

                                    <SettingsRow label={t.systemPrompt} stacked>
                                        <Textarea
                                            value={settings.systemPrompt}
                                            onChange={(e) => saveSettings({ systemPrompt: e.target.value })}
                                            aria-label={t.systemPrompt}
                                            className="min-h-24"
                                        />
                                    </SettingsRow>
                                </SettingsSection>

                                <SettingsSection title={t.agentRuntimeTitle} description={t.agentRuntimeHint} className="mt-8">
                                    <SettingsRow label={t.maxToolStepsLabel} description={t.maxToolStepsHint}>
                                        <Input
                                            type="number"
                                            min={5}
                                            max={100}
                                            step={5}
                                            value={settings.agentMaxSteps ?? 25}
                                            onChange={(e) => saveSettings({ agentMaxSteps: Math.max(5, Math.min(Number(e.target.value), 100)) })}
                                            className="w-24"
                                            aria-label={t.maxToolStepsLabel}
                                        />
                                    </SettingsRow>
                                    <SettingsRow label={t.recommendedProfileLabel} stacked>
                                        <div className="grid gap-2 sm:grid-cols-3">
                                            {[
                                                { label: t.profileCautious, value: 10, note: t.profileCautiousNote },
                                                { label: t.profileBalanced, value: 25, note: t.profileBalancedNote },
                                                { label: t.profileAutonomous, value: 50, note: t.profileAutonomousNote },
                                            ].map((profile) => (
                                                <button
                                                    key={profile.label}
                                                    onClick={() => saveSettings({ agentMaxSteps: profile.value })}
                                                    className={cn(
                                                        "rounded-xl border p-3 text-left transition-colors",
                                                        (settings.agentMaxSteps ?? 25) === profile.value
                                                            ? "border-primary/40 bg-primary/5"
                                                            : "border-border hover:bg-muted/50"
                                                    )}
                                                >
                                                    <span className="block text-sm font-medium">{profile.label}</span>
                                                    <span className="mt-0.5 block text-xs text-muted-foreground">
                                                        {profile.value} steps · {profile.note}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </SettingsRow>
                                </SettingsSection>

                                <SettingsSection title={t.sandboxSectionTitle} description={t.sandboxSectionHint} className="mt-8">
                                    <SettingsRow label={t.networkToolsLabel} description={t.networkToolsHint}>
                                        <Button
                                            size="sm"
                                            variant={(settings.networkToolsEnabled ?? true) ? "default" : "outline"}
                                            onClick={() => saveSettings({ networkToolsEnabled: !(settings.networkToolsEnabled ?? true) })}
                                            className="gap-1.5"
                                        >
                                            {(settings.networkToolsEnabled ?? true) && <Check className="size-3.5" />}
                                            {(settings.networkToolsEnabled ?? true) ? t.enabled : t.disabled}
                                        </Button>
                                    </SettingsRow>
                                    <SettingsRow label={t.sandboxMaxMemoryLabel} description={t.sandboxMaxMemoryHint}>
                                        <Input
                                            type="number"
                                            min={128}
                                            step={128}
                                            value={settings.sandboxMaxMemoryMB ?? 2048}
                                            onChange={(e) => saveSettings({ sandboxMaxMemoryMB: Math.max(128, Number(e.target.value)) })}
                                            className="w-28"
                                            aria-label={t.sandboxMaxMemoryLabel}
                                        />
                                    </SettingsRow>
                                    <SettingsRow label={t.sandboxMaxCpuLabel} description={t.sandboxMaxCpuHint}>
                                        <Input
                                            type="number"
                                            min={1}
                                            max={100}
                                            placeholder="—"
                                            value={settings.sandboxMaxCpuPercent ?? ""}
                                            onChange={(e) =>
                                                saveSettings({
                                                    sandboxMaxCpuPercent: e.target.value === "" ? undefined : Math.max(1, Math.min(100, Number(e.target.value))),
                                                })
                                            }
                                            className="w-28"
                                            aria-label={t.sandboxMaxCpuLabel}
                                        />
                                    </SettingsRow>
                                    <SettingsRow label={t.sandboxStatusLabel} stacked>
                                        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                                            {sandboxCapabilities?.mechanism === "bubblewrap" || sandboxCapabilities?.mechanism === "sandbox-exec" ? (
                                                <Shield className="mt-0.5 size-3.5 shrink-0 text-primary" />
                                            ) : (
                                                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                            )}
                                            <span>
                                                {!sandboxCapabilities
                                                    ? "…"
                                                    : sandboxCapabilities.mechanism === "bubblewrap"
                                                      ? t.sandboxStatusBubblewrap
                                                      : sandboxCapabilities.mechanism === "sandbox-exec"
                                                        ? t.sandboxStatusSandboxExec
                                                        : t.sandboxStatusNone}
                                            </span>
                                        </div>
                                    </SettingsRow>
                                </SettingsSection>

                                <SettingsSection title={t.verificationSectionTitle} description={t.verificationSectionHint} className="mt-8">
                                    <SettingsRow label={t.verificationEnabledLabel}>
                                        <Button
                                            size="sm"
                                            variant={settings.verificationEnabled ? "default" : "outline"}
                                            onClick={() => saveSettings({ verificationEnabled: !settings.verificationEnabled })}
                                            className="gap-1.5"
                                        >
                                            {settings.verificationEnabled && <Check className="size-3.5" />}
                                            {settings.verificationEnabled ? t.enabled : t.disabled}
                                        </Button>
                                    </SettingsRow>
                                    <SettingsRow label={t.verificationCommandsLabel} description={t.verificationCommandsHint} stacked>
                                        <Textarea
                                            value={(settings.verificationCommands ?? []).join("\n")}
                                            onChange={(e) =>
                                                saveSettings({
                                                    verificationCommands: e.target.value
                                                        .split("\n")
                                                        .map((s) => s.trim())
                                                        .filter(Boolean),
                                                })
                                            }
                                            placeholder="npm run build&#10;npm test"
                                            className="min-h-20 font-mono text-xs"
                                            aria-label={t.verificationCommandsLabel}
                                        />
                                    </SettingsRow>
                                    <SettingsRow label={t.verificationMaxRetriesLabel} description={t.verificationMaxRetriesHint}>
                                        <Input
                                            type="number"
                                            min={1}
                                            max={10}
                                            value={settings.verificationMaxRetries ?? 3}
                                            onChange={(e) => saveSettings({ verificationMaxRetries: Math.max(1, Math.min(10, Number(e.target.value))) })}
                                            className="w-24"
                                            aria-label={t.verificationMaxRetriesLabel}
                                        />
                                    </SettingsRow>
                                </SettingsSection>

                                <SettingsSection
                                    title={t.promptLibrary}
                                    description={t.promptLibraryVariablesHint}
                                    className="mt-8"
                                >
                                    {settings.promptPresets.map((preset) =>
                                        editingPresetId === preset.id ? (
                                            <SettingsRow key={preset.id} stacked>
                                                <div className="flex w-full flex-col gap-2">
                                                    <Input
                                                        value={editDraftName}
                                                        onChange={(e) => setEditDraftName(e.target.value)}
                                                        placeholder={t.presetName}
                                                        aria-label={t.presetName}
                                                        className="h-8 text-xs"
                                                    />
                                                    <Textarea
                                                        value={editDraftPrompt}
                                                        onChange={(e) => setEditDraftPrompt(e.target.value)}
                                                        className="min-h-20 text-xs"
                                                    />
                                                    <div className="flex gap-1.5">
                                                        <Button size="sm" onClick={() => saveEditedPreset(preset)} disabled={!editDraftName.trim()}>
                                                            {t.savePreset}
                                                        </Button>
                                                        <Button size="sm" variant="outline" onClick={cancelEditPreset}>
                                                            {t.cancel}
                                                        </Button>
                                                    </div>
                                                </div>
                                            </SettingsRow>
                                        ) : (
                                            <SettingsRow key={preset.id} label={preset.name} description={preset.prompt}>
                                                <Button size="sm" variant="outline" onClick={() => applyPreset(preset.prompt)}>
                                                    {t.apply}
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    onClick={() => startEditPreset(preset)}
                                                    aria-label={`${t.editPreset} ${preset.name}`}
                                                >
                                                    <Pencil />
                                                </Button>
                                                <Popover>
                                                    <PopoverTrigger
                                                        render={
                                                            <Button
                                                                size="icon"
                                                                variant="ghost"
                                                                aria-label={`${t.presetHistory}: ${preset.name}`}
                                                            >
                                                                <History />
                                                            </Button>
                                                        }
                                                    />
                                                    <PopoverContent className="w-72">
                                                        <p className="mb-2 text-xs font-medium">{t.presetHistory}</p>
                                                        {(preset.versions ?? []).length === 0 ? (
                                                            <p className="text-xs text-muted-foreground">{t.noPreviousVersions}</p>
                                                        ) : (
                                                            <div className="flex max-h-64 flex-col gap-2 overflow-auto">
                                                                {(preset.versions ?? []).map((v, i) => (
                                                                    <div key={i} className="rounded-md border border-border p-2">
                                                                        <p className="mb-1 text-[10px] text-muted-foreground">
                                                                            {new Date(v.savedAt).toLocaleString()}
                                                                        </p>
                                                                        <p className="mb-2 line-clamp-3 text-xs">{v.prompt}</p>
                                                                        <Button
                                                                            size="sm"
                                                                            variant="outline"
                                                                            onClick={() => restorePresetVersion(preset, v)}
                                                                        >
                                                                            {t.restore}
                                                                        </Button>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </PopoverContent>
                                                </Popover>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    onClick={() => deletePreset(preset.id)}
                                                    aria-label={`Delete preset ${preset.name}`}
                                                >
                                                    <Trash2 className="text-destructive" />
                                                </Button>
                                            </SettingsRow>
                                        )
                                    )}
                                    <SettingsRow stacked>
                                        <div className="flex gap-1.5">
                                            <Input
                                                value={newPresetName}
                                                onChange={(e) => setNewPresetName(e.target.value)}
                                                onKeyDown={(e) => e.key === "Enter" && handleSavePreset()}
                                                placeholder={t.presetName}
                                                aria-label={t.presetName}
                                                className="h-8 text-xs"
                                            />
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={handleSavePreset}
                                                disabled={!newPresetName.trim()}
                                                className="gap-1.5 whitespace-nowrap"
                                            >
                                                <BookMarked className="size-3.5" /> {t.savePromptAsPreset}
                                            </Button>
                                        </div>
                                    </SettingsRow>
                                    <SettingsRow label={t.sharePrompts} description={t.sharePromptsHint}>
                                        <Button size="sm" variant="outline" onClick={exportPresets} className="gap-1.5">
                                            <FileDown className="size-3.5" /> {t.export}
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={importPresets} className="gap-1.5">
                                            <FileUp className="size-3.5" /> {t.import}
                                        </Button>
                                    </SettingsRow>
                                    {importPresetsMessage && (
                                        <p className="px-4 pb-3 text-xs text-muted-foreground">{importPresetsMessage}</p>
                                    )}
                                </SettingsSection>
                            </>
                        )}
                    </div>
                    </TabsContent>

                    <TabsContent value="data" className="min-w-0 flex-1 flex flex-col gap-8">
                    <div>
                        <SettingsSection title={t.dataManagement}>
                            <SettingsRow label={t.exportAllConversations} description={t.exportAllDescription}>
                                <Button size="sm" variant="outline" onClick={handleExportAll} className="gap-1.5">
                                    <FileDown className="size-4" /> {t.export}
                                </Button>
                            </SettingsRow>
                            <SettingsRow label={t.importConversations} description={importMessage ?? t.importDescription}>
                                <Button size="sm" variant="outline" onClick={handleImport} className="gap-1.5">
                                    <FileUp className="size-4" /> {t.import}
                                </Button>
                            </SettingsRow>
                            <SettingsRow label={t.clearAllConversations} description={t.clearAllDescription}>
                                <Button size="sm" variant="destructive" onClick={handleClearAll} className="gap-1.5">
                                    <Trash2 className="size-4" /> {t.clearAll}
                                </Button>
                            </SettingsRow>
                            {userDataPath && (
                                <SettingsRow label={t.dataLocation} description={userDataPath}>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => window.api.data.openUserDataFolder()}
                                        className="gap-1.5"
                                    >
                                        <FolderOpen className="size-4" /> {t.open}
                                    </Button>
                                </SettingsRow>
                            )}
                        </SettingsSection>

                        {settings && (
                            <SettingsSection
                                title="Energy and cost monitoring"
                                description="Integrates measured or estimated power while local models are active. Historical records retain the tariff used at calculation time."
                            >
                                <SettingsRow label="Enable monitoring" description="Sample every 1–5 seconds only while a local inference request is active.">
                                    <input
                                        type="checkbox"
                                        checked={settings.energyMonitoringEnabled ?? false}
                                        onChange={(event) => saveSettings({ energyMonitoringEnabled: event.target.checked })}
                                        className="size-4 accent-primary"
                                    />
                                </SettingsRow>
                                <SettingsRow label="Electricity price and currency">
                                    <div className="flex gap-2">
                                        <Input
                                            type="number" min={0} step={0.01}
                                            value={settings.electricityPricePerKwh ?? 0.2}
                                            onChange={(event) => saveSettings({ electricityPricePerKwh: Math.max(0, Number(event.target.value)) })}
                                            className="w-28" aria-label="Electricity price per kWh"
                                        />
                                        <Input
                                            value={settings.energyCurrency ?? "USD"}
                                            onChange={(event) => saveSettings({ energyCurrency: event.target.value.toUpperCase().slice(0, 4) })}
                                            className="w-24" aria-label="Currency"
                                        />
                                    </div>
                                </SettingsRow>
                                <SettingsRow label="Sampling and retention">
                                    <div className="flex gap-2">
                                        <Input
                                            type="number" min={1} max={5}
                                            value={settings.energySampleIntervalSeconds ?? 2}
                                            onChange={(event) => saveSettings({ energySampleIntervalSeconds: Math.max(1, Math.min(5, Number(event.target.value))) })}
                                            className="w-24" aria-label="Sample interval seconds" title="Sample interval in seconds"
                                        />
                                        <Input
                                            type="number" min={1} max={3650}
                                            value={settings.energyUsageRetentionDays ?? 365}
                                            onChange={(event) => saveSettings({ energyUsageRetentionDays: Math.max(1, Number(event.target.value)) })}
                                            className="w-28" aria-label="Retention days" title="Usage retention in days"
                                        />
                                    </div>
                                </SettingsRow>
                                <SettingsRow label="Manual wattage estimates" description="Optional maximum CPU/GPU wattage and idle system draw, used when hardware telemetry is unavailable." stacked>
                                    <div className="grid gap-2 sm:grid-cols-3">
                                        <Input
                                            type="number" min={0} placeholder="CPU max W"
                                            value={settings.manualCpuWatts ?? ""}
                                            onChange={(event) => saveSettings({ manualCpuWatts: event.target.value ? Math.max(0, Number(event.target.value)) : undefined })}
                                        />
                                        <Input
                                            type="number" min={0} placeholder="GPU max W"
                                            value={settings.manualGpuWatts ?? ""}
                                            onChange={(event) => saveSettings({ manualGpuWatts: event.target.value ? Math.max(0, Number(event.target.value)) : undefined })}
                                        />
                                        <Input
                                            type="number" min={0} placeholder="System idle W"
                                            value={settings.manualSystemIdleWatts ?? ""}
                                            onChange={(event) => saveSettings({ manualSystemIdleWatts: event.target.value ? Math.max(0, Number(event.target.value)) : undefined })}
                                        />
                                    </div>
                                </SettingsRow>
                                <SettingsRow label="Include idle system consumption">
                                    <input
                                        type="checkbox"
                                        checked={settings.includeIdleSystemConsumption ?? true}
                                        onChange={(event) => saveSettings({ includeIdleSystemConsumption: event.target.checked })}
                                        className="size-4 accent-primary"
                                    />
                                </SettingsRow>
                                <SettingsRow label="Grid carbon intensity" description="Optional grams of CO₂ equivalent per kWh.">
                                    <Input
                                        type="number" min={0} placeholder="gCO₂e/kWh"
                                        value={settings.gridIntensityGCo2PerKwh ?? ""}
                                        onChange={(event) => saveSettings({ gridIntensityGCo2PerKwh: event.target.value ? Math.max(0, Number(event.target.value)) : undefined })}
                                        className="w-36"
                                    />
                                </SettingsRow>
                                <SettingsRow label="Time-of-use tariffs" description="A tariff can cross midnight when its end hour is earlier than its start hour." stacked>
                                    <div className="space-y-2">
                                        {(settings.timeOfUseTariffs ?? []).map((tariff, index) => (
                                            <div key={`${tariff.name}-${index}`} className="flex items-center gap-2 rounded-lg border border-border/70 p-2 text-xs">
                                                <span className="min-w-0 flex-1 truncate font-medium">{tariff.name}</span>
                                                <span className="text-muted-foreground">{tariff.startHour}:00–{tariff.endHour}:00 · {tariff.pricePerKwh} {settings.energyCurrency ?? "USD"}/kWh</span>
                                                <Button size="icon" variant="ghost" onClick={() => removeTimeOfUseTariff(index)} aria-label={`Remove ${tariff.name}`}>
                                                    <Trash2 className="size-3.5" />
                                                </Button>
                                            </div>
                                        ))}
                                        <div className="grid gap-2 sm:grid-cols-[1fr_80px_80px_110px_auto]">
                                            <Input value={tariffName} onChange={(event) => setTariffName(event.target.value)} placeholder="Tariff name" />
                                            <Input type="number" min={0} max={24} value={tariffStartHour} onChange={(event) => setTariffStartHour(Number(event.target.value))} aria-label="Start hour" />
                                            <Input type="number" min={0} max={24} value={tariffEndHour} onChange={(event) => setTariffEndHour(Number(event.target.value))} aria-label="End hour" />
                                            <Input type="number" min={0} step={0.01} value={tariffPrice} onChange={(event) => setTariffPrice(Number(event.target.value))} aria-label="Tariff price" />
                                            <Button size="sm" onClick={addTimeOfUseTariff} disabled={!tariffName.trim()}><Plus className="size-3.5" /> Add</Button>
                                        </div>
                                    </div>
                                </SettingsRow>
                            </SettingsSection>
                        )}

                        <SettingsSection
                            title={t.appActivity}
                            description={t.appActivityDescription}
                            action={
                                <Button size="sm" variant="outline" onClick={refreshActivity} className="gap-1.5" disabled={activityLoading}>
                                    <RefreshCw className={`size-3.5 ${activityLoading ? "animate-spin" : ""}`} /> {t.refresh}
                                </Button>
                            }
                        >
                            {activity && (
                                <>
                                    <SettingsRow label="llama.cpp">
                                        <span className="text-sm text-muted-foreground">
                                            {activity.llamacppLoadedModels.length > 0
                                                ? activity.llamacppLoadedModels.map((p) => p.split(/[/\\]/).pop()).join(", ")
                                                : t.noModelsLoaded}
                                        </span>
                                    </SettingsRow>
                                    {(activity.localBackendServers ?? []).length > 0 && (
                                        <SettingsRow label="MLX / ROCm">
                                            <span className="text-sm text-muted-foreground">
                                                {activity.localBackendServers
                                                    .map((s) => `${s.backend.toUpperCase()}: ${s.model.split(/[/\\]/).pop()}`)
                                                    .join(", ")}
                                            </span>
                                        </SettingsRow>
                                    )}
                                    <SettingsRow label={t.mcpServersLabel}>
                                        {Object.keys(activity.mcpServers).length > 0 ? (
                                            <div className="flex flex-wrap justify-end gap-1.5">
                                                {Object.entries(activity.mcpServers).map(([id, status]) => (
                                                    <Badge key={id} variant={status.connected ? "secondary" : "outline"}>
                                                        {id} · {status.toolCount} {t.tools}
                                                    </Badge>
                                                ))}
                                            </div>
                                        ) : (
                                            <span className="text-sm text-muted-foreground">{t.noneConnected}</span>
                                        )}
                                    </SettingsRow>
                                    <SettingsRow label={t.appMemoryUsage}>
                                        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                                            <MemoryStick className="size-3.5" />
                                            {activity.memory.rssMB.toLocaleString()} MB
                                        </span>
                                    </SettingsRow>
                                </>
                            )}
                        </SettingsSection>

                        <SettingsSection
                            title="Diagnostics & performance benchmark"
                            description="Measure the selected runtime on this PC. Context tests send progressively larger prompts and can take several minutes."
                            action={
                                benchmarkRunning ? (
                                    <Button size="sm" variant="destructive" onClick={cancelHardwareBenchmark}>
                                        <Loader2 className="size-3.5 animate-spin" /> Cancel
                                    </Button>
                                ) : (
                                    <Button size="sm" onClick={runHardwareBenchmark} disabled={!benchmarkModel}>
                                        <Gauge className="size-3.5" /> Run benchmark
                                    </Button>
                                )
                            }
                        >
                            <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_180px_auto]">
                                <Select value={benchmarkModel} onValueChange={(value) => value && setBenchmarkModel(value)}>
                                    <SelectTrigger className="w-full">
                                        <SelectValue placeholder="Select a local model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {llamaCppModels.length > 0 && (
                                            <SelectGroup>
                                                <SelectLabel>llama.cpp / ROCm</SelectLabel>
                                                {llamaCppModels.map((model) => (
                                                    <SelectItem key={`bench-llama-${model.name}`} value={formatModelRef("llamacpp", model.name)}>
                                                        {model.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectGroup>
                                        )}
                                        {(settings?.mlxModels ?? []).map((model) => (
                                            <SelectItem key={`bench-mlx-${model}`} value={formatModelRef("mlx", model)}>
                                                MLX · {model}
                                            </SelectItem>
                                        ))}
                                        {(settings?.vllmModels ?? []).map((model) => (
                                            <SelectItem key={`bench-vllm-${model}`} value={formatModelRef("vllm", model)}>
                                                vLLM · {model}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Input
                                    type="number"
                                    min={2048}
                                    max={131072}
                                    step={2048}
                                    value={benchmarkContext}
                                    onChange={(event) => setBenchmarkContext(Math.max(2048, Math.min(131072, Number(event.target.value) || 2048)))}
                                    aria-label="Maximum context length to test"
                                    title="Maximum context length to test"
                                />
                                <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
                                    <input
                                        type="checkbox"
                                        checked={benchmarkCompare}
                                        onChange={(event) => setBenchmarkCompare(event.target.checked)}
                                        className="size-4 accent-primary"
                                    />
                                    Compare CPU/GPU
                                </label>
                            </div>

                            {benchmarkResult && (
                                <div className="border-t border-border/60 p-4">
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                            <Badge variant={benchmarkResult.health.healthy ? "default" : "destructive"}>
                                                {benchmarkResult.health.healthy ? "Runtime healthy" : "Runtime failed"}
                                            </Badge>
                                            <span className="truncate font-mono text-xs text-muted-foreground">{benchmarkResult.model}</span>
                                        </div>
                                        <Button size="sm" variant="outline" onClick={exportHardwareDiagnostic}>
                                            <FileDown className="size-3.5" /> Export report
                                        </Button>
                                    </div>

                                    {benchmarkResult.primary ? (
                                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                                            {[
                                                ["Generation", `${benchmarkResult.primary.tokensPerSecond.toLocaleString()} tok/s`],
                                                ["Prompt processing", `${benchmarkResult.primary.promptTokensPerSecond.toLocaleString()} tok/s`],
                                                ["Time to first token", `${benchmarkResult.primary.timeToFirstTokenMs.toLocaleString()} ms`],
                                                ["Total response", `${benchmarkResult.primary.totalTimeMs.toLocaleString()} ms`],
                                                ["Peak system RAM", `${benchmarkResult.primary.resources.peakSystemRamMB.toLocaleString()} MB`],
                                                ["Peak app RAM", `${benchmarkResult.primary.resources.peakAppRamMB.toLocaleString()} MB`],
                                                ["Peak VRAM", benchmarkResult.primary.resources.peakVramMB === null ? "Unavailable" : `${benchmarkResult.primary.resources.peakVramMB.toLocaleString()} MB`],
                                                ["Measured by", benchmarkResult.primary.resources.vramMeasurement],
                                            ].map(([label, value]) => (
                                                <div key={label} className="rounded-xl border border-border/70 bg-muted/25 p-3">
                                                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                                                    <p className="mt-1 text-sm font-semibold">{value}</p>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                                            {benchmarkResult.health.error ?? "The runtime did not complete the health check."}
                                        </p>
                                    )}

                                    {benchmarkResult.comparison.supported && benchmarkResult.comparison.cpu && benchmarkResult.comparison.gpu && (
                                        <div className="mt-4 overflow-hidden rounded-xl border border-border/70">
                                            <div className="grid grid-cols-3 bg-muted/40 px-3 py-2 text-xs font-semibold">
                                                <span>Mode</span><span>Generation</span><span>First token</span>
                                            </div>
                                            {([benchmarkResult.comparison.cpu, benchmarkResult.comparison.gpu] as const).map((measurement) => (
                                                <div key={measurement.mode} className="grid grid-cols-3 border-t border-border/60 px-3 py-2 text-sm">
                                                    <span className="font-medium uppercase">{measurement.mode}</span>
                                                    <span>{measurement.tokensPerSecond} tok/s</span>
                                                    <span>{measurement.timeToFirstTokenMs} ms</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {benchmarkResult.comparison.note && <p className="mt-3 text-xs text-muted-foreground">{benchmarkResult.comparison.note}</p>}

                                    {benchmarkResult.contextTests.length > 0 && (
                                        <div className="mt-4">
                                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Context-length tests</p>
                                            <div className="flex flex-wrap gap-2">
                                                {benchmarkResult.contextTests.map((test) => (
                                                    <Badge key={test.requestedTokens} variant={test.accepted ? "secondary" : "destructive"} title={test.error}>
                                                        {(test.requestedTokens / 1024).toLocaleString()}K · {test.accepted ? "passed" : "failed"} · {test.elapsedMs} ms
                                                    </Badge>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {benchmarkResult.warnings.map((warning) => (
                                        <p key={warning} className="mt-2 text-xs text-muted-foreground">{warning}</p>
                                    ))}
                                </div>
                            )}
                        </SettingsSection>

                        <SettingsSection title={t.diagnostics} description={t.diagnosticsDescription}>
                            <SettingsRow label={t.copyDiagnosticInfo}>
                                <Button size="sm" variant="outline" onClick={handleCopyDiagnostics} className="gap-1.5">
                                    {diagnosticsCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
                                    {diagnosticsCopied ? t.copied : t.copyDiagnosticInfo}
                                </Button>
                            </SettingsRow>
                            <SettingsRow label={t.openLogsFolder}>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => window.api.app.openLogsFolder()}
                                    className="gap-1.5"
                                >
                                    <Bug className="size-4" /> {t.open}
                                </Button>
                            </SettingsRow>
                        </SettingsSection>
                    </div>
                    </TabsContent>
                </Tabs>
            </div>
        </ScrollArea>
    );
}
