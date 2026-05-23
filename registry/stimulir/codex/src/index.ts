/**
 * @stimulir/code-runtime-codex
 *
 * Wraps the upstream `@rivet-dev/agent-os-codex-agent` ACP binary
 * (`codex-wasm-acp`). Spawns it as a subprocess, speaks ACP JSON-RPC
 * over stdio, and translates the SDK's native notifications into
 * Stimulir's canonical trajectory event shape — the same one the Pi
 * adapter emits — so Lemon Tasker can swap any adapter behind
 * `--agent <name>` and get a uniform trajectory.
 *
 * Usage:
 *
 *   import { createCodexAdapter } from "@stimulir/code-runtime-codex";
 *
 *   const session = await createCodexAdapter({
 *     cwd: "/path/to/workspace",
 *     appendSystemPrompt: "You are a coding agent…",
 *     env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
 *   });
 *
 *   session.subscribe(ev => writer.write(ev));
 *   await session.prompt("Fix the failing tests in tests/test.sh.");
 *   await session.close();
 *
 * The adapter resolves the upstream binary path via require.resolve
 * so it works as long as `@rivet-dev/agent-os-codex-agent` is in the
 * dependency graph (handled by the workspace declaration).
 */

import { createRequire } from "node:module";
import { resolve as resolvePath, dirname, join } from "node:path";
import { spawnAcpClient, type AcpClient, type CanonicalEvent } from "@stimulir/code-runtime-host";

const require = createRequire(import.meta.url);

export interface CreateCodexAdapterSpec {
	/** Working dir the agent operates in. */
	cwd: string;
	/** Optional system prompt appended to the upstream binary's default. */
	appendSystemPrompt?: string;
	/** Environment overrides — OPENAI_API_KEY etc. */
	env?: Record<string, string | undefined>;
	/** Extra CLI args for the upstream binary (rarely needed). */
	extraArgs?: string[];
}

export interface CodexAgentSession {
	/** Session id assigned by the upstream binary. */
	readonly sessionId: string;
	/** Subscribe to canonical trajectory events. */
	subscribe(handler: (ev: CanonicalEvent) => void): void;
	/** Send a prompt; resolves on turn end. */
	prompt(text: string): Promise<void>;
	/** Cancel in-flight prompt. */
	cancel(): Promise<void>;
	/** Tear down the subprocess. */
	close(): Promise<void>;
	/** Underlying ACP client (advanced — for the per-tool-call watchdog). */
	readonly acp: AcpClient;
}

/** Resolve the path to the upstream codex-wasm-acp binary. */
export function resolveCodexAcpBinary(): string {
	// require.resolve gives us the entry .js inside the upstream package;
	// the binary lives next to it as `dist/adapter.js` per the upstream
	// package.json `bin` field.
	const upstreamEntry = require.resolve("@rivet-dev/agent-os-codex-agent");
	return join(dirname(upstreamEntry), "adapter.js");
}

/**
 * Single-call Codex session factory. Returns an `AgentSessionLike` you
 * can subscribe to and prompt against.
 */
export async function createCodexAdapter(
	spec: CreateCodexAdapterSpec,
): Promise<CodexAgentSession> {
	const binaryPath = resolveCodexAcpBinary();
	const args: string[] = [];
	if (spec.appendSystemPrompt) {
		args.push("--append-system-prompt", spec.appendSystemPrompt);
	}
	if (spec.extraArgs) args.push(...spec.extraArgs);

	const acp = await spawnAcpClient({
		binaryPath: process.execPath,  // run with node, not as standalone exec
		args: [binaryPath, ...args],
		cwd: resolvePath(spec.cwd),
		env: spec.env,
	});

	return {
		acp,
		get sessionId() {
			return acp.sessionId;
		},
		subscribe(h) {
			acp.subscribe(h);
		},
		prompt(text) {
			return acp.prompt(text);
		},
		cancel() {
			return acp.cancel();
		},
		close() {
			return acp.close();
		},
	};
}
