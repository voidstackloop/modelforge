import { createWorker, type Worker } from "tesseract.js";
import { mainResourceOrchestrator } from "./resource-orchestrator";

// A single lazily-created worker is reused across calls — spinning one up is
// relatively expensive (loads the WASM engine + language data), and OCR
// requests are one-at-a-time from the UI anyway. The English language model
// downloads once on first use and is cached by tesseract.js afterwards, so
// only the very first OCR call in a fresh install needs network access.
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
    if (!workerPromise) {
        workerPromise = createWorker("eng").catch((err) => {
            workerPromise = null; // let the next call retry instead of caching a failure forever
            throw err;
        });
    }
    return workerPromise;
}

// Item 1: "OCR/document processing — Background unless user-triggered." This
// module is only ever invoked from a direct user action (attaching an image
// for text extraction), so user-interactive is the right default — there is
// no scheduled/background OCR path in this codebase to distinguish from.
export async function recognizeText(imageBase64: string): Promise<string> {
    return mainResourceOrchestrator.withLease(
        { workloadKind: "user-ocr", priority: "user-interactive", requirements: { cpuThreads: 1, accelerator: "none" } },
        async () => {
            const worker = await getWorker();
            const buffer = Buffer.from(imageBase64, "base64");
            const {
                data: { text },
            } = await worker.recognize(buffer);
            return text.trim();
        }
    );
}
