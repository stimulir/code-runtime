/**
 * Pi-session-on-AgentCore — the integration layer.
 *
 * ───────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 * ───────────────────────────────────────────────────────────────────────
 *
 * Constructs a real Pi `AgentSession` whose LIVE coding tools execute inside
 * an AWS Bedrock AgentCore sandbox. A real LLM turn drives bash/read/write/
 * edit/find/grep/ls, and every one of those operations runs in AgentCore (not
 * on the host).
 *
 * The injection seam is `AgentSession`'s `baseToolsOverride`: a
 * `Record<string, AgentTool>` that FULLY replaces Pi's built-in coding tools.
 * The active tool set then becomes `Object.keys(baseToolsOverride)` (verified
 * in agent-session.js _buildRuntime: `defaultActiveToolNames = baseToolsOverride
 * ? Object.keys(baseToolsOverride) : [...]`). We pass `initialActiveToolNames`
 * explicitly too — belt and suspenders so all 7 tools are guaranteed active.
 *
 * ───────────────────────────────────────────────────────────────────────
 * WHY NOT createStimulirAgentSession / createAgentSession?
 * ───────────────────────────────────────────────────────────────────────
 *
 * Both convenience fns build the `Agent` + `AgentSession` internally and do
 * NOT expose `baseToolsOverride`. So we inline the two recipes:
 *   - manager wiring from registry/stimulir/core/src/index.ts
 *     (createStimulirAgentSession) — AuthStorage / ModelRegistry / explicit
 *     find-guard / SettingsManager / DefaultResourceLoader / SessionManager.
 *   - Agent + AgentSession construction from the SDK's createAgentSession
 *     (dist/core/sdk.js lines 159-234) — the getApiKey / convertToLlm /
 *     onPayload / transformContext callbacks + the AgentSession config.
 *
 * The one non-obvious must-have: the Agent's `getApiKey` callback. Without it,
 * `session.prompt()` throws "No API key found" — the key is resolved per-call
 * via `modelRegistry.getApiKeyForProvider`, NOT from auth.json. (Our models.json
 * declares `apiKey: "OPENROUTER_API_KEY"` + `authHeader: true`, so the value
 * comes from that env var.)
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  AgentSession,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  DefaultResourceLoader,
  SessionManager,
  convertToLlm,
} from "@mariozechner/pi-coding-agent";
import {
  createAgentCorePiTools,
  type AgentCoreSandboxLike,
} from "./ops.js";
import {
  createAgentCoreGrepTool,
  type AgentCoreGrepSandboxLike,
} from "./grep-tool.js";
import { createSpawnSubagentsTool } from "./spawn-subagent-tool.js";

/** The sandbox surface this layer needs (union of the two tool modules'). */
export type AgentCorePiSessionSandbox = AgentCoreSandboxLike & AgentCoreGrepSandboxLike;

/** A child sandbox factory returns a session sandbox plus optional lifecycle. */
export type SpawnableChildSandbox = AgentCorePiSessionSandbox & {
  start?(): Promise<unknown>;
  dispose?(): Promise<unknown>;
};

export interface CreateAgentCorePiSessionOpts {
  /** Live, started AgentCore sandbox session. */
  sandbox: AgentCorePiSessionSandbox;
  /**
   * The cwd the Pi managers + tools resolve against. MUST be a real host
   * directory (DefaultResourceLoader.reload() and SettingsManager read it on
   * the host). An empty temp dir is ideal: nothing is loaded, and tool paths
   * relativize to the sandbox session cwd identically to a sentinel.
   */
  cwd: string;
  /** Host dir containing models.json + settings.json (+ auth.json path). */
  agentDir: string;
  /** Provider name as it appears in models.json (e.g. "openrouter"). */
  provider: string;
  /** Model id as it appears in models.json (e.g. "openai/gpt-4o-mini"). */
  modelId: string;
  /** Optional system prompt appended to Pi's default coding prompt. */
  appendSystemPrompt?: string;
  /** Optional thinking level (model-dependent). Default "off". */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Factory for a fresh child sandbox. When provided (and depth < maxDepth),
   * the session gains a `spawn_subagents` tool that fans work out to child
   * agents, each running in its own isolated sandbox from this factory. Omit
   * to disable subagent spawning entirely.
   */
  spawnChildSandbox?: () => Promise<SpawnableChildSandbox>;
  /** Current recursion depth (0 = top-level). Internal — children set depth+1. */
  depth?: number;
  /** Max spawn depth. Default 1 (children cannot spawn grandchildren). */
  maxDepth?: number;
  /** Default concurrency cap for spawn_subagents. Default 4. */
  maxConcurrency?: number;
}

export interface AgentCorePiSession {
  /** The constructed Pi AgentSession (full surface: subscribe/prompt/etc). */
  session: AgentSession;
  /** Active tool names at construction time (should be the 7 AgentCore tools). */
  activeToolNames: string[];
}

/**
 * Build a Pi AgentSession whose live tools execute in the given AgentCore
 * sandbox. Throws (loudly) if the model isn't registered in models.json —
 * the explicit find-guard from createStimulirAgentSession.
 */
