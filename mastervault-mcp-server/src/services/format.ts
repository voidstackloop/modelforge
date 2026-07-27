/**
 * Shared response + error formatting helpers, used by every tool so behavior
 * (truncation, error shape, structured content) is consistent and not
 * copy-pasted per tool.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import { PathSecurityError } from "./vault.js";

export interface ToolResponse {
  // The MCP SDK types a tool result as an open record (CallToolResult), so the
  // index signature is required for our helper's return type to be assignable
  // to a registerTool handler's expected return type.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Build a successful tool response with both a text rendering and structured
 *  data. Truncates the text side if it exceeds CHARACTER_LIMIT. */
export function ok(text: string, structured: Record<string, unknown>): ToolResponse {
  let out = text;
  if (out.length > CHARACTER_LIMIT) {
    out =
      out.slice(0, CHARACTER_LIMIT) +
      `\n\n[Response truncated at ${CHARACTER_LIMIT} characters. ` +
      `Use pagination (offset/limit), a line range, or a narrower query to see more.]`;
  }
  return {
    content: [{ type: "text", text: out }],
    structuredContent: structured,
  };
}

/** Build an actionable error response. Never leaks internal stack details;
 *  gives the agent a next step where one exists. */
export function fail(error: unknown): ToolResponse {
  let message: string;
  if (error instanceof PathSecurityError) {
    message = `Error: ${error.message}`;
  } else if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    switch (code) {
      case "ENOENT":
        message =
          "Error: File or directory not found. Check the vault-relative path with mastervault_list.";
        break;
      case "EISDIR":
        message = "Error: That path is a directory, not a file. Use mastervault_list instead.";
        break;
      case "ENOTDIR":
        message = "Error: A path component is a file, not a directory.";
        break;
      case "EACCES":
        message = "Error: Permission denied for that path.";
        break;
      default:
        message = `Error: ${error.message}`;
    }
  } else {
    message = `Error: ${String(error)}`;
  }
  return { content: [{ type: "text", text: message }], isError: true };
}
