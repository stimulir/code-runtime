/**
 * spawn_subagents — a Pi AgentTool that lets a coding agent fan out work to
 * child agents that run in parallel, each in its own isolated sandbox.
 *
 * ───────────────────────────────────────────────────────────────────────
 * WHY
 * ───────────────────────────────────────────────────────────────────────
 * Pi ships only bash/read/write/edit/find/grep/ls — no Task/subagent tool.
 * For exhaustive work (deep research over N sources, a migration across N
 * files) a single agent loop does them sequentially. This tool gives the
 * agent a real fan-out primitive so a SKILL.md can say "spawn one subagent
 * per candidate, research each in parallel, then synthesize."
 *
 * ───────────────────────────────────────────────────────────────────────
 * SHAPE
 * ───────────────────────────────────────────────────────────────────────
 * The tool is deliberately dumb: it validates the task list, runs each task
 * through an injected `runChild` callback under a concurrency bound, and
 * returns a compact JSON summary. `runChild` — supplied by session.ts, which
 * owns createAgentCorePiSession — is what actually spins up a child session
 * in a fresh sandbox and returns its final text. Keeping the recipe there
 * (not here) avoids a circular import and keeps the recursion guard
 * (depth < maxDepth) in one place.
 *
 * The tool NEVER throws out of a child: one failed/timed-out subagent returns
 * `{ ok: false, error }` and the batch continues. Child return text is capped
 * so a fan-out of long reports can't blow the parent's context — the parent
 * is meant to synthesize summaries, with full artifacts persisted to the
 * shared workspace by the children themselves.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

/** One child result, as returned by `runChild` and surfaced to the parent. */
export interface SubagentResult {
  label?: string;
  ok: boolean;
  text?: string;
  error?: string;
}

/** The child-runner session.ts injects — creates + runs one child to completion. */
export type SpawnChildRunner = (
  task: { prompt: string; label?: string; model?: string },
  signal?: AbortSignal,
) => Promise<SubagentResult>;

export interface SpawnSubagentsToolOptions {
  runChild: SpawnChildRunner;
  /** Concurrency cap when the caller doesn't pass one. Default 4. */
  defaultMaxConcurrency?: number;
  /** Per-child returned-text cap (chars) to protect the parent context. Default 6000. */
  childTextCap?: number;
}

const spawnSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      prompt: Type.String({ description: "The full, self-contained instruction for one child agent." }),
      label: Type.Optional(Type.String({ description: "Short name for this task (for the result summary)." })),
      model: Type.Optional(
        Type.String({ description: "Optional 'provider/modelId' override; defaults to the parent's model." }),
      ),
    }),
    { minItems: 1, description: "One entry per child agent. They run in parallel (bounded)." },
  ),
  maxConcurrency: Type.Optional(
    Type.Number({ description: "Max children running at once (default 4)." }),
  ),
});

export type SpawnSubagentsInput = Static<typeof spawnSchema>;

export interface SpawnSubagentsDetails {
  total: number;
  ok: number;
  failed: number;
}

/** Run `items` through `worker` with at most `limit` in flight. Order preserved. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export function createSpawnSubagentsTool(
  opts: SpawnSubagentsToolOptions,
): AgentTool<typeof spawnSchema, SpawnSubagentsDetails> {
  const cap = opts.childTextCap ?? 6000;
  return {
    name: "spawn_subagents",
    label: "spawn_subagents",
    description:
      "Fan out to child agents that run IN PARALLEL, each in its own isolated sandbox. " +
      "Give one task (a full instruction) per child; each returns its final text. " +
      "Use for exhaustive work — research N sources, process N items — then synthesize the results yourself. " +
      "Child output is capped; have children persist full artifacts to the workspace and return summaries.",
    parameters: spawnSchema,
    execute: async (_toolCallId, input, signal) => {
      if (signal?.aborted) throw new Error("Operation aborted");
      const limit = typeof input.maxConcurrency === "number" && input.maxConcurrency > 0
        ? Math.floor(input.maxConcurrency)
        : opts.defaultMaxConcurrency ?? 4;

      const results = await pool(input.tasks, limit, async (task) => {
        try {
          const r = await opts.runChild({ prompt: task.prompt, label: task.label, model: task.model }, signal);
          if (r.ok && r.text && r.text.length > cap) {
            return { ...r, text: r.text.slice(0, cap) + `\n\n[truncated at ${cap} chars]` };
          }
          return r;
        } catch (e) {
          return { label: task.label, ok: false, error: String(e) };
        }
      });

      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        details: { total: results.length, ok, failed },
      };
    },
  };
}
