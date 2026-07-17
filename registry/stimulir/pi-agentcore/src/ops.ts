/**
 * AgentCore-backed Pi tool operations — migration foundation.
 *
 * ───────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 * ───────────────────────────────────────────────────────────────────────
 *
 * Pi's coding tools (bash/read/write/edit/find/grep/ls) are constructed by
 * factories that accept pluggable `*Operations`. By default those operations
 * hit the LOCAL filesystem / local shell. This module supplies AgentCore-backed
 * operations so the SAME Pi tools execute inside an AWS Bedrock AgentCore
 * managed sandbox instead of on the host.
 *
 * This is the per-tool seam (complements runner/src/sandbox.ts, which owns the
 * staging + test-exec seam). Here we route the agent's LIVE tool calls into
 * AgentCore.
 *
 * ───────────────────────────────────────────────────────────────────────
 * PATH MODEL
 * ───────────────────────────────────────────────────────────────────────
 *
 * The Pi factories resolve every user-supplied path against `cwd` with
 * node:path (resolveToCwd → resolvePath(cwd, p)), so our operations always
 * receive an ABSOLUTE host-style path rooted at the sentinel `cwd` we pass in.
 * AgentCore, by contrast, reads/writes/execs relative to its own session cwd
 * (/opt/amazon/genesis1p-tools/var) and its writeFile auto-creates nested dirs.
 *
 * So we map `cwd`-absolute → sandbox-relative with `path.relative(cwd, abs)`
 * (stripping any leading "./"), matching the relative-path convention the
 * BedrockAgentCoreSandboxProvider in sandbox.ts uses.
 *
 * ───────────────────────────────────────────────────────────────────────
 * COVERAGE / ROUGH EDGES (see report)
 * ───────────────────────────────────────────────────────────────────────
 *  - bash  : fully in-sandbox (sandbox.exec). Exact exit code threaded through.
 *  - read  : fully in-sandbox (sandbox.readFile → Buffer).
 *  - write : fully in-sandbox (sandbox.writeFile; auto-mkdir, so mkdir is a no-op).
 *  - edit  : fully in-sandbox. The factory owns the fuzzy find/replace; we only
 *            supply readFile/writeFile/access.
 *  - find  : fully in-sandbox via `glob` op (sandbox.exec "find …"). The factory
 *            fully delegates to glob when provided.
 *  - ls    : fully in-sandbox via exists/stat/readdir ops (sandbox.exec).
 *  - grep  : NOT in-sandbox. createGrepTool ALWAYS spawns a LOCAL ripgrep on the
 *            resolved (sentinel-absolute) searchPath, which does not exist on the
 *            host → it errors. The GrepOperations (isDirectory/readFile) only feed
 *            the dir pre-check + context-line rendering, not the search engine, so
 *            they cannot redirect the search into AgentCore. We provide compliant
 *            ops to satisfy the interface but grep is non-functional against the
 *            sandbox via this factory. See report.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
// The factories are re-exported from the package root (./core/sdk.js). The
// package's exports map only exposes "." and "./hooks", so deep imports into
// dist/core/tools/* are not resolvable — import from the root entrypoint.
import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import { relative as pathRelative } from "node:path";

/**
 * Structural view of the AgentCore sandbox surface we touch. Kept structural
 * (not an import of the concrete class) so this module stays decoupled from the
 * runtime package the same way sandbox.ts is — pass a real AgentCoreSandbox at
 * the call site.
 */
