import { useEffect, useMemo, useRef, useState } from "react";
import {
    Download,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
    OllamaModel,
    SystemSpecs,
    PromptPreset,
    PromptVersion,
    McpServerConfig,
    McpServerStatus,
    LocalGgufModel,
    LlamaCppGpuBackend,
    HfModelSummary,
    HfGgufFile,
    ScheduledTask,
    AppActivity,
    LinkedAccount,
    LocalRuntimeStatus,
    SandboxCapabilities,
} from "@/types/electron";
import { EXTRA_MODELS } from "@/lib/model-catalog";
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
import { OPENAI_MODELS, ANTHROPIC_MODELS, GEMINI_MODELS, formatModelRef, CUSTOM_PROVIDER_PRESETS } from "@/lib/providers";
import { useSessions } from "@/lib/sessions-context";
import { useI18n } from "@/lib/i18n";
import type { Locale } from "@/lib/translations";
import { useTheme, ACCENT_COLORS, type AccentColor } from "@/components/theme-provider";
import { speakText } from "@/lib/tts";
import { cn } from "@/lib/utils";

type SettingsTab = "general" | "models" | "accounts" | "integrations" | "chat" | "voice" | "automation" | "data";

const SETTINGS_SEARCH_ITEMS: { tab: SettingsTab; label: string; keywords: string }[] = [
    { tab: "general", label: "Appearance, density & motion", keywords: "theme color compact comfortable animation reduced motion language server gpu cache" },
    { tab: "models", label: "Models & hardware", keywords: "ollama hugging face download vram recommendation gguf" },
    { tab: "accounts", label: "Connected accounts", keywords: "github hugging face account token profile repository" },
    { tab: "integrations", label: "Providers & MCP", keywords: "api key custom gpu backend figma mcp openai claude gemini" },
    { tab: "chat", label: "Chat & agent behavior", keywords: "prompt temperature context tokens agent steps tool calls" },
    { tab: "voice", label: "Voice & speech", keywords: "microphone transcription tts read aloud voice" },
    { tab: "automation", label: "Automation", keywords: "scheduled task interval prompt" },
    { tab: "data", label: "Data, activity & diagnostics", keywords: "export import logs memory activity clear" },
];

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

// Ollama pulls Hugging Face GGUF models via a "hf.co/user/repo[:quant]" model
// name — accept a pasted full URL or the "huggingface.co/" host too, rather
// than making the user hand-edit what they copied from their browser.
function normalizeModelTag(input: string): string {
    return input
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/^huggingface\.co\//i, "hf.co/");
}

// Static preview swatches for the accent color picker — independent of the
// live CSS variables so the dot always shows the same recognizable hue
// regardless of which theme is currently active.
const ACCENT_SWATCHES: Record<AccentColor, string> = {
    default: "oklch(0.556 0 0)",
    blue: "oklch(0.55 0.2 260)",
    green: "oklch(0.55 0.16 145)",
    purple: "oklch(0.55 0.22 300)",
    orange: "oklch(0.62 0.19 55)",
    rose: "oklch(0.58 0.22 10)",
};

function formatBytes(bytes: number) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
}

