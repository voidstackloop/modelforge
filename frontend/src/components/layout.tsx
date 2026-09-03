import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import {
    BookMarked,
    ChevronDown,
    ChevronRight,
    FolderPlus,
    FolderOpen,
    MessageSquare,
    MoreHorizontal,
    PanelLeftClose,
    PanelLeftOpen,
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
    BarChart3,
    Menu,
    Sparkles,
    Download,
    Server,
    ClipboardList,
    BookOpen,
    Share2,
    ShieldCheck,
    Inbox,
    ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { InlineNotice, SectionHeader } from "@/components/ds";
import { ThemeToggle } from "@/components/theme-toggle";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { useSessions } from "@/lib/sessions-context";
import { useCaseAutoLock } from "@/lib/use-case-auto-lock";
import { CaseLockScreen } from "@/components/case-lock-screen";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ChatOptions, ChatSession, Project, PromptPreset } from "@/types/electron";
import { extractVariables, fillTemplate } from "@/lib/prompt-templates";
import { PromptVariableDialog } from "@/components/prompt-variable-dialog";
import { DEFAULT_KEYBINDINGS, matchesBinding, subscribeKeybindings, type KeybindingAction } from "@/lib/keybindings";
import { formatRelativeTime } from "@/lib/format-time";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "sidebar-collapsed";

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
    const [tagEditorOpen, setTagEditorOpen] = useState(false);
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
        <div>
            <div
                onClick={onOpen}
                className={cn(
                    "group relative flex cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-2.5 text-sm transition-all",
                    active
                        ? "border-primary/25 bg-primary/10 text-foreground shadow-sm"
                        : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/60"
                )}
            >
                <MessageSquare className="size-3.5 shrink-0" />
                <span className="flex-1 truncate">{session.title}</span>
                {tags.length > 0 && (
                    <span className="hidden shrink-0 items-center gap-1 sm:flex">
                        {tags.slice(0, 2).map((tg) => (
                            <span
                                key={tg}
                                className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground group-hover:bg-background"
                            >
                                {tg}
                            </span>
                        ))}
                        {tags.length > 2 && <span className="text-[10px] text-muted-foreground">+{tags.length - 2}</span>}
                    </span>
                )}
                <span className="hidden shrink-0 text-[10px] tabular-nums text-muted-foreground/70 group-hover:hidden sm:inline">
                    {formatRelativeTime(session.updatedAt)}
                </span>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <button
                                onClick={(e) => e.stopPropagation()}
                                className="shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 data-popup-open:opacity-100"
                                aria-label={`${t.moreActions}: ${session.title}`}
                            >
                                <MoreHorizontal className="size-3.5" />
                            </button>
                        }
                    />
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem onClick={() => setTagEditorOpen(true)}>
                            <Tag className="size-3.5" />
                            {t.editTags}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={onDelete}>
                            <Trash2 className="size-3.5" />
                            {t.deleteConversation}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {tagEditorOpen && (
                <div
                    className="mt-1 ml-5 flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5"
                    onClick={(e) => e.stopPropagation()}
                >
                    <p className="text-xs font-medium">{t.editTags}</p>
                    {tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                            {tags.map((tg) => (
                                <span key={tg} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
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
                    <Button size="sm" variant="ghost" className="self-end" onClick={() => setTagEditorOpen(false)}>
                        {t.done}
                    </Button>
                </div>
            )}
        </div>
    );
}

/** A sidebar nav item that collapses to an icon-only button with a
 * right-side tooltip in rail mode, or a full icon+label row otherwise. */
function SidebarNavLink({
    to,
    icon,
    label,
    collapsed,
    disabled,
}: {
    to: string;
    icon: React.ReactNode;
    label: string;
    collapsed: boolean;
    disabled?: boolean;
}) {
    const navigate = useNavigate();
    const location = useLocation();
    const active = location.pathname === to;
    const button = (
        <Button
            onClick={() => navigate(to)}
            size="sm"
            variant="ghost"
            className={cn("nav-action w-full gap-2", collapsed ? "justify-center px-0" : "justify-start", active && "nav-action-active")}
            aria-current={active ? "page" : undefined}
            aria-label={collapsed ? label : undefined}
            disabled={disabled}
        >
            {icon}
            {!collapsed && label}
        </Button>
    );
    if (!collapsed) return button;
    return (
        <Tooltip>
            <TooltipTrigger render={button} />
            <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
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
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button
                                onClick={() => onNewChat(project.id)}
                                className="shrink-0 opacity-0 hover:text-foreground group-hover:opacity-100"
                                aria-label={t.newChatInProject}
                            >
                                <Plus className="size-3.5" />
                            </button>
                        }
                    />
                    <TooltipContent>{t.newChatInProject}</TooltipContent>
                </Tooltip>
                <Popover
                    onOpenChange={(open) => {
                        if (open) window.api.settings.get().then((s) => setPresets(s.promptPresets));
                    }}
                >
                    <PopoverTrigger
                        render={
                            <button
                                className="shrink-0 opacity-0 hover:text-foreground group-hover:opacity-100"
                                aria-label={t.editProject}
                                title={t.editProject}
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
                <div className="ml-4 flex flex-col gap-1 border-l border-border pl-2">
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
    const { sessions, projects, hasApi, sessionsLocked, sessionsLoadError, createSession, deleteSession, createProject, refresh } = useSessions();
    useCaseAutoLock();
    const { t } = useI18n();
    const navigate = useNavigate();
    const { sessionId } = useParams();
    const [search, setSearch] = useState("");
    const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
    const [creatingProject, setCreatingProject] = useState(false);
    const [newProjectName, setNewProjectName] = useState("");
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [keybindings, setKeybindings] = useState<Record<KeybindingAction, string>>(DEFAULT_KEYBINDINGS);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    // Desktop-only icon rail mode — purely a frontend presentation
    // preference (unlike density/reduceMotion, which are backend-persisted
    // AppSettings), so it's kept in localStorage rather than round-tripping
    // through window.api.settings. The toggle that flips this is hidden on
    // mobile (md:flex hidden), so mobile always sees the full drawer.
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        try {
            return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
        } catch {
            return false;
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
        } catch {
            /* localStorage unavailable (e.g. private mode) — collapse state just won't persist */
        }
    }, [sidebarCollapsed]);
    // Closes the mobile sidebar on navigating to a session — adjusted during
    // render (not an effect) per React's "resetting state when a prop
    // changes" pattern, since the reset needs to happen before the closed
    // sidebar's first paint rather than flash open-then-closed.
    const [prevSessionId, setPrevSessionId] = useState(sessionId);
    if (sessionId !== prevSessionId) {
        setPrevSessionId(sessionId);
        setSidebarOpen(false);
    }

    useEffect(() => {
        if (!hasApi) return;
        const applyDisplaySettings = (s: { uiDensity?: string; reduceMotion?: boolean }) => {
            const root = document.documentElement;
            root.classList.toggle("density-compact", s.uiDensity === "compact");
            root.classList.toggle("reduce-motion", s.reduceMotion === true);
        };
        window.api.settings.get().then((s) => {
            setShowOnboarding(!s.onboardingComplete);
            setKeybindings({ ...DEFAULT_KEYBINDINGS, ...s.keybindings });
            applyDisplaySettings(s);
        });
        const onDisplaySettings = (event: Event) => applyDisplaySettings((event as CustomEvent).detail);
        window.addEventListener("app:display-settings", onDisplaySettings);
        const unsubscribe = subscribeKeybindings(setKeybindings);
        return () => {
            unsubscribe();
            window.removeEventListener("app:display-settings", onDisplaySettings);
        };
    }, [hasApi]);

    // Filtering re-scans every message of every chat, which can get expensive
    // with a large history — defer it a frame behind the input so typing in
    // the search box never feels laggy, even while the filter itself is slow.
    const deferredSearch = useDeferredValue(search);
    const query = deferredSearch.trim().toLowerCase();
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
    /* eslint-disable react-hooks/exhaustive-deps --
       matchesSearch is a plain function derived from `query`/`activeTags`, already listed below */
    const sessionsByProject = useMemo(() => {
        const map = new Map<string, ChatSession[]>();
        for (const s of sessions) {
            if (!s.projectId || !matchesSearch(s)) continue;
            const list = map.get(s.projectId);
            if (list) list.push(s);
            else map.set(s.projectId, [s]);
        }
        return map;
    }, [sessions, query, activeTags]);
    /* eslint-enable react-hooks/exhaustive-deps */

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

    // Command palette and the shortcuts cheat-sheet are renderer-only (no
    // native menu entry), so they're matched here against the user's
    // (possibly remapped) bindings rather than a hardcoded key check.
    // "New chat"/"Settings" are remapped instead by rebuilding the native
    // menu's accelerator — see app/src/menu.ts — so they're not handled here.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (matchesBinding(e, keybindings.commandPalette)) {
                e.preventDefault();
                setPaletteOpen((o) => !o);
            } else if (matchesBinding(e, keybindings.showShortcuts)) {
                e.preventDefault();
                setShortcutsOpen((o) => !o);
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [keybindings]);

    async function handleDelete(e: React.MouseEvent, id: string) {
        e.stopPropagation();
        await deleteSession(id);
        if (id === sessionId) navigate("/");
    }

    const collapsed = sidebarCollapsed;

    // Chat sessions share the case-encryption gate (sessions-store.ts) — when
    // it's locked, `sessions` is empty-and-stale rather than "no chats yet",
    // so the whole app shell is replaced with the unlock prompt instead of
    // rendering a misleadingly empty sidebar/chat view.
    if (sessionsLocked) {
        return (
            <TooltipProvider>
                <CaseLockScreen onUnlocked={refresh} />
            </TooltipProvider>
        );
    }

    // A load failure that isn't encryption being locked (see
    // sessions-context.tsx's refresh() — it re-checks status before ever
    // setting this) must not show the same unlock prompt: no passphrase
    // fixes a corrupted local store or a disk I/O error.
    if (sessionsLoadError) {
        return (
            <TooltipProvider>
                <div className="flex h-svh items-center justify-center bg-background p-8">
                    <InlineNotice
                        variant="destructive"
                        title="Couldn't load your chats and projects"
                        action={
                            <Button variant="outline" size="sm" onClick={() => void refresh()} className="shrink-0">
                                Retry
                            </Button>
                        }
                    >
                        {sessionsLoadError}
                    </InlineNotice>
                </div>
            </TooltipProvider>
        );
    }

    return (
        <TooltipProvider>
        <div className="flex h-svh overflow-hidden bg-background">
            {sidebarOpen && <button className="fixed inset-0 z-30 bg-black/35 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}
            <aside className={cn(
                "app-sidebar fixed inset-y-0 left-0 z-40 flex w-[17.5rem] shrink-0 flex-col border-r border-border/60 shadow-2xl transition-[transform,width] duration-200 md:static md:translate-x-0 md:shadow-none",
                sidebarOpen ? "translate-x-0" : "-translate-x-full",
                collapsed && "md:w-[4.5rem]"
            )}>
                <div className={cn("flex items-center pb-4 pt-5", collapsed ? "flex-col gap-2 px-2" : "justify-between px-4")}>
                    <div className={cn("flex items-center gap-2.5", collapsed && "flex-col gap-1.5")}>
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Sparkles className="size-4" /></span>
                        {!collapsed && (
                            <div><span className="block text-[15px] font-semibold tracking-[-0.02em]">{t.appName}</span><span className="section-eyebrow mt-0.5 block">Clinical workspace</span></div>
                        )}
                    </div>
                    <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
                        {!collapsed && <ThemeToggle />}
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <button
                                        onClick={() => setSidebarCollapsed((c) => !c)}
                                        className="hidden size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground md:flex"
                                        aria-label={collapsed ? t.expandSidebar : t.collapseSidebar}
                                    >
                                        {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                                    </button>
                                }
                            />
                            <TooltipContent side="right">{collapsed ? t.expandSidebar : t.collapseSidebar}</TooltipContent>
                        </Tooltip>
                    </div>
                </div>

                <div className={cn("flex flex-col gap-1 pb-3", collapsed ? "px-2" : "px-3")}>
                    {collapsed ? (
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button onClick={() => handleNewChat()} size="sm" variant="default" className="h-10 w-full justify-center rounded-xl px-0" disabled={!hasApi} aria-label={t.newChat}>
                                        <Plus className="size-4" />
                                    </Button>
                                }
                            />
                            <TooltipContent side="right">{t.newChat}</TooltipContent>
                        </Tooltip>
                    ) : (
                        <>
                            <Button onClick={() => handleNewChat()} size="sm" variant="default" className="h-10 w-full justify-start gap-2 rounded-xl px-3" disabled={!hasApi}>
                                <Plus className="size-4" />
                                {t.newChat}
                            </Button>
                            <Button onClick={() => setCreatingProject(true)} size="sm" variant="ghost" className="nav-action w-full justify-start gap-2" disabled={!hasApi}>
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
                        </>
                    )}
                    {!collapsed && <SectionHeader title={t.navClinicalGroup} className="mb-0 px-2 pb-1 pt-3" />}
                    <SidebarNavLink to="/cases" icon={<ClipboardList className="size-4" />} label={t.patientCases} collapsed={collapsed} disabled={!hasApi} />
                    <SidebarNavLink to="/evidence" icon={<BookOpen className="size-4" />} label={t.evidenceLibrary} collapsed={collapsed} disabled={!hasApi} />
                    <SidebarNavLink to="/knowledge-graph" icon={<Share2 className="size-4" />} label={t.knowledgeGraph} collapsed={collapsed} disabled={!hasApi} />
                    <SidebarNavLink to="/audit" icon={<ShieldCheck className="size-4" />} label={t.auditPrivacy} collapsed={collapsed} disabled={!hasApi} />
                    <SidebarNavLink to="/hl7-inbox" icon={<Inbox className="size-4" />} label={t.hl7Inbox} collapsed={collapsed} disabled={!hasApi} />
                    <SidebarNavLink to="/external-ehr" icon={<ExternalLink className="size-4" />} label={t.externalEhr} collapsed={collapsed} disabled={!hasApi} />

                    {!collapsed && <SectionHeader title={t.navWorkspaceGroup} className="mb-0 px-2 pb-1 pt-3" />}
                    <SidebarNavLink to="/compare" icon={<Scale className="size-4" />} label={t.compareModels} collapsed={collapsed} disabled={!hasApi} />
                    <SidebarNavLink to="/usage" icon={<BarChart3 className="size-4" />} label={t.usageDashboard} collapsed={collapsed} disabled={!hasApi} />
                    <SidebarNavLink to="/downloads" icon={<Download className="size-4" />} label={t.downloadCenter} collapsed={collapsed} disabled={!hasApi} />
                    <SidebarNavLink to="/runtimes" icon={<Server className="size-4" />} label={t.runtimeManager} collapsed={collapsed} disabled={!hasApi} />
                </div>

                {!collapsed && (
                    <>
                        <div className="relative px-3 pb-3 pt-2">
                            <SectionHeader title={t.navConversationsGroup} className="mb-2 px-2" />
                            <Search className="pointer-events-none absolute bottom-[1.35rem] left-5 size-3.5 translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={t.searchChats}
                                aria-label={t.searchChats}
                                className="h-9 rounded-xl border-border/70 bg-background/55 pl-8 text-xs shadow-sm focus-visible:bg-card"
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

                        <ScrollArea className="flex-1 px-2.5">
                            <div className="flex flex-col gap-0.5 pb-2">
                                {projects.map((project) => (
                                    <ProjectGroup
                                        key={project.id}
                                        project={project}
                                        sessions={sessionsByProject.get(project.id) ?? []}
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
                    </>
                )}
                {collapsed && <div className="flex-1" />}

                <div className={cn("flex border-t border-border/60 bg-background/25 p-2.5", collapsed && "flex-col gap-1")}>
                    <SidebarNavLink to="/settings" icon={<SettingsIcon className="size-4" />} label={t.settings} collapsed={collapsed} />
                    {collapsed ? (
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <button
                                        onClick={() => setShortcutsOpen(true)}
                                        className="flex size-9 shrink-0 items-center justify-center self-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                                        aria-label={t.keyboardShortcuts}
                                    >
                                        <Keyboard className="size-4" />
                                    </button>
                                }
                            />
                            <TooltipContent side="right">{t.keyboardShortcuts}</TooltipContent>
                        </Tooltip>
                    ) : (
                        <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setShortcutsOpen(true)} aria-label={t.keyboardShortcuts}>
                            <Keyboard className="size-4" />
                        </Button>
                    )}
                </div>
            </aside>

            <main className="relative min-w-0 flex-1 overflow-hidden bg-background">
                <Button variant="outline" size="icon" className="surface-glass absolute left-3 top-3 z-30 shadow-md md:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">
                    <Menu className="size-4" />
                </Button>
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
                onNavigateUsage={() => navigate("/usage")}
            />
            <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} keybindings={keybindings} />
            <OnboardingWizard open={showOnboarding} onDone={() => setShowOnboarding(false)} />
        </div>
        </TooltipProvider>
    );
}
