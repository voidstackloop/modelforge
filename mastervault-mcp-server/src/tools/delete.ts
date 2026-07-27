/**
 * Soft-delete tier. The server NEVER hard-deletes. `stage_delete` moves a file
 * into _ToDelete/ and records the proposal in the decision log; the human is
 * the sole final actor who empties _ToDelete/. A rescued file is strong signal
 * that the deletion judgment was wrong.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultService } from "../services/vault.js";
import { ok, fail } from "../services/format.js";
import { TO_DELETE_DIR, DECISION_LOG_FILE } from "../constants.js";
import {
  StageDeleteInputSchema,
  ResponseFormat,
  type StageDeleteInput,
} from "../schemas/index.js";

export function registerDeleteTools(server: McpServer, vault: VaultService): void {
  server.registerTool(
    "mastervault_stage_delete",
    {
      title: "Stage a file for deletion",
      description: `Move a file to ${TO_DELETE_DIR}/ and log the deletion proposal. Does NOT hard-delete.

This is the only deletion mechanism the server offers. The file is moved, not destroyed; the human reviews ${TO_DELETE_DIR}/ and performs the final removal (or rescues the file). A delete-proposals row is appended to ${DECISION_LOG_FILE} so the deletion judgment is tracked and can be calibrated over time.

Args:
  - path (string): vault-relative file to stage
  - reason (string): why it should be removed (recorded in the log)
  - est_confidence (number 0-100): confidence the deletion is correct (default 50)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  Confirmation with the file's new location under ${TO_DELETE_DIR}/ and the logged row.

Examples:
  - Use when: a file is stale/redundant and should be removed, pending human confirmation.
  - Don't use when: you only want to edit or move a file (use mastervault_patch / mastervault_write).`,
      inputSchema: StageDeleteInputSchema,
      annotations: {
        readOnlyHint: false,
        // Not destructive: the file is preserved in _ToDelete/, fully reversible.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: StageDeleteInput) => {
      try {
        if (!(await vault.exists(params.path))) {
          return fail(new Error(`File not found: ${params.path}. Nothing to stage.`));
        }

        // Derive a destination under _ToDelete/, preserving the basename and
        // avoiding collisions with a timestamp suffix if needed.
        const base = params.path.split("/").pop() as string;
        let dest = `${TO_DELETE_DIR}/${base}`;
        if (await vault.exists(dest)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const dot = base.lastIndexOf(".");
          dest =
            dot > 0
              ? `${TO_DELETE_DIR}/${base.slice(0, dot)}.${stamp}${base.slice(dot)}`
              : `${TO_DELETE_DIR}/${base}.${stamp}`;
        }

        const moved = await vault.move(params.path, dest);

        // Log a delete-proposals row (verdict pending — the human decides by
        // emptying or rescuing). We record verdict as 'defer' until acted on.
        const today = new Date().toISOString().slice(0, 10);
        const row =
          `| ${today} | ${escapeCell(moved.from)} | ${escapeCell(params.reason)} | ` +
          `${params.est_confidence}% | defer | Staged to ${escapeCell(moved.to)}; awaiting human final action. |`;
        await appendDeleteRow(vault, row);

        const structured = {
          staged: true,
          from: moved.from,
          to: moved.to,
          est_confidence: params.est_confidence,
          logged_row: row,
        };
        const msg =
          `Staged for deletion:\n- moved: ${moved.from} → ${moved.to}\n` +
          `- logged to ${DECISION_LOG_FILE} (delete-proposals, verdict pending)\n` +
          `The file is preserved in ${TO_DELETE_DIR}/ until you remove or rescue it.`;
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

function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Append a row to the delete-proposals table, or fall back to a plain append. */
async function appendDeleteRow(vault: VaultService, row: string): Promise<void> {
  if (!(await vault.exists(DECISION_LOG_FILE))) {
    const seed =
      `# Decision Log — Confidence Calibration Dataset\n\n` +
      `### delete-proposals\n\n${row}\n`;
    await vault.write(DECISION_LOG_FILE, seed);
    return;
  }
  const r = await vault.read(DECISION_LOG_FILE);
  const lines = r.content.split("\n");
  const headingIdx = lines.findIndex(
    (l) => l.trim().toLowerCase() === "### delete-proposals"
  );
  if (headingIdx === -1) {
    await vault.append(DECISION_LOG_FILE, `\n### delete-proposals\n\n${row}\n`);
    return;
  }
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  let insertAt = -1;
  for (let i = sectionEnd - 1; i > headingIdx; i--) {
    if (lines[i].trim().startsWith("|")) {
      insertAt = i + 1;
      break;
    }
  }
  if (insertAt === -1) insertAt = sectionEnd;
  lines.splice(insertAt, 0, row);
  await vault.write(DECISION_LOG_FILE, lines.join("\n"));
}
