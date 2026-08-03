import { z } from "zod";

// Runtime validation for the two places TypeScript's types disappear at
// runtime: IPC arguments coming from the renderer (main.ts) and JSON files
// loaded from disk (json-store.ts). Schemas here intentionally mirror the
// TypeScript interfaces they guard (McpServerConfig in mcp-client.ts,
// AppSettings in settings-store.ts) rather than the other way around — keep
// them in sync when those interfaces change.

export function formatZodError(error: z.ZodError): string {
    return error.issues
        .map((issue) => `${issue.path.length ? issue.path.join(".") : "value"}: ${issue.message}`)
        .join("; ");
}

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new Error(`Invalid ${label}: ${formatZodError(result.error)}`);
    }
    return result.data;
}

// --- MCP server config (settings.mcpServers, mcp:connect) ------------------

export const mcpServerConfigSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    transport: z.enum(["stdio", "http"]),
    enabled: z.boolean(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    trustProfile: z.object({ autoApprovedTools: z.array(z.string()) }).optional(),
    auth: z.object({ type: z.enum(["none", "oauth2"]) }).optional(),
    blockedTools: z.array(z.string()).optional(),
    warningBanner: z.string().optional(),
});

// --- secrets.json ------------------------------------------------------

export const secretsFileSchema = z.record(z.string(), z.string());

export const secretsSetInputSchema = z.object({
    key: z.string().min(1),
    value: z.string().optional(),
});

// --- settings.json / settings:save -----------------------------------------

const promptVersionSchema = z.object({
    prompt: z.string(),
    savedAt: z.string(),
});

const promptPresetSchema = z.object({
    id: z.string(),
    name: z.string(),
    prompt: z.string(),
    versions: z.array(promptVersionSchema).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
});

const customProviderConfigSchema = z.object({
    id: z.string(),
    name: z.string(),
    baseUrl: z.string(),
    modelIds: z.array(z.string()),
    localGpuBackend: z.boolean().optional(),
});

const timeOfUseTariffSchema = z.object({
    name: z.string(),
    startHour: z.number(),
    endHour: z.number(),
    pricePerKwh: z.number(),
});

// --- GPU selection / per-runtime config (settings.json, runtime startup) --

export const gpuSelectionSchema = z.object({
    mode: z.enum(["auto", "single", "group", "all", "cpu"]),
    // Stable GpuInfo.id values — validated as non-empty strings only; actual
    // device existence is checked against live hardware at startup
    // (resolveGpuSelection in gpu-selection.ts), not here.
    deviceIds: z.array(z.string().min(1)).max(64),
});

export const runtimeGpuConfigSchema = z.object({
    selection: gpuSelectionSchema.optional(),
    tensorSplit: z.array(z.number().finite().positive()).max(16).optional(),
    splitMode: z.enum(["layer", "tensor", "row"]).transform((value) => value === "row" ? "tensor" as const : value).optional(),
    mainGpuId: z.string().optional(),
    tensorParallelSize: z.number().int().min(1).max(16).optional(),
    memoryReserveGB: z.number().min(0).max(64).optional(),
});

