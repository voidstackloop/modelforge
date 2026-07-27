/**
 * Protocol-tier tools. These are what make this server more than a generic
 * file server: they surface the MasterVault's OPERATING PROTOCOL so any LLM
 * can run the system, not just read its files.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VaultService } from "../services/vault.js";
import { ok, fail } from "../services/format.js";
import {
  PROTOCOL_FILES,
  ORIENTATION_FILE,
  CONFIDENCE_SUMMARY_FILE,
  DECISION_LOG_FILE,
  type DecisionCategory,
} from "../constants.js";
import {
  OrientInputSchema,
  GetConfidenceSummaryInputSchema,
  LogDecisionInputSchema,
  ResponseFormat,
  type OrientInput,
  type GetConfidenceSummaryInput,
  type LogDecisionInput,
} from "../schemas/index.js";

export function registerProtocolTools(server: McpServer, vault: VaultService): void {
  // ---- mastervault_orient -------------------------------------------------
  server.registerTool(
    "mastervault_orient",
    {
      title: "Orient on the MasterVault",
      description: `Read the MasterVault's operating protocol and return it in reading order.

This is the FIRST tool to call when beginning work with a MasterVault. It reads the orientation file (${ORIENTATION_FILE}) and the protocol files it points to, so you inherit the vault's conventions — how to work in it, what its logging and soft-delete rules are, where things live — before doing anything else.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  The full text of each protocol file that exists (${PROTOCOL_FILES.join(", ")}), in order, plus a note listing any that are absent. A vault missing some protocol files is still usable; absence is reported, not an error.

Examples:
  - Use when: starting any session against a MasterVault, before reading or writing content.
  - Don't use when: you only need a single known file (use mastervault_read).`,
      inputSchema: OrientInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: OrientInput) => {
      try {
        const present: { path: string; content: string }[] = [];
        const missing: string[] = [];
        for (const file of PROTOCOL_FILES) {
          if (await vault.exists(file)) {
            const r = await vault.read(file);
            present.push({ path: r.path, content: r.content });
          } else {
            missing.push(file);
          }
        }

        const structured = {
          vault_root: vault.getRoot(),
          protocol_files_present: present.map((p) => p.path),
          protocol_files_missing: missing,
          files: present,
        };

        if (params.response_format === ResponseFormat.JSON) {
          return ok(JSON.stringify(structured, null, 2), structured);
        }

        const parts: string[] = ["# MasterVault Orientation", ""];
        if (missing.length) {
          parts.push(`_Protocol files not found in this vault: ${missing.join(", ")}._`, "");
        }
        for (const p of present) {
          parts.push(`---`, ``, `## ${p.path}`, ``, p.content, ``);
        }
        if (!present.length) {
          parts.push(
            "_No protocol files found. This vault has no MasterVault protocol layer; " +
              "it can still be read and written as a plain file tree._"
          );
        }
        return ok(parts.join("\n"), structured);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- mastervault_get_confidence_summary --------------------------------
  server.registerTool(
    "mastervault_get_confidence_summary",
    {
      title: "Get the confidence calibration summary",
      description: `Return the MasterVault's confidence-calibration dashboard (${CONFIDENCE_SUMMARY_FILE}).

This is the compact per-category rollup derived from the decision log. It tells you, per domain, whether to push proposals confidently or defer more to the human — a calibration prior earned from past agree/reject history rather than guessed.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  The summary file's text. If the vault has no calibration system yet, reports that plainly.

Examples:
  - Use when: about to make a consequential proposal and you want the domain's track record.
  - Don't use when: you need the full row-level dataset (read ${DECISION_LOG_FILE} directly).`,
      inputSchema: GetConfidenceSummaryInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GetConfidenceSummaryInput) => {
      try {
        if (!(await vault.exists(CONFIDENCE_SUMMARY_FILE))) {
          const structured = { exists: false, path: CONFIDENCE_SUMMARY_FILE };
          const msg =
            `No confidence summary found at ${CONFIDENCE_SUMMARY_FILE}. ` +
            `This vault has no calibration system yet.`;
          return ok(msg, structured);
        }
        const r = await vault.read(CONFIDENCE_SUMMARY_FILE);
        const structured = { exists: true, path: r.path, content: r.content };
        if (params.response_format === ResponseFormat.JSON) {
          return ok(JSON.stringify(structured, null, 2), structured);
        }
        return ok(r.content, structured);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- mastervault_log_decision ------------------------------------------
  server.registerTool(
    "mastervault_log_decision",
    {
      title: "Log a consequential decision",
      description: `Append a row to the decision log (${DECISION_LOG_FILE}) under the given category.

Records a consequential proposal, your pre-verdict confidence estimate, and the human's verdict, so the gap between estimate and outcome accumulates into a calibration signal over time. Log only consequential, effort-to-reverse decisions — not trivial confirmations.

The est_confidence you supply is a PREDICTION to be scored, not introspected truth. State it before the human responds; log it after.

Args:
  - category (string): one of the vault's decision categories
  - proposal (string): terse description of what was proposed
  - est_confidence (number 0-100): your pre-verdict confidence
  - verdict ('agree' | 'modify' | 'reject' | 'defer'): the human's response
  - calibration_note (string, optional): how the estimate compared to the verdict
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  Confirmation with the appended row and the log path.

Examples:
  - Use when: the human has just accepted or rejected an architectural/structural/IP/content proposal.
  - Don't use when: the exchange was a trivial one-line confirmation.`,
      inputSchema: LogDecisionInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: LogDecisionInput) => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const note = params.calibration_note.trim() || "—";
        const isDeleteCat = params.category === ("delete-proposals" as DecisionCategory);

        // delete-proposals has an extra "File staged / Reason" column shape;
        // for a plain log_decision call we record into the standard columns and
        // fold file/reason into the proposal text if the caller used it there.
        const row = isDeleteCat
          ? `| ${today} | ${escapeCell(params.proposal)} | — | ${params.est_confidence}% | ${params.verdict} | ${escapeCell(note)} |`
          : `| ${today} | ${escapeCell(params.proposal)} | ${params.est_confidence}% | ${params.verdict} | ${escapeCell(note)} |`;

        // Append after the file's existing content. The category table is
        // located by the caller keeping the log well-formed; we append a row
        // to the end of the correct table using a section-aware append.
        await appendRowToCategory(vault, params.category, row);

        const structured = {
          logged: true,
          path: DECISION_LOG_FILE,
          category: params.category,
          date: today,
          est_confidence: params.est_confidence,
          verdict: params.verdict,
          row,
        };
        const msg =
          `Logged to ${DECISION_LOG_FILE} under "${params.category}":\n${row}`;
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

/** Escape pipe and newline so a value can't break the markdown table. */
function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Append a row to the end of a specific category's table within the decision
 * log. Locates the `### <category>` heading and inserts the row after the last
 * table line beneath it. If the log or heading is absent, falls back to a
 * plain append so no data is ever lost.
 */
