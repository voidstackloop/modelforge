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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingsSection, SettingsRow } from "@/components/settings-ui";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { AppSettings, ModelRecommendations, OllamaModel, SystemSpecs } from "@/types/electron";
import { EXTRA_MODELS } from "@/lib/model-catalog";
import { OPENAI_MODELS, ANTHROPIC_MODELS, formatModelRef } from "@/lib/providers";
import { useSessions } from "@/lib/sessions-context";
import { useI18n } from "@/lib/i18n";
import type { Locale } from "@/lib/translations";

function formatBytes(bytes: number) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
}

export default function Settings() {
    const { t, locale, setLocale } = useI18n();
    const [running, setRunning] = useState<boolean | null>(null);
    const [specs, setSpecs] = useState<SystemSpecs | null>(null);
    const [recommendations, setRecommendations] = useState<ModelRecommendations | null>(null);
    const [installed, setInstalled] = useState<OllamaModel[]>([]);
    const [pulling, setPulling] = useState<Record<string, number>>({});
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [hasApi, setHasApi] = useState(true);
    const [search, setSearch] = useState("");
    const [openaiKeyInput, setOpenaiKeyInput] = useState("");
    const [anthropicKeyInput, setAnthropicKeyInput] = useState("");
    const [openaiKeySet, setOpenaiKeySet] = useState(false);
    const [anthropicKeySet, setAnthropicKeySet] = useState(false);
    const [appVersion, setAppVersion] = useState<string | null>(null);
    const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
    const [userDataPath, setUserDataPath] = useState<string | null>(null);
    const [importMessage, setImportMessage] = useState<string | null>(null);
    const [ollamaHostInput, setOllamaHostInput] = useState("");
    const [newPresetName, setNewPresetName] = useState("");
    const { refresh: refreshSessions } = useSessions();
    const activePullCount = useRef(0);

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
        });
        window.api.secrets.has("openai_api_key").then(setOpenaiKeySet);
        window.api.secrets.has("anthropic_api_key").then(setAnthropicKeySet);
        window.api.app.getVersion().then(setAppVersion);
        window.api.data.getUserDataPath().then(setUserDataPath);
        refreshInstalled();
    }, []);

    async function handleExportAll() {
        await window.api.data.exportAll();
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
        await window.api.secrets.set("openai_api_key", openaiKeyInput.trim());
        setOpenaiKeySet(!!openaiKeyInput.trim());
        setOpenaiKeyInput("");
    }

    async function saveAnthropicKey() {
        await window.api.secrets.set("anthropic_api_key", anthropicKeyInput.trim());
        setAnthropicKeySet(!!anthropicKeyInput.trim());
        setAnthropicKeyInput("");
    }

    async function saveOllamaHost() {
        const host = ollamaHostInput.trim() || "http://127.0.0.1:11434";
        setOllamaHostInput(host);
        await saveSettings({ ollamaHost: host });
        window.api.ollama.status().then(setRunning);
        refreshInstalled();
    }

    async function toggleServer() {
        if (running) {
            await window.api.ollama.stop();
            setRunning(false);
        } else {
            const result = await window.api.ollama.start();
            setRunning(!result.error);
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
    }

    async function handleSavePreset() {
        if (!settings) return;
        const name = newPresetName.trim();
        if (!name) return;
        const preset = { id: crypto.randomUUID(), name, prompt: settings.systemPrompt };
        await saveSettings({ promptPresets: [...settings.promptPresets, preset] });
        setNewPresetName("");
    }

    function applyPreset(prompt: string) {
        saveSettings({ systemPrompt: prompt });
    }

    function deletePreset(id: string) {
        if (!settings) return;
        saveSettings({ promptPresets: settings.promptPresets.filter((p) => p.id !== id) });
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
        <ScrollArea className="h-full">
            <div className="mx-auto max-w-2xl p-6 pb-16 2xl:max-w-3xl">
                <div className="mb-6 flex items-center gap-2">
                    <Settings2 className="size-5 text-muted-foreground" />
                    <h1 className="text-lg font-semibold tracking-tight">{t.settings}</h1>
                </div>

                <div className="flex flex-col gap-8">
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
                        </SettingsSection>

                        <SettingsSection title={t.language}>
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
                                <SettingsRow label="GPU">
                                    <span className="text-sm text-muted-foreground">
                                        {specs.gpu
                                            ? `${specs.gpu.name}${specs.gpu.vramGB ? ` (${specs.gpu.vramGB} GB VRAM)` : ""}`
                                            : "No dedicated GPU detected"}
                                    </span>
                                </SettingsRow>
                            </SettingsSection>
                        )}

                        <p className="text-center text-xs text-muted-foreground">
                            {t.appName}{appVersion ? ` v${appVersion}` : ""}
                        </p>
                    </div>

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
                        </SettingsSection>
                    </div>

                    <div>
                        <SettingsSection title={t.ollamaModelsSection}>
                            <div className="p-3">
                                <div className="relative">
                                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        placeholder="Search any model, e.g. codellama:13b, mixtral:8x7b..."
                                        aria-label="Search models"
                                        className="pl-8"
                                    />
                                </div>
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

                            {search.trim() && !exactMatchExists && !installedNames.has(search.trim()) && (
                                <SettingsRow
                                    label={search.trim()}
                                    description="Not in the catalog — pull this exact model tag from Ollama's library."
                                >
                                    {pulling[search.trim()] !== undefined ? (
                                        <Button size="icon" variant="outline" disabled aria-label={`Downloading ${search.trim()}`}>
                                            <Loader2 className="animate-spin" />
                                        </Button>
                                    ) : (
                                        <Button
                                            size="icon"
                                            variant="outline"
                                            onClick={() => pullModel(search.trim())}
                                            aria-label={`Download ${search.trim()}`}
                                        >
                                            <Download />
                                        </Button>
                                    )}
                                </SettingsRow>
                            )}
                        </SettingsSection>

                        {otherInstalled.length > 0 && (
                            <SettingsSection title={t.otherInstalledModels}>
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
                                        </div>
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

                                <SettingsSection
                                    title={t.promptLibrary}
                                    className="mt-8"
                                >
                                    {settings.promptPresets.map((preset) => (
                                        <SettingsRow key={preset.id} label={preset.name} description={preset.prompt}>
                                            <Button size="sm" variant="outline" onClick={() => applyPreset(preset.prompt)}>
                                                {t.apply}
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                onClick={() => deletePreset(preset.id)}
                                                aria-label={`Delete preset ${preset.name}`}
                                            >
                                                <Trash2 className="text-destructive" />
                                            </Button>
                                        </SettingsRow>
                                    ))}
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
                                </SettingsSection>
                            </>
                        )}
                    </div>

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
                </div>
            </div>
        </ScrollArea>
    );
}