// .partial() — every field optional, matching AppSettings being persisted/
// patched as `Partial<AppSettings>` (settings:save sends a partial patch;
// settings.json itself only ever contains whatever's been saved so far).
// .passthrough() rather than .strict() so a settings.json (or a save call)
// carrying a field from a newer/older build version doesn't get treated as
// malformed just because this build doesn't know about it — only fields this
// schema does recognize are type-checked.
export const appSettingsSchema = z
    .object({
        defaultModel: z.string().nullable(),
        ollamaHost: z.string(),
        modelsDir: z.string(),
        temperature: z.number(),
        topP: z.number(),
        maxTokens: z.number(),
        frequencyPenalty: z.number(),
        presencePenalty: z.number(),
        contextLength: z.number(),
        gpuLayers: z.number(),
        gpuLayerMode: z.enum(["auto", "cpu", "max", "manual"]),
        seed: z.number(),
        topK: z.number(),
        repeatPenalty: z.number(),
        stop: z.array(z.string()),
        systemPrompt: z.string(),
        promptPresets: z.array(promptPresetSchema),
        theme: z.enum(["light", "dark", "system"]),
        language: z.enum(["en", "tr"]),
        uiDensity: z.enum(["comfortable", "compact"]),
        reduceMotion: z.boolean(),
        agentMaxSteps: z.number(),
        llamaCppMaxCachedModels: z.number(),
        llamaCppMaxThreads: z.number(),
        llamaCppVramReserveGB: z.number(),
        llamaCppRamReserveGB: z.number(),
        llamaCppNumaPolicy: z.enum(["auto", "distribute", "isolate", "numactl", "mirror"]),
        llamaCppBatchSize: z.number(),
        llamaCppFlashAttention: z.enum(["auto", "on", "off"]),
        ttsVoiceURI: z.string(),
        ttsAutoRead: z.boolean(),
        mcpServers: z.array(mcpServerConfigSchema),
        llamaCppModelsDir: z.string(),
        llamaCppGpuBackend: z.enum(["auto", "vulkan", "cuda", "metal", "cpu"]),
        ragEmbeddingModel: z.string(),
        preferredRuntime: z.enum(["automatic", "ollama", "llamacpp", "vllm", "mlx"]),
        recommendationGoal: z.enum(["quality", "speed", "memory", "energy", "agent", "balanced"]),
        customProviders: z.array(customProviderConfigSchema),
        onboardingComplete: z.boolean(),
        keybindings: z.record(z.string(), z.string()),
        mlxModels: z.array(z.string()),
        mlxPythonPath: z.string(),
        rocmServerPath: z.string(),
        vllmModels: z.array(z.string()),
        vllmCommand: z.string(),
        networkToolsEnabled: z.boolean(),
        sandboxMaxMemoryMB: z.number(),
        sandboxMaxCpuPercent: z.number(),
        verificationEnabled: z.boolean(),
        verificationCommands: z.array(z.string()),
        verificationMaxRetries: z.number(),
        // Minutes of inactivity before patient-case encryption auto-locks
        // (see case-encryption.ts) — 0 or unset disables auto-lock. Only
        // meaningful when case encryption is actually enabled; harmless
        // otherwise since there's nothing to lock.
        caseAutoLockMinutes: z.number().optional(),
        // Best-effort pattern-based scrubbing (see medical-safety.ts's
        // redactIdentifiers — email/phone/SSN/MRN/DOB patterns only, not
        // clinical-grade de-identification) applied to outgoing content
        // before a remote (non-local) model send. Opt-in, not a default: it
        // can alter clinically meaningful text, so the user decides.
        redactBeforeRemoteSend: z.boolean().optional(),
        // Days to retain audit-log-store.ts events; 0 or unset means "no
        // age-based purge" (still bounded by the fixed MAX_EVENTS cap there).
        auditLogRetentionDays: z.number().optional(),
        // Opt-in, experimental: route audit-log-store.ts through the Rust
        // SQLite scaffold (lib/src/store/audit.rs) instead of the JSON file.
        // Unset/"json" (the default) is completely unaffected by this
        // setting existing — see docs/RUST_MIGRATION_ASSESSMENT.md.
        auditLogBackend: z.enum(["json", "sqlite"]).optional(),
        energyMonitoringEnabled: z.boolean(),
        electricityPricePerKwh: z.number(),
        energyCurrency: z.string(),
        timeOfUseTariffs: z.array(timeOfUseTariffSchema),
        manualCpuWatts: z.number(),
        manualGpuWatts: z.number(),
        manualSystemIdleWatts: z.number(),
        includeIdleSystemConsumption: z.boolean(),
        energyUsageRetentionDays: z.number(),
        energySampleIntervalSeconds: z.number(),
        downloadGlobalConcurrency: z.number(),
        downloadBandwidthMbps: z.number(),
        gridIntensityGCo2PerKwh: z.number(),
        defaultGpuSelectionMode: z.enum(["auto", "single", "group", "all", "cpu"]),
        // Keyed by runtime backend id (validated as a non-empty string here
        // rather than a closed enum — z.record with an enum key schema
        // requires every enum member present, which would break a config
        // that only has some backends set).
        runtimeGpuConfigs: z.record(z.string().min(1), runtimeGpuConfigSchema),
    })
    .partial()
    .passthrough();

// --- tools:execute -----------------------------------------------------

// One schema per built-in agent tool, mirroring the `parameters` declared for
// each entry in AGENT_TOOLS (agent-tools.ts) and the shape executeTool()'s
// switch statement actually reads. Keeping this a plain record (rather than
// baking validation into AGENT_TOOLS itself) means a JSON-Schema tool
// declaration — sent to model providers — doesn't need to also be a valid
// Zod schema.
const stringField = z.string();
const optionalString = z.string().optional();

