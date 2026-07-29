import type { ToolDefinition } from "../providers/types";

export const AGENT_TOOLS: ToolDefinition[] = [
    {
        name: "read_file",
        description: "Read the contents of a text file within the workspace. Fails on binary files (images, compiled artifacts, etc.) — those aren't readable this way.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path, relative to the workspace root." },
                start_line: { type: "number", description: "Optional 1-based first line to read." },
                end_line: { type: "number", description: "Optional 1-based last line to read (inclusive)." },
            },
            required: ["path"],
        },
    },
    {
        name: "write_file",
        description: "Create a file or overwrite it with the given content. Creates parent directories as needed.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path, relative to the workspace root." },
                content: { type: "string", description: "The full content to write to the file." },
            },
            required: ["path", "content"],
        },
    },
    {
        name: "replace_in_file",
        description: "Replace one exact block of text in a file. Safer and more token-efficient than rewriting the whole file; fails if the text is missing or ambiguous.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path, relative to the workspace root." },
                old_text: { type: "string", description: "Exact text currently in the file." },
                new_text: { type: "string", description: "Replacement text." },
                replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
            },
            required: ["path", "old_text", "new_text"],
        },
    },
    {
        name: "find_files",
        description: "Find files by a glob-style pattern such as **/*.ts or src/*.tsx. Skips generated and dependency directories.",
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "Glob-style path pattern relative to the search directory." },
                path: { type: "string", description: 'Search directory relative to the workspace root. Defaults to ".".' },
            },
            required: ["pattern"],
        },
    },
    {
        name: "file_info",
        description: "Get a file or directory's type, size, and modification time.",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Path relative to the workspace root." } },
            required: ["path"],
        },
    },
    {
        name: "make_directory",
        description: "Create a directory and any missing parent directories within the workspace.",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Directory path relative to the workspace root." } },
            required: ["path"],
        },
    },
    {
        name: "move_path",
        description: "Move or rename a file or directory within the workspace. Refuses to overwrite an existing destination.",
        parameters: {
            type: "object",
            properties: {
                source: { type: "string", description: "Existing source path relative to the workspace root." },
                destination: { type: "string", description: "New destination path relative to the workspace root." },
            },
            required: ["source", "destination"],
        },
    },
    {
        name: "delete_path",
        description: "Delete a file or an empty directory within the workspace. Set recursive=true only when explicitly asked to delete a non-empty directory.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path relative to the workspace root." },
                recursive: { type: "boolean", description: "Allow deleting a non-empty directory tree." },
            },
            required: ["path"],
        },
    },
    {
        name: "list_dir",
        description: "List files and subdirectories at a path within the workspace. Capped at 500 entries — a truncation notice is appended as the last entry when a directory has more, listing a subdirectory instead of the root usually avoids it.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: 'Directory path, relative to the workspace root. Use "." for the root.' },
            },
            required: [],
        },
    },
    {
        name: "search_files",
        description: "Search for a text string across files in the workspace and return matching lines. Stops at 50 matches (a notice is appended when the cap is hit — there may be more that weren't found); binary files are skipped. Scope with `path` to a subdirectory for a more complete search of a specific area.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The text to search for (plain substring match, case-sensitive)." },
                path: { type: "string", description: 'Subdirectory to scope the search to, relative to the workspace root. Defaults to "."' },
            },
            required: ["query"],
        },
    },
    {
        name: "run_command",
        description:
            "Execute a shell command in the workspace (or a subdirectory of it) and return its stdout/stderr/exit code. Use for builds, tests, git, npm, etc. Commands that could affect the system outside the workspace (deleting elsewhere, shutting down the machine, privilege escalation, etc.) are rejected. Runs inside an OS-level sandbox confined to the workspace where the platform supports it (Linux with bubblewrap installed, macOS always) — on Windows this containment isn't available and only the command-text checks above apply.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to run." },
                cwd: { type: "string", description: 'Working directory for the command, relative to the workspace root. Defaults to "."' },
                network: { type: "boolean", description: "Whether this command needs network access (e.g. npm install, curl). Defaults to false — most commands don't need it." },
            },
            required: ["command"],
        },
    },
    {
        name: "run_code",
        description:
            "Run a Python or JavaScript code snippet in the workspace and return its stdout/stderr/exit code. A convenience over run_command for multi-line code (no shell-quoting to worry about) — subject to the same sandboxing (where available) and safety checks as run_command.",
        parameters: {
            type: "object",
            properties: {
                language: { type: "string", enum: ["python", "javascript"], description: "Which interpreter to run the code with." },
                code: { type: "string", description: "The full source code to execute." },
                cwd: { type: "string", description: 'Working directory, relative to the workspace root. Defaults to "."' },
                network: { type: "boolean", description: "Whether this code needs network access. Defaults to false." },
            },
            required: ["language", "code"],
        },
    },
    {
        name: "start_background_command",
        description:
            "Start a long-running command (dev server, build watcher, long test run) in the background and return immediately with a task id. Use get_background_output to check on it later and stop_background_command when done — unlike run_command, this doesn't block or time out. Subject to the same safety checks and sandboxing as run_command.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to run." },
                cwd: { type: "string", description: 'Working directory, relative to the workspace root. Defaults to "."' },
                name: { type: "string", description: "Short human-readable label for this task (e.g. \"dev server\")." },
                network: { type: "boolean", description: "Whether this command needs network access (e.g. a dev server that fetches data). Defaults to false." },
            },
            required: ["command"],
        },
    },
    {
        name: "get_background_output",
        description: "Get the current status and recent output of a background command started with start_background_command.",
        parameters: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "The task id returned by start_background_command." },
            },
            required: ["task_id"],
        },
    },
    {
        name: "stop_background_command",
        description: "Stop a running background command by its task id.",
        parameters: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "The task id returned by start_background_command." },
            },
            required: ["task_id"],
        },
    },
    {
        name: "list_background_commands",
        description: "List all background commands from this session with their status.",
        parameters: { type: "object", properties: {}, required: [] },
    },
    {
        name: "create_terminal",
        description:
            "Open a real interactive shell (a pseudo-terminal) in the workspace and return its id. Unlike run_command/start_background_command, this can be driven interactively over multiple turns — write_to_terminal to send input (including to a program already waiting for it, e.g. a REPL or a confirmation prompt), read_terminal_output to see what happened. Use this instead of start_background_command when you need to send input after the process has already started, not just read its output.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Short human-readable label (e.g. \"debug session\")." },
                cwd: { type: "string", description: 'Working directory, relative to the workspace root. Defaults to "."' },
            },
            required: [],
        },
    },
    {
        name: "write_to_terminal",
        description: "Send input to a terminal opened with create_terminal, as if typed at the keyboard. Include \\n (or \\r) to press Enter and actually run a typed command — without it, the text is typed but not submitted.",
        parameters: {
            type: "object",
            properties: {
                terminal_id: { type: "string", description: "The id returned by create_terminal." },
                input: { type: "string", description: "The text to send." },
            },
            required: ["terminal_id", "input"],
        },
    },
    {
        name: "read_terminal_output",
        description: "Read the recent output of a terminal opened with create_terminal.",
        parameters: {
            type: "object",
            properties: {
                terminal_id: { type: "string", description: "The id returned by create_terminal." },
                tail_chars: { type: "number", description: "How many characters of recent output to return, from the end. Defaults to 4000." },
            },
            required: ["terminal_id"],
        },
    },
    {
        name: "close_terminal",
        description: "Close a terminal opened with create_terminal, ending its shell process.",
        parameters: {
            type: "object",
            properties: {
                terminal_id: { type: "string", description: "The id returned by create_terminal." },
            },
            required: ["terminal_id"],
        },
    },
    {
        name: "git_status",
        description: "Show the working tree status (git status) for the workspace.",
        parameters: { type: "object", properties: {}, required: [] },
    },
    {
        name: "git_diff",
        description: "Show unstaged (or, if staged=true, staged) changes in the workspace as a unified diff.",
        parameters: {
            type: "object",
            properties: {
                staged: { type: "boolean", description: "Show staged changes (git diff --staged) instead of unstaged." },
                path: { type: "string", description: "Limit the diff to this file or directory, relative to the workspace root." },
            },
            required: [],
        },
    },
    {
        name: "git_log",
        description: "Show recent commit history for the workspace.",
        parameters: {
            type: "object",
            properties: {
                count: { type: "number", description: "How many commits to show. Defaults to 10." },
            },
            required: [],
        },
    },
    {
        name: "git_commit",
        description: "Stage all changes and create a commit in the workspace. Requires explicit approval, like write_file.",
        parameters: {
            type: "object",
            properties: {
                message: { type: "string", description: "The commit message." },
            },
            required: ["message"],
        },
    },
    {
        name: "git_blame",
        description: "Show who last changed each line of a tracked file, and in which commit — use to find context for a piece of code before changing it (e.g. why a workaround exists).",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path, relative to the workspace root." },
                start_line: { type: "number", description: "Optional: first line to blame (1-indexed). Omit to blame the whole file." },
                end_line: { type: "number", description: "Optional: last line to blame (inclusive). Required if start_line is given." },
            },
            required: ["path"],
        },
    },
    {
        name: "web_search",
        description: "Search the web for a query and return the top results (title, URL, snippet). Use this to find information not available locally.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The search query." },
            },
            required: ["query"],
        },
    },
    {
        name: "github_list_repositories",
        description: "List repositories accessible to the linked GitHub account. Use this to choose a repository for analysis.",
        parameters: {
            type: "object",
            properties: {
                visibility: { type: "string", enum: ["all", "public", "private"], description: "Repository visibility filter. Defaults to all." },
                limit: { type: "number", description: "Maximum repositories to return, from 1 to 100. Defaults to 30." },
            },
            required: [],
        },
    },
    {
        name: "github_repository_tree",
        description: "List the complete file tree of a GitHub repository so its structure can be analyzed before reading selected files.",
        parameters: {
            type: "object",
            properties: {
                repository: { type: "string", description: "Repository in owner/name form." },
                ref: { type: "string", description: "Branch, tag, or commit. Defaults to the repository's default branch." },
            },
            required: ["repository"],
        },
    },
    {
        name: "github_read_file",
        description: "Read a UTF-8 text file from a repository accessible to the linked GitHub account.",
        parameters: {
            type: "object",
            properties: {
                repository: { type: "string", description: "Repository in owner/name form." },
                path: { type: "string", description: "File path inside the repository." },
                ref: { type: "string", description: "Branch, tag, or commit. Defaults to the default branch." },
            },
            required: ["repository", "path"],
        },
    },
    {
        name: "fetch_url",
        description: "Fetch a web page by URL and return its readable text content (HTML tags stripped). Use after web_search to read a specific result, or for any URL the user provides.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The full URL to fetch, including https://." },
            },
            required: ["url"],
        },
    },
    {
        name: "http_request",
        description:
            "Make an HTTP request to any URL with a chosen method, headers, and body, and return the response status and body. Use this for calling REST APIs — fetch_url is for reading web pages, this is for actual API calls (GET/POST/PUT/PATCH/DELETE). Requires explicit approval, like write_file, since it can have side effects on external systems.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The full URL to request, including https://." },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Defaults to GET." },
                headers: { type: "object", properties: {}, description: "Request headers as a flat object of string values." },
                body: { type: "string", description: "Raw request body, e.g. a JSON string. Omit for GET/DELETE." },
            },
            required: ["url"],
        },
    },
    {
        name: "capture_page_screenshot",
        description:
            "Load a URL in a hidden browser window and return a screenshot of the rendered page as an image. Use this to visually inspect a web page or a local dev server (e.g. http://localhost:3000) — fetch_url only gives you the HTML/text, not what it actually looks like.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The full URL to load, including http:// or https://." },
                width: { type: "number", description: "Viewport width in pixels. Defaults to 1280." },
                height: { type: "number", description: "Viewport height in pixels. Defaults to 800." },
            },
            required: ["url"],
        },
    },
    {
        name: "find_symbol_references",
        description:
            "Find where a function, class, variable, or other identifier is defined and referenced across the workspace. Faster and more targeted than search_files for navigating code — use this before editing something to see everywhere it's used. Stops at 50 matches (a notice is appended when the cap is hit); binary files are skipped.",
        parameters: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "The identifier to search for (e.g. a function or class name)." },
                path: { type: "string", description: 'Subdirectory to scope the search to, relative to the workspace root. Defaults to "."' },
            },
            required: ["symbol"],
        },
    },
    {
        name: "apply_patch",
        description:
            "Apply a unified diff (the format produced by `git diff` / `diff -u`) across one or more files in a single call, instead of one replace_in_file call per file. Use this for multi-file refactors or when you already have a precise diff in mind. Requires explicit approval, like write_file.",
        parameters: {
            type: "object",
            properties: {
                patch: { type: "string", description: "The unified diff text, with --- /+++ file headers and @@ hunks." },
            },
            required: ["patch"],
        },
    },
    {
        name: "read_notes",
        description: "Read the agent's persistent notes for this workspace — a scratchpad for tracking long-running context, decisions, or progress across turns and sessions. Empty if nothing has been written yet.",
        parameters: { type: "object", properties: {}, required: [] },
    },
    {
        name: "write_notes",
        description: "Overwrite the agent's persistent notes for this workspace with the given content. Use this to record progress, decisions, or context worth remembering later in a long task — write the full notes each time, not just an addition.",
        parameters: {
            type: "object",
            properties: {
                content: { type: "string", description: "The full notes content to save, replacing whatever was there before." },
            },
            required: ["content"],
        },
    },
    {
        name: "set_plan",
        description:
            "Declare or update a step-by-step plan for the current task, shown to the user as a checklist. Call this once at the start of any multi-step task, then call it again (with the full updated list) whenever a step is completed or the plan changes. Always pass the complete list, not just changes.",
        parameters: {
            type: "object",
            properties: {
                steps: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            text: { type: "string", description: "Short description of this step." },
                            done: { type: "boolean", description: "Whether this step is already complete." },
                        },
                        required: ["text", "done"],
                    },
                    description: "The full, ordered list of steps.",
                },
            },
            required: ["steps"],
        },
    },
    {
        name: "request_checkpoint",
        description:
            "Pause and ask the user to confirm before continuing — use this after finishing a meaningful chunk of work or before starting something risky/irreversible, so the user can review progress rather than only finding out at the very end.",
        parameters: {
            type: "object",
            properties: {
                summary: { type: "string", description: "What's been done so far, in a sentence or two." },
                question: { type: "string", description: "What you'd like to confirm before continuing (optional)." },
            },
            required: ["summary"],
        },
    },
];
