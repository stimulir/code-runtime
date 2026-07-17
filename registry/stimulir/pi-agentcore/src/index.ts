/**
 * @stimulir/code-runtime-pi-agentcore
 *
 * AgentCore-backed Pi coding tools + a direct Pi `AgentSession` that runs them
 * via `baseToolsOverride`.
 *
 * WHY: a lightweight, in-process Pi agent can run its bash/read/write/edit/
 * grep/find/ls tools inside AWS-managed Bedrock AgentCore sandboxes — the
 * OOM-free, horizontally-scalable alternative to an in-process VM. The caller's
 * container memory stays flat under concurrency because tool-execution is
 * offloaded to a managed per-session sandbox.
 *
 * TWO ENTRY POINTS:
 *
 *   1) Tools — `createAgentCorePiTools(sandbox, cwd)` yields the seven Pi
 *      AgentTools (bash/read/write/edit/find/grep/ls) backed by one AgentCore
 *      session. `createAgentCoreGrepTool(sandbox, cwd)` is the in-sandbox grep
 *      replacement (the factory grep is non-functional against AgentCore — see
 *      grep-tool.ts). Wire these into your own AgentSession's baseToolsOverride.
 *
 *   2) Full session — `createAgentCorePiSession(opts)` constructs a real Pi
 *      `AgentSession` with the AgentCore tool bundle already injected via
 *      `baseToolsOverride` (grep swapped for the in-sandbox tool). Subscribe +
 *      prompt and every live tool call runs in AgentCore.
 *
 * Verified against live AgentCore (eu-west-2):
 *   - 8/8 tool ops executed in-sandbox (pi-agentcore-ops-smoke).
 *   - a live LLM turn drove the tools end-to-end (pi-agentcore-turn-smoke).
 */

export { createAgentCorePiTools } from "./ops.js";
export type {
  AgentCoreSandboxLike,
  AgentCorePiTools,
} from "./ops.js";

export { createAgentCoreGrepTool } from "./grep-tool.js";
export type {
  AgentCoreGrepSandboxLike,
  AgentCoreGrepInput,
  AgentCoreGrepDetails,
} from "./grep-tool.js";

export { createAgentCorePiSession } from "./session.js";
export type {
  AgentCorePiSessionSandbox,
  SpawnableChildSandbox,
  CreateAgentCorePiSessionOpts,
  AgentCorePiSession,
} from "./session.js";

export { createSpawnSubagentsTool } from "./spawn-subagent-tool.js";
export type {
  SpawnChildRunner,
  SubagentResult,
  SpawnSubagentsToolOptions,
  SpawnSubagentsInput,
  SpawnSubagentsDetails,
} from "./spawn-subagent-tool.js";
