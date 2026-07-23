export type Locale = "en" | "tr";

export interface Dictionary {
    appName: string;
    newChat: string;
    newProject: string;
    searchChats: string;
    settings: string;
    noChatsYet: string;
    noMatchingChats: string;
    model: string;
    sendMessage: string;
    startConversationWith: (model: string) => string;
    attach: string;
    attachFiles: string;
    attachProjectFolder: string;
    noOllamaModelsInstalled: string;
    huggingFaceHint: string;
    pullFromHuggingFace: string;
    pullExactTag: string;
    agentMode: string;
    agentModeTooltip: string;
    changeFolder: string;
    allow: string;
    deny: string;
    toolResult: string;
    alwaysAllowThisSession: string;
    agentStep: string;
    agentStepTooltip: string;
    agentPlan: string;
    agentCheckpoint: string;
    continueAgent: string;
    stopAgent: string;
    ollamaServer: string;
    serverAddress: string;
    serverAddressHelp: string;
    save: string;
    running: string;
    stopped: string;
    checking: string;
    online: string;
    offline: string;
    start: string;
    stop: string;
    yourSystem: string;
    cloudProviders: string;
    keysEncryptedNote: string;
    ollamaModelsSection: string;
    otherInstalledModels: string;
    chatDefaults: string;
    defaultModel: string;
    temperature: string;
    topP: string;
    maxTokens: string;
    contextLength: string;
    gpuLayers: string;
    gpuLayersAuto: string;
    gpuLayersHelp: string;
    seed: string;
    seedRandom: string;
    seedHelp: string;
    topK: string;
    topKHelp: string;
    repeatPenalty: string;
    repeatPenaltyHelp: string;
    stopSequences: string;
    stopSequencesHelp: string;
    stopSequencesPlaceholder: string;
    contextLengthOllamaOnly: string;
    frequencyPenalty: string;
    presencePenalty: string;
    penaltyClaudeNote: string;
    systemPrompt: string;
    promptLibrary: string;
    savePromptAsPreset: string;
    presetName: string;
    apply: string;
    cancel: string;
    fillPromptVariables: string;
    fillPromptVariablesHelp: string;
    editPreset: string;
    presetHistory: string;
    restore: string;
    noPreviousVersions: string;
    savePreset: string;
    promptLibraryVariablesHint: string;
    startRecording: string;
    stopRecording: string;
    cancelRecording: string;
    transcribing: string;
    ttsSection: string;
    ttsAutoRead: string;
    ttsVoice: string;
    ttsVoiceDefault: string;
    ttsVoiceTest: string;
    enabled: string;
    disabled: string;
    mcpServersSection: string;
    mcpServersHint: string;
    addMcpServer: string;
    mcpServerName: string;
    mcpTransport: string;
    mcpCommandHint: string;
    mcpUrlHint: string;
    mcpConnect: string;
    mcpConnecting: string;
    mcpDisconnect: string;
    mcpRemove: string;
    mcpConnected: string;
    mcpNotConnected: string;
    mcpToolCount: string;
    mcpAdd: string;
    undoLastEdit: string;
    nothingToUndo: string;
    restoredFile: string;
    deletedNewFile: string;
    runTests: string;
    runLint: string;
    runFormat: string;
    newFile: string;
    modelsDir: string;
    modelsDirHint: string;
    modelsDirDefault: string;
    chooseFolder: string;
    modelsDirApplied: string;
    modelsDirFailed: string;
    modelsDirExternalWarning: string;
    analyzeAs: string;
    analyzeDescribeUI: string;
    analyzeToMermaid: string;
    analyzeToCode: string;
    analyzeListComponents: string;
    analyzeFindIssues: string;
    sharePrompts: string;
    sharePromptsHint: string;
    noPromptsImported: string;
    importedPromptsCount: string;
    captureScreenshot: string;
    captureScreenshotHelp: string;
    noScreenSources: string;
    integrations: string;
    figmaTokenHint: string;
    attachFigmaFrame: string;
    figmaUrlPlaceholder: string;
    figmaFetch: string;
    extractTextOcr: string;
    ocrNoTextFound: string;
    editTags: string;
    addTag: string;
    add: string;
    pinnedMessages: string;
    you: string;
    assistant: string;
    llamaCppSection: string;
    llamaCppHint: string;
    gpuBackend: string;
    gpuBackendHint: string;
    gpuBackendAuto: string;
    gpuBackendCpu: string;
    gpuRecommended: string;
    gpuDetected: string;
    gpuAmdRocmNote: string;
    gpuIntelVulkanNote: string;
    gpuNoneDetectedNote: string;
    llamaCppNoModels: string;
    huggingFaceResults: string;
    huggingFaceResultsHint: string;
    noHuggingFaceResults: string;
    downloads: string;
    likes: string;
    noGgufFiles: string;
    pullWithOllama: string;
    downloadForLlamaCpp: string;
    settingsTabGeneral: string;
    settingsTabModels: string;
    settingsTabIntegrations: string;
    settingsTabChat: string;
    settingsTabVoice: string;
    settingsTabData: string;
    keyboardShortcuts: string;
    keyboardShortcutsHelp: string;
    shortcutCommandPalette: string;
    shortcutNewChat: string;
    shortcutSettings: string;
    shortcutShowShortcuts: string;
    shortcutSend: string;
    shortcutNewline: string;
    shortcutStopGenerating: string;
    compareModels: string;
    usageDashboard: string;
    usageTotalCost: string;
    usageTotalTokens: string;
    usageTotalSessions: string;
    usageByProvider: string;
    usageByModel: string;
    usageByDay: string;
    usageSessions: string;
    usageNoData: string;
    compareSamePrompt: string;
    compareRun: string;
    compareRunToSee: string;
    noModelsAvailable: string;
    settingsTabAutomation: string;
    scheduledTasksSection: string;
    scheduledTasksHint: string;
    taskName: string;
    taskPrompt: string;
    taskModel: string;
    intervalMinutes: string;
    createTask: string;
    noScheduledTasks: string;
    runNow: string;
    lastRun: string;
    never: string;
    every: string;
    minutes: string;
    enable: string;
    disable: string;
    customProvidersSection: string;
    customProvidersHint: string;
    customProviderName: string;
    customProviderBaseUrl: string;
    customProviderModelIds: string;
    addCustomProvider: string;
    onboardingTitle: string;
    onboardingSubtitle: string;
    onboardingOllama: string;
    onboardingOllamaDesc: string;
    onboardingLlamaCpp: string;
    onboardingLlamaCppDesc: string;
    onboardingCloudDesc: string;
    onboardingKeyLabel: string;
    onboardingKeyHint: string;
    onboardingSkip: string;
    onboardingContinue: string;
    resetToDefault: string;
    usingCustomPrompt: string;
    dataManagement: string;
    exportAllConversations: string;
    exportAsMarkdown: string;
    copyAsMarkdown: string;
    exportAsJson: string;
    exportAllDescription: string;
    export: string;
    importConversations: string;
    importDescription: string;
    import: string;
    clearAllConversations: string;
    clearAllDescription: string;
    clearAll: string;
    dataLocation: string;
    open: string;
    diagnostics: string;
    diagnosticsDescription: string;
    copyDiagnosticInfo: string;
    appActivity: string;
    appActivityDescription: string;
    refresh: string;
    noModelsLoaded: string;
    notRunning: string;
    mcpServersLabel: string;
    tools: string;
    noneConnected: string;
    appMemoryUsage: string;
    keybindings: string;
    keybindingsDescription: string;
    pressAKey: string;
    recordShortcut: string;
    reset: string;
    keybindingConflict: string;
    copied: string;
    openLogsFolder: string;
    checkForUpdates: string;
    language: string;
    appearance: string;
    colorMode: string;
    colorModeLight: string;
    colorModeDark: string;
    colorModeSystem: string;
    accentColor: string;
    accentColorNames: { default: string; blue: string; green: string; purple: string; orange: string; rose: string };
    general: string;
    providers: string;
    models: string;
    chat: string;
    data: string;
    delete: string;
}

