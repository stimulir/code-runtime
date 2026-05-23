/**
 * @stimulir/code-runtime-pi
 *
 * Stimulir's Pi adapter. Wraps `@mariozechner/pi-coding-agent`'s SDK
 * with the explicit AuthStorage/ModelRegistry/SettingsManager/
 * DefaultResourceLoader/SessionManager wire-up — the Lemon Tasker
 * golden standard.
 *
 * Usage:
 *
 *   import { createPiAdapter } from "@stimulir/code-runtime-pi";
 *
 *   const session = await createPiAdapter({
 *     cwd: "/path/to/workspace",
 *     stateDir: "./.code-runtime-state",
 *     sessionId: "demo-1",
 *     modelProvider: "openrouter",
 *     model: "anthropic/claude-sonnet-4.6",
 *     appendSystemPrompt: "You are a coding agent…",
 *   });
 *
 *   session.subscribe(ev => writer.write(ev));
 *   await session.prompt("Fix the failing test in tests/test.sh.");
 *
 * The adapter does NOT spawn `vibe-acp`-style subprocesses; it loads
 * the Pi SDK in-process. For V8-isolated deployments (stimulir-console
 * style), use the upstream `@rivet-dev/agent-os-pi` ACP adapter
 * registered via defineSoftware. This package targets the host-direct
 * mode that Lemon Tasker proved out.
 */

import {
	createStimulirAgentSession,
	type AgentSdkLike,
	type AgentSessionLike,
} from "@stimulir/code-runtime-core";
import {
	applyPiRuntimeEnv,
	materializePiAgentConfig,
	type PiAgentSpec,
	type PiModelProvider,
} from "./config.js";

// Re-export config helpers so callers can pre-flight their auth setup.
export {
	hybrieApiKey,
	hybrieBaseUrl,
	openrouterApiKey,
	openrouterBaseUrl,
	materializePiAgentConfig,
	applyPiRuntimeEnv,
	type PiAgentSpec,
	type PiModelProvider,
	type MaterializedPiConfig,
} from "./config.js";

// ── Pi SDK loader ───────────────────────────────────────────────────────

/**
 * Dynamically import @mariozechner/pi-coding-agent and shape it to the
 * AgentSdkLike interface createStimulirAgentSession expects. Dynamic
 * import keeps the SDK out of the require graph until an adapter is
 * actually instantiated — saves ~100 MB of TUI code on cold start for
 * callers that only need the type surface.
 */
async function loadPiSdk(): Promise<AgentSdkLike> {
	const piSdk = await import("@mariozechner/pi-coding-agent");
	return {
		AuthStorage: piSdk.AuthStorage as unknown as AgentSdkLike["AuthStorage"],
		ModelRegistry:
			piSdk.ModelRegistry as unknown as AgentSdkLike["ModelRegistry"],
		SettingsManager:
			piSdk.SettingsManager as unknown as AgentSdkLike["SettingsManager"],
		DefaultResourceLoader:
			piSdk.DefaultResourceLoader as unknown as AgentSdkLike["DefaultResourceLoader"],
		SessionManager:
			piSdk.SessionManager as unknown as AgentSdkLike["SessionManager"],
		createAgentSession:
			piSdk.createAgentSession as unknown as AgentSdkLike["createAgentSession"],
	};
}

// ── createPiAdapter ────────────────────────────────────────────────────

export interface CreatePiAdapterSpec extends PiAgentSpec {
	/** Working dir the agent operates in. */
	cwd: string;
	/** Root for per-session state (Pi config dir). Default: ./.code-runtime-state. */
	stateDir?: string;
	/** Unique session id — used to namespace agentDir on disk. */
	sessionId: string;
	/** Optional system prompt appended to Pi's default. */
	appendSystemPrompt?: string;
	/** "off" | "low" | "medium" | "high". Default: "off". */
	thinkingLevel?: string;
}

/**
 * Single-call Pi session factory. Materializes per-session config to
 * `<stateDir>/pi-config/<sessionId>/`, applies the env-var dance so
 * Pi's internal lookups resolve, and returns an `AgentSessionLike`
 * ready for `.subscribe()` and `.prompt()`.
 *
 * @throws if the model isn't registered in models.json (the explicit
 *   throw that turns silent-no-engagement into a loud, actionable
 *   error at adapter init).
 */
export async function createPiAdapter(
	spec: CreatePiAdapterSpec,
): Promise<AgentSessionLike> {
	const stateDir = spec.stateDir ?? "./.code-runtime-state";
	applyPiRuntimeEnv(spec);
	const { agentDir } = await materializePiAgentConfig(
		spec,
		stateDir,
		spec.sessionId,
	);
	const sdk = await loadPiSdk();
	return createStimulirAgentSession({
		sdk,
		cwd: spec.cwd,
		agentDir,
		provider: spec.modelProvider,
		modelId: spec.model,
		appendSystemPrompt: spec.appendSystemPrompt,
		thinkingLevel: spec.thinkingLevel,
	});
}
