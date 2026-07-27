/**
 * Zod input schemas for every MasterVault tool.
 * All schemas use .strict() so unexpected fields are rejected rather than
 * silently ignored — a client bug surfaces as a clear validation error.
 */

import { z } from "zod";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DECISION_CATEGORIES,
  DECISION_VERDICTS,
} from "../constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

const responseFormat = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

export const OrientInputSchema = z
  .object({
    response_format: responseFormat,
  })
  .strict();

export const GetConfidenceSummaryInputSchema = z
  .object({
    response_format: responseFormat,
  })
  .strict();

export const ReadInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path is required")
      .describe("Vault-relative path to the file, e.g. 'CLEO_context.md' or '_Meta/Decision Log.md'"),
    start_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Optional 1-indexed first line to return (inclusive)"),
    end_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Optional 1-indexed last line to return (inclusive)"),
    response_format: responseFormat,
  })
  .strict();

export const ListInputSchema = z
  .object({
    path: z
      .string()
      .default("")
      .describe("Vault-relative directory path. Empty string or '.' lists the vault root."),
    offset: z.number().int().min(0).default(0).describe("Entries to skip (pagination)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Maximum entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
    response_format: responseFormat,
  })
  .strict();

export const SearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1, "query is required")
      .max(500)
      .describe("Case-insensitive substring to find across text files in the vault"),
    path: z
      .string()
      .default("")
      .describe("Optional vault-relative subdirectory to limit the search. Empty = whole vault."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Maximum matching lines to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
    response_format: responseFormat,
  })
  .strict();

export const WriteInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path is required")
      .describe("Vault-relative path to create or overwrite"),
    content: z.string().describe("Full file content to write (UTF-8)"),
    response_format: responseFormat,
  })
  .strict();

export const PatchInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path is required")
      .describe("Vault-relative path of the file to patch"),
    old_str: z
      .string()
      .min(1, "old_str is required")
      .describe("Exact text to replace. Must appear exactly once in the file."),
    new_str: z
      .string()
      .describe("Replacement text. Empty string deletes the matched text."),
    response_format: responseFormat,
  })
  .strict();

export const LogDecisionInputSchema = z
  .object({
    category: z
      .enum(DECISION_CATEGORIES)
      .describe(`Decision-log category. One of: ${DECISION_CATEGORIES.join(", ")}`),
    proposal: z
      .string()
      .min(1, "proposal is required")
      .describe("Terse description of what was proposed"),
    est_confidence: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe("Claude's pre-verdict confidence estimate (0-100). A prediction to be scored, not introspected truth."),
    verdict: z
      .enum(DECISION_VERDICTS)
      .describe(`The human's verdict. One of: ${DECISION_VERDICTS.join(", ")}`),
    calibration_note: z
      .string()
      .default("")
      .describe("Optional note on how the estimate compared to the verdict"),
    response_format: responseFormat,
  })
  .strict();

export const StageDeleteInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path is required")
      .describe("Vault-relative path of the file to stage for deletion (moved to _ToDelete/, never hard-deleted)"),
    reason: z
      .string()
      .min(1, "reason is required")
      .describe("Why this file should be removed — recorded in the decision log"),
    est_confidence: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(50)
      .describe("Confidence that the deletion is correct (0-100)"),
    response_format: responseFormat,
  })
  .strict();

export type OrientInput = z.infer<typeof OrientInputSchema>;
export type GetConfidenceSummaryInput = z.infer<typeof GetConfidenceSummaryInputSchema>;
export type ReadInput = z.infer<typeof ReadInputSchema>;
export type ListInput = z.infer<typeof ListInputSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
export type WriteInput = z.infer<typeof WriteInputSchema>;
export type PatchInput = z.infer<typeof PatchInputSchema>;
export type LogDecisionInput = z.infer<typeof LogDecisionInputSchema>;
export type StageDeleteInput = z.infer<typeof StageDeleteInputSchema>;