export interface AgentCoreSandboxLike {
  exec(command: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    isError: boolean;
  }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/** The bundle of constructed Pi AgentTools, all backed by one AgentCore session. */
export interface AgentCorePiTools {
  bash: AgentTool<any>;
  read: AgentTool<any>;
  write: AgentTool<any>;
  edit: AgentTool<any>;
  find: AgentTool<any>;
  grep: AgentTool<any>;
  ls: AgentTool<any>;
}

/** Single-quote a string for safe interpolation into a bash command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Map a `cwd`-absolute path (as produced by Pi's resolveToCwd) to the
 * sandbox-relative path AgentCore expects. Leading "./" stripped; the sentinel
 * cwd itself maps to "." (the session cwd).
 */
function toSandboxRel(absolutePath: string, cwd: string): string {
  const rel = pathRelative(cwd, absolutePath);
  if (rel === "" ) return ".";
  return rel.replace(/^\.\//, "");
}

/**
 * Build AgentCore-backed Pi tools. `cwd` is the sentinel root the factories
 * resolve paths against; it never touches the host filesystem — it only anchors
 * the relativization. Use a stable sentinel like "/sandbox" at the call site.
 */
export function createAgentCorePiTools(
  sandbox: AgentCoreSandboxLike,
  cwd: string,
): AgentCorePiTools {
  // ── bash ──────────────────────────────────────────────────────────────
  // Run the command in AgentCore's session cwd via sandbox.exec, stream the
  // combined stdout+stderr to onData once, and return the EXACT exit code.
  const bash = createBashTool(cwd, {
    operations: {
      exec: async (command, _cwd, { onData, signal, timeout }) => {
        if (signal?.aborted) throw new Error("aborted");

        // Honor timeout best-effort: `timeout` arrives in SECONDS at this
        // boundary (the schema + createLocalBashOperations treat it as seconds,
        // multiplying by 1000 only for setTimeout). Wrap with coreutils
        // `timeout Ns` so an over-running command is killed in-sandbox and
        // surfaces a non-zero exit (124) rather than hanging.
        let full = command;
        if (typeof timeout === "number" && timeout > 0) {
          const secs = Math.max(1, Math.ceil(timeout));
          full = `timeout ${secs}s bash -c ${shQuote(command)}`;
        }

        const r = await sandbox.exec(full);

        // Stream the combined stream once (Pi buffers/truncates downstream).
        const combined = (r.stdout ?? "") + (r.stderr ?? "");
        if (combined.length > 0) {
          onData(Buffer.from(combined, "utf-8"));
        }

        // Exact exit code from AgentCore's structuredContent. Fall back to the
        // tool-level isError flag only when exitCode is null (never conflate a
        // pass with a fail).
        const exitCode =
          typeof r.exitCode === "number" ? r.exitCode : r.isError ? 1 : 0;
        return { exitCode };
      },
    },
  });

  // ── read ──────────────────────────────────────────────────────────────
  // ReadOperations.readFile MUST return a Buffer. detectImageMimeType is
  // optional and omitted (everything is treated as text — fine for code).
  const read = createReadTool(cwd, {
    operations: {
      readFile: async (absolutePath) =>
        Buffer.from(await sandbox.readFile(toSandboxRel(absolutePath, cwd)), "utf-8"),
      access: async (absolutePath) => {
        await assertReadable(sandbox, toSandboxRel(absolutePath, cwd));
      },
    },
  });

  // ── write ─────────────────────────────────────────────────────────────
  // AgentCore writeFile auto-creates parent dirs, so mkdir is a no-op.
  const write = createWriteTool(cwd, {
    operations: {
      writeFile: async (absolutePath, content) =>
        sandbox.writeFile(toSandboxRel(absolutePath, cwd), content),
      mkdir: async () => {
        /* AgentCore writeFile auto-creates nested dirs; nothing to do. */
      },
    },
  });

  // ── edit ──────────────────────────────────────────────────────────────
  // The factory owns the fuzzy find/replace + diff; we only supply file I/O.
  // readFile MUST return a Buffer (same as read).
  const edit = createEditTool(cwd, {
    operations: {
      readFile: async (absolutePath) =>
        Buffer.from(await sandbox.readFile(toSandboxRel(absolutePath, cwd)), "utf-8"),
      writeFile: async (absolutePath, content) =>
        sandbox.writeFile(toSandboxRel(absolutePath, cwd), content),
      access: async (absolutePath) => {
        await assertReadable(sandbox, toSandboxRel(absolutePath, cwd));
      },
    },
  });

  // ── find ──────────────────────────────────────────────────────────────
  // The factory fully delegates to `glob` when provided. We run `find` IN the
  // sandbox (relative to the searchDir) and return paths UNDER searchPath so the
  // factory's `p.slice(searchPath.length+1)` relativization works. searchPath is
  // the sentinel-absolute dir the factory passes us.
  const find = createFindTool(cwd, {
    operations: {
      exists: async (absolutePath) =>
        await pathExists(sandbox, toSandboxRel(absolutePath, cwd)),
      glob: async (pattern, searchPath, options) => {
        const relDir = toSandboxRel(searchPath, cwd);
        // Translate the glob into a find -path expression rooted at relDir.
        // `find -path` matches against the printed path; -name is too narrow for
        // patterns with slashes, so use -path with a leading prefix.
        const cmd =
          `cd ${shQuote(relDir)} 2>/dev/null && ` +
          `find . -path ${shQuote("./" + pattern)} -not -path '*/node_modules/*' ` +
          `-not -path '*/.git/*' 2>/dev/null | head -n ${Math.max(1, options.limit)}`;
        const r = await sandbox.exec(cmd);
        const lines = (r.stdout ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((l) => l.replace(/^\.\//, ""));
        // Return absolute-under-searchPath so the factory relativizes correctly.
        return lines.map((l) => `${searchPath}/${l}`);
      },
    },
  });

  // ── grep ──────────────────────────────────────────────────────────────
  // NOTE: createGrepTool ALWAYS spawns a LOCAL ripgrep on searchPath; these ops
  // only feed the dir pre-check + context-line read. They cannot move the search
  // engine into AgentCore. Provided for interface-compliance only — grep does
  // not function against the sandbox via this factory. See module header / report.
  const grep = createGrepTool(cwd, {
    operations: {
      isDirectory: async (absolutePath) =>
        await isDirectory(sandbox, toSandboxRel(absolutePath, cwd)),
      readFile: async (absolutePath) =>
        await sandbox.readFile(toSandboxRel(absolutePath, cwd)),
    },
  });

  // ── ls ────────────────────────────────────────────────────────────────
  const ls = createLsTool(cwd, {
    operations: {
      exists: async (absolutePath) =>
        await pathExists(sandbox, toSandboxRel(absolutePath, cwd)),
      stat: async (absolutePath) => {
        const isDir = await isDirectory(sandbox, toSandboxRel(absolutePath, cwd));
        return { isDirectory: () => isDir };
      },
      readdir: async (absolutePath) => {
        const rel = toSandboxRel(absolutePath, cwd);
        // -A: include dotfiles, exclude . and ..; -1: one entry per line.
        const r = await sandbox.exec(`ls -A1 ${shQuote(rel)}`);
        return (r.stdout ?? "")
          .split("\n")
          .map((l) => l.replace(/\r$/, ""))
          .filter((l) => l.length > 0);
      },
    },
  });

  return { bash, read, write, edit, find, grep, ls };
}

// ── sandbox-exec helpers ──────────────────────────────────────────────────

/** Throw if the file is not readable in the sandbox (mirrors fs.access semantics). */
async function assertReadable(
  sandbox: AgentCoreSandboxLike,
  rel: string,
): Promise<void> {
  const r = await sandbox.exec(`test -r ${shQuote(rel)}`);
  const code = typeof r.exitCode === "number" ? r.exitCode : r.isError ? 1 : 0;
  if (code !== 0) {
    throw new Error(`Not readable: ${rel}`);
  }
}

/** True if the path exists in the sandbox. */
async function pathExists(
  sandbox: AgentCoreSandboxLike,
  rel: string,
): Promise<boolean> {
  const r = await sandbox.exec(`test -e ${shQuote(rel)}`);
  const code = typeof r.exitCode === "number" ? r.exitCode : r.isError ? 1 : 0;
  return code === 0;
}

/** True if the path is a directory in the sandbox. Throws if it does not exist. */
async function isDirectory(
  sandbox: AgentCoreSandboxLike,
  rel: string,
): Promise<boolean> {
  const r = await sandbox.exec(
    `if [ -e ${shQuote(rel)} ]; then if [ -d ${shQuote(rel)} ]; then exit 0; else exit 1; fi; else exit 2; fi`,
  );
  const code = typeof r.exitCode === "number" ? r.exitCode : r.isError ? 1 : 0;
  if (code === 2) throw new Error(`Path not found: ${rel}`);
  return code === 0;
}