async function appendRowToCategory(
  vault: VaultService,
  category: string,
  row: string
): Promise<void> {
  if (!(await vault.exists(DECISION_LOG_FILE))) {
    // No log yet: create a minimal one with this category and row.
    const seed =
      `# Decision Log — Confidence Calibration Dataset\n\n` +
      `### ${category}\n\n${row}\n`;
    await vault.write(DECISION_LOG_FILE, seed);
    return;
  }

  const r = await vault.read(DECISION_LOG_FILE);
  const lines = r.content.split("\n");
  const headingIdx = lines.findIndex(
    (l) => l.trim().toLowerCase() === `### ${category}`.toLowerCase()
  );

  if (headingIdx === -1) {
    // Category heading missing: create it at end of file.
    const addition = `\n### ${category}\n\n${row}\n`;
    await vault.append(DECISION_LOG_FILE, addition);
    return;
  }

  // Find the end of this section: the next heading (## or ###) after the
  // category heading, or end of file.
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  // Within the section, find the last markdown table row (starts with '|').
  let insertAt = -1;
  for (let i = sectionEnd - 1; i > headingIdx; i--) {
    if (lines[i].trim().startsWith("|")) {
      insertAt = i + 1;
      break;
    }
  }
  // If no table row found (unlikely), insert right after the heading block.
  if (insertAt === -1) insertAt = sectionEnd;

  lines.splice(insertAt, 0, row);
  await vault.write(DECISION_LOG_FILE, lines.join("\n"));
}
