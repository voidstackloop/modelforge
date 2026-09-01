import { Building2, ClipboardList, Cpu, DatabaseBackup, Gauge, LogOut, Plug, ShieldAlert, ShieldCheck, UserRoundCog, Users2, KeyRound, Mail, ScrollText } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth/auth-context";
import { useMe, useOrg } from "@/lib/org-context";
import type { FixedAction } from "@/lib/authz/permissions";

function NavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
    return (
        <NavLink
            to={to}
            className={({ isActive }) =>
                cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                    isActive && "bg-accent text-accent-foreground"
                )
            }
        >
            {icon}
            {label}
        </NavLink>
    );
}

export default function Layout() {
    const { user, signOut } = useAuth();
    const { me } = useMe();
    const { organizationId, membership, permissions } = useOrg();
    const navigate = useNavigate();

    const allow = (action: FixedAction): boolean => permissions?.[action] ?? false;

    return (
        <div className="flex h-screen flex-col">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <ShieldCheck className="size-4 text-primary" />
                    ModelForge Admin
                </div>
                <div className="flex items-center gap-3">
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            render={
                                <Button variant="outline" size="sm" className="gap-2">
                                    <Building2 className="size-4" />
                                    {membership.organization.name}
                                </Button>
                            }
                        />
                        <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                                <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {me?.memberships.map((m) => (
                                    <DropdownMenuItem key={m.organization.id} onClick={() => navigate(`/organizations/${m.organization.id}/users`)}>
                                        {m.organization.name}
                                        {m.organization.id === organizationId && <span className="ml-auto text-xs text-muted-foreground">current</span>}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => navigate("/")}>All organizations…</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            render={
                                <Button variant="ghost" size="sm" className="gap-2">
                                    <UserRoundCog className="size-4" />
                                    {user?.profile.email ?? user?.profile.name ?? me?.subject}
                                </Button>
                            }
                        />
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => void signOut()}>
                                <LogOut className="size-4" />
                                Sign out
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </header>
            <div className="flex flex-1 overflow-hidden">
                <aside className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-muted/40 p-3">
                    <NavItem to={`/organizations/${organizationId}/users`} icon={<Users2 className="size-4" />} label="Users" />
                    {allow("iam:listUsers") && (
                        <NavItem to={`/organizations/${organizationId}/invitations`} icon={<Mail className="size-4" />} label="Invitations" />
                    )}
                    {allow("iam:listGroups") && (
                        <NavItem to={`/organizations/${organizationId}/groups`} icon={<Users2 className="size-4" />} label="Groups" />
                    )}
                    {allow("iam:listPolicies") && (
                        <NavItem to={`/organizations/${organizationId}/policies`} icon={<KeyRound className="size-4" />} label="Policies" />
                    )}
                    {allow("iam:listUsers") && (
                        <NavItem
                            to={`/organizations/${organizationId}/service-principals`}
                            icon={<ShieldCheck className="size-4" />}
                            label="Service principals"
                        />
                    )}
                    {allow("audit:read") && (
                        <NavItem to={`/organizations/${organizationId}/audit`} icon={<ScrollText className="size-4" />} label="Audit log" />
                    )}
                    {(allow("breakGlass:invoke") || allow("breakGlass:list")) && (
                        <NavItem to={`/organizations/${organizationId}/break-glass`} icon={<ShieldAlert className="size-4" />} label="Break Glass" />
                    )}
                    {allow("accessReview:list") && (
                        <NavItem
                            to={`/organizations/${organizationId}/access-reviews`}
                            icon={<ClipboardList className="size-4" />}
                            label="Access Reviews"
                        />
                    )}
                    {(allow("tenantBackup:export") || allow("tenantBackup:proposeRestore") || allow("tenantBackup:approveRestore")) && (
                        <NavItem to={`/organizations/${organizationId}/backup`} icon={<DatabaseBackup className="size-4" />} label="Backup" />
                    )}
                    {(allow("aiGateway:viewAuditTrail") || allow("aiGateway:manageProviders")) && (
                        <NavItem to={`/organizations/${organizationId}/inference`} icon={<Cpu className="size-4" />} label="Inference" />
                    )}
                    {(allow("mcpRegistry:list") || allow("mcpRegistry:manage")) && (
                        <NavItem to={`/organizations/${organizationId}/mcp-registry`} icon={<Plug className="size-4" />} label="MCP registry" />
                    )}
                    {allow("compute:list") && (
                        <NavItem to={`/organizations/${organizationId}/compute`} icon={<Gauge className="size-4" />} label="Compute fleet" />
                    )}
                    {allow("compute:list") && (
                        <NavItem to={`/organizations/${organizationId}/compute-policies`} icon={<ShieldCheck className="size-4" />} label="Compute policies" />
                    )}
                </aside>
                <main className="flex-1 overflow-y-auto">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