export default function Settings() {
    const { t, locale, setLocale } = useI18n();
    const { theme, setTheme, accent, setAccent } = useTheme();
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

    useEffect(() => {
        function loadVoices() {
            setVoices(window.speechSynthesis.getVoices());
        }
        loadVoices();
        window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
        return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
    }, []);
    const [running, setRunning] = useState<boolean | null>(null);
    const [specs, setSpecs] = useState<SystemSpecs | null>(null);
    const [recommendations, setRecommendations] = useState<ModelRecommendations | null>(null);
    const [installed, setInstalled] = useState<OllamaModel[]>([]);
    const [pulling, setPulling] = useState<Record<string, number>>({});
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
    const [keybindings, setKeybindings] = useState<Record<KeybindingAction, string>>(DEFAULT_KEYBINDINGS);
    const [localModelInput, setLocalModelInput] = useState("");
    const [localModelBackend, setLocalModelBackend] = useState<"mlx" | "vllm">("vllm");
    const [runtimeStatuses, setRuntimeStatuses] = useState<LocalRuntimeStatus[]>([]);
    const [runtimeRefreshing, setRuntimeRefreshing] = useState(false);
    const [recordingAction, setRecordingAction] = useState<KeybindingAction | null>(null);
    const [keybindingConflict, setKeybindingConflict] = useState<string | null>(null);
    const [importMessage, setImportMessage] = useState<string | null>(null);
    const [ollamaHostInput, setOllamaHostInput] = useState("");
    const [sandboxCapabilities, setSandboxCapabilities] = useState<SandboxCapabilities | null>(null);
    const [modelsDirStatus, setModelsDirStatus] = useState<string | null>(null);
    const [changingModelsDir, setChangingModelsDir] = useState(false);
    const [newPresetName, setNewPresetName] = useState("");
    const [importPresetsMessage, setImportPresetsMessage] = useState<string | null>(null);
    const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
    const [editDraftName, setEditDraftName] = useState("");
    const [editDraftPrompt, setEditDraftPrompt] = useState("");
    const { refresh: refreshSessions } = useSessions();
    const toast = useToast();
    const activePullCount = useRef(0);
    const loadedTabs = useRef(new Set<SettingsTab>());

    const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpServerStatus>>({});
    const [mcpConnecting, setMcpConnecting] = useState<Record<string, boolean>>({});
    const [showAddMcp, setShowAddMcp] = useState(false);
    const [mcpDraftName, setMcpDraftName] = useState("");
    const [mcpDraftTransport, setMcpDraftTransport] = useState<"stdio" | "http">("stdio");
    const [mcpDraftCommand, setMcpDraftCommand] = useState("");
    const [mcpDraftUrl, setMcpDraftUrl] = useState("");

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

    const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
    const [showAddTask, setShowAddTask] = useState(false);
    const [taskDraftName, setTaskDraftName] = useState("");
    const [taskDraftPrompt, setTaskDraftPrompt] = useState("");
    const [taskDraftModel, setTaskDraftModel] = useState("");
    const [taskDraftInterval, setTaskDraftInterval] = useState(60);

    async function refreshInstalled() {
        const list = await window.api.ollama.listModels();
        setInstalled(list);
    }

    useEffect(() => {
        if (!window.api) {
            // Intentional: one-time environment check (browser dev preview has no
            // Electron preload bridge), not state derived from props.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setHasApi(false);
            return;
        }
        window.api.ollama.status().then(setRunning);
        window.api.system.getSpecs().then(setSpecs);
        window.api.system.getRecommendations().then(setRecommendations);
        window.api.settings.get().then((s) => {
            setSettings(s);
            setOllamaHostInput(s.ollamaHost);
            setKeybindings({ ...DEFAULT_KEYBINDINGS, ...s.keybindings } as Record<KeybindingAction, string>);
        });
        refreshInstalled();
        window.api.llamacpp.listModels().then(setLlamaCppModels);
        window.api.llamacpp.getAvailableGpuBackends().then(setLlamaCppGpuBackends);
        refreshRuntimeStatuses();
        window.api.agent.getSandboxCapabilities().then(setSandboxCapabilities);
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
        if (activeTab !== "models" || !hasApi || !query || /^https?:\/\//i.test(query) || /^hf\.co\//i.test(query)) {
            // Intentional: clears stale results when the search box empties or
            // looks like a direct tag/URL paste rather than a search query.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setHfResults([]);
            setHfError(null);
            return;
        }
        setHfSearching(true);
        const timer = setTimeout(async () => {
            const res = await window.api.huggingface.search(query);
            setHfResults(res.results ?? []);
            setHfError(res.error ?? null);
            setHfSearching(false);
        }, 400);
        return () => clearTimeout(timer);
    }, [activeTab, hasApi, search]);

    async function toggleHfExpanded(modelId: string) {
        if (hfExpandedId === modelId) {
            setHfExpandedId(null);
            return;
        }
        setHfExpandedId(modelId);
        setHfFilesLoading(true);
        const res = await window.api.huggingface.listFiles(modelId);
        setHfFiles(res.files ?? []);
        setHfFilesLoading(false);
    }

    async function downloadForLlamaCpp(modelId: string, filename: string) {
        const key = `${modelId}/${filename}`;
        setHfDownloading((d) => ({ ...d, [key]: 0 }));
        const res = await window.api.huggingface.downloadFile(modelId, filename, (progress) => {
            if (progress.totalBytes) {
                setHfDownloading((d) => ({ ...d, [key]: Math.round((progress.receivedBytes / progress.totalBytes!) * 100) }));
            }
        });
        setHfDownloading((d) => {
            const next = { ...d };
            delete next[key];
            return next;
        });
        if (res.error) toast.error(res.error);
        else window.api.llamacpp.listModels().then(setLlamaCppModels);
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

    async function handleExportAll() {
        const result = await window.api.data.exportAll();
        if (result.success) toast.success(t.toastExportDone);
    }

    async function handleImport() {
        const result = await window.api.data.import();
        setImportMessage(
            result.imported > 0
                ? `Imported ${result.imported} conversation${result.imported === 1 ? "" : "s"}.`
                : "No conversations found in that file."
        );
        await refreshSessions();
        setTimeout(() => setImportMessage(null), 4000);
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
            `Ollama host: ${d.ollamaHost} — ${d.ollamaRunning ? "reachable" : "unreachable"}`,
            "",
            "--- recent log output ---",
            d.logTail || "(empty)",
        ].join("\n");
        await navigator.clipboard.writeText(text);
        setDiagnosticsCopied(true);
        setTimeout(() => setDiagnosticsCopied(false), 1500);
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

    async function saveOllamaHost() {
        const host = ollamaHostInput.trim() || "http://127.0.0.1:11434";
        setOllamaHostInput(host);
        await saveSettings({ ollamaHost: host });
        window.api.ollama.status().then(setRunning);
        refreshInstalled();
    }

    async function chooseModelsDir() {
        const dir = await window.api.ollama.pickModelsDir();
        if (!dir) return;
        setChangingModelsDir(true);
        setModelsDirStatus(null);
        const result = await window.api.ollama.setModelsDir(dir);
        if (result.error) {
            setModelsDirStatus(result.error);
        } else {
            const updated = await window.api.settings.get();
            setSettings(updated);
            setModelsDirStatus(
                result.external ? t.modelsDirExternalWarning : result.started || result.alreadyRunning ? t.modelsDirApplied : t.modelsDirFailed
            );
            window.api.ollama.status().then(setRunning);
            refreshInstalled();
        }
        setChangingModelsDir(false);
    }

    async function resetModelsDir() {
        setChangingModelsDir(true);
        setModelsDirStatus(null);
        const result = await window.api.ollama.setModelsDir(null);
        setModelsDirStatus(
            result.external ? t.modelsDirExternalWarning : result.started || result.alreadyRunning ? t.modelsDirApplied : t.modelsDirFailed
        );
        const updated = await window.api.settings.get();
        setSettings(updated);
        window.api.ollama.status().then(setRunning);
        refreshInstalled();
        setChangingModelsDir(false);
    }

    async function toggleServer() {
        if (running) {
            await window.api.ollama.stop();
            setRunning(false);
        } else {
            const result = await window.api.ollama.start();
            setRunning(!result.error);
            if (result.error === "not-installed") {
                toast.error(t.toastOllamaNotInstalled);
            } else if (result.error) {
                toast.error(`${t.toastOllamaStartFailed}: ${result.error}`);
            }
        }
    }

    async function pullModel(name: string) {
        // Called imperatively (not via a useEffect) so it still fires even if
        // this component unmounts mid-download — e.g. the user navigates to
        // Chat while a large model is downloading. Counted rather than a flag
        // so concurrent pulls don't clear busy while another is still running.
        activePullCount.current++;
        if (activePullCount.current === 1) window.api.app.setBusy(true);

        setPulling((p) => ({ ...p, [name]: 0 }));
        await window.api.ollama.pullModel(name, (chunk) => {
            if (chunk.total && chunk.completed) {
                setPulling((p) => ({ ...p, [name]: Math.round((chunk.completed! / chunk.total!) * 100) }));
            }
        });
        setPulling((p) => {
            const next = { ...p };
            delete next[name];
            return next;
        });
        refreshInstalled();

        activePullCount.current--;
        if (activePullCount.current === 0) window.api.app.setBusy(false);
    }

    async function deleteModel(name: string) {
        await window.api.ollama.deleteModel(name);
        refreshInstalled();
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
        setMcpStatuses((s) => ({
            ...s,
            [server.id]: res.error
                ? { connected: false, toolCount: 0, error: res.error }
                : { connected: true, toolCount: res.tools?.length ?? 0 },
        }));
        setMcpConnecting((c) => ({ ...c, [server.id]: false }));
    }

    async function disconnectMcpServer(id: string) {
        await window.api.mcp.disconnect(id);
        setMcpStatuses((s) => ({ ...s, [id]: { connected: false, toolCount: 0 } }));
    }

    async function addMcpServer() {
        if (!settings) return;
        const name = mcpDraftName.trim();
        if (!name) return;
        const server: McpServerConfig =
            mcpDraftTransport === "stdio"
                ? {
                      id: crypto.randomUUID(),
                      name,
                      transport: "stdio",
                      enabled: true,
                      command: mcpDraftCommand.trim().split(/\s+/)[0] ?? "",
                      args: mcpDraftCommand.trim().split(/\s+/).slice(1),
                  }
                : { id: crypto.randomUUID(), name, transport: "http", enabled: true, url: mcpDraftUrl.trim() };
        const updated = await window.api.settings.save({ mcpServers: [...(settings.mcpServers ?? []), server] });
        setSettings(updated);
        setMcpDraftName("");
        setMcpDraftCommand("");
        setMcpDraftUrl("");
        setShowAddMcp(false);
        connectMcpServer(server);
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

    const searchResults = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return [];

        const fromRecommended = (recommendations?.models ?? []).map((m) => ({
            name: m.name,
            label: m.label,
            description: m.description,
        }));
        const combined = [...fromRecommended, ...EXTRA_MODELS];
        const seen = new Set<string>();
        const deduped = combined.filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)));

        return deduped.filter(
            (m) => m.name.toLowerCase().includes(query) || m.label.toLowerCase().includes(query)
        );
    }, [search, recommendations]);

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Settings are only available when running inside the Electron app.
            </div>
        );
    }

    const installedNames = new Set(installed.map((m) => m.name));
    const catalogNames = new Set(recommendations?.models.map((m) => m.name) ?? []);
    const otherInstalled = installed.filter((m) => !catalogNames.has(m.name));

    const exactMatchExists = searchResults.some((m) => m.name.toLowerCase() === search.trim().toLowerCase());

    return (
        <ScrollArea className="h-full bg-background/25">
            <div className="mx-auto max-w-5xl px-4 pb-20 pt-16 sm:px-6 md:pt-8 2xl:max-w-6xl">
                <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-sm"><Settings2 className="size-5" /></span>
                    <div><h1 className="text-2xl font-semibold tracking-tight">{t.settings}</h1><p className="mt-0.5 text-xs text-muted-foreground">{t.settingsSubtitle}</p></div></div>
                    <div className="relative w-full sm:w-72">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input value={settingsQuery} onChange={(e) => setSettingsQuery(e.target.value)} placeholder={t.searchSettingsPlaceholder} className="h-10 rounded-xl bg-card pl-9 shadow-sm" aria-label={t.searchSettingsPlaceholder} />
                    </div>
                </div>

                {settingsQuery.trim() && (
                    <div className="surface-glass shadow-soft mb-6 grid gap-2 rounded-2xl border border-border/70 p-3 sm:grid-cols-2">
                        {SETTINGS_SEARCH_ITEMS.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(settingsQuery.trim().toLowerCase())).map((item) => (
                            <button key={item.tab} onClick={() => { setActiveTab(item.tab); setSettingsQuery(""); }} className="rounded-xl border border-transparent p-3 text-left text-sm font-medium transition-colors hover:border-primary/20 hover:bg-primary/5">{item.label}<span className="mt-0.5 block text-xs font-normal text-muted-foreground">Open {item.tab} settings</span></button>
                        ))}
                    </div>
                )}

                <Tabs
                    value={activeTab}
                    onValueChange={(v) => setActiveTab(v as SettingsTab)}
                    orientation="vertical"
                    className="flex-col items-stretch gap-6 lg:flex-row lg:items-start lg:gap-10"
                >
                    <TabsList variant="line" className="surface-glass sticky top-0 z-10 w-full shrink-0 flex-row overflow-x-auto rounded-xl border border-border/70 p-1 shadow-sm lg:top-6 lg:w-52 lg:flex-col lg:rounded-2xl lg:p-2">
                        <TabsTrigger value="general" className="justify-start gap-2">
                            <SlidersHorizontal className="size-4 shrink-0" /> {t.settingsTabGeneral}
                        </TabsTrigger>
                        <TabsTrigger value="models" className="justify-start gap-2">
                            <Boxes className="size-4 shrink-0" /> {t.settingsTabModels}
                        </TabsTrigger>
                        <TabsTrigger value="accounts" className="justify-start gap-2">
                            <UserRound className="size-4 shrink-0" /> Accounts
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
                        <SettingsSection title={t.ollamaServer}>
                            <SettingsRow
                                label={running === null ? t.checking : running ? t.running : t.stopped}
                            >
                                <Badge variant={running ? "default" : "secondary"}>
                                    {running ? t.online : t.offline}
                                </Badge>
                                <Button size="sm" variant="outline" onClick={toggleServer}>
                                    {running ? t.stop : t.start}
                                </Button>
                            </SettingsRow>
                            <SettingsRow label={t.serverAddress} description={t.serverAddressHelp} stacked>
                                <div className="flex gap-1.5">
                                    <Input
                                        value={ollamaHostInput}
                                        onChange={(e) => setOllamaHostInput(e.target.value)}
                                        placeholder="http://127.0.0.1:11434"
                                        aria-label={t.serverAddress}
                                        className="h-8 text-xs"
                                    />
                                    <Button size="sm" variant="outline" onClick={saveOllamaHost}>
                                        {t.save}
                                    </Button>
                                </div>
                            </SettingsRow>
                            <SettingsRow label={t.modelsDir} description={t.modelsDirHint} stacked>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs">
                                        {settings?.modelsDir ?? t.modelsDirDefault}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={changingModelsDir}
                                        onClick={chooseModelsDir}
                                        className="gap-1.5"
                                    >
                                        {changingModelsDir ? (
                                            <Loader2 className="size-3.5 animate-spin" />
                                        ) : (
                                            <FolderOpen className="size-3.5" />
                                        )}
                                        {t.chooseFolder}
                                    </Button>
                                    {settings?.modelsDir && (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={changingModelsDir}
                                            onClick={resetModelsDir}
                                            className="text-xs text-muted-foreground"
                                        >
                                            {t.resetToDefault}
                                        </Button>
                                    )}
                                </div>
                                {modelsDirStatus && <p className="text-xs text-muted-foreground">{modelsDirStatus}</p>}
                            </SettingsRow>
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
                            <SettingsRow label={t.accentColor} stacked>
                                <div className="flex flex-wrap gap-2">
                                    {ACCENT_COLORS.map((c) => (
                                        <button
                                            key={c}
                                            type="button"
                                            onClick={() => setAccent(c)}
                                            aria-label={t.accentColorNames[c]}
                                            aria-pressed={accent === c}
                                            title={t.accentColorNames[c]}
                                            className={cn(
                                                "flex size-8 items-center justify-center rounded-full border-2 transition-colors",
                                                accent === c ? "border-foreground" : "border-transparent"
                                            )}
                                        >
                                            <span
                                                className="size-6 rounded-full"
                                                style={{ backgroundColor: ACCENT_SWATCHES[c] }}
                                            />
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

                        <SettingsSection title={t.ollamaModelsSection} className="mt-8">
                            <div className="p-3">
                                <div className="relative">
                                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        placeholder="Search catalog, an exact tag (mixtral:8x7b), or a Hugging Face model (hf.co/user/repo)..."
                                        aria-label="Search models"
                                        className="pl-8"
                                    />
                                </div>
                                <p className="mt-1.5 px-1 text-xs text-muted-foreground">
                                    {t.huggingFaceHint}
                                </p>
                            </div>

                            {search.trim()
                                ? searchResults.map((m) => {
                                      const isInstalled = installedNames.has(m.name);
                                      const progress = pulling[m.name];
                                      return (
                                          <SettingsRow key={m.name} label={m.label} description={m.description}>
                                              {progress !== undefined && (
                                                  <Progress value={progress} className="h-1.5 w-20" />
                                              )}
                                              {isInstalled ? (
                                                  <Button
                                                      size="icon"
                                                      variant="ghost"
                                                      onClick={() => deleteModel(m.name)}
                                                      aria-label={`Delete ${m.name}`}
                                                  >
                                                      <Trash2 className="text-destructive" />
                                                  </Button>
                                              ) : progress !== undefined ? (
                                                  <Button size="icon" variant="outline" disabled aria-label={`Downloading ${m.name}`}>
                                                      <Loader2 className="animate-spin" />
                                                  </Button>
                                              ) : (
                                                  <Button
                                                      size="icon"
                                                      variant="outline"
                                                      onClick={() => pullModel(m.name)}
                                                      aria-label={`Download ${m.name}`}
                                                  >
                                                      <Download />
                                                  </Button>
                                              )}
                                          </SettingsRow>
                                      );
                                  })
                                : recommendations?.models.map((m) => {
                                      const isInstalled = installedNames.has(m.name);
                                      const progress = pulling[m.name];
                                      return (
                                          <SettingsRow key={m.name} stacked>
                                              <div className="flex items-center justify-between gap-3">
                                                  <div className="min-w-0">
                                                      <div className="flex flex-wrap items-center gap-1.5">
                                                          <span className="text-sm font-medium">{m.label}</span>
                                                          {m.recommended && <Badge>Recommended for your PC</Badge>}
                                                          {m.supportsTools && (
                                                              <Badge variant="secondary" title="Reliable tool/function calling — a good fit for Agent mode">
                                                                  🔧 Tool calling
                                                              </Badge>
                                                          )}
                                                          {m.runsOnGpu && <Badge variant="secondary">Runs on GPU</Badge>}
                                                          {!m.fits && <Badge variant="secondary">May be too large</Badge>}
                                                      </div>
                                                      <p className="text-xs text-muted-foreground">{m.description}</p>
                                                      <p className="text-xs text-muted-foreground">Needs ~{m.minRAMGB} GB RAM</p>
                                                  </div>
                                                  {isInstalled ? (
                                                      <Button
                                                          size="icon"
                                                          variant="ghost"
                                                          onClick={() => deleteModel(m.name)}
                                                          aria-label={`Delete ${m.name}`}
                                                      >
                                                          <Trash2 className="text-destructive" />
                                                      </Button>
                                                  ) : progress !== undefined ? (
                                                      <Button size="icon" variant="outline" disabled aria-label={`Downloading ${m.name}`}>
                                                          <Loader2 className="animate-spin" />
                                                      </Button>
                                                  ) : (
                                                      <Button
                                                          size="icon"
                                                          variant="outline"
                                                          onClick={() => pullModel(m.name)}
                                                          aria-label={`Download ${m.name}`}
                                                      >
                                                          <Download />
                                                      </Button>
                                                  )}
                                              </div>
                                              {progress !== undefined && <Progress value={progress} className="h-1.5" />}
                                          </SettingsRow>
                                      );
                                  })}

                            {search.trim() && !exactMatchExists && !installedNames.has(search.trim()) && (() => {
                                const customTag = normalizeModelTag(search);
                                const isHuggingFace = /^hf\.co\//i.test(customTag);
                                return (
                                    <SettingsRow
                                        label={customTag}
                                        description={isHuggingFace ? t.pullFromHuggingFace : t.pullExactTag}
                                    >
                                        {pulling[customTag] !== undefined ? (
                                            <Button size="icon" variant="outline" disabled aria-label={`Downloading ${customTag}`}>
                                                <Loader2 className="animate-spin" />
                                            </Button>
                                        ) : (
                                            <Button
                                                size="icon"
                                                variant="outline"
                                                onClick={() => pullModel(customTag)}
                                                aria-label={`Download ${customTag}`}
                                            >
                                                <Download />
                                            </Button>
                                        )}
                                    </SettingsRow>
                                );
                            })()}
                        </SettingsSection>

                        {search.trim() && (
                            <SettingsSection title={t.huggingFaceResults} description={t.huggingFaceResultsHint} className="mt-8">
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
                                                    hfFiles.map((f) => {
                                                        const key = `${r.id}/${f.path}`;
                                                        const progress = hfDownloading[key];
                                                        const ggufTag = `hf.co/${r.id}`;
                                                        return (
                                                            <div
                                                                key={f.path}
                                                                className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-xs"
                                                            >
                                                                <div className="min-w-0">
                                                                    <p className="truncate font-mono">{f.path}</p>
                                                                    {f.sizeBytes !== null && (
                                                                        <p className="text-muted-foreground">{formatBytes(f.sizeBytes)}</p>
                                                                    )}
                                                                    {progress !== undefined && <Progress value={progress} className="mt-1 h-1" />}
                                                                </div>
                                                                <div className="flex shrink-0 gap-1.5">
                                                                    <Button size="sm" variant="outline" onClick={() => pullModel(ggufTag)}>
                                                                        {t.pullWithOllama}
                                                                    </Button>
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        disabled={progress !== undefined}
                                                                        onClick={() => downloadForLlamaCpp(r.id, f.path)}
                                                                    >
                                                                        {t.downloadForLlamaCpp}
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </SettingsSection>
                        )}

                        {otherInstalled.length > 0 && (
                            <SettingsSection title={t.otherInstalledModels} className="mt-8">
                                {otherInstalled.map((m) => (
                                    <SettingsRow key={m.name} label={m.name} description={`${formatBytes(m.size)} · installed`}>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => deleteModel(m.name)}
                                            aria-label={`Delete ${m.name}`}
                                        >
                                            <Trash2 className="text-destructive" />
                                        </Button>
                                    </SettingsRow>
                                ))}
                            </SettingsSection>
                        )}
                    </div>
                    </TabsContent>

                    <TabsContent value="integrations" className="min-w-0 flex-1 flex flex-col gap-8">
                    <div>
                        <SettingsSection title={t.cloudProviders} description={t.keysEncryptedNote}>
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
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge variant={status?.connected ? "default" : "secondary"}>
                                                    {status?.connected
                                                        ? `${t.mcpConnected} · ${status.toolCount} ${t.mcpToolCount}`
                                                        : t.mcpNotConnected}
                                                </Badge>
                                                {status?.error && (
                                                    <span className="text-xs text-destructive">{status.error}</span>
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
                                        </SettingsRow>
                                    );
                                })}
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
                                                <Input
                                                    value={mcpDraftUrl}
                                                    onChange={(e) => setMcpDraftUrl(e.target.value)}
                                                    placeholder={t.mcpUrlHint}
                                                    className="h-8 text-xs"
                                                />
                                            )}
                                            <div className="flex gap-2">
                                                <Button size="sm" onClick={addMcpServer} className="gap-1.5">
                                                    <Plus className="size-3.5" /> {t.mcpAdd}
                                                </Button>
                                                <Button size="sm" variant="outline" onClick={() => setShowAddMcp(false)}>
                                                    {t.cancel}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => setShowAddMcp(true)}
                                            className="w-fit gap-1.5"
                                        >
                                            <Plus className="size-3.5" /> {t.addMcpServer}
                                        </Button>
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
                                                    <SelectLabel>Ollama (local)</SelectLabel>
                                                    {installed.map((m) => (
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
                                                    <SelectLabel>Ollama (local)</SelectLabel>
                                                    {installed.map((m) => (
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
                                                <label htmlFor="setting-gpuLayers" className="text-xs text-muted-foreground">{t.gpuLayers}</label>
                                                <Input
                                                    id="setting-gpuLayers"
                                                    type="number"
                                                    min={0}
                                                    step={1}
                                                    placeholder={t.gpuLayersAuto}
                                                    title={t.gpuLayersHelp}
                                                    value={settings.gpuLayers ?? ""}
                                                    onChange={(e) =>
                                                        saveSettings({ gpuLayers: e.target.value === "" ? undefined : Number(e.target.value) })
                                                    }
                                                />
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
                                    <SettingsRow label="Ollama">
                                        <span className="text-sm text-muted-foreground">
                                            {activity.ollamaRunning
                                                ? activity.ollamaLoadedModels.length > 0
                                                    ? activity.ollamaLoadedModels.map((m) => m.name).join(", ")
                                                    : t.noModelsLoaded
                                                : t.notRunning}
                                        </span>
                                    </SettingsRow>
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