export const en: Dictionary = {
    appName: "Modelforge",
    newChat: "New chat",
    newProject: "New project",
    searchChats: "Search chats and messages...",
    settings: "Settings",
    noChatsYet: "No chats yet.",
    noMatchingChats: "No matching chats.",
    model: "Model",
    sendMessage: "Send a message...",
    startConversationWith: (model) => `Start a conversation with ${model}.`,
    attach: "Attach",
    attachFiles: "Attach files",
    attachProjectFolder: "Attach project folder",
    noOllamaModelsInstalled: "No Ollama models installed — go to Settings to install one.",
    huggingFaceHint: "Tip: paste any GGUF model's Hugging Face URL (or hf.co/user/repo) to pull it directly — you're not limited to the catalog above.",
    pullFromHuggingFace: "Pull this GGUF model directly from Hugging Face.",
    pullExactTag: "Not in the catalog — pull this exact model tag from Ollama's library.",
    agentMode: "Agent",
    agentModeTooltip: "Agent mode: gives the model file tools (read/write/list/search) and shell command execution, scoped to a folder you choose. Every tool call needs your approval, and destructive/system-level commands (deleting outside the workspace, shutdown, privilege escalation) are blocked outright — but this is a safety net, not a full OS sandbox. Only approve commands you understand.",
    changeFolder: "Change folder",
    allow: "Allow",
    deny: "Deny",
    toolResult: "result",
    alwaysAllowThisSession: "Always allow this session",
    agentStep: "Agent step",
    agentStepTooltip: "How many automatic tool-result → model-continuation round trips have happened for this turn.",
    agentPlan: "Plan",
    agentCheckpoint: "Checkpoint",
    continueAgent: "Continue",
    stopAgent: "Stop here",
    ollamaServer: "Ollama server",
    serverAddress: "Server address",
    serverAddressHelp:
        "Point this at a remote Ollama instance if you're not running it on this machine. Leave it as the default to use a local install.",
    save: "Save",
    running: "Running",
    stopped: "Stopped",
    checking: "Checking...",
    online: "Online",
    offline: "Offline",
    start: "Start",
    stop: "Stop",
    yourSystem: "Your system",
    cloudProviders: "Cloud providers",
    keysEncryptedNote: "Keys are encrypted at rest using your OS credential store and never leave this device.",
    ollamaModelsSection: "Ollama models",
    otherInstalledModels: "Other installed models",
    chatDefaults: "Chat defaults",
    defaultModel: "Default model",
    temperature: "Temperature",
    topP: "Top P",
    maxTokens: "Max tokens",
    contextLength: "Context length",
    gpuLayers: "GPU layers",
    gpuLayersAuto: "Auto",
    gpuLayersHelp: "How many model layers to offload to the GPU (Ollama's num_gpu). Leave blank to let Ollama decide automatically; 0 forces CPU-only.",
    seed: "Seed",
    seedRandom: "Random",
    seedHelp: "A fixed seed makes output reproducible — same seed and prompt should give the same response. Leave blank for a random seed each time. Not supported by Claude.",
    topK: "Top K",
    topKHelp: "Limits sampling to the K most likely next tokens. Lower values are more focused/deterministic. Not supported by ChatGPT.",
    repeatPenalty: "Repeat penalty",
    repeatPenaltyHelp: "Penalizes tokens that already appeared recently, reducing repetition. 1.0 = no penalty. Ollama only.",
    stopSequences: "Stop sequences",
    stopSequencesHelp: "Generation stops as soon as any of these strings appears in the output. Comma-separated.",
    stopSequencesPlaceholder: "e.g. \\n\\nUser:, ###, <|end|>",
    contextLengthOllamaOnly: " (Ollama only)",
    frequencyPenalty: "Frequency penalty",
    presencePenalty: "Presence penalty",
    penaltyClaudeNote:
        "Context length only applies to Ollama models. Frequency/presence penalty aren't supported by Claude and are ignored for that provider.",
    systemPrompt: "System prompt",
    promptLibrary: "Prompt library",
    savePromptAsPreset: "Save current prompt as preset",
    presetName: "Preset name...",
    apply: "Apply",
    cancel: "Cancel",
    fillPromptVariables: "Fill in prompt variables",
    fillPromptVariablesHelp: "This prompt has blanks to fill in before it's applied.",
    editPreset: "Edit",
    presetHistory: "History",
    restore: "Restore",
    noPreviousVersions: "No previous versions yet.",
    savePreset: "Save",
    promptLibraryVariablesHint: "Add {{variables}} to a prompt (e.g. {{topic}}) and you'll be asked to fill them in each time you apply it. Edits keep version history so you can undo a change.",
    startRecording: "Start voice input",
    stopRecording: "Stop and transcribe",
    cancelRecording: "Cancel recording",
    transcribing: "Transcribing...",
    ttsSection: "Voice",
    ttsAutoRead: "Automatically read responses aloud",
    ttsVoice: "Voice",
    ttsVoiceDefault: "System default",
    ttsVoiceTest: "Test",
    enabled: "Enabled",
    disabled: "Disabled",
    mcpServersSection: "MCP servers",
    mcpServersHint: "Connect external Model Context Protocol servers to give Agent mode more tools (e.g. a database, a ticket tracker, a browser). stdio launches a local command; HTTP connects to a remote MCP server URL.",
    addMcpServer: "Add server",
    mcpServerName: "Name",
    mcpTransport: "Transport",
    mcpCommandHint: "Command (e.g. npx -y @modelcontextprotocol/server-filesystem /path)",
    mcpUrlHint: "Server URL (e.g. https://example.com/mcp)",
    mcpConnect: "Connect",
    mcpConnecting: "Connecting...",
    mcpDisconnect: "Disconnect",
    mcpRemove: "Remove",
    mcpConnected: "Connected",
    mcpNotConnected: "Not connected",
    mcpToolCount: "tools",
    mcpAdd: "Add",
    undoLastEdit: "Undo last edit",
    nothingToUndo: "Nothing to undo.",
    restoredFile: "Restored previous content of",
    deletedNewFile: "Removed newly-created file",
    runTests: "Run tests",
    runLint: "Lint",
    runFormat: "Format",
    newFile: "New file",
    modelsDir: "Model storage location",
    modelsDirHint: "Where Ollama downloads and stores model files. Changing this restarts Ollama (only if this app started it) — running downloads will be interrupted.",
    modelsDirDefault: "Default (Ollama's own location)",
    chooseFolder: "Choose folder...",
    modelsDirApplied: "Applied — Ollama restarted with the new location.",
    modelsDirFailed: "Couldn't restart Ollama with the new location. Try starting it manually.",
    modelsDirExternalWarning: "Saved, but Ollama is running outside this app — restart it manually (with OLLAMA_MODELS set to this folder) for the change to take effect.",
    analyzeAs: "Analyze as...",
    analyzeDescribeUI: "Describe UI/wireframe",
    analyzeToMermaid: "Convert to Mermaid diagram",
    analyzeToCode: "Convert to React + Tailwind code",
    analyzeListComponents: "List UI components",
    analyzeFindIssues: "Find usability/accessibility issues",
    sharePrompts: "Share prompts",
    sharePromptsHint: "Export your Prompt Library to a file to share with teammates, or import one they sent you. There's no live sync — this is a plain file you send however you like.",
    noPromptsImported: "No prompts found in that file.",
    importedPromptsCount: "Imported",
    captureScreenshot: "Capture screenshot",
    captureScreenshotHelp: "Pick a screen or window to attach as an image. On macOS you may need to grant Screen Recording permission first.",
    noScreenSources: "No screens or windows available to capture.",
    integrations: "Integrations",
    figmaTokenHint: "Add a Figma personal access token (Figma -> Settings -> Personal access tokens) to attach frames directly from a Figma link.",
    attachFigmaFrame: "Attach Figma frame...",
    figmaUrlPlaceholder: "Paste a Figma frame link (Copy link to selection)...",
    figmaFetch: "Fetch",
    extractTextOcr: "Extract text (OCR)",
    ocrNoTextFound: "No text found in that image.",
    editTags: "Edit tags",
    addTag: "Add tag...",
    add: "Add",
    pinnedMessages: "Pinned",
    you: "You",
    assistant: "Assistant",
    llamaCppSection: "llama.cpp (local)",
    llamaCppHint: "Run GGUF models directly via llama.cpp instead of Ollama — useful for Vulkan GPU acceleration or models Ollama doesn't package. Agent mode tool-calling isn't supported on this backend yet.",
    gpuBackend: "GPU backend",
    gpuBackendHint: "Only backends detected on this machine are shown as selectable, besides Auto and CPU.",
    gpuBackendAuto: "Auto-detect",
    gpuBackendCpu: "CPU only",
    gpuRecommended: "Recommended",
    gpuDetected: "Detected",
    gpuAmdRocmNote:
        "AMD GPUs are accelerated through Vulkan here. For native ROCm acceleration, run your models through the Ollama backend instead — it supports ROCm directly.",
    gpuIntelVulkanNote: "Intel GPUs (Arc and integrated) are accelerated through Vulkan.",
    gpuNoneDetectedNote: "No GPU detected — inference will run on the CPU.",
    llamaCppNoModels: "No GGUF models downloaded yet — search Hugging Face below and choose \"Download for llama.cpp\".",
    huggingFaceResults: "Hugging Face results",
    huggingFaceResultsHint: "Real search results from huggingface.co — expand a model to see its GGUF files.",
    noHuggingFaceResults: "No matching models found on Hugging Face.",
    downloads: "downloads",
    likes: "likes",
    noGgufFiles: "No GGUF files found in this repo.",
    pullWithOllama: "Pull with Ollama",
    downloadForLlamaCpp: "Download for llama.cpp",
    settingsTabGeneral: "General",
    settingsTabModels: "Models",
    settingsTabIntegrations: "Integrations",
    settingsTabChat: "Chat & Prompts",
    settingsTabVoice: "Voice",
    settingsTabData: "Data",
    keyboardShortcuts: "Keyboard shortcuts",
    keyboardShortcutsHelp: "Everything you can do without touching the mouse.",
    shortcutCommandPalette: "Command palette",
    shortcutNewChat: "New chat",
    shortcutSettings: "Open settings",
    shortcutShowShortcuts: "Show this dialog",
    shortcutSend: "Send message",
    shortcutNewline: "New line",
    shortcutStopGenerating: "Stop generating",
    compareModels: "Compare models",
    usageDashboard: "Usage dashboard",
    usageTotalCost: "Estimated total cost",
    usageTotalTokens: "Total tokens",
    usageTotalSessions: "Chats with usage",
    usageByProvider: "By provider",
    usageByModel: "By model",
    usageByDay: "Last 14 days",
    usageSessions: "chats",
    usageNoData: "No usage data yet — send some messages to cloud models to see cost estimates here.",
    compareSamePrompt: "Type a prompt to send to every selected model at once...",
    compareRun: "Run",
    compareRunToSee: "Run the comparison to see this model's response.",
    noModelsAvailable: "No models available yet — install one in Settings first.",
    settingsTabAutomation: "Automation",
    scheduledTasksSection: "Scheduled tasks",
    scheduledTasksHint: "Run a saved prompt on a repeating interval while the app is open — results are appended to a dedicated chat for that task. This runs only while Modelforge is open, not as a background service, and doesn't use Agent mode tools.",
    taskName: "Task name",
    taskPrompt: "Prompt to send each run",
    taskModel: "Model",
    intervalMinutes: "Every (minutes)",
    createTask: "Create task",
    noScheduledTasks: "No scheduled tasks yet.",
    runNow: "Run now",
    lastRun: "Last run",
    never: "Never",
    every: "every",
    minutes: "min",
    enable: "Enable",
    disable: "Disable",
    customProvidersSection: "Custom providers",
    customProvidersHint: "Add any OpenAI-compatible API endpoint — Groq, Mistral, DeepSeek, xAI, OpenRouter, a self-hosted server, or anything else that speaks the same chat-completions format. Pick a quick-add preset below or enter your own.",
    customProviderName: "Name (e.g. Groq)",
    customProviderBaseUrl: "Base URL (e.g. https://api.groq.com/openai/v1)",
    customProviderModelIds: "Model IDs, comma-separated",
    addCustomProvider: "Add provider",
    onboardingTitle: "Welcome to Modelforge",
    onboardingSubtitle: "How would you like to run models? You can add more later in Settings.",
    onboardingOllama: "Ollama (local)",
    onboardingOllamaDesc: "Free, private, runs on your machine. Recommended to start.",
    onboardingLlamaCpp: "llama.cpp (local)",
    onboardingLlamaCppDesc: "Free, private, with Vulkan/CUDA GPU acceleration.",
    onboardingCloudDesc: "Requires an API key and a paid account with the provider.",
    onboardingKeyLabel: "API key",
    onboardingKeyHint: "Stored encrypted on this device — you can change it anytime in Settings.",
    onboardingSkip: "Skip for now",
    onboardingContinue: "Continue",
    resetToDefault: "Reset to default",
    usingCustomPrompt: "Custom prompt for this chat",
    dataManagement: "Data management",
    exportAllConversations: "Export all conversations",
    exportAsMarkdown: "Export as Markdown",
    copyAsMarkdown: "Copy as Markdown",
    exportAsJson: "Export as JSON",
    exportAllDescription: "Save every chat to a single JSON file.",
    export: "Export",
    importConversations: "Import conversations",
    importDescription: "Load chats from a previously exported JSON file.",
    import: "Import",
    clearAllConversations: "Clear all conversations",
    clearAllDescription: "Permanently delete every saved chat.",
    clearAll: "Clear all",
    dataLocation: "Data location",
    open: "Open",
    diagnostics: "Diagnostics",
    diagnosticsDescription: "Useful when reporting a bug: app/system versions, Ollama connection status, and recent log output.",
    appActivity: "Activity & resource usage",
    appActivityDescription: "What's currently loaded and connected, plus this app's memory footprint.",
    refresh: "Refresh",
    noModelsLoaded: "No models loaded",
    notRunning: "Not running",
    mcpServersLabel: "MCP servers",
    tools: "tools",
    noneConnected: "None connected",
    appMemoryUsage: "App memory usage",
    keybindings: "Keybindings",
    keybindingsDescription: "Rebind the app's global shortcuts to whatever combo you'd rather use.",
    pressAKey: "Press a key combo… (Esc to cancel)",
    recordShortcut: "Record shortcut",
    reset: "Reset",
    keybindingConflict: "{key} is already used by another shortcut.",
    copyDiagnosticInfo: "Copy diagnostic info",
    copied: "Copied",
    openLogsFolder: "Open logs folder",
    checkForUpdates: "Check for updates",
    language: "Language",
    appearance: "Appearance",
    colorMode: "Color mode",
    colorModeLight: "Light",
    colorModeDark: "Dark",
    colorModeSystem: "System",
    accentColor: "Accent color",
    accentColorNames: {
        default: "Default (gray)",
        blue: "Blue",
        green: "Green",
        purple: "Purple",
        orange: "Orange",
        rose: "Rose",
    },
    general: "General",
    providers: "Providers",
    models: "Models",
    chat: "Chat",
    data: "Data",
    delete: "Delete",
};

