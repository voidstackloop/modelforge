/**
 * VaultService — the filesystem spine of the MasterVault MCP server.
 *
 * Every path that enters this class is resolved and confined to the vault root
 * BEFORE any filesystem call happens. This is the single security boundary of
 * the server: "point it at any vault" is only safe because nothing here can
 * touch a path outside `vaultRoot`, including via `..` traversal or a symlink
 * that resolves out of the tree.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import {
  TEXT_EXTENSIONS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../constants.js";

export interface ReadResult {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  size: number;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
}

export interface ListResult {
  path: string;
  total: number;
  count: number;
  offset: number;
  entries: DirEntry[];
  has_more: boolean;
  next_offset?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  query: string;
  total: number;
  count: number;
  hits: SearchHit[];
  truncated: boolean;
}

/** Raised for any path that escapes the vault root. Caught by the tool layer
 *  and turned into an actionable error message. */
export class PathSecurityError extends Error {
  constructor(requested: string) {
    super(
      `Path '${requested}' resolves outside the vault root and was rejected. ` +
        `All paths must be relative to the vault and must not escape it.`
    );
    this.name = "PathSecurityError";
  }
}

export class VaultService {
  private readonly vaultRoot: string;

  constructor(vaultRoot: string) {
    // Resolve to an absolute, normalized path once at construction.
    this.vaultRoot = path.resolve(vaultRoot);
  }

  /** The absolute vault root, for diagnostics. */
  getRoot(): string {
    return this.vaultRoot;
  }