export const agentToolArgsSchemas: Record<string, z.ZodType> = {
    read_file: z.object({
        path: stringField,
        start_line: z.number().optional(),
        end_line: z.number().optional(),
    }),
    write_file: z.object({ path: stringField, content: stringField }),
    replace_in_file: z.object({
        path: stringField,
        old_text: stringField,
        new_text: stringField,
        replace_all: z.boolean().optional(),
    }),
    find_files: z.object({ pattern: stringField, path: optionalString }),
    file_info: z.object({ path: stringField }),
    make_directory: z.object({ path: stringField }),
    move_path: z.object({ source: stringField, destination: stringField }),
    delete_path: z.object({ path: stringField, recursive: z.boolean().optional() }),
    list_dir: z.object({ path: optionalString }),
    search_files: z.object({ query: stringField, path: optionalString }),
    run_command: z.object({ command: stringField, cwd: optionalString, network: z.boolean().optional() }),
    run_code: z.object({
        language: z.enum(["python", "javascript"]),
        code: stringField,
        cwd: optionalString,
        network: z.boolean().optional(),
    }),
    start_background_command: z.object({
        command: stringField,
        cwd: optionalString,
        name: optionalString,
        network: z.boolean().optional(),
    }),
    get_background_output: z.object({ task_id: stringField }),
    stop_background_command: z.object({ task_id: stringField }),
    list_background_commands: z.object({}),
    create_terminal: z.object({ name: optionalString, cwd: optionalString }),
    write_to_terminal: z.object({ terminal_id: stringField, input: stringField }),
    read_terminal_output: z.object({ terminal_id: stringField, tail_chars: z.number().optional() }),
    close_terminal: z.object({ terminal_id: stringField }),
    git_status: z.object({}),
    git_diff: z.object({ staged: z.boolean().optional(), path: optionalString }),
    git_log: z.object({ count: z.number().optional() }),
    git_commit: z.object({ message: stringField }),
    git_blame: z.object({ path: stringField, start_line: z.number().optional(), end_line: z.number().optional() }),
    web_search: z.object({ query: stringField }),
    github_list_repositories: z.object({
        visibility: z.enum(["all", "public", "private"]).optional(),
        limit: z.number().optional(),
    }),
    github_repository_tree: z.object({ repository: stringField, ref: optionalString }),
    github_read_file: z.object({ repository: stringField, path: stringField, ref: optionalString }),
    fetch_url: z.object({ url: stringField }),
    http_request: z.object({
        url: stringField,
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: optionalString,
    }),
    capture_page_screenshot: z.object({
        url: stringField,
        width: z.number().optional(),
        height: z.number().optional(),
    }),
    find_symbol_references: z.object({ symbol: stringField, path: optionalString }),
    apply_patch: z.object({ patch: stringField }),
    read_notes: z.object({}),
    write_notes: z.object({ content: stringField }),
};

// Args for an MCP-provided tool (mcp__<server>__<tool>) are defined by that
// server's own inputSchema, which this app never sees ahead of time in a form
// Zod can check — so all that's enforced here is "a plain object", the one
// shape assumption callMcpTool relies on (it forwards `args` verbatim as the
// JSON-RPC `arguments` field). Real validation against the tool's actual
// declared schema happens downstream in mcp-schema-validation.ts, which
// compiles each tool's inputSchema with AJV (full JSON Schema support —
// $ref/oneOf/pattern/enum/nested schemas — not just this shape check).
export const mcpToolArgsSchema = z.record(z.string(), z.unknown());

// --- Patient cases (patient-cases.json) -------------------------------------
//
// Every top-level clinical field carries `includeInContext: boolean` so the
// user controls exactly which fields are eligible to be sent to a model —
// see patient-cases-store.ts and the "context selection" UI. Nothing here is
// sent to a model implicitly; the include flags are read by the caller that
// assembles a prompt, not enforced by this schema itself.

const caseFieldSchema = <T extends z.ZodType>(valueSchema: T) =>
    z.object({ value: valueSchema, includeInContext: z.boolean() });

export const labResultSchema = z.object({
    id: z.string(),
    name: z.string(),
    value: z.string(),
    unit: z.string().optional(),
    referenceRange: z.string().optional(),
    observedAt: z.string().optional(),
});

// Sign-off on a model-inference note — records that a clinician reviewed the
// model's output before it's treated as part of the clinical record, rather
// than assuming presence-in-case implies review. Meaningless for
// author: "clinician" notes (never set on those) since a clinician's own
// text needs no separate reviewer.
export const clinicalNoteReviewSchema = z.object({
    reviewedBy: z.string(),
    reviewedAt: z.string(),
    outcome: z.enum(["accepted", "accepted-with-edits", "rejected"]),
    comment: z.string().optional(),
});

export const clinicalNoteSchema = z.object({
    id: z.string(),
    // Distinguishes clinician-authored free text from model output that was
    // saved into the case — the right panel and export views must never
    // blur this distinction.
    author: z.enum(["clinician", "model-inference"]),
    text: z.string(),
    createdAt: z.string(),
    review: clinicalNoteReviewSchema.optional(),
});

export const attachmentRefSchema = z.object({
    id: z.string(),
    name: z.string(),
    mimeType: z.string().optional(),
    addedAt: z.string(),
});

