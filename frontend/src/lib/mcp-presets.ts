export interface McpServerPreset {
    name: string;
    /**
     * A stdio command line, same free-text format as the manual "Add MCP
     * server" field — split on whitespace into command + args when saved.
     * Presets containing `<...>` placeholders are intentionally left for the
     * user to fill in (e.g. a folder path) rather than guessed at, since a
     * wrong guess would silently point the server at the wrong data.
     */
    commandTemplate: string;
    /** What this preset needs installed locally before it will actually connect — shown so "quick add" doesn't imply "already working". */
    setupHint: string;
    docsUrl: string;
    /** Tool names filtered out of both the tool list and callMcpTool itself
     * (mcp-client.ts's blockedTools) — enforced in code, not just noted here. */
    blockedTools?: string[];
    /** Carried onto the resulting McpServerConfig and shown everywhere this
     * server's tools appear — for integrations the upstream project itself
     * warns aren't ready for real clinical use. */
    warningBanner?: string;
}

// Every preset here has been verified against its own documentation to have
// a real, working stdio MCP invocation — this list intentionally does not
// include servers whose setup couldn't be confirmed to work as a simple
// "add a command line" preset (e.g. ones requiring a Docker build and cloud
// API keys just to start). Those are worth using but belong in manual setup,
// documented in the README, not offered as a one-click button that would
// fail the moment someone clicks it.
export const MCP_SERVER_PRESETS: McpServerPreset[] = [
    {
        name: "Graphify (this project's knowledge graph)",
        commandTemplate: "graphify <path-to-folder> --mcp",
        setupHint: "Requires the graphify CLI installed (pip install graphifyy, or see CLAUDE.md). Replace <path-to-folder> with the folder to expose — e.g. a case's attachments folder.",
        docsUrl: "https://github.com/graphify-ai/graphify",
    },
    {
        name: "BioMCP (PubMed, ClinicalTrials.gov, MyVariant.info)",
        commandTemplate: "biomcp serve",
        setupHint: "Requires the biomcp CLI installed (uv tool install biomcp-cli, or pip install biomcp-cli). No API key needed — these are public databases.",
        docsUrl: "https://github.com/genomoncology/biomcp",
    },
    {
        name: "DICOM MCP — imaging metadata (prototype, not for clinical use)",
        commandTemplate: "uvx dicom-mcp <path-to-config.yaml>",
        setupHint:
            "Requires uv (uv tool install dicom-mcp) and a config.yaml describing your DICOM node(s) — see the project's README for the config format. Replace <path-to-config.yaml> with its path.",
        docsUrl: "https://github.com/ChristianHinge/dicom-mcp",
        // The upstream server's own tool catalog includes move_series/move_study
        // (DICOM C-MOVE — transfers studies between nodes); ModelForge Medical
        // never exposes these regardless of what a given connection offers.
        blockedTools: ["move_series", "move_study"],
        warningBanner:
            "DICOM-MCP is not meant for clinical use, and should not be connected with live hospital databases or databases with patient-sensitive data. Doing so could lead to both loss of patient data, and leakage of patient data onto the internet. — the DICOM MCP project's own README. Treat this integration as a prototype only.",
    },
];
