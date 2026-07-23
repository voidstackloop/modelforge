import { useEffect, useMemo, useState } from "react";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import {
    BookMarked,
    ChevronDown,
    ChevronRight,
    FolderPlus,
    FolderOpen,
    MessageSquare,
    Pencil,
    Plus,
    RotateCw,
    Search,
    Settings as SettingsIcon,
    Tag,
    Trash2,
    X,
    Keyboard,
    Scale,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ThemeToggle } from "@/components/theme-toggle";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { useSessions } from "@/lib/sessions-context";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ChatOptions, ChatSession, Project, PromptPreset } from "@/types/electron";
import { extractVariables, fillTemplate } from "@/lib/prompt-templates";
import { PromptVariableDialog } from "@/components/prompt-variable-dialog";

function SessionRow({
    session,
    active,
    onOpen,
    onDelete,
    onUpdateTags,
}: {
    session: ChatSession;
    active: boolean;
    onOpen: () => void;
    onDelete: (e: React.MouseEvent) => void;
    onUpdateTags: (tags: string[]) => void;
}) {
    const { t } = useI18n();
    const [tagInput, setTagInput] = useState("");
    const tags = session.tags ?? [];

    function addTag() {
        const value = tagInput.trim();
        if (!value || tags.includes(value)) return;
        onUpdateTags([...tags, value]);
        setTagInput("");
    }

    function removeTag(tag: string) {
        onUpdateTags(tags.filter((t) => t !== tag));
    }

    return (
        <div
            onClick={onOpen}
            className={cn(
                "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                active ? "bg-muted text-foreground" : "text-muted-foreground"
            )}
        >
            <MessageSquare className="size-3.5 shrink-0" />
            <span className="flex-1 truncate">{session.title}</span>
            {tags.length > 0 && (
                <span className="hidden shrink-0 truncate text-[10px] text-muted-foreground sm:inline">
                    {tags.map((tg) => `#${tg}`).join(" ")}
                </span>
            )}
            <Popover>
                <PopoverTrigger
                    render={
                        <button
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                            aria-label={`${t.editTags}: ${session.title}`}
                        >
                            <Tag className="size-3.5" />
                        </button>
                    }
                />
                <PopoverContent align="start" className="w-56" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-col gap-2">
                        <p className="text-xs font-medium">{t.editTags}</p>
                        {tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                                {tags.map((tg) => (
                                    <span
                                        key={tg}
                                        className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                                    >
                                        #{tg}
                                        <button onClick={() => removeTag(tg)} aria-label={`Remove tag ${tg}`}>
                                            <X className="size-3" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-1.5">
                            <Input
                                autoFocus
                                value={tagInput}
                                onChange={(e) => setTagInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && addTag()}
                                placeholder={t.addTag}
                                className="h-7 text-xs"
                            />
                            <Button size="sm" variant="outline" onClick={addTag} disabled={!tagInput.trim()}>
                                {t.add}
                            </Button>
                        </div>
                    </div>
                </PopoverContent>
            </Popover>
            <button
                onClick={onDelete}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                aria-label="Delete conversation"
            >
                <Trash2 className="size-3.5" />
            </button>
        </div>
    );
}

function ProjectGroup({
    project,
    sessions,
    activeSessionId,
    onOpenSession,
    onDeleteSession,
    onNewChat,
    onUpdateSessionTags,
}: {
    project: Project;
    sessions: ChatSession[];
    activeSessionId: string | undefined;
    onOpenSession: (id: string) => void;
    onDeleteSession: (e: React.MouseEvent, id: string) => void;
    onNewChat: (projectId: string) => void;
    onUpdateSessionTags: (id: string, tags: string[]) => void;
}) {
    const { updateProject, deleteProject } = useSessions();
    const { t } = useI18n();
    const [collapsed, setCollapsed] = useState(false);
    const [name, setName] = useState(project.name);
    const [instructions, setInstructions] = useState(project.instructions);
    const [params, setParams] = useState<ChatOptions>(project.params ?? {});
    const [presets, setPresets] = useState<PromptPreset[]>([]);
    const [newPresetName, setNewPresetName] = useState("");
    const [pendingVariablePreset, setPendingVariablePreset] = useState<PromptPreset | null>(null);

    async function handleSave() {
        await updateProject(project.id, { name, instructions });
    }

    function updateParam(partial: Partial<ChatOptions>) {
        const next = { ...params, ...partial };
        setParams(next);
        updateProject(project.id, { params: next });
    }

    function resetParams() {
        setParams({});
        updateProject(project.id, { params: {} });
    }

    function applyPreset(prompt: string) {
        setInstructions(prompt);
        updateProject(project.id, { instructions: prompt });
    }

    function selectPreset(preset: PromptPreset) {
        const variables = extractVariables(preset.prompt);
        if (variables.length === 0) {
            applyPreset(preset.prompt);
        } else {
            setPendingVariablePreset(preset);
        }
    }

    async function saveCurrentAsPreset() {
        const name = newPresetName.trim();
        if (!name || !instructions.trim()) return;
        const settings = await window.api.settings.get();
        const now = new Date().toISOString();
        const preset: PromptPreset = { id: crypto.randomUUID(), name, prompt: instructions, versions: [], createdAt: now, updatedAt: now };
        await window.api.settings.save({ promptPresets: [...settings.promptPresets, preset] });
        setPresets([...settings.promptPresets, preset]);
        setNewPresetName("");
    }

    async function handleDeleteProject() {
        if (!confirm(`Delete project "${project.name}"? Its chats will be kept, just ungrouped.`)) return;
        await deleteProject(project.id);
    }

    return (
        <div className="mb-1">
            <div className="group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted">
                <button
                    onClick={() => setCollapsed((c) => !c)}
                    className="flex flex-1 items-center gap-1.5 text-left"
                >
                    {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="flex-1 truncate font-medium">{project.name}</span>
                </button>
                <button
                    onClick={() => onNewChat(project.id)}
                    className="shrink-0 opacity-0 hover:text-foreground group-hover:opacity-100"
                    aria-label="New chat in project"
                >
                    <Plus className="size-3.5" />
                </button>
                <Popover
                    onOpenChange={(open) => {
                        if (open) window.api.settings.get().then((s) => setPresets(s.promptPresets));
                    }}
                >
                    <PopoverTrigger
                        render={
                            <button
                                className="shrink-0 opacity-0 hover:text-foreground group-hover:opacity-100"
                                aria-label="Edit project"
                            >
                                <Pencil className="size-3.5" />
                            </button>
                        }
                    />
                    <PopoverContent align="start" className="w-96">
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">Name</label>
                                <Input
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    onBlur={handleSave}
                                    aria-label="Project name"
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">
                                    Instructions (applied to every chat in this project)
                                </label>
                                <Textarea
                                    value={instructions}
                                    onChange={(e) => setInstructions(e.target.value)}
                                    onBlur={handleSave}
                                    aria-label="Project instructions"
                                    className="min-h-20 text-xs"
                                />
                            </div>

                            {presets.length > 0 && (
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.promptLibrary}</label>
                                    <div className="flex flex-col gap-1">
                                        {presets.map((preset) => (
                                            <button
                                                key={preset.id}
                                                onClick={() => selectPreset(preset)}
                                                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                                            >
                                                <span className="truncate font-medium">{preset.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <div className="flex gap-1.5">
                                <Input
                                    value={newPresetName}
                                    onChange={(e) => setNewPresetName(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && saveCurrentAsPreset()}
                                    placeholder={t.presetName}
                                    aria-label={t.presetName}
                                    className="h-8 text-xs"
                                />
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={saveCurrentAsPreset}
                                    disabled={!newPresetName.trim()}
                                    className="shrink-0 gap-1.5 whitespace-nowrap"
                                >
                                    <BookMarked className="size-3.5" /> {t.save}
                                </Button>
                            </div>

                            <div className="flex items-center justify-between">
                                <label className="text-xs text-muted-foreground">Model parameters</label>
                                <button
                                    onClick={resetParams}
                                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                >
                                    <RotateCw className="size-3" /> {t.resetToDefault}
                                </button>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.temperature}</label>
                                    <Input
                                        type="number"
                                        min={0}
                                        max={2}
                                        step={0.1}
                                        value={params.temperature ?? ""}
                                        onChange={(e) => updateParam({ temperature: Number(e.target.value) })}
                                        aria-label={t.temperature}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.topP}</label>
                                    <Input
                                        type="number"
                                        min={0}
                                        max={1}
                                        step={0.05}
                                        value={params.topP ?? ""}
                                        onChange={(e) => updateParam({ topP: Number(e.target.value) })}
                                        aria-label={t.topP}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.maxTokens}</label>
                                    <Input
                                        type="number"
                                        min={1}
                                        step={1}
                                        value={params.maxTokens ?? ""}
                                        onChange={(e) => updateParam({ maxTokens: Number(e.target.value) })}
                                        aria-label={t.maxTokens}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.contextLength}</label>
                                    <Input
                                        type="number"
                                        min={512}
                                        step={512}
                                        value={params.contextLength ?? ""}
                                        onChange={(e) => updateParam({ contextLength: Number(e.target.value) })}
                                        aria-label={t.contextLength}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.gpuLayers}</label>
                                    <Input
                                        type="number"
                                        min={0}
                                        step={1}
                                        placeholder={t.gpuLayersAuto}
                                        value={params.gpuLayers ?? ""}
                                        onChange={(e) =>
                                            updateParam({ gpuLayers: e.target.value === "" ? undefined : Number(e.target.value) })
                                        }
                                        aria-label={t.gpuLayers}
                                        title={t.gpuLayersHelp}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.frequencyPenalty}</label>
                                    <Input
                                        type="number"
                                        min={-2}
                                        max={2}
                                        step={0.1}
                                        value={params.frequencyPenalty ?? ""}
                                        onChange={(e) => updateParam({ frequencyPenalty: Number(e.target.value) })}
                                        aria-label={t.frequencyPenalty}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.presencePenalty}</label>
                                    <Input
                                        type="number"
                                        min={-2}
                                        max={2}
                                        step={0.1}
                                        value={params.presencePenalty ?? ""}
                                        onChange={(e) => updateParam({ presencePenalty: Number(e.target.value) })}
                                        aria-label={t.presencePenalty}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.seed}</label>
                                    <Input
                                        type="number"
                                        step={1}
                                        placeholder={t.seedRandom}
                                        title={t.seedHelp}
                                        value={params.seed ?? ""}
                                        onChange={(e) => updateParam({ seed: e.target.value === "" ? undefined : Number(e.target.value) })}
                                        aria-label={t.seed}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.topK}</label>
                                    <Input
                                        type="number"
                                        min={1}
                                        step={1}
                                        title={t.topKHelp}
                                        value={params.topK ?? ""}
                                        onChange={(e) => updateParam({ topK: e.target.value === "" ? undefined : Number(e.target.value) })}
                                        aria-label={t.topK}
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">{t.repeatPenalty}</label>
                                    <Input
                                        type="number"
                                        min={0}
                                        step={0.05}
                                        title={t.repeatPenaltyHelp}
                                        value={params.repeatPenalty ?? ""}
                                        onChange={(e) =>
                                            updateParam({ repeatPenalty: e.target.value === "" ? undefined : Number(e.target.value) })
                                        }
                                        aria-label={t.repeatPenalty}
                                        className="h-8 text-xs"
                                    />
                                </div>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">{t.stopSequences}</label>
                                <Input
                                    placeholder={t.stopSequencesPlaceholder}
                                    value={(params.stop ?? []).join(", ")}
                                    onChange={(e) =>
                                        updateParam({
                                            stop: e.target.value
                                                .split(",")
                                                .map((s) => s.trim())
                                                .filter(Boolean),
                                        })
                                    }
                                    aria-label={t.stopSequences}
                                    className="h-8 text-xs"
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Blank fields fall back to the global default. {t.penaltyClaudeNote}
                            </p>

                            <Button size="sm" variant="destructive" onClick={handleDeleteProject} className="gap-1.5">
                                <Trash2 className="size-3.5" /> {t.delete}
                            </Button>
                        </div>
                    </PopoverContent>
                </Popover>
            </div>
            {!collapsed && (
                <div className="ml-4 flex flex-col gap-0.5 border-l border-border pl-2">
                    {sessions.length === 0 && (
                        <p className="px-2 py-1 text-xs text-muted-foreground">No chats yet.</p>
                    )}
                    {sessions.map((s) => (
                        <SessionRow
                            key={s.id}
                            session={s}
                            active={s.id === activeSessionId}
                            onOpen={() => onOpenSession(s.id)}
                            onDelete={(e) => onDeleteSession(e, s.id)}
                            onUpdateTags={(tags) => onUpdateSessionTags(s.id, tags)}
                        />
                    ))}
                </div>
            )}
            <PromptVariableDialog
                open={pendingVariablePreset !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingVariablePreset(null);
                }}
                variables={pendingVariablePreset ? extractVariables(pendingVariablePreset.prompt) : []}
                onSubmit={(values) => {
                    if (pendingVariablePreset) applyPreset(fillTemplate(pendingVariablePreset.prompt, values));
                }}
            />
        </div>
    );
}

export default function Layout() {
    const { sessions, projects, hasApi, createSession, deleteSession, createProject, refresh } = useSessions();
    const { t } = useI18n();
    const navigate = useNavigate();
    const { sessionId } = useParams();
    const [search, setSearch] = useState("");
    const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
    const [creatingProject, setCreatingProject] = useState(false);
    const [newProjectName, setNewProjectName] = useState("");
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);

    const query = search.trim().toLowerCase();
    const matchesSearch = (s: ChatSession) =>
        (!query ||
            s.title.toLowerCase().includes(query) ||
            s.messages.some((m) => m.content.toLowerCase().includes(query))) &&
        (activeTags.size === 0 || (s.tags ?? []).some((tg) => activeTags.has(tg)));

    const allTags = useMemo(() => {
        const set = new Set<string>();
        for (const s of sessions) for (const tg of s.tags ?? []) set.add(tg);
        return [...set].sort();
    }, [sessions]);

    function toggleTagFilter(tag: string) {
        setActiveTags((prev) => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
    }

    async function updateSessionTags(id: string, tags: string[]) {
        await window.api.sessions.update(id, { tags });
        await refresh();
    }

    /* eslint-disable-next-line react-hooks/exhaustive-deps --
       matchesSearch is a plain function derived from `query`/`activeTags`, already listed below */
    const ungroupedSessions = useMemo(() => sessions.filter((s) => !s.projectId && matchesSearch(s)), [
        sessions,
        query,
        activeTags,
    ]);

    async function handleNewChat(projectId?: string) {
        const session = await createSession(null, projectId ?? null);
        navigate(`/chat/${session.id}`);
    }

    async function handleCreateProject() {
        const name = newProjectName.trim();
        if (!name) return;
        await createProject(name);
        setNewProjectName("");
        setCreatingProject(false);
    }

    // The native File menu owns Ctrl/Cmd+N and Ctrl/Cmd+, — it sends these events instead.
    useEffect(() => {
        if (!hasApi) return;
        const unsubNewChat = window.api.menu.onNewChat(() => handleNewChat());
        const unsubSettings = window.api.menu.onOpenSettings(() => navigate("/settings"));
        return () => {
            unsubNewChat();
            unsubSettings();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasApi]);

    // Ctrl/Cmd+K opens the command palette, Ctrl/Cmd+/ shows the shortcuts
    // cheat-sheet, both from anywhere in the app.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setPaletteOpen((o) => !o);
            } else if ((e.ctrlKey || e.metaKey) && e.key === "/") {
                e.preventDefault();
                setShortcutsOpen((o) => !o);
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    async function handleDelete(e: React.MouseEvent, id: string) {
        e.stopPropagation();
        await deleteSession(id);
        if (id === sessionId) navigate("/");
    }

    return (
        <div className="flex h-svh">
            <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/40">
                <div className="flex items-center justify-between px-3 py-3">
                    <span className="text-sm font-semibold tracking-tight">{t.appName}</span>
                    <ThemeToggle />
                </div>

                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <Button
                        onClick={() => handleNewChat()}
                        size="sm"
                        variant="outline"
                        className="w-full justify-start gap-2"
                        disabled={!hasApi}
                    >
                        <Plus className="size-4" />
                        {t.newChat}
                    </Button>
                    <Button
                        onClick={() => setCreatingProject(true)}
                        size="sm"
                        variant="ghost"
                        className="w-full justify-start gap-2 text-muted-foreground"
                        disabled={!hasApi}
                    >
                        <FolderPlus className="size-4" />
                        {t.newProject}
                    </Button>
                    {creatingProject && (
                        <div className="flex items-center gap-1.5">
                            <Input
                                autoFocus
                                value={newProjectName}
                                onChange={(e) => setNewProjectName(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                                placeholder={t.newProject + "..."}
                                aria-label={t.newProject}
                                className="h-7 text-xs"
                            />
                            <Button size="sm" variant="outline" onClick={handleCreateProject}>
                                {t.save}
                            </Button>
                        </div>
                    )}
                    <Button
                        onClick={() => navigate("/compare")}
                        size="sm"
                        variant="ghost"
                        className="w-full justify-start gap-2 text-muted-foreground"
                        disabled={!hasApi}
                    >
                        <Scale className="size-4" />
                        {t.compareModels}
                    </Button>
                </div>

                <div className="relative px-3 pb-2">
                    <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t.searchChats}
                        aria-label={t.searchChats}
                        className="h-8 pl-7 text-xs"
                    />
                </div>

                {allTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 px-3 pb-2">
                        {allTags.map((tg) => (
                            <button
                                key={tg}
                                onClick={() => toggleTagFilter(tg)}
                                className={cn(
                                    "rounded-full px-2 py-0.5 text-[10px] transition-colors",
                                    activeTags.has(tg)
                                        ? "bg-primary text-primary-foreground"
                                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                                )}
                            >
                                #{tg}
                            </button>
                        ))}
                    </div>
                )}

                <ScrollArea className="flex-1 px-2">
                    <div className="flex flex-col gap-0.5 pb-2">
                        {projects.map((project) => (
                            <ProjectGroup
                                key={project.id}
                                project={project}
                                sessions={sessions.filter((s) => s.projectId === project.id && matchesSearch(s))}
                                activeSessionId={sessionId}
                                onOpenSession={(id) => navigate(`/chat/${id}`)}
                                onDeleteSession={handleDelete}
                                onNewChat={handleNewChat}
                                onUpdateSessionTags={updateSessionTags}
                            />
                        ))}

                        {ungroupedSessions.length === 0 && projects.length === 0 && (
                            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                {search ? t.noMatchingChats : t.noChatsYet}
                            </p>
                        )}
                        {ungroupedSessions.map((s) => (
                            <SessionRow
                                key={s.id}
                                session={s}
                                active={s.id === sessionId}
                                onOpen={() => navigate(`/chat/${s.id}`)}
                                onDelete={(e) => handleDelete(e, s.id)}
                                onUpdateTags={(tags) => updateSessionTags(s.id, tags)}
                            />
                        ))}
                    </div>
                </ScrollArea>

                <div className="flex border-t border-border p-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 justify-start gap-2"
                        onClick={() => navigate("/settings")}
                    >
                        <SettingsIcon className="size-4" />
                        {t.settings}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => setShortcutsOpen(true)}
                        aria-label={t.keyboardShortcuts}
                        title={t.keyboardShortcuts}
                    >
                        <Keyboard className="size-4" />
                    </Button>
                </div>
            </aside>

            <main className="flex-1 overflow-hidden">
                <Outlet />
            </main>

            <CommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                sessions={sessions}
                projects={projects}
                onNewChat={(projectId) => handleNewChat(projectId)}
                onOpenSession={(id) => navigate(`/chat/${id}`)}
                onNavigateSettings={() => navigate("/settings")}
                onNavigateCompare={() => navigate("/compare")}
            />
            <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        </div>
    );
}
