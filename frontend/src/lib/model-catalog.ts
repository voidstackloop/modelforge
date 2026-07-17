export interface CatalogEntry {
    name: string;
    label: string;
    description: string;
}

// A broader browsing list beyond the RAM-based recommendations, for models
// a user might deliberately want regardless of whether they "fit" this PC.
export const EXTRA_MODELS: CatalogEntry[] = [
    { name: "codellama:7b", label: "Code Llama 7B", description: "Meta's code-focused model, good general coding assistant." },
    { name: "codellama:13b", label: "Code Llama 13B", description: "Larger Code Llama, stronger code completion and explanation." },
    { name: "codellama:34b", label: "Code Llama 34B", description: "Top-end Code Llama size, needs a capable machine." },
    { name: "deepseek-coder:6.7b", label: "DeepSeek Coder 6.7B", description: "Strong at code generation and repair for its size." },
    { name: "deepseek-coder-v2:16b", label: "DeepSeek Coder V2 16B", description: "Larger, higher-quality coding model." },
    { name: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B", description: "Coding-specialized variant of Qwen 2.5." },
    { name: "mixtral:8x7b", label: "Mixtral 8x7B", description: "Mixture-of-experts model, strong quality-to-speed ratio." },
    { name: "dolphin-mixtral:8x7b", label: "Dolphin Mixtral 8x7B", description: "Uncensored fine-tune of Mixtral, conversational." },
    { name: "llava:7b", label: "LLaVA 7B", description: "Vision-language model — can describe and reason about images." },
    { name: "llava:13b", label: "LLaVA 13B", description: "Larger vision-language model for image understanding." },
    { name: "command-r:35b", label: "Command R 35B", description: "Optimized for retrieval-augmented generation and tool use." },
    { name: "starcoder2:3b", label: "StarCoder2 3B", description: "Lightweight code generation model." },
    { name: "starcoder2:15b", label: "StarCoder2 15B", description: "Larger StarCoder2 for higher-quality code generation." },
    { name: "wizardlm2:7b", label: "WizardLM2 7B", description: "Instruction-tuned general-purpose model." },
    { name: "yi:6b", label: "Yi 6B", description: "Efficient bilingual (English/Chinese) general-purpose model." },
    { name: "vicuna:7b", label: "Vicuna 7B", description: "Early popular fine-tune, conversational general-purpose model." },
    { name: "nomic-embed-text", label: "Nomic Embed Text", description: "Text embedding model, not for chat — used for search/RAG." },
    { name: "qwen2.5:0.5b", label: "Qwen 2.5 0.5B", description: "Tiny model for extremely low-resource devices." },
    { name: "qwen2.5:1.5b", label: "Qwen 2.5 1.5B", description: "Small, fast general-purpose model." },
    { name: "gemma2:27b", label: "Gemma 2 27B", description: "Larger Gemma 2 for higher-quality responses." },
];
