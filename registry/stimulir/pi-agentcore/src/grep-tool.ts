/**
 * AgentCore-backed grep AgentTool — the in-sandbox replacement for Pi's
 * non-functional factory grep.
 *
 * ───────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────
 *
 * Pi's `createGrepTool` ALWAYS spawns a LOCAL ripgrep on the resolved
 * (sentinel-absolute) search path (see agentcore-pi-ops.ts module header).
 * Its `GrepOperations` only feed the directory pre-check + context-line
 * rendering — they cannot redirect the search engine into the sandbox. So
 * against an AgentCore session, the factory grep errors (the host path does
 * not exist).
 *
 * This module supplies a DROP-IN replacement: same tool name (`grep`), same
 * input schema (pattern / path? / glob? / ignoreCase? / literal? / context? /
 * limit?), but `execute` runs `grep -rn …` (preferring `rg` if available)
 * INSIDE the AgentCore sandbox via `sandbox.exec`, and returns the matches in
 * Pi's `file:line:content` shape. It slots straight into
 * `baseToolsOverride.grep`.
 *
 * ───────────────────────────────────────────────────────────────────────
 * PATH MODEL (identical to agentcore-pi-ops.ts)
 * ───────────────────────────────────────────────────────────────────────
 *
 * Pi resolves the user-supplied `path` against `cwd` (cwd-absolute), so we
 * relativize back to the sandbox session cwd with `path.relative(cwd, abs)`.
 * Default search root is the session cwd (".").
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { relative as pathRelative, isAbsolute as pathIsAbsolute } from "node:path";

/** Structural view of the AgentCore surface this tool touches. */
export interface AgentCoreGrepSandboxLike {
  exec(command: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    isError: boolean;
  }>;
}

const DEFAULT_LIMIT = 100;

/**
 * Schema mirrors Pi's grep schema field-for-field (rebuilt here because the
 * factory's `grepSchema` is module-local and not exported).
 */
const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(
    Type.String({ description: "Directory or file to search (default: current directory)" }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search (default: false)" }),
  ),
  literal: Type.Optional(
    Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
  ),
  context: Type.Optional(
    Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of matches to return (default: 100)" }),
  ),
});

export type AgentCoreGrepInput = Static<typeof grepSchema>;

export interface AgentCoreGrepDetails {
  /** Engine actually used in-sandbox. */
  engine: "rg" | "grep";
  /** Total match lines returned (after the limit cap). */
  matchCount: number;
  /** True if the limit truncated the result. */
  matchLimitReached: boolean;
}

/** Single-quote a string for safe interpolation into a bash command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Map a cwd-absolute path (as produced by Pi's path resolution) to the
 * sandbox-relative path AgentCore expects. The session cwd maps to ".".
 * Already-relative inputs are passed through (defensive — Pi normally
 * absolutizes, but a raw relative path is still meaningful in-sandbox).
 */
function toSandboxRel(p: string, cwd: string): string {
  if (!pathIsAbsolute(p)) {
    return p === "" || p === "." ? "." : p.replace(/^\.\//, "");
  }
  const rel = pathRelative(cwd, p);
  if (rel === "") return ".";
  return rel.replace(/^\.\//, "");
}

/**
 * Build an AgentCore-backed grep AgentTool. `cwd` is the same sentinel/session
 * root passed to `createAgentCorePiTools` — it anchors path relativization and
 * never touches the host filesystem.
 */
export function createAgentCoreGrepTool(
  sandbox: AgentCoreGrepSandboxLike,
  cwd: string,
): AgentTool<typeof grepSchema, AgentCoreGrepDetails> {
  return {
    name: "grep",
    label: "grep",
    description:
      `Search file contents for a pattern. Returns matching lines with file ` +
      `paths and line numbers. Runs inside the AgentCore sandbox (prefers ` +
      `ripgrep, falls back to grep -rn). Output is truncated to ${DEFAULT_LIMIT} ` +
      `matches.`,
    parameters: grepSchema,
    execute: async (_toolCallId, input, signal) => {
      if (signal?.aborted) throw new Error("Operation aborted");

      const { pattern, path: searchPath, glob, ignoreCase, literal, context, limit } = input;
      const max = typeof limit === "number" && limit > 0 ? limit : DEFAULT_LIMIT;
      const relDir = toSandboxRel(searchPath ?? ".", cwd);

      // Probe for ripgrep once; prefer it (gitignore-aware, faster), else grep.
      const probe = await sandbox.exec("command -v rg >/dev/null 2>&1 && echo rg || echo grep");
      const engine: "rg" | "grep" =
        (probe.stdout ?? "").trim() === "rg" ? "rg" : "grep";

      let cmd: string;
      if (engine === "rg") {
        // rg: -n line numbers, --no-heading + : separator for file:line:text,
        // -e for an explicit pattern (so leading-dash patterns are safe).
        // rg is gitignore-aware, but the sandbox cwd often has no .gitignore
        // (e.g. a bare node_modules tree), so add explicit excludes to match
        // the grep branch and avoid flooding on vendored dirs.
        const flags = [
          "--no-heading",
          "--color=never",
          "-n",
          ignoreCase ? "-i" : "",
          literal ? "-F" : "",
          typeof context === "number" && context > 0 ? `-C ${Math.floor(context)}` : "",
          "-g '!node_modules'",
          "-g '!.git'",
          glob ? `-g ${shQuote(glob)}` : "",
          `-m ${max}`, // per-file cap; head below enforces the global cap
        ]
          .filter(Boolean)
          .join(" ");
        cmd =
          `rg ${flags} -e ${shQuote(pattern)} -- ${shQuote(relDir)} 2>/dev/null ` +
          `| head -n ${max}`;
      } else {
        // grep -rn recursive with line numbers; -E regex / -F literal; -i case;
        // -C context. --include applies the glob. Exclude noise dirs.
        const flags = [
          "-rn",
          ignoreCase ? "-i" : "",
          literal ? "-F" : "-E",
          typeof context === "number" && context > 0 ? `-C ${Math.floor(context)}` : "",
          glob ? `--include=${shQuote(glob)}` : "",
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
        ]
          .filter(Boolean)
          .join(" ");
        cmd =
          `grep ${flags} -e ${shQuote(pattern)} -- ${shQuote(relDir)} 2>/dev/null ` +
          `| head -n ${max}`;
      }

      const r = await sandbox.exec(cmd);
      const lines = (r.stdout ?? "")
        .split("\n")
        .map((l) => l.replace(/\r$/, ""))
        .filter((l) => l.length > 0);

      const matchLimitReached = lines.length >= max;
      const text =
        lines.length === 0
          ? `No matches found for pattern: ${pattern}`
          : lines.join("\n") +
            (matchLimitReached ? `\n\n[truncated at ${max} matches]` : "");

      return {
        content: [{ type: "text", text }],
        details: {
          engine,
          matchCount: lines.length,
          matchLimitReached,
        },
      };
    },
  };
}