// Structured consent record — separate from the free-text `consentNote`
// (kept below, unchanged, for backward compatibility with existing stored
// cases) so consent has a queryable scope and a real grant/revoke lifecycle
// instead of being buried in prose. This is a *recording* mechanism, not an
// enforcement one: nothing in this app currently blocks an action based on
// consent state (see docs/ENTERPRISE_READINESS_ASSESSMENT.md's Consent
// entity, proposed as part of the target institutional data model) — that
// gating is future scope once there's an identity system to attribute
// actions to.
export const caseConsentSchema = z.object({
    id: z.string(),
    scope: z.enum(["ai-assistance", "remote-model-use", "research"]),
    grantedAt: z.string(),
    revokedAt: z.string().optional(),
    // How consent was obtained — free text (e.g. "verbal", "written form
    // signed 2026-01-05") since this app has no structured consent-capture
    // workflow of its own.
    method: z.string(),
});

export const patientCaseSchema = z.object({
    id: z.string(),
    title: z.string(),
    demographics: caseFieldSchema(z.object({ age: z.string().optional(), sex: z.string().optional(), notes: z.string().optional() })),
    presentingComplaint: caseFieldSchema(z.string()),
    symptomsTimeline: caseFieldSchema(z.string()),
    vitalSigns: caseFieldSchema(z.string()),
    conditions: caseFieldSchema(z.array(z.string())),
    allergies: caseFieldSchema(z.array(z.string())),
    medications: caseFieldSchema(z.array(z.string())),
    labResults: caseFieldSchema(z.array(labResultSchema)),
    imagingAndReports: caseFieldSchema(z.string()),
    clinicalNotes: z.array(clinicalNoteSchema),
    attachments: z.array(attachmentRefSchema),
    // Provenance/consent metadata — who entered this case and under what
    // consent basis, kept as plain text since this app has no clinician
    // identity/auth system to attach a verified actor to.
    consentNote: z.string().optional(),
    // Optional so a case created before this field existed still validates.
    consentRecords: z.array(caseConsentSchema).optional(),
    enteredBy: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

export const patientCasesFileSchema = z.array(patientCaseSchema);

// --- Audit log (audit-log.json) ---------------------------------------------
//
// Deliberately excludes clinical content — only who/what-category/when, so
// the audit trail itself never becomes a second place PHI can leak from.

export const auditEventSchema = z.object({
    id: z.string(),
    timestamp: z.string(),
    actionCategory: z.enum([
        "case-created",
        "case-updated",
        "case-deleted",
        "case-viewed",
        "model-call-local",
        "model-call-remote",
        "mcp-tool-call",
        "export",
        "data-deleted",
        "settings-changed",
    ]),
    targetType: z.enum(["patient-case", "session", "export", "settings"]).optional(),
    targetId: z.string().optional(),
    detail: z.string().optional(),
    // mcp-tool-call fields — deliberately structured (server id/name, tool
    // name, approval outcome, duration) rather than packed into `detail`,
    // and deliberately never includes the call's actual arguments/result:
    // those can carry PHI, and the audit trail's whole purpose here is
    // accountability (who called what, when, was it approved) without
    // becoming a second place clinical content could leak from.
    mcpServerId: z.string().optional(),
    mcpServerName: z.string().optional(),
    mcpToolName: z.string().optional(),
    approvalOutcome: z.enum(["approved", "auto-approved", "denied"]).optional(),
    durationMs: z.number().optional(),
    // Hash-chain fields (tamper-evidence) — optional so an audit-log.json
    // written before this field existed doesn't fail schema validation and
    // get backed-up-and-reset by readJsonWithSchema (see json-store.ts). An
    // event with no eventHash is treated as pre-chain/legacy and excluded
    // from verification rather than rejected — see audit-log-store.ts's
    // verifyChainIntegrity().
    previousEventHash: z.string().nullable().optional(),
    eventHash: z.string().optional(),
});

export const auditLogFileSchema = z.array(auditEventSchema);

// --- Evidence library (evidence-sources.json) -------------------------------

export const evidenceSourceSchema = z.object({
    id: z.string(),
    url: z.string(),
    title: z.string(),
    organization: z.string().optional(),
    publishedOrUpdated: z.string().optional(),
    retrievedAt: z.string(),
    sourceType: z.enum(["peer-reviewed", "guideline", "reference-database", "local-document", "other"]),
    excerpt: z.string().optional(),
    addedAt: z.string(),
});

export const evidenceSourcesFileSchema = z.array(evidenceSourceSchema);

// --- Approved-model registry (model-registry.json) --------------------------

export const approvedModelSchema = z.object({
    id: z.string(),
    provider: z.string(),
    modelId: z.string(),
    approvedUseCases: z.array(z.string()),
    approvedBy: z.string().optional(),
    approvedAt: z.string(),
    retiredAt: z.string().optional(),
});

export const modelRegistryFileSchema = z.array(approvedModelSchema);
