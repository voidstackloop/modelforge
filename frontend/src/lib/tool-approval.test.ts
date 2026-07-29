import { describe, it, expect } from "vitest";
import { canAlwaysAllow } from "./tool-approval";

describe("canAlwaysAllow", () => {
    it("allows a standing grant for workspace-local reads", () => {
        expect(canAlwaysAllow("read_file")).toBe(true);
        expect(canAlwaysAllow("list_dir")).toBe(true);
        expect(canAlwaysAllow("git_diff")).toBe(true);
        expect(canAlwaysAllow("git_blame")).toBe(true);
        expect(canAlwaysAllow("find_symbol_references")).toBe(true);
    });

    // A standing grant on these would let content the model reads steer an
    // outbound request on every later turn with no prompt shown.
    it("never allows a standing grant for tools that reach the network", () => {
        expect(canAlwaysAllow("fetch_url")).toBe(false);
        expect(canAlwaysAllow("web_search")).toBe(false);
        expect(canAlwaysAllow("github_read_file")).toBe(false);
        expect(canAlwaysAllow("github_list_repositories")).toBe(false);
        expect(canAlwaysAllow("github_repository_tree")).toBe(false);
    });

    // Not read-only in either sense: it fetches a model-chosen URL and writes
    // a PNG into the workspace.
    it("never allows a standing grant for capture_page_screenshot", () => {
        expect(canAlwaysAllow("capture_page_screenshot")).toBe(false);
    });

    it("never allows a standing grant for tools with side effects", () => {
        for (const tool of ["write_file", "run_command", "run_code", "apply_patch", "delete_path", "git_commit", "http_request", "write_to_terminal"]) {
            expect(canAlwaysAllow(tool)).toBe(false);
        }
    });

    it("defaults to denying an unrecognised tool", () => {
        expect(canAlwaysAllow("some_future_tool")).toBe(false);
    });
});