export const tr: Dictionary = {
    appName: "Modelforge",
    newChat: "Yeni sohbet",
    newProject: "Yeni proje",
    searchChats: "Sohbetlerde ve mesajlarda ara...",
    settings: "Ayarlar",
    noChatsYet: "Henüz sohbet yok.",
    noMatchingChats: "Eşleşen sohbet yok.",
    model: "Model",
    sendMessage: "Bir mesaj gönderin...",
    startConversationWith: (model) => `${model} ile sohbete başlayın.`,
    attach: "Ekle",
    attachFiles: "Dosya ekle",
    attachProjectFolder: "Proje klasörü ekle",
    noOllamaModelsInstalled: "Yüklü Ollama modeli yok — birini yüklemek için Ayarlar'a gidin.",
    huggingFaceHint: "İpucu: herhangi bir GGUF modelinin Hugging Face bağlantısını (veya hf.co/kullanıcı/depo) yapıştırarak doğrudan indirebilirsiniz — yukarıdaki katalogla sınırlı değilsiniz.",
    pullFromHuggingFace: "Bu GGUF modelini doğrudan Hugging Face'ten indir.",
    pullExactTag: "Katalogda yok — bu tam model etiketini Ollama kütüphanesinden indirin.",
    agentMode: "Ajan",
    agentModeTooltip: "Ajan modu: modele seçtiğiniz bir klasörle sınırlı dosya araçları (okuma/yazma/listeleme/arama) ve kabuk komutu çalıştırma verir. Her araç çağrısı onayınızı gerektirir ve yıkıcı/sistem düzeyindeki komutlar (çalışma alanı dışında silme, kapatma, yetki yükseltme) tamamen engellenir — ancak bu bir güvenlik ağıdır, tam bir işletim sistemi korumalı alanı değildir. Yalnızca anladığınız komutlara izin verin.",
    changeFolder: "Klasörü değiştir",
    allow: "İzin ver",
    deny: "Reddet",
    toolResult: "sonucu",
    alwaysAllowThisSession: "Bu oturumda her zaman izin ver",
    agentStep: "Ajan adımı",
    agentStepTooltip: "Bu tur için kaç otomatik araç sonucu → model devamı gidiş-dönüşü gerçekleşti.",
    agentPlan: "Plan",
    agentCheckpoint: "Kontrol noktası",
    continueAgent: "Devam et",
    stopAgent: "Burada dur",
    ollamaServer: "Ollama sunucusu",
    serverAddress: "Sunucu adresi",
    serverAddressHelp:
        "Bu bilgisayarda çalıştırmıyorsanız, uzak bir Ollama sunucusunu buraya girin. Yerel kurulum için varsayılanı kullanın.",
    save: "Kaydet",
    running: "Çalışıyor",
    stopped: "Durduruldu",
    checking: "Kontrol ediliyor...",
    online: "Çevrimiçi",
    offline: "Çevrimdışı",
    start: "Başlat",
    stop: "Durdur",
    yourSystem: "Sisteminiz",
    cloudProviders: "Bulut sağlayıcılar",
    keysEncryptedNote:
        "Anahtarlar, işletim sistemi kimlik bilgisi deposu kullanılarak şifrelenir ve bu cihazdan çıkmaz.",
    ollamaModelsSection: "Ollama modelleri",
    otherInstalledModels: "Diğer yüklü modeller",
    chatDefaults: "Sohbet varsayılanları",
    defaultModel: "Varsayılan model",
    temperature: "Sıcaklık",
    topP: "Top P",
    maxTokens: "Maksimum token",
    contextLength: "Bağlam uzunluğu",
    gpuLayers: "GPU katmanları",
    gpuLayersAuto: "Otomatik",
    gpuLayersHelp: "GPU'ya kaç model katmanının aktarılacağı (Ollama'nın num_gpu ayarı). Ollama'nın otomatik karar vermesi için boş bırakın; 0 sadece CPU kullanımını zorlar.",
    seed: "Seed",
    seedRandom: "Rastgele",
    seedHelp: "Sabit bir seed, çıktıyı tekrarlanabilir kılar — aynı seed ve istemle aynı yanıt alınır. Her seferinde rastgele bir seed için boş bırakın. Claude tarafından desteklenmez.",
    topK: "Top K",
    topKHelp: "Örneklemeyi en olası K sonraki token ile sınırlar. Düşük değerler daha odaklı/deterministik sonuç verir. ChatGPT tarafından desteklenmez.",
    repeatPenalty: "Tekrar cezası",
    repeatPenaltyHelp: "Yakın zamanda geçmiş olan token'ları cezalandırarak tekrarı azaltır. 1.0 = ceza yok. Sadece Ollama.",
    stopSequences: "Durdurma dizileri",
    stopSequencesHelp: "Çıktıda bu dizilerden herhangi biri göründüğünde üretim durur. Virgülle ayırın.",
    stopSequencesPlaceholder: "örn. \\n\\nUser:, ###, <|end|>",
    contextLengthOllamaOnly: " (yalnızca Ollama)",
    frequencyPenalty: "Sıklık cezası",
    presencePenalty: "Varlık cezası",
    penaltyClaudeNote:
        "Bağlam uzunluğu yalnızca Ollama modelleri için geçerlidir. Sıklık/varlık cezası Claude tarafından desteklenmez ve o sağlayıcı için yok sayılır.",
    systemPrompt: "Sistem istemi",
    promptLibrary: "İstem kütüphanesi",
    savePromptAsPreset: "Mevcut istemi ön ayar olarak kaydet",
    presetName: "Ön ayar adı...",
    apply: "Uygula",
    cancel: "İptal",
    fillPromptVariables: "İstem değişkenlerini doldurun",
    fillPromptVariablesHelp: "Bu istemde uygulanmadan önce doldurulması gereken boşluklar var.",
    editPreset: "Düzenle",
    presetHistory: "Geçmiş",
    restore: "Geri yükle",
    noPreviousVersions: "Henüz önceki bir sürüm yok.",
    savePreset: "Kaydet",
    promptLibraryVariablesHint: "Bir isteme {{değişkenler}} ekleyin (ör. {{konu}}) — her uyguladığınızda bunları doldurmanız istenir. Düzenlemeler sürüm geçmişini korur, böylece bir değişikliği geri alabilirsiniz.",
    startRecording: "Sesli girişi başlat",
    stopRecording: "Durdur ve yazıya dök",
    cancelRecording: "Kaydı iptal et",
    transcribing: "Yazıya dökülüyor...",
    ttsSection: "Ses",
    ttsAutoRead: "Yanıtları otomatik olarak sesli oku",
    ttsVoice: "Ses",
    ttsVoiceDefault: "Sistem varsayılanı",
    ttsVoiceTest: "Test et",
    enabled: "Etkin",
    disabled: "Kapalı",
    mcpServersSection: "MCP sunucuları",
    mcpServersHint: "Agent moduna daha fazla araç kazandırmak için harici Model Context Protocol sunucularına bağlanın (ör. bir veritabanı, bir destek sistemi, bir tarayıcı). stdio yerel bir komut başlatır; HTTP uzak bir MCP sunucu adresine bağlanır.",
    addMcpServer: "Sunucu ekle",
    mcpServerName: "Ad",
    mcpTransport: "Bağlantı türü",
    mcpCommandHint: "Komut (ör. npx -y @modelcontextprotocol/server-filesystem /yol)",
    mcpUrlHint: "Sunucu adresi (ör. https://example.com/mcp)",
    mcpConnect: "Bağlan",
    mcpConnecting: "Bağlanıyor...",
    mcpDisconnect: "Bağlantıyı kes",
    mcpRemove: "Kaldır",
    mcpConnected: "Bağlı",
    mcpNotConnected: "Bağlı değil",
    mcpToolCount: "araç",
    mcpAdd: "Ekle",
    undoLastEdit: "Son düzenlemeyi geri al",
    nothingToUndo: "Geri alınacak bir şey yok.",
    restoredFile: "Önceki içerik geri yüklendi:",
    deletedNewFile: "Yeni oluşturulan dosya kaldırıldı:",
    runTests: "Testleri çalıştır",
    runLint: "Lint",
    runFormat: "Biçimlendir",
    newFile: "Yeni dosya",
    modelsDir: "Model depolama konumu",
    modelsDirHint: "Ollama'nın model dosyalarını indirdiği ve sakladığı yer. Bunu değiştirmek Ollama'yı yeniden başlatır (yalnızca bu uygulama başlattıysa) — devam eden indirmeler kesintiye uğrar.",
    modelsDirDefault: "Varsayılan (Ollama'nın kendi konumu)",
    chooseFolder: "Klasör seç...",
    modelsDirApplied: "Uygulandı — Ollama yeni konumla yeniden başlatıldı.",
    modelsDirFailed: "Ollama yeni konumla yeniden başlatılamadı. Elle başlatmayı deneyin.",
    modelsDirExternalWarning: "Kaydedildi, ancak Ollama bu uygulamanın dışında çalışıyor — değişikliğin etkili olması için Ollama'yı bu klasör OLLAMA_MODELS olarak ayarlanmış şekilde elle yeniden başlatın.",
    analyzeAs: "Şu şekilde analiz et...",
    analyzeDescribeUI: "UI/wireframe'i betimle",
    analyzeToMermaid: "Mermaid diyagramına dönüştür",
    analyzeToCode: "React + Tailwind koduna dönüştür",
    analyzeListComponents: "UI bileşenlerini listele",
    analyzeFindIssues: "Kullanılabilirlik/erişilebilirlik sorunlarını bul",
    sharePrompts: "Promptları paylaş",
    sharePromptsHint: "Prompt kitaplığınızı bir dosyaya aktararak ekip arkadaşlarınızla paylaşın veya size gönderilen bir dosyayı içe aktarın. Canlı senkronizasyon yoktur — bu, istediğiniz şekilde gönderebileceğiniz düz bir dosyadır.",
    noPromptsImported: "O dosyada prompt bulunamadı.",
    importedPromptsCount: "İçe aktarıldı:",
    captureScreenshot: "Ekran görüntüsü al",
    captureScreenshotHelp: "Görüntü olarak eklemek için bir ekran veya pencere seçin. macOS'ta önce Ekran Kaydı izni vermeniz gerekebilir.",
    noScreenSources: "Yakalanacak ekran veya pencere yok.",
    integrations: "Entegrasyonlar",
    figmaTokenHint: "Figma bağlantısından doğrudan çerçeve eklemek için bir Figma kişisel erişim belirteci ekleyin (Figma -> Settings -> Personal access tokens).",
    attachFigmaFrame: "Figma çerçevesi ekle...",
    figmaUrlPlaceholder: "Bir Figma çerçeve bağlantısı yapıştırın (Copy link to selection)...",
    figmaFetch: "Getir",
    extractTextOcr: "Metni çıkar (OCR)",
    ocrNoTextFound: "O görüntüde metin bulunamadı.",
    editTags: "Etiketleri düzenle",
    addTag: "Etiket ekle...",
    add: "Ekle",
    pinnedMessages: "Sabitlenenler",
    you: "Siz",
    assistant: "Asistan",
    llamaCppSection: "llama.cpp (yerel)",
    llamaCppHint: "GGUF modellerini Ollama yerine doğrudan llama.cpp ile çalıştırın — Vulkan GPU hızlandırma veya Ollama'nın paketlemediği modeller için kullanışlı. Agent modu araç çağırma bu backend'de henüz desteklenmiyor.",
    gpuBackend: "GPU backend'i",
    gpuBackendHint: "Otomatik ve CPU dışında yalnızca bu makinede tespit edilen backend'ler seçilebilir olarak gösterilir.",
    gpuBackendAuto: "Otomatik algıla",
    gpuBackendCpu: "Yalnızca CPU",
    gpuRecommended: "Önerilen",
    gpuDetected: "Algılanan",
    gpuAmdRocmNote:
        "AMD GPU'lar burada Vulkan üzerinden hızlandırılır. Yerel ROCm hızlandırması için modellerinizi ROCm'u doğrudan destekleyen Ollama arka ucu üzerinden çalıştırın.",
    gpuIntelVulkanNote: "Intel GPU'lar (Arc ve tümleşik) Vulkan üzerinden hızlandırılır.",
    gpuNoneDetectedNote: "GPU algılanmadı — çıkarım CPU üzerinde çalışacak.",
    llamaCppNoModels: "Henüz indirilmiş GGUF modeli yok — aşağıdan Hugging Face'te arayın ve \"llama.cpp için indir\"i seçin.",
    huggingFaceResults: "Hugging Face sonuçları",
    huggingFaceResultsHint: "huggingface.co'dan gerçek arama sonuçları — GGUF dosyalarını görmek için bir modeli genişletin.",
    noHuggingFaceResults: "Hugging Face'te eşleşen model bulunamadı.",
    downloads: "indirme",
    likes: "beğeni",
    noGgufFiles: "Bu depoda GGUF dosyası bulunamadı.",
    pullWithOllama: "Ollama ile indir",
    downloadForLlamaCpp: "llama.cpp için indir",
    settingsTabGeneral: "Genel",
    settingsTabModels: "Modeller",
    settingsTabIntegrations: "Entegrasyonlar",
    settingsTabChat: "Sohbet ve Promptlar",
    settingsTabVoice: "Ses",
    settingsTabData: "Veri",
    keyboardShortcuts: "Klavye kısayolları",
    keyboardShortcutsHelp: "Fareye dokunmadan yapabileceğiniz her şey.",
    shortcutCommandPalette: "Komut paleti",
    shortcutNewChat: "Yeni sohbet",
    shortcutSettings: "Ayarları aç",
    shortcutShowShortcuts: "Bu pencereyi göster",
    shortcutSend: "Mesaj gönder",
    shortcutNewline: "Yeni satır",
    shortcutStopGenerating: "Üretimi durdur",
    compareModels: "Modelleri karşılaştır",
    usageDashboard: "Kullanım paneli",
    usageTotalCost: "Tahmini toplam maliyet",
    usageTotalTokens: "Toplam token",
    usageTotalSessions: "Kullanımı olan sohbetler",
    usageByProvider: "Sağlayıcıya göre",
    usageByModel: "Modele göre",
    usageByDay: "Son 14 gün",
    usageSessions: "sohbet",
    usageNoData: "Henüz kullanım verisi yok — maliyet tahminlerini burada görmek için bulut modellere birkaç mesaj gönderin.",
    compareSamePrompt: "Seçili tüm modellere aynı anda gönderilecek bir prompt yazın...",
    compareRun: "Çalıştır",
    compareRunToSee: "Bu modelin yanıtını görmek için karşılaştırmayı çalıştırın.",
    noModelsAvailable: "Henüz kullanılabilir model yok — önce Ayarlar'dan bir tane kurun.",
    settingsTabAutomation: "Otomasyon",
    scheduledTasksSection: "Zamanlanmış görevler",
    scheduledTasksHint: "Uygulama açıkken kayıtlı bir promptu tekrarlayan aralıklarla çalıştırın — sonuçlar o görev için ayrılmış bir sohbete eklenir. Bu yalnızca Modelforge açıkken çalışır, arka plan servisi değildir ve Agent modu araçlarını kullanmaz.",
    taskName: "Görev adı",
    taskPrompt: "Her çalıştırmada gönderilecek prompt",
    taskModel: "Model",
    intervalMinutes: "Her (dakika)",
    createTask: "Görev oluştur",
    noScheduledTasks: "Henüz zamanlanmış görev yok.",
    runNow: "Şimdi çalıştır",
    lastRun: "Son çalıştırma",
    never: "Hiç",
    every: "her",
    minutes: "dk",
    enable: "Etkinleştir",
    disable: "Devre dışı bırak",
    customProvidersSection: "Özel sağlayıcılar",
    customProvidersHint: "Herhangi bir OpenAI uyumlu API uç noktası ekleyin — Groq, Mistral, DeepSeek, xAI, OpenRouter, kendi barındırdığınız bir sunucu veya aynı chat-completions formatını konuşan başka bir şey. Aşağıdan hızlı ekleme ön ayarlarından birini seçin veya kendinizinkini girin.",
    customProviderName: "Ad (ör. Groq)",
    customProviderBaseUrl: "Temel URL (ör. https://api.groq.com/openai/v1)",
    customProviderModelIds: "Model ID'leri, virgülle ayrılmış",
    addCustomProvider: "Sağlayıcı ekle",
    onboardingTitle: "Modelforge'a hoş geldiniz",
    onboardingSubtitle: "Modelleri nasıl çalıştırmak istersiniz? Daha sonra Ayarlar'dan başka sağlayıcı da ekleyebilirsiniz.",
    onboardingOllama: "Ollama (yerel)",
    onboardingOllamaDesc: "Ücretsiz, özel, bilgisayarınızda çalışır. Başlamak için önerilir.",
    onboardingLlamaCpp: "llama.cpp (yerel)",
    onboardingLlamaCppDesc: "Vulkan/CUDA GPU hızlandırmalı, ücretsiz ve özel.",
    onboardingCloudDesc: "Sağlayıcıdan bir API anahtarı ve ücretli hesap gerektirir.",
    onboardingKeyLabel: "API anahtarı",
    onboardingKeyHint: "Bu cihazda şifreli olarak saklanır — istediğiniz zaman Ayarlar'dan değiştirebilirsiniz.",
    onboardingSkip: "Şimdilik atla",
    onboardingContinue: "Devam et",
    resetToDefault: "Varsayılana dön",
    usingCustomPrompt: "Bu sohbet için özel istem",
    dataManagement: "Veri yönetimi",
    exportAllConversations: "Tüm sohbetleri dışa aktar",
    exportAsMarkdown: "Markdown olarak dışa aktar",
    copyAsMarkdown: "Markdown olarak kopyala",
    exportAsJson: "JSON olarak dışa aktar",
    exportAllDescription: "Tüm sohbetleri tek bir JSON dosyasına kaydedin.",
    export: "Dışa aktar",
    importConversations: "Sohbetleri içe aktar",
    importDescription: "Daha önce dışa aktarılmış bir JSON dosyasından sohbetleri yükleyin.",
    import: "İçe aktar",
    clearAllConversations: "Tüm sohbetleri temizle",
    clearAllDescription: "Kaydedilen tüm sohbetleri kalıcı olarak silin.",
    clearAll: "Tümünü temizle",
    dataLocation: "Veri konumu",
    open: "Aç",
    diagnostics: "Tanılama",
    diagnosticsDescription: "Hata bildirirken faydalıdır: uygulama/sistem sürümleri, Ollama bağlantı durumu ve son günlük çıktısı.",
    copyDiagnosticInfo: "Tanılama bilgisini kopyala",
    appActivity: "Etkinlik ve kaynak kullanımı",
    appActivityDescription: "Şu anda yüklü ve bağlı olanlar, ayrıca bu uygulamanın bellek kullanımı.",
    refresh: "Yenile",
    noModelsLoaded: "Yüklü model yok",
    notRunning: "Çalışmıyor",
    mcpServersLabel: "MCP sunucuları",
    tools: "araç",
    noneConnected: "Bağlı yok",
    appMemoryUsage: "Uygulama bellek kullanımı",
    keybindings: "Kısayol tuşları",
    keybindingsDescription: "Uygulamanın genel kısayollarını istediğiniz tuş kombinasyonuna yeniden atayın.",
    pressAKey: "Bir tuş kombinasyonuna basın… (İptal için Esc)",
    recordShortcut: "Kısayolu kaydet",
    reset: "Sıfırla",
    keybindingConflict: "{key} zaten başka bir kısayol tarafından kullanılıyor.",
    copied: "Kopyalandı",
    openLogsFolder: "Günlük klasörünü aç",
    checkForUpdates: "Güncellemeleri denetle",
    language: "Dil",
    appearance: "Görünüm",
    colorMode: "Renk modu",
    colorModeLight: "Açık",
    colorModeDark: "Koyu",
    colorModeSystem: "Sistem",
    accentColor: "Vurgu rengi",
    accentColorNames: {
        default: "Varsayılan (gri)",
        blue: "Mavi",
        green: "Yeşil",
        purple: "Mor",
        orange: "Turuncu",
        rose: "Gül kurusu",
    },
    general: "Genel",
    providers: "Sağlayıcılar",
    models: "Modeller",
    chat: "Sohbet",
    data: "Veri",
    delete: "Sil",
};

export const DICTIONARIES: Record<Locale, Dictionary> = { en, tr };
