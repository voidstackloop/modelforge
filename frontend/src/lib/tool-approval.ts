// Which agent tools may be granted "always allow for this session".
//
// The bar for that grant is not "doesn't write to the workspace" — it's "the
// user has nothing to lose by never being asked again". Those differ: a tool
// can leave the workspace untouched and still reach the network or the disk.
//
// This matters because the model's inputs are not trusted. Agent mode reads
// file contents and web pages, and instructions embedded in that content can
// steer subsequent tool calls. The per-call approval prompt is what stops that
// from becoming unattended action, so anything with a side effect the user
// would want to see keeps its prompt. Notably that excludes:
//
//  - web_search, fetch_url and the github_* tools, which each send a request
//    to a destination the model chooses — a standing grant on those is an
//    unattended outbound channel for whatever the model has already read.
//  - capture_page_screenshot, which fetches a model-chosen URL *and* writes a
//    PNG into the workspace, so it is not read-only in either sense.
//
// Listing what qualifies, rather than what doesn't, keeps this default-deny: a
// tool added to AGENT_TOOLS without being classified here needs per-call
// approval until someone decides otherwise.
export const AUTO_APPROVABLE_TOOLS = new Set([
    "read_file",
    "find_files",
    "file_info",
    "list_dir",
    "search_files",
    "git_status",
    "git_diff",
    "git_log",
    "read_notes",
    "get_background_output",
    "list_background_commands",
    "find_symbol_references",
    "read_terminal_output",
]);

export function canAlwaysAllow(toolName: string): boolean {
    return AUTO_APPROVABLE_TOOLS.has(toolName);
}
