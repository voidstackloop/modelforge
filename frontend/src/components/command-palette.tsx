import { FolderOpen, MessageSquare, Plus, Settings as SettingsIcon, Scale } from "lucide-react";
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import type { ChatSession, Project } from "@/types/electron";

export function CommandPalette({
    open,
    onOpenChange,
    sessions,
    projects,
    onNewChat,
    onOpenSession,
    onNavigateSettings,
    onNavigateCompare,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sessions: ChatSession[];
    projects: Project[];
    onNewChat: (projectId?: string) => void;
    onOpenSession: (id: string) => void;
    onNavigateSettings: () => void;
    onNavigateCompare: () => void;
}) {
    function run(action: () => void) {
        action();
        onOpenChange(false);
    }

    return (
        <CommandDialog open={open} onOpenChange={onOpenChange} title="Command Palette">
            <CommandInput placeholder="Search chats, projects, or run a command..." />
            <CommandList>
                <CommandEmpty>No results found.</CommandEmpty>
                <CommandGroup heading="Actions">
                    <CommandItem onSelect={() => run(() => onNewChat())}>
                        <Plus /> New chat
                    </CommandItem>
                    <CommandItem onSelect={() => run(onNavigateSettings)}>
                        <SettingsIcon /> Settings
                    </CommandItem>
                    <CommandItem onSelect={() => run(onNavigateCompare)}>
                        <Scale /> Compare models
                    </CommandItem>
                </CommandGroup>

                {projects.length > 0 && (
                    <CommandGroup heading="Projects">
                        {projects.map((p) => (
                            <CommandItem key={p.id} onSelect={() => run(() => onNewChat(p.id))}>
                                <FolderOpen /> New chat in {p.name}
                            </CommandItem>
                        ))}
                    </CommandGroup>
                )}

                {sessions.length > 0 && (
                    <CommandGroup heading="Chats">
                        {sessions.map((s) => (
                            <CommandItem key={s.id} onSelect={() => run(() => onOpenSession(s.id))}>
                                <MessageSquare /> {s.title}
                            </CommandItem>
                        ))}
                    </CommandGroup>
                )}
            </CommandList>
        </CommandDialog>
    );
}
