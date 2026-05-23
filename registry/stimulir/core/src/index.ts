/**
 * @stimulir/code-runtime-core
 *
 * Thin wrapper over @rivet-dev/agent-os-core. Two responsibilities:
 *
 *   1. Re-export the upstream API so downstream packages can import
 *      everything from `@stimulir/code-runtime-core` and not need to
 *      pull in the rivet-dev scope directly.
 *
 *   2. Expose `createStimulirAgentSession(spec)` — a single-call helper
 *      that does the EXPLICIT wire-up the upstream Pi adapter (and its
 *      siblings: claude, codex, opencode) all silently skip:
 *
 *        - AuthStorage.create(...)          — explicit auth.json path
 *        - new ModelRegistry(authStorage,…) — explicit models.json path
 *        - SettingsManager.create(cwd, ag)  — explicit per-session
 *        - DefaultResourceLoader({…})       — explicit resource loader
 *        - SessionManager.inMemory()        — explicit session manager
 *        - modelRegistry.find(prov, model)  — EXPLICIT model resolution
 *          that throws if the model isn't registered (the upstream lets
 *          the SDK fall back to internal defaults that "load" but never
 *          engage — the silent-no-engagement bug we hit on every fresh
 *          rl-env install before we wrote this helper).
 *
 *      Each adapter (Pi, Codex, Claude Code, OpenCode, Vibe) provides
 *      its specific `agentSdk` import (loadPiSdk(), loadCodexSdk(), …)
 *      and per-agent config materialization. This helper handles the
 *      parts that are IDENTICAL across all adapters.
 *
 *   SOURCE: pattern extracted from rl-env/runner/src/run-task.ts lines
 *   391–426 (the Lemon Tasker golden standard), originally proved by
 *   stimulir-console/backend/agent-os-runtime/stimulir-agent-os-pi-adapter.
 */

// ── Upstream re-export ──────────────────────────────────────────────────
export * from "@rivet-dev/agent-os-core";

// ── Host primitives — bundled for convenience ──────────────────────────
export {
	TrajectoryWriter,
	type TrajectoryHeader,
	collectShellDescendants,
	killShellDescendants,
	InflightToolCallRegistry,
	startWatchdog,
	killProcessesReferencingPath,
	type InflightToolCall,
	type WatchdogOptions,
} from "@stimulir/code-runtime-host";

// ── createStimulirAgentSession ─────────────────────────────────────────

/**
 * The SDK shape every adapter exposes. Each agent vendor (Pi, Codex,
 * Claude Code, …) ships a coding-agent SDK with this set of factories.
 * Stimulir adapters wrap their respective SDKs and pass an object of
 * this shape to `createStimulirAgentSession`.
 *
 * The names match @mariozechner/pi-coding-agent — the original golden
 * standard — but the shape is generic enough that every other agent's
 * SDK can be adapted to fit.
 */
export interface AgentSdkLike {
	AuthStorage: {
		create(authPath: string): unknown;
	};
	ModelRegistry: new (
		authStorage: unknown,
		modelsPath: string,
	) => {
		find(provider: string, modelId: string): unknown | null;
		getError?(): string | null;
	};
	SettingsManager: {
		create(cwd: string, agentDir: string): unknown;
	};
	DefaultResourceLoader: new (options: {
		cwd: string;
		agentDir: string;
		settingsManager: unknown;
		appendSystemPrompt?: string;
		noExtensions?: boolean;
		extensionFactories?: unknown[];
	}) => { reload(): Promise<void> };
	SessionManager: {
		inMemory(cwd?: string): unknown;
	};
	createAgentSession(options: {
		cwd: string;
		agentDir: string;
		model: unknown;
		authStorage: unknown;
		modelRegistry: unknown;
		settingsManager: unknown;
		resourceLoader: unknown;
		sessionManager: unknown;
		thinkingLevel?: string;
	}): Promise<{
		session: AgentSessionLike;
		modelFallbackMessage?: string;
	}>;
}

/** Minimal session shape every adapter's SDK returns. */
export interface AgentSessionLike {
	sessionId: string;
	subscribe(handler: (event: unknown) => void): void;
	prompt(text: string): Promise<unknown>;
	getAvailableThinkingLevels?(): string[];
	thinkingLevel?: string;
}

/**
 * One-call agent-session creator. Encodes the EXACT wire-up sequence
 * from rl-env/runner/src/run-task.ts. Every Stimulir adapter calls this
 * instead of re-implementing the dance.
 *
 * @throws if `provider/modelId` isn't registered in `models.json` —
 *   this is the explicit guard that turns the silent-no-engagement
 *   failure into a loud, actionable error at adapter init time.
 */
export interface CreateStimulirAgentSessionSpec {
	/** SDK loaded by the adapter (e.g. await loadPiSdk()). */
	sdk: AgentSdkLike;
	/** Working dir the agent operates in (per-session workspace). */
	cwd: string;
	/** Where models.json / auth.json / settings.json live for this session. */
	agentDir: string;
	/** Provider name as it appears in models.json (e.g. "openrouter"). */
	provider: string;
	/** Model id as it appears in models.json (e.g. "anthropic/claude-sonnet-4.6"). */
	modelId: string;
	/** Optional system prompt appended to the SDK's default. */
	appendSystemPrompt?: string;
	/** Optional thinking level (model-dependent: "off"/"low"/"medium"/"high"). */
	thinkingLevel?: string;
	/** Optional extension factories for the resource loader. */
	extensionFactories?: unknown[];
}

export async function createStimulirAgentSession(
	spec: CreateStimulirAgentSessionSpec,
): Promise<AgentSessionLike> {
	const {
		sdk,
		cwd,
		agentDir,
		provider,
		modelId,
		appendSystemPrompt,
		thinkingLevel = "off",
		extensionFactories = [],
	} = spec;

	// 1. Auth + model registry — explicit paths into agentDir.
	const authStorage = sdk.AuthStorage.create(`${agentDir}/auth.json`);
	const modelRegistry = new sdk.ModelRegistry(
		authStorage,
		`${agentDir}/models.json`,
	);

	// 2. EXPLICIT model resolution. This is the line that catches the
	//    silent-no-engagement bug at adapter init time instead of letting
	//    Pi load and then do nothing.
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
				`If you just created the agentDir, did you materialize models.json + settings.json first?`,
		);
	}

	// 3. Per-session settings manager + resource loader.
	const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		appendSystemPrompt,
		noExtensions: true,
		extensionFactories,
	});
	await resourceLoader.reload();

	// 4. createAgentSession with ALL FIVE managers passed explicitly. The
	//    upstream adapter omits authStorage + modelRegistry; the SDK then
	//    silently falls back to internal defaults that can't find the
	//    model. This explicit-pass pattern is what makes engagement
	//    reliable.
	const result = await sdk.createAgentSession({
		cwd,
		agentDir,
		model,
		authStorage,
		modelRegistry,
		settingsManager,
		resourceLoader,
		sessionManager: sdk.SessionManager.inMemory(),
		thinkingLevel,
	});

	if (result.modelFallbackMessage) {
		throw new Error(result.modelFallbackMessage);
	}
	return result.session;
}