export async function createAgentCorePiSession(
  opts: CreateAgentCorePiSessionOpts,
): Promise<AgentCorePiSession> {
  const {
    sandbox,
    cwd,
    agentDir,
    provider,
    modelId,
    appendSystemPrompt,
    thinkingLevel = "off",
  } = opts;

  // ── 1. Auth + model registry (explicit paths into agentDir) ────────────
  const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
  const modelRegistry = new ModelRegistry(authStorage, `${agentDir}/models.json`);

  // ── 2. EXPLICIT model resolution — the silent-no-engagement guard. ─────
  const model = modelRegistry.find(provider, modelId);
  const registryError = modelRegistry.getError?.();
  if (registryError) {
    throw new Error(
      `Pi model registry failed to load ${agentDir}/models.json: ${registryError}`,
    );
  }
  if (!model) {
    throw new Error(
      `Agent model not found: ${provider}/${modelId}. ` +
        `Expected an entry in ${agentDir}/models.json. ` +
        `Did you materialize models.json + settings.json first?`,
    );
  }

  // ── 3. Settings + resource loader + session manager. ───────────────────
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt,
    // No extensions: keeps the runtime minimal and the active tool set equal
    // to exactly our baseToolsOverride keys (no extension tools layered in).
    noExtensions: true,
  });
  // reload() reads cwd/agentDir on the HOST — this is why cwd must be real.
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);

  // ── 4. Build the AgentCore-backed tool bundle. ─────────────────────────
  // createAgentCorePiTools yields bash/read/write/edit/find/grep/ls, but its
  // grep is the non-functional factory grep — replace it with the real
  // in-sandbox grep tool.
  const baseToolsOverride: Record<string, AgentTool> = {
    ...createAgentCorePiTools(sandbox, cwd),
    // The typed grep tool's concrete schema is invariant against the Record's
    // generic AgentTool<TSchema>; widen it the same way createAgentCorePiTools
    // exposes its tools as AgentTool<any>.
    grep: createAgentCoreGrepTool(sandbox, cwd) as unknown as AgentTool,
  };

  // spawn_subagents — added only when a child-sandbox factory is supplied and
  // we're under the depth cap. The runChild closure lives here (not in the tool
  // module) so createAgentCorePiSession stays the single place a child session
  // is built, and the depth guard is enforced in one spot.
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? 1;
  if (opts.spawnChildSandbox && depth < maxDepth) {
    const spawnChild = opts.spawnChildSandbox;
    baseToolsOverride.spawn_subagents = createSpawnSubagentsTool({
      defaultMaxConcurrency: opts.maxConcurrency,
      runChild: async (task) => {
        const child = await spawnChild();
        try {
          await child.start?.();
          let childProvider = provider;
          let childModelId = modelId;
          if (task.model) {
            const slash = task.model.indexOf("/");
            if (slash > 0) {
              childProvider = task.model.slice(0, slash);
              childModelId = task.model.slice(slash + 1);
            }
          }
          const { session: childSession } = await createAgentCorePiSession({
            sandbox: child,
            cwd,
            agentDir,
            provider: childProvider,
            modelId: childModelId,
            appendSystemPrompt,
            thinkingLevel,
            spawnChildSandbox: spawnChild,
            depth: depth + 1,
            maxDepth,
            maxConcurrency: opts.maxConcurrency,
          });
          await childSession.prompt(task.prompt);
          return { label: task.label, ok: true, text: childSession.getLastAssistantText?.() ?? "" };
        } catch (e) {
          return { label: task.label, ok: false, error: String(e) };
        } finally {
          await child.dispose?.();
        }
      },
    }) as unknown as AgentTool;
  }

  const toolNames = Object.keys(baseToolsOverride);

  // ── 5. Construct the Agent (mirrors sdk.js createAgentSession 159-208). ─
  // extensionRunnerRef is the mutable ref the AgentSession populates; the
  // Agent's onPayload/transformContext read it. With noExtensions there's no
  // runner, so both reduce to pass-throughs.
  const extensionRunnerRef: { current?: any } = {};
  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: "",
      model,
      thinkingLevel,
      tools: [],
    },
    convertToLlm,
    onPayload: async (payload: any, _model: any) => {
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers?.("before_provider_request")) return payload;
      return runner.emitBeforeProviderRequest(payload);
    },
    sessionId: sessionManager.getSessionId(),
    transformContext: async (messages: any) => {
      const runner = extensionRunnerRef.current;
      if (!runner) return messages;
      return runner.emitContext(messages);
    },
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    transport: settingsManager.getTransport(),
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
    // THE load-bearing callback. Resolves the API key per LLM call from the
    // registry (which reads the env var named in models.json). Omit this and
    // prompt() throws "No API key found".
    getApiKey: async (provider?: string) => {
      const resolvedProvider = provider || agent.state.model?.provider;
      if (!resolvedProvider) throw new Error("No model selected");
      const key = await modelRegistry.getApiKeyForProvider(resolvedProvider);
      if (!key) {
        throw new Error(
          `No API key found for "${resolvedProvider}". ` +
            `Set the API key env var named in ${agentDir}/models.json.`,
        );
      }
      return key;
    },
  });

  // Fresh session bookkeeping (sdk.js 216-222): record initial model +
  // thinking level so resume/restore is well-formed.
  sessionManager.appendModelChange(model.provider, model.id);
  sessionManager.appendThinkingLevelChange(thinkingLevel);

  // ── 6. Construct the AgentSession with baseToolsOverride. ──────────────
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    resourceLoader,
    modelRegistry,
    baseToolsOverride,
    // Explicit — guarantees all 7 AgentCore tools are active (the default
    // would also activate them, but we don't leave it implicit).
    initialActiveToolNames: toolNames,
    extensionRunnerRef,
  });

  return { session, activeToolNames: session.getActiveToolNames() };
}
