/**
 * Shared constants for the MasterVault MCP server.
 */

/** Maximum size of any single tool response, in characters. Prevents blowing
 *  out a client's context window on a large file or search result. */
export const CHARACTER_LIMIT = 25000;

/**
 * Protocol files, in the order a fresh LLM should read them.
 * These paths are conventions of the MasterVault structure. If a given vault
 * does not contain one of them, `mastervault_orient` reports it as missing
 * rather than failing — a vault is still usable without the full protocol.
 */
export const PROTOCOL_FILES = [
  "_orientation.md",
  "CLEO_global_filter.md",
  "CLEO_context.md",
] as const;

/** The orientation file is the entry point: it names the protocol and points
 *  at the others. Served first and in full by `mastervault_orient`. */
export const ORIENTATION_FILE = "_orientation.md";

/** Directory where files staged for deletion are moved. The human is the
 *  final actor: the server never hard-deletes. */
export const TO_DELETE_DIR = "_ToDelete";

/** Decision-log dataset and its derived summary (the calibration system). */
export const DECISION_LOG_FILE = "_Meta/Decision Log.md";
export const CONFIDENCE_SUMMARY_FILE = "_Meta/Confidence Summary.md";

/** Valid decision-log categories. `log_decision` rejects anything else so the
 *  log's category tables stay well-formed. Mirrors the headings in
 *  `_Meta/Decision Log.md`. */
export const DECISION_CATEGORIES = [
  "vault-structure",
  "cleo-architecture",
  "infrastructure",
  "ip-legal",
  "external-content",
  "delete-proposals",
] as const;

export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

/** Valid verdicts for a logged decision. */
export const DECISION_VERDICTS = ["agree", "modify", "reject", "defer"] as const;
export type DecisionVerdict = (typeof DECISION_VERDICTS)[number];

/** Default and max page sizes for directory / search listings. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** File extensions treated as readable text for search and read operations. */
export const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv",
  ".ts", ".js", ".py", ".html", ".css", ".xml", ".toml", ".ini", ".cfg",
]);
