/**
 * File-ops tier. The generic filesystem spine, every path confined to the
 * vault root by VaultService.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultService } from "../services/vault.js";
import { ok, fail } from "../services/format.js";
import {
  ReadInputSchema,
  ListInputSchema,
  SearchInputSchema,
  WriteInputSchema,
  PatchInputSchema,
  ResponseFormat,
  type ReadInput,
  type ListInput,
  type SearchInput,
  type WriteInput,
  type PatchInput,
} from "../schemas/index.js";

export function registerFileTools(server: McpServer, vault: VaultService): void {
  // ---- mastervault_read ---------------------------------------------------
  server.registerTool(
    "mastervault_read",
    {
      title: "Read a vault file",
      description: `Read a single text file from the vault, optionally by line range.

Args:
  - path (string): vault-relative file path
  - start_line (number, optional): 1-indexed first line (inclusive)
  - end_line (number, optional): 1-indexed last line (inclusive)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  The file content. For markdown files, parsed frontmatter is included in the structured output. JSON format returns { path, size, frontmatter, content }.

Examples:
  - Use when: you know the file path and want its contents.
  - Don't use when: you want the whole protocol at once (use mastervault_orient).`,
      inputSchema: ReadInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: ReadInput) => {
      try {
        const r = await vault.read(params.path, params.start_line, params.end_line);
        const structured = {
          path: r.path,
          size: r.size,
          frontmatter: r.frontmatter,
          content: r.content,
        };
        if (params.response_format === ResponseFormat.JSON) {
          return ok(JSON.stringify(structured, null, 2), structured);
        }
        return ok(r.content, structured);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- mastervault_list ---------------------------------------------------
  server.registerTool(
    "mastervault_list",
    {
      title: "List a vault directory",
      description: `List files and subdirectories in a vault directory, paginated.

Args:
  - path (string): vault-relative directory ('' or '.' = vault root)
  - offset (number): entries to skip (default 0)
  - limit (number): max entries (default 50, max 200)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  Directories first, then files, alphabetical. Includes total, count, has_more, next_offset for pagination.

Examples:
  - Use when: exploring vault structure or finding a file's exact path.`,
      inputSchema: ListInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: ListInput) => {
      try {
        const r = await vault.list(params.path, params.offset, params.limit);
        if (params.response_format === ResponseFormat.JSON) {
          return ok(JSON.stringify(r, null, 2), r as unknown as Record<string, unknown>);
        }
        const lines = [`# ${r.path}`, ``, `${r.total} entries (showing ${r.count})`, ``];
        for (const e of r.entries) {
          lines.push(e.type === "directory" ? `- 📁 ${e.name}/` : `- 📄 ${e.name} (${e.size} bytes)`);
        }
        if (r.has_more) lines.push(``, `_More available — offset ${r.next_offset}._`);
        return ok(lines.join("\n"), r as unknown as Record<string, unknown>);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- mastervault_search -------------------------------------------------
  server.registerTool(
    "mastervault_search",
    {
      title: "Search the vault",
      description: `Case-insensitive full-text substring search across text files in the vault.

Args:
  - query (string): substring to find
  - path (string, optional): subdirectory to limit search ('' = whole vault)
  - limit (number): max matching lines (default 50, max 200)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  Matching lines with file path and line number. Reports total matches and whether results were truncated.

Examples:
  - Use when: finding where a term, name, or phrase appears across the vault.
  - Don't use when: you want a specific known file (use mastervault_read).`,
      inputSchema: SearchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: SearchInput) => {
      try {
        const r = await vault.search(params.query, params.path, params.limit);
        if (params.response_format === ResponseFormat.JSON) {
          return ok(JSON.stringify(r, null, 2), r as unknown as Record<string, unknown>);
        }
        const lines = [
          `# Search: "${r.query}"`,
          ``,
          `${r.total} matches${r.truncated ? ` (showing ${r.count})` : ""}`,
          ``,
        ];
        for (const h of r.hits) {
          lines.push(`- \`${h.path}\`:${h.line} — ${h.text}`);
        }
        if (r.truncated) lines.push(``, `_Truncated — narrow the query or set a subdirectory._`);
        return ok(lines.join("\n"), r as unknown as Record<string, unknown>);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- mastervault_write --------------------------------------------------
  server.registerTool(
    "mastervault_write",
    {
      title: "Write a vault file",
      description: `Create a new file or completely overwrite an existing one. Creates parent directories as needed.

This overwrites without preserving prior content. To change part of an existing file, prefer mastervault_patch.

Args:
  - path (string): vault-relative path to write
  - content (string): full UTF-8 content
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  Confirmation with the path and bytes written.

Examples:
  - Use when: creating a new note, or replacing a file's entire content.
  - Don't use when: editing one section (use mastervault_patch) or removing a file (use mastervault_stage_delete).`,
      inputSchema: WriteInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: WriteInput) => {
      try {
        const r = await vault.write(params.path, params.content);
        const structured = { written: true, ...r };
        const msg = `Wrote ${r.bytes} bytes to ${r.path}.`;
        if (params.response_format === ResponseFormat.JSON) {
          return ok(JSON.stringify(structured, null, 2), structured);
        }
        return ok(msg, structured);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- mastervault_patch --------------------------------------------------
  server.registerTool(
    "mastervault_patch",
    {
      title: "Patch a vault file",
      description: `Replace an exact text block in a file without rewriting the whole thing.

old_str must appear EXACTLY ONCE in the file (including whitespace). Zero or multiple matches are rejected with a clear message, so widen old_str with surrounding context until it is unique. An empty new_str deletes the matched text.

Args:
  - path (string): vault-relative file to edit
  - old_str (string): exact text to replace (must be unique in the file)
  - new_str (string): replacement text (empty = delete)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  Confirmation with the path and number of replacements (always 1 on success).

Examples:
  - Use when: changing or removing a specific line or block in a file.
  - Don't use when: replacing the whole file (use mastervault_write).`,
      inputSchema: PatchInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: PatchInput) => {
      try {
        const r = await vault.read(params.path);
        const occurrences = r.content.split(params.old_str).length - 1;
        if (occurrences === 0) {
          return fail(
            new Error(
              `old_str not found in ${params.path}. Copy the exact text (including whitespace) from a prior read.`
            )
          );
        }
        if (occurrences > 1) {
          return fail(
            new Error(
              `old_str matched ${occurrences} times in ${params.path}; it must be unique. Add surrounding context to disambiguate.`
            )
          );
        }
        const updated = r.content.replace(params.old_str, params.new_str);
        const w = await vault.write(params.path, updated);
        const structured = { patched: true, path: w.path, replacements: 1, bytes: w.bytes };
        const msg = `Patched ${w.path} (1 replacement, now ${w.bytes} bytes).`;
        if (params.response_format === ResponseFormat.JSON) {
          return ok(JSON.stringify(structured, null, 2), structured);
        }
        return ok(msg, structured);
      } catch (err) {
        return fail(err);
      }
    }
  );
}
