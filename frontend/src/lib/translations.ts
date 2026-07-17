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
    contextLengthOllamaOnly: string;
    frequencyPenalty: string;
    presencePenalty: string;
    penaltyClaudeNote: string;
    systemPrompt: string;
    promptLibrary: string;
    savePromptAsPreset: string;
    presetName: string;
    apply: string;
    resetToDefault: string;
    usingCustomPrompt: string;
    dataManagement: string;
    exportAllConversations: string;
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
    language: string;
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
    searchChats: "Search chats...",
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
    resetToDefault: "Reset to default",
    usingCustomPrompt: "Custom prompt for this chat",
    dataManagement: "Data management",
    exportAllConversations: "Export all conversations",
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
    language: "Language",
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
    searchChats: "Sohbetlerde ara...",
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
    resetToDefault: "Varsayılana dön",
    usingCustomPrompt: "Bu sohbet için özel istem",
    dataManagement: "Veri yönetimi",
    exportAllConversations: "Tüm sohbetleri dışa aktar",
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
    language: "Dil",
    general: "Genel",
    providers: "Sağlayıcılar",
    models: "Modeller",
    chat: "Sohbet",
    data: "Veri",
    delete: "Sil",
};

export const DICTIONARIES: Record<Locale, Dictionary> = { en, tr };