  /**
   * Confine an arbitrary client-supplied relative path to the vault root.
   * Returns the absolute path if safe; throws PathSecurityError otherwise.
   * Rejects absolute paths, `..` traversal, and null bytes up front.
   */
  private confine(relPath: string): string {
    if (relPath.includes("\0")) {
      throw new PathSecurityError(relPath);
    }
    // Treat a leading slash as vault-relative, not filesystem-absolute.
    const cleaned = relPath.replace(/^[/\\]+/, "");
    const resolved = path.resolve(this.vaultRoot, cleaned);
    // The resolved path must be the root itself or sit strictly beneath it.
    const rel = path.relative(this.vaultRoot, resolved);
    if (rel === "") return resolved; // the root itself
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathSecurityError(relPath);
    }
    return resolved;
  }

  /**
   * A second, defense-in-depth check performed AFTER resolving symlinks on an
   * existing path. `confine` catches lexical traversal; this catches a symlink
   * inside the vault that points outside it. Used before reads/moves of paths
   * that already exist.
   */
  private async assertRealPathInside(absPath: string): Promise<void> {
    try {
      const real = await fs.realpath(absPath);
      const rel = path.relative(this.vaultRoot, real);
      if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
        throw new PathSecurityError(absPath);
      }
    } catch (err) {
      // ENOENT: path doesn't exist yet (e.g. a write target). That's fine —
      // the lexical `confine` check already guaranteed the intended location
      // is inside the vault. Re-throw anything that is a security error.
      if (err instanceof PathSecurityError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  /** Vault-relative POSIX-style path for display in results. */
  private toRel(absPath: string): string {
    return path.relative(this.vaultRoot, absPath).split(path.sep).join("/");
  }

  /**
   * Boolean sibling of assertRealPathInside, for filtering during a
   * recursive walk (search) rather than rejecting the whole operation — one
   * escaping symlink encountered mid-walk should be silently skipped, not
   * abort every other file's search results. `read()`/`list()`/etc. already
   * guard their own single target the same way `assertRealPathInside`
   * always has; `walk()` below is the equivalent guard for every path a
   * recursive search visits, file or directory.
   */
  private async isRealPathInside(absPath: string): Promise<boolean> {
    try {
      const real = await fs.realpath(absPath);
      const rel = path.relative(this.vaultRoot, real);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    } catch {
      return false;
    }
  }

  /** Read a text file, optionally by 1-indexed inclusive line range. */
  async read(
    relPath: string,
    startLine?: number,
    endLine?: number
  ): Promise<ReadResult> {
    const abs = this.confine(relPath);
    await this.assertRealPathInside(abs);
    const raw = await fs.readFile(abs, "utf-8");
    const stat = await fs.stat(abs);

    let content = raw;
    let frontmatter: Record<string, unknown> = {};
    // Parse frontmatter only for markdown; leave other formats byte-faithful.
    if (path.extname(abs).toLowerCase() === ".md") {
      const parsed = matter(raw);
      frontmatter = parsed.data as Record<string, unknown>;
    }

    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split("\n");
      const s = Math.max(1, startLine ?? 1);
      const e = Math.min(lines.length, endLine ?? lines.length);
      content = lines.slice(s - 1, e).join("\n");
    }

    return {
      path: this.toRel(abs),
      content,
      frontmatter,
      size: stat.size,
    };
  }

  /** List a directory with pagination. */
  async list(
    relPath: string,
    offset = 0,
    limit = DEFAULT_LIMIT
  ): Promise<ListResult> {
    const abs = this.confine(relPath || ".");
    await this.assertRealPathInside(abs);
    const dirents = await fs.readdir(abs, { withFileTypes: true });

    const all: DirEntry[] = [];
    for (const d of dirents) {
      const childAbs = path.join(abs, d.name);
      let size = 0;
      let type: "file" | "directory" = d.isDirectory() ? "directory" : "file";
      try {
        const st = await fs.stat(childAbs);
        size = st.size;
        type = st.isDirectory() ? "directory" : "file";
      } catch {
        // Broken symlink or race; report what we know from the dirent.
      }
      all.push({ name: d.name, path: this.toRel(childAbs), type, size });
    }

    // Directories first, then alphabetical — stable, predictable ordering.
    all.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const capped = Math.min(limit, MAX_LIMIT);
    const page = all.slice(offset, offset + capped);
    const hasMore = all.length > offset + page.length;

    return {
      path: this.toRel(abs) || ".",
      total: all.length,
      count: page.length,
      offset,
      entries: page,
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + page.length } : {}),
    };
  }

  /** Recursively collect text-file paths under a directory (vault-relative).
   *  Every entry — directory or file — is realpath-checked before being
   *  descended into or collected, so a symlink placed inside the vault
   *  (e.g. by an external sync tool, not by this server) that resolves
   *  outside it can never be traversed or read through search(), the same
   *  guarantee every other VaultService method already gives its own
   *  single target. */
  private async walk(absDir: string, acc: string[]): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const childAbs = path.join(absDir, d.name);
      if (d.isDirectory()) {
        if (await this.isRealPathInside(childAbs)) {
          await this.walk(childAbs, acc);
        }
      } else if (TEXT_EXTENSIONS.has(path.extname(d.name).toLowerCase())) {
        if (await this.isRealPathInside(childAbs)) {
          acc.push(childAbs);
        }
      }
    }
  }

  /** Full-text (case-insensitive substring) search across the vault. */
  async search(
    query: string,
    subdir = "",
    limit = DEFAULT_LIMIT
  ): Promise<SearchResult> {
    const base = this.confine(subdir || ".");
    await this.assertRealPathInside(base);
    const files: string[] = [];
    await this.walk(base, files);

    const needle = query.toLowerCase();
    const capped = Math.min(limit, MAX_LIMIT);
    const hits: SearchHit[] = [];
    let total = 0;

    for (const abs of files) {
      let text: string;
      try {
        text = await fs.readFile(abs, "utf-8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          total++;
          if (hits.length < capped) {
            hits.push({
              path: this.toRel(abs),
              line: i + 1,
              text: lines[i].trim().slice(0, 300),
            });
          }
        }
      }
    }

    return {
      query,
      total,
      count: hits.length,
      hits,
      truncated: total > hits.length,
    };
  }

  /** Create or overwrite a file. Creates parent directories as needed. */
  async write(relPath: string, content: string): Promise<{ path: string; bytes: number }> {
    const abs = this.confine(relPath);
    await this.assertRealPathInside(path.dirname(abs));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    const stat = await fs.stat(abs);
    return { path: this.toRel(abs), bytes: stat.size };
  }

  /** Append content to a file (creating it if absent). Used by log_decision. */
  async append(relPath: string, content: string): Promise<{ path: string; bytes: number }> {
    const abs = this.confine(relPath);
    await this.assertRealPathInside(path.dirname(abs));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, content, "utf-8");
    const stat = await fs.stat(abs);
    return { path: this.toRel(abs), bytes: stat.size };
  }

  /** Check whether a vault-relative path exists. */
  async exists(relPath: string): Promise<boolean> {
    try {
      const abs = this.confine(relPath);
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  /** Move a file within the vault (both ends confined). Used by stage_delete. */
  async move(
    fromRel: string,
    toRel: string,
    overwrite = false
  ): Promise<{ from: string; to: string }> {
    const fromAbs = this.confine(fromRel);
    const toAbs = this.confine(toRel);
    await this.assertRealPathInside(fromAbs);
    await this.assertRealPathInside(path.dirname(toAbs));

    if (!overwrite) {
      try {
        await fs.access(toAbs);
        throw new Error(
          `Destination '${this.toRel(toAbs)}' already exists. ` +
            `Choose a different name or set overwrite=true.`
        );
      } catch (err) {
        // Only proceed if the error was "does not exist".
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
    }

    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    return { from: this.toRel(fromAbs), to: this.toRel(toAbs) };
  }
}
