/**
 * Pi-coding-agent host-side config materialization.
 *
 * Pi's SDK reads `models.json` + `settings.json` + `auth.json` from a host
 * dir (`agentDir`). We invoke the SDK directly from Node (no V8 isolate),
 * so we materialize those files to disk before calling
 * createStimulirAgentSession.
 *
 * SOURCE: ported from rl-env/runner/src/pi-config.ts (the Lemon Tasker
 * golden standard). Format mirrors stimulir-console's
 * piRuntimeConfigFiles() so we stay compatible with the same Pi version.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Inference gateway routing for a Pi model. `hybrie` is Stimulir's local
 * open-weights gateway; `openrouter` is the frontier-model aggregator.
 * Add new providers here as their routing differs.
 */
export type PiModelProvider = "hybrie" | "openrouter" | string;

export interface PiAgentSpec {
	/** Provider name as it'll appear in models.json. */
	modelProvider: PiModelProvider;
	/** Model id as the provider expects it (e.g. "anthropic/claude-sonnet-4.6"). */
	model: string;
	/** Optional display label for logs / Pi UI. */
	label?: string;
}

// ── Provider routing helpers ────────────────────────────────────────────

/** HybrIE base URL — override via HYBRIE_API_URL. */
export function hybrieBaseUrl(): string {
	let raw = (
		process.env.AGENT_OS_RUNTIME_HYBRIE_BASE_URL ||
		process.env.HYBRIE_API_URL ||
		process.env.HYBRIE_ENDPOINT ||
		"http://localhost:8011"
	).trim();
	raw = raw.replace(/\/$/, "");
	if (!/\/v1$/.test(raw)) raw = `${raw}/v1`;
	return raw;
}

/** HybrIE API key. */
export function hybrieApiKey(): string {
	return (
		process.env.AGENT_OS_RUNTIME_HYBRIE_API_KEY ||
		process.env.HYBRIE_API_KEY ||
		process.env.OPENAI_API_KEY ||
		""
	).trim();
}

/** OpenRouter base URL — override via OPENROUTER_API_URL (rare). */
export function openrouterBaseUrl(): string {
	let raw = (
		process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1"
	).trim();
	raw = raw.replace(/\/$/, "");
	if (!/\/v1$/.test(raw)) raw = `${raw}/v1`;
	return raw;
}

/** OpenRouter API key. */
export function openrouterApiKey(): string {
	return (process.env.OPENROUTER_API_KEY || "").trim();
}

interface ProviderRouting {
	baseUrl: string;
	apiKeyEnv: string;
	apiKey: string;
	headers: Record<string, string>;
}

function providerRouting(provider: PiModelProvider): ProviderRouting {
	if (provider === "openrouter") {
		return {
			baseUrl: openrouterBaseUrl(),
			apiKeyEnv: "OPENROUTER_API_KEY",
			apiKey: openrouterApiKey(),
			headers: {
				"HTTP-Referer": "https://github.com/stimulir/code-runtime",
				"X-Title": "Stimulir code-runtime",
			},
		};
	}
	// Default = HybrIE for any provider we don't recognise explicitly.
	return {
		baseUrl: hybrieBaseUrl(),
		apiKeyEnv: "HYBRIE_API_KEY",
		apiKey: hybrieApiKey(),
		headers: {},
	};
}

function buildModelsJson(spec: PiAgentSpec): unknown {
	const r = providerRouting(spec.modelProvider);
	const niceLabel = spec.modelProvider === "openrouter" ? "OpenRouter" : "HybrIE";
	return {
		providers: {
			[spec.modelProvider]: {
				baseUrl: r.baseUrl,
				api: "openai-completions",
				apiKey: r.apiKeyEnv,
				authHeader: true,
				headers: r.headers,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					supportsUsageInStreaming: true,
					supportsStrictMode: false,
				},
				models: [
					{
						id: spec.model,
						name: spec.label ?? `${niceLabel} ${spec.model}`,
						reasoning: false,
						input: ["text"],
						contextWindow: 131072,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
}

function buildSettingsJson(spec: PiAgentSpec): unknown {
	return {
		defaultProvider: spec.modelProvider,
		defaultModel: spec.model,
		defaultThinkingLevel: "off",
		hideThinkingBlock: false,
		transport: "sse",
		retry: {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 2000,
			maxDelayMs: 60000,
		},
	};
}

export interface MaterializedPiConfig {
	/** Host path containing models.json + settings.json (Pi reads from here). */
	agentDir: string;
}

/**
 * Write Pi's per-session config to a host dir. Returns the path the
 * adapter passes as `agentDir` to createStimulirAgentSession.
 *
 * @throws if the required API key for the provider isn't in env.
 */
export async function materializePiAgentConfig(
	spec: PiAgentSpec,
	rootDir: string,
	sessionId: string,
): Promise<MaterializedPiConfig> {
	const r = providerRouting(spec.modelProvider);
	if (!r.apiKey) {
		if (spec.modelProvider === "openrouter") {
			throw new Error(
				"OPENROUTER_API_KEY is not set. Get one at https://openrouter.ai/keys " +
					"and put it in .env, or pick a HybrIE-routed agent instead.",
			);
		}
		throw new Error(
			"HYBRIE_API_KEY (or AGENT_OS_RUNTIME_HYBRIE_API_KEY / OPENAI_API_KEY) is not set.",
		);
	}
	const agentDir = join(rootDir, "pi-config", sessionId);
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify(buildModelsJson(spec), null, 2) + "\n",
		"utf8",
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify(buildSettingsJson(spec), null, 2) + "\n",
		"utf8",
	);
	return { agentDir };
}

/**
 * Set the environment variables Pi's SDK consults legacy-style. Pi's
 * own models.json lookup is preferred, but some SDK paths still check
 * OPENAI_BASE_URL / OPENAI_API_KEY — keep those pinned to the active
 * gateway so nothing falls through to a phantom default.
 */
export function applyPiRuntimeEnv(spec: PiAgentSpec): void {
	if (hybrieApiKey()) {
		process.env.HYBRIE_API_KEY = hybrieApiKey();
		process.env.HYBRIE_API_URL = hybrieBaseUrl().replace(/\/v1$/, "");
	}
	if (openrouterApiKey()) {
		process.env.OPENROUTER_API_KEY = openrouterApiKey();
	}
	if (spec.modelProvider === "openrouter") {
		process.env.OPENAI_API_KEY = openrouterApiKey();
		process.env.OPENAI_BASE_URL = openrouterBaseUrl();
	} else {
		process.env.OPENAI_API_KEY = hybrieApiKey();
		process.env.OPENAI_BASE_URL = hybrieBaseUrl();
	}
}
