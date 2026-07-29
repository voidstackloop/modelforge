import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Leaf, Zap } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MetricCard, EmptyState } from "@/components/ds";
import { useI18n } from "@/lib/i18n";
import { PROVIDER_LABELS } from "@/lib/providers";
import { formatCost } from "@/lib/pricing";
import { summarizeSession, aggregateBy, formatEnergy } from "@/lib/usage";
import type { ChatSession, EnergyDashboard, EnergyTotals, ProviderId } from "@/types/electron";

function energyCost(value: number, currency: string): string {
    try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 4 }).format(value);
    } catch {
        return `${value.toFixed(4)} ${currency}`;
    }
}

function EnergyCard({ label, totals, currency }: { label: string; totals: EnergyTotals; currency: string }) {
    return (
        <MetricCard
            label={label}
            value={energyCost(totals.cost, currency)}
            hint={`${formatEnergy(totals.energyKwh)} · ${totals.requestCount} requests`}
        />
    );
}

export default function UsageDashboard() {
    const { t } = useI18n();
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [energy, setEnergy] = useState<EnergyDashboard | null>(null);

    useEffect(() => {
        if (!hasApi) return;
        window.api.sessions.list().then(setSessions);
        const refreshEnergy = () => window.api.energy.getDashboard().then(setEnergy);
        refreshEnergy();
        const timer = window.setInterval(refreshEnergy, 2000);
        return () => window.clearInterval(timer);
    }, [hasApi]);

    const usages = useMemo(
        () => sessions.map(summarizeSession).filter((u) => u.promptTokens > 0 || u.completionTokens > 0),
        [sessions]
    );

    const totalCost = usages.reduce((sum, u) => sum + (u.cost ?? 0), 0);
    const totalTokens = usages.reduce((sum, u) => sum + u.promptTokens + u.completionTokens, 0);
    const byProvider = useMemo(() => aggregateBy(usages, (u) => u.provider ?? "unknown"), [usages]);
    const byModel = useMemo(() => aggregateBy(usages, (u) => u.modelId ?? "unknown"), [usages]);

    const byDay = useMemo(() => {
        const costByDay = new Map<string, number>();
        for (const u of usages) {
            const day = u.session.createdAt.slice(0, 10);
            costByDay.set(day, (costByDay.get(day) ?? 0) + (u.cost ?? 0));
        }
        const days: { day: string; cost: number }[] = [];
        const today = new Date();
        for (let i = 13; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            days.push({ day: key, cost: costByDay.get(key) ?? 0 });
        }
        return days;
    }, [usages]);

    const maxDayCost = Math.max(...byDay.map((d) => d.cost), 0.0001);

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Usage dashboard is only available when running inside the Electron app.
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <BarChart3 className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{t.usageDashboard}</span>
            </div>

            <ScrollArea className="flex-1">
                <div className="flex flex-col gap-6 p-4">
                    {energy && (
                        <>
                            <div>
                                <div className="mb-2 flex items-center gap-2">
                                    <Zap className="size-4 text-primary" />
                                    <h2 className="text-sm font-semibold">Local inference energy</h2>
                                </div>
                                {energy.current.length > 0 ? (
                                    <div className="mb-3 grid gap-2 sm:grid-cols-2">
                                        {energy.current.map((runtime) => (
                                            <div key={runtime.id} className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                                        <Activity className="size-3.5 animate-pulse text-primary" />
                                                        <span className="truncate">{runtime.modelId}</span>
                                                    </span>
                                                    <span className="text-lg font-semibold">{runtime.currentPowerWatts.toFixed(1)} W</span>
                                                </div>
                                                <p className="mt-1 text-xs text-muted-foreground">
                                                    {runtime.runtime} · {runtime.backend} · CPU {(runtime.cpuUtilization * 100).toFixed(0)}%
                                                    {runtime.gpuUtilization === null ? "" : ` · GPU ${(runtime.gpuUtilization * 100).toFixed(0)}%`}
                                                    {runtime.processId ? ` · PID ${runtime.processId}` : ""}
                                                </p>
                                                <p className="mt-1 text-xs text-muted-foreground">
                                                    Current request: {formatEnergy(runtime.energyKwh)} · {energyCost(runtime.cost, energy.currency)} · {runtime.measurement}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="mb-3 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">No local inference is active.</p>
                                )}
                                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                    <EnergyCard label="Today" totals={energy.today} currency={energy.currency} />
                                    <EnergyCard label="Last 7 days" totals={energy.week} currency={energy.currency} />
                                    <EnergyCard label="This month" totals={energy.month} currency={energy.currency} />
                                    <EnergyCard label="Lifetime retained" totals={energy.lifetime} currency={energy.currency} />
                                </div>
                            </div>

                            <div className="grid gap-4 lg:grid-cols-3">
                                <MetricCard label="Cost per million generated tokens" value={energyCost(energy.costPerMillionGeneratedTokens, energy.currency)} />
                                <MetricCard
                                    label="Measured versus estimated"
                                    value={`${energy.measuredPercent.toFixed(1)}% measured`}
                                    hint={`${(100 - energy.measuredPercent).toFixed(1)}% estimated`}
                                />
                                <MetricCard
                                    label="Carbon estimate"
                                    icon={<Leaf className="size-3.5" />}
                                    value={`${energy.lifetime.carbonGrams.toFixed(1)} gCO₂e`}
                                />
                            </div>

                            <div className="grid gap-4 lg:grid-cols-2">
                                <div>
                                    <h3 className="mb-2 text-sm font-semibold">Energy cost by model</h3>
                                    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                                        {energy.byModel.slice(0, 12).map(({ key, totals }) => (
                                            <div key={key} className="flex items-center justify-between gap-3 p-3 text-sm">
                                                <span className="min-w-0 flex-1 truncate">{key}</span>
                                                <span className="text-xs text-muted-foreground">{formatEnergy(totals.energyKwh)}</span>
                                                <span className="font-medium">{energyCost(totals.cost, energy.currency)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <h3 className="mb-2 text-sm font-semibold">Energy cost by runtime</h3>
                                    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                                        {energy.byRuntime.map(({ key, totals }) => (
                                            <div key={key} className="flex items-center justify-between gap-3 p-3 text-sm">
                                                <span className="font-medium">{key}</span>
                                                <span className="text-xs text-muted-foreground">{totals.completionTokens.toLocaleString()} generated tokens</span>
                                                <span>{energyCost(totals.cost, energy.currency)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}

                    {usages.length === 0 ? (
                        <EmptyState icon={<BarChart3 className="size-5" />} title={t.usageNoData} />
                    ) : (
                        <>
                            <div className="grid grid-cols-3 gap-3">
                                <MetricCard label={t.usageTotalCost} value={formatCost(totalCost)} />
                                <MetricCard label={t.usageTotalTokens} value={totalTokens.toLocaleString()} />
                                <MetricCard label={t.usageTotalSessions} value={usages.length} />
                            </div>

                            <div>
                                <h3 className="mb-2 text-sm font-semibold">{t.usageByDay}</h3>
                                <div className="flex h-24 items-end gap-1 rounded-lg border border-border p-3">
                                    {byDay.map((d) => (
                                        <div
                                            key={d.day}
                                            className="flex flex-1 flex-col items-center justify-end gap-1"
                                            title={`${d.day}: ${formatCost(d.cost)}`}
                                        >
                                            <div
                                                className="w-full rounded-t bg-primary/70"
                                                style={{ height: `${Math.max(2, (d.cost / maxDayCost) * 100)}%` }}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <h3 className="mb-2 text-sm font-semibold">{t.usageByProvider}</h3>
                                    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                                        {byProvider.map(([provider, stats]) => (
                                            <div key={provider} className="flex items-center justify-between gap-4 p-3 text-sm">
                                                <span>{PROVIDER_LABELS[provider as ProviderId] ?? provider}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {stats.sessions} {t.usageSessions} · {stats.tokens.toLocaleString()} tok
                                                </span>
                                                <span className="font-medium">{formatCost(stats.cost)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <h3 className="mb-2 text-sm font-semibold">{t.usageByModel}</h3>
                                    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                                        {byModel.map(([modelId, stats]) => (
                                            <div key={modelId} className="flex items-center justify-between gap-4 p-3 text-sm">
                                                <span className="truncate">{modelId}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {stats.sessions} {t.usageSessions} · {stats.tokens.toLocaleString()} tok
                                                </span>
                                                <span className="font-medium">{formatCost(stats.cost)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
