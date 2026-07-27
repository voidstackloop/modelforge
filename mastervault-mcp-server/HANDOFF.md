# Handoff Spec — Deferred Work

This is the scoped, mechanical work deliberately left out of v1 so it can be
handed to a cheaper model (in ModelForge, Claude Code, or a Sonnet session)
rather than spending premium tokens on it. v1 is complete and verified without
any of the below; these are additive.

## Context for the model picking this up

`mastervault-mcp-server` is a TypeScript stdio MCP server that serves a
"MasterVault" (a structured Obsidian-style knowledge vault) to any MCP client,
without Obsidian. It has 9 tools across three tiers (protocol / files / delete).
The build passes (`npm run build`), a functional harness passes 12/12 including
path-traversal security tests, and an MCP stdio handshake exposes all 9 tools.
Read `README.md` first, then `src/` — start at `src/index.ts`.

Do not change the security model in `src/services/vault.ts` without re-running
`node test-harness.mjs` and keeping all security tests green.

## Task 1 — Evaluation suite (mcp-builder Phase 4)

The mcp-builder skill asks for 10 evaluation questions in XML. Create
`evaluations/eval.xml` with 10 `<qa_pair>` entries that test whether an LLM can
use these tools to answer realistic questions about a vault. Each question must
be independent, read-only, complex (multiple tool calls), realistic, verifiable
(single string-comparable answer), and stable.

Build a small fixture vault under `evaluations/fixture-vault/` with known
content so answers are deterministic. Example question shape: "Using orient then
search, what confidence value is recorded for the vault-structure seed row?" →
answer a specific string.

Format per the skill:
```xml
<evaluation>
  <qa_pair>
    <question>...</question>
    <answer>...</answer>
  </qa_pair>
</evaluation>
```

## Task 2 — Unit tests

Convert `test-harness.mjs` into a proper test suite (node:test or vitest). Cover:
- VaultService: read (with/without line range), list pagination, search, write,
  append, move (collision + overwrite paths).
- Security: `../` traversal, absolute path, escaping move, null byte — all must
  throw `PathSecurityError` or stay confined.
- Tool layer: patch's zero-match and multi-match rejection; log_decision
  section-aware append when the category heading is absent vs present;
  stage_delete collision suffixing.
Wire it to `npm test` and a `.github/workflows/ci.yml` that runs lint + build +
test on push.

## Task 3 — Git read tools (v2 tool tier)

Add read-only git helpers as a fourth tier, mirroring ModelForge's own set:
`mastervault_git_status`, `mastervault_git_log`, `mastervault_git_diff`. All
`readOnlyHint: true`. Shell out to `git -C <vaultRoot>` with argument arrays
(never string interpolation — no injection surface). Guard: if the vault is not
a git repo, return an actionable message, not an error. Keep `git_commit` out
unless explicitly requested — writes should stay behind the existing tools.

## Task 4 — Packaging niceties

- Add a `LICENSE` file (MIT) to match `package.json`.
- Add `.gitignore` (`node_modules/`, `dist/`, `*.log`).
- Consider publishing as an npm package so the ModelForge config can use
  `npx -y mastervault-mcp-server <vault>` like the filesystem-server example.

## Explicitly NOT in scope

- No hard-delete tool, ever.
- No shell/run_command tool (clients provide their own).
- No streamable-HTTP transport in v1 (stdio is the target for local clients like
  ModelForge). Add later only if a remote/multi-client use case appears; the
  mcp-builder TypeScript guide has the HTTP transport pattern ready to drop in.
