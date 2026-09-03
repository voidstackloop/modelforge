import { z } from "zod";
export {
    attachmentRefSchema,
    caseConsentSchema,
    clinicalNoteReviewSchema,
    clinicalNoteSchema,
    labResultSchema,
    patientCaseSchema,
    patientCasesFileSchema,
} from "@modelforge/contracts";
import {
    attachmentRefSchema,
    caseConsentSchema,
    clinicalNoteReviewSchema,
    clinicalNoteSchema,
    labResultSchema,
    patientCaseSchema,
    patientCasesFileSchema,
} from "@modelforge/contracts";

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
    oauthClientId: z.string().min(1).max(512).optional(),
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
        preferredRuntime: z.enum(["automatic", "llamacpp", "vllm", "mlx"]),
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
        auditLogSqliteDir: z.string().optional(),
        // Selects a registered MedicationSafetyProvider by name (see
        // medical-safety.ts) — a plain string, not an enum, since the set of
        // registered providers is a runtime registry, not a fixed list this
        // schema could enumerate ahead of time.
        medicationSafetyProviderId: z.string().optional(),
        // Selects a registered PatientCasesBackend by name (see
        // patient-cases-store.ts) — a plain string, not an enum, since the
        // set of registered backends is a runtime registry, not a fixed
        // list this schema could enumerate ahead of time.
        patientCasesBackendId: z.string().optional(),
        // Selects a registered SessionsBackend by name (see
        // sessions-store.ts) — same runtime-registry reasoning as
        // patientCasesBackendId above.
        sessionsBackendId: z.string().optional(),
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
        // Item 4/7: the resource-orchestrator's own OS-reserve budget mode —
        // distinct from llamaCppVramReserveGB/llamaCppRamReserveGB above,
        // which only configure node-llama-cpp's internal context-sizing
        // math for that one backend. This governs the cross-workload
        // admission ceiling every workload kind shares (see
        // resource-budget.ts). "manual" is the only mode where the Max*
        // fields below are consulted at all.
        resourceBudgetMode: z.enum(["balanced", "performance", "efficient", "manual"]),
        resourceMaxRamMB: z.number(),
        resourceMaxVramMB: z.number(),
        resourceCpuThreadCeiling: z.number(),
        resourceRuntimeProfile: z.enum(["interactive", "balanced", "throughput", "energy-efficient"]),
        // Opt-in: makes this install act as a compute-control-plane fleet
        // agent (see compute-agent.ts, docs/COMPUTE_CONTROL_PLANE.md) on top
        // of an already-connected shared backend. Off by default — standalone
        // operation never depends on this.
        computeAgentEnabled: z.boolean().optional(),
        // The node id an organization compute admin assigned to this
        // install via POST /compute/nodes (compute-node-identity.ts's
        // fingerprint is what they registered it under) — a plain string,
        // not auto-discovered, since node registration is an admin action
        // this app never performs on its own behalf.
        computeNodeId: z.string().optional(),
    })
    .partial()
    .passthrough();

// --- Central policy (policy-store.ts) ---------------------------------------
//
// A deliberately small, closed subset of AppSettings — not appSettingsSchema
// itself — so a policy document can only ever govern the specific
// institution-relevant fields listed here, never arbitrary settings (e.g. a
// signed policy can lock down auditLogRetentionDays; it can't set someone's
// theme). Keep this in sync with policy-store.ts's MANAGED_SETTING_KEYS,
// which is the runtime source of truth this schema mirrors — see that file's
// comment for why the two must match exactly.
export const managedSettingsSchema = z
    .object({
        networkToolsEnabled: z.boolean(),
        verificationEnabled: z.boolean(),
        verificationMaxRetries: z.number(),
        agentMaxSteps: z.number(),
        caseAutoLockMinutes: z.number(),
        redactBeforeRemoteSend: z.boolean(),
        auditLogRetentionDays: z.number(),
        auditLogBackend: z.enum(["json", "sqlite"]),
        medicationSafetyProviderId: z.string(),
        patientCasesBackendId: z.string(),
        sessionsBackendId: z.string(),
        llamaCppGpuBackend: z.enum(["auto", "vulkan", "cuda", "metal", "cpu"]),
        llamaCppMaxCachedModels: z.number(),
        llamaCppMaxThreads: z.number(),
        llamaCppVramReserveGB: z.number(),
        llamaCppRamReserveGB: z.number(),
        llamaCppBatchSize: z.number(),
        llamaCppFlashAttention: z.enum(["auto", "on", "off"]),
        resourceBudgetMode: z.enum(["balanced", "performance", "efficient", "manual"]),
        resourceMaxRamMB: z.number(),
        resourceMaxVramMB: z.number(),
        resourceCpuThreadCeiling: z.number(),
        resourceRuntimeProfile: z.enum(["interactive", "balanced", "throughput", "energy-efficient"]),
    })
    .partial()
    .strict(); // .strict(), unlike appSettingsSchema's .passthrough(): an
    // unrecognized key in a *signed* policy document should fail verification
    // loudly rather than being silently ignored — a typo'd field name in an
    // institution's policy tooling should surface as an error, not silently
    // govern nothing.

export const policyPayloadSchema = z.object({
    version: z.literal(1),
    issuer: z.string().min(1),
    issuedAt: z.string(),
    expiresAt: z.string(),
    settings: managedSettingsSchema,
});

export const signedPolicySchema = z.object({
    payload: z.string(), // policyPayloadSchema, serialized — see policy-store.ts's canonicalPayloadString()
    signatureHex: z.string(),
    algorithm: z.literal("ed25519"),
});

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

// Clinical schemas are re-exported from @modelforge/contracts above. The
// app, server, and renderer now compile against one strict runtime contract.

// --- Shared backend connection config (sharedBackend:setConfig) ------------
//
// Mirrors app/src/shared-backend-config-store.ts's SharedBackendConfig
// interface exactly — see that file for what each field means and why this
// lives in its own store rather than AppSettings or secrets.json.
export const sharedBackendConfigSchema = z.object({
    baseUrl: z.string().min(1),
    issuer: z.string().min(1),
    clientId: z.string().min(1),
    audience: z.string().optional(),
    organizationId: z.string().optional(),
});

// --- Medication conflict check (patientCases:checkConflicts) ---------------

export const medicationConflictCheckInputSchema = z.object({
    allergies: z.array(z.string()),
    medications: z.array(z.string()),
});

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
        "backup-created",
        "backup-restored",
    ]),
    targetType: z.enum(["patient-case", "session", "export", "settings", "backup", "model"]).optional(),
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
