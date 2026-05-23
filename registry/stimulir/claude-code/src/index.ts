/**
 * @stimulir/code-runtime-claude-code
 *
 * Wraps the upstream `@rivet-dev/agent-os-claude` ACP binary
 * (`claude-sdk-acp`). Same pattern as the Codex wrapper — spawn the
 * binary, speak ACP, translate notifications to Stimulir's canonical
 * trajectory shape.
 *
 * Auth: requires `ANTHROPIC_API_KEY` in env, or whatever the upstream
 * binary's `@anthropic-ai/claude-agent-sdk` expects.
 *
 * Usage:
 *
 *   import { createClaudeCodeAdapter } from "@stimulir/code-runtime-claude-code";
 *
 *   const session = await createClaudeCodeAdapter({
 *     cwd: "/path/to/workspace",
 *     appendSystemPrompt: "You are a coding agent…",
 *   });
 *
 *   session.subscribe(ev => writer.write(ev));
 *   await session.prompt("Fix the failing tests.");
 *   await session.close();
 */

import { createRequire } from "node:module";
import { resolve as resolvePath, dirname, join } from "node:path";
import { spawnAcpClient, type AcpClient, type CanonicalEvent } from "@stimulir/code-runtime-host";

const require = createRequire(import.meta.url);

export interface CreateClaudeCodeAdapterSpec {
	cwd: string;
	appendSystemPrompt?: string;
	env?: Record<string, string | undefined>;
	extraArgs?: string[];
}

export interface ClaudeCodeAgentSession {
	readonly sessionId: string;
	subscribe(handler: (ev: CanonicalEvent) => void): void;
	prompt(text: string): Promise<void>;
	cancel(): Promise<void>;
	close(): Promise<void>;
	readonly acp: AcpClient;
}

export function resolveClaudeCodeAcpBinary(): string {
	const upstreamEntry = require.resolve("@rivet-dev/agent-os-claude");
	return join(dirname(upstreamEntry), "adapter.js");
}

export async function createClaudeCodeAdapter(
	spec: CreateClaudeCodeAdapterSpec,
): Promise<ClaudeCodeAgentSession> {
	const binaryPath = resolveClaudeCodeAcpBinary();
	const args: string[] = [];
	if (spec.appendSystemPrompt) {
		args.push("--append-system-prompt", spec.appendSystemPrompt);
	}
	if (spec.extraArgs) args.push(...spec.extraArgs);

	const acp = await spawnAcpClient({
		binaryPath: process.execPath,
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
