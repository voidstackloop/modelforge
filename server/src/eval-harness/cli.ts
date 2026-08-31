import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OpenAiCompatibleInferenceClient } from "../ai-gateway/provider-client.js";
import { clinicalEvalSuiteSchema, runClinicalEvaluation, type ClinicalEvalReport } from "./runner.js";

function arg(name: string, required = false): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (required && !value) throw new Error(`--${name} is required`);
    return value;
}

async function main(): Promise<void> {
    const suitePath = resolve(arg("suite") ?? "src/eval-harness/fixtures/clinical-synthetic-v1.json");
    const model = arg("model", true)!;
    const version = arg("version") ?? model;
    const baseUrl = arg("base-url") ?? process.env.MODELFORGE_INFERENCE_BASE_URL;
    if (!baseUrl) throw new Error("--base-url or MODELFORGE_INFERENCE_BASE_URL is required");
    const apiKey = arg("api-key") ?? process.env.MODELFORGE_INFERENCE_API_KEY;
    if (!apiKey) throw new Error("--api-key or MODELFORGE_INFERENCE_API_KEY is required");
    const outputPath = resolve(arg("output") ?? "clinical-eval-report.json");
    const suite = clinicalEvalSuiteSchema.parse(JSON.parse(await readFile(suitePath, "utf8")));
    const baselinePath = arg("baseline");
    const baseline = baselinePath ? JSON.parse(await readFile(resolve(baselinePath), "utf8")) as ClinicalEvalReport : undefined;
    const client = new OpenAiCompatibleInferenceClient(baseUrl, apiKey, model, version);
    if (!await client.healthCheck()) throw new Error("The authenticated inference endpoint is unhealthy or is not serving the expected model");
    const report = await runClinicalEvaluation({ suite, client, modelId: model, modelVersion: version, baseline });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(JSON.stringify({ event: "clinical_eval_complete", outputPath, model, version, metrics: report.metrics, gate: report.gate }));
    if (!report.gate.passed) process.exitCode = 2;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
