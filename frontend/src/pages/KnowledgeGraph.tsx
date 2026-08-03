import { useEffect, useMemo, useState } from "react";
import { Share2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, InlineNotice } from "@/components/ds";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import type { PatientCase } from "@/types/electron";

interface ConceptNode {
    id: string;
    label: string;
    kind: "condition" | "allergy" | "medication";
    sourceField: string;
}

function sanitizeMermaidId(prefix: string, value: string): string {
    return `${prefix}_${value.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}`;
}

/**
 * Deterministic, per-case concept graph: nodes come directly from the
 * structured fields the clinician entered (conditions/allergies/medications),
 * not from any NLP extraction over free text. This is intentionally a
 * literal reflection of case data with provenance, not a medical-ontology
 * knowledge graph — see the in-page notice.
 */
function buildGraph(patientCase: PatientCase): { nodes: ConceptNode[]; mermaid: string } {
    const nodes: ConceptNode[] = [
        ...patientCase.conditions.value.map((label) => ({ id: sanitizeMermaidId("cond", label), label, kind: "condition" as const, sourceField: "Known conditions" })),
        ...patientCase.allergies.value.map((label) => ({ id: sanitizeMermaidId("alg", label), label, kind: "allergy" as const, sourceField: "Allergies" })),
        ...patientCase.medications.value.map((label) => ({ id: sanitizeMermaidId("med", label), label, kind: "medication" as const, sourceField: "Current medications" })),
    ];

    const caseNodeId = "case_root";
    const lines = ["graph TD", `${caseNodeId}["${patientCase.title.replace(/"/g, "'")}"]`];
    for (const node of nodes) {
        lines.push(`${node.id}("${node.label.replace(/"/g, "'")}")`);
        lines.push(`${caseNodeId} --> ${node.id}`);
    }
    lines.push(`classDef condition fill:#fde68a,stroke:#b45309;`);
    lines.push(`classDef allergy fill:#fecaca,stroke:#b91c1c;`);
    lines.push(`classDef medication fill:#bfdbfe,stroke:#1d4ed8;`);
    const byKind = { condition: nodes.filter((n) => n.kind === "condition"), allergy: nodes.filter((n) => n.kind === "allergy"), medication: nodes.filter((n) => n.kind === "medication") };
    for (const kind of ["condition", "allergy", "medication"] as const) {
        if (byKind[kind].length > 0) lines.push(`class ${byKind[kind].map((n) => n.id).join(",")} ${kind};`);
    }

    return { nodes, mermaid: lines.join("\n") };
}

export default function KnowledgeGraph() {
    const hasApi = typeof window !== "undefined" && !!window.api;
    const [cases, setCases] = useState<PatientCase[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    useEffect(() => {
        if (!hasApi) return;
        window.api.patientCases.list().then((list) => {
            setCases(list);
            if (list.length > 0) setSelectedId((prev) => prev ?? list[0].id);
        });
    }, [hasApi]);

    const selectedCase = cases.find((c) => c.id === selectedId) ?? null;
    const graph = useMemo(() => (selectedCase ? buildGraph(selectedCase) : null), [selectedCase]);

    if (!hasApi) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                Knowledge Graph is only available when running inside the Electron app.
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <Share2 className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Knowledge Graph</span>
            </div>

            <ScrollArea className="flex-1">
                <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
                    <InlineNotice variant="info" title="What this graph is — and isn't">
                        Nodes are built directly from the structured fields you entered on a patient case
                        (conditions, allergies, medications) — every node's provenance is the exact case field it
                        came from, listed below. This is <strong>not</strong> a medical ontology or a clinical
                        knowledge base (no UMLS/SNOMED/RxNorm linkage) — it does not infer relationships between
                        concepts, only shows what's directly on the case.
                    </InlineNotice>

                    <InlineNotice variant="default" title="For a richer graph, connect Graphify as an MCP server">
                        This view only visualizes fields already on a case. For deeper investigation — building a
                        real knowledge graph from a folder of documents, papers, or imaging reports and letting
                        Clinical Assistant query/path/explain it directly — add Graphify under Settings → MCP
                        Servers (it ships a <code>--mcp</code> stdio mode). Once connected, its query/path/explain
                        tools appear in Clinical Assistant like any other tool, gated by the same approval flow.
                    </InlineNotice>

                    {cases.length === 0 ? (
                        <EmptyState icon={<Share2 className="size-5" />} title="No cases to visualize yet" description="Create a patient case with some structured fields first." />
                    ) : (
                        <>
                            <Select value={selectedId ?? undefined} onValueChange={setSelectedId}>
                                <SelectTrigger className="w-full">
                                    <SelectValue placeholder="Select a case" />
                                </SelectTrigger>
                                <SelectContent>
                                    {cases.map((c) => (
                                        <SelectItem key={c.id} value={c.id}>
                                            {c.title}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            {graph && graph.nodes.length === 0 && (
                                <EmptyState title="No conditions, allergies, or medications recorded yet" description="Add some on the case's detail page to see them here." />
                            )}

                            {graph && graph.nodes.length > 0 && (
                                <>
                                    <div className="rounded-xl border border-border/70 bg-card p-3">
                                        <MermaidDiagram code={graph.mermaid} />
                                    </div>
                                    <div className="rounded-xl border border-border/70 bg-card p-3.5">
                                        <p className="mb-2 text-xs font-semibold">Provenance</p>
                                        <table className="w-full text-xs">
                                            <tbody>
                                                {graph.nodes.map((n) => (
                                                    <tr key={n.id} className="border-t border-border/50">
                                                        <td className="py-1 pr-2 font-medium">{n.label}</td>
                                                        <td className="py-1 pr-2 capitalize text-muted-foreground">{n.kind}</td>
                                                        <td className="py-1 text-muted-foreground">from “{n.sourceField}”</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
