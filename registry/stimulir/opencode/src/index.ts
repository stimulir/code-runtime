/**
 * @stimulir/code-runtime-opencode
 *
 * Wraps the upstream `@rivet-dev/agent-os-opencode` ACP binary
 * (`agent-os-opencode-acp`). Same pattern as the Codex / Claude Code
 * wrappers — spawn the binary, speak ACP, translate notifications to
 * Stimulir's canonical trajectory shape.
 *
 * Auth: requires whatever model-provider credentials the upstream
 * opencode binary expects (typically `OPENAI_API_KEY` or
 * `ANTHROPIC_API_KEY`).
 *
 * Usage:
 *
 *   import { createOpenCodeAdapter } from "@stimulir/code-runtime-opencode";
 *
 *   const session = await createOpenCodeAdapter({
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

export interface CreateOpenCodeAdapterSpec {
	cwd: string;
	appendSystemPrompt?: string;
	env?: Record<string, string | undefined>;
	extraArgs?: string[];
}

export interface OpenCodeAgentSession {
	readonly sessionId: string;
	subscribe(handler: (ev: CanonicalEvent) => void): void;
	prompt(text: string): Promise<void>;
	cancel(): Promise<void>;
	close(): Promise<void>;
	readonly acp: AcpClient;
}

export function resolveOpenCodeAcpBinary(): string {
	const upstreamEntry = require.resolve("@rivet-dev/agent-os-opencode");
	return join(dirname(upstreamEntry), "adapter.js");
}

export async function createOpenCodeAdapter(
	spec: CreateOpenCodeAdapterSpec,
): Promise<OpenCodeAgentSession> {
	const binaryPath = resolveOpenCodeAcpBinary();
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
