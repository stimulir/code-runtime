/**
 * ACP subprocess client wrapper.
 *
 * Every upstream `@rivet-dev/agent-os-*` adapter ships an ACP-compliant
 * binary (`pi-sdk-acp`, `codex-wasm-acp`, `claude-sdk-acp`,
 * `agent-os-opencode-acp`). Mistral's Vibe ships `vibe-acp`. Talking to
 * any of them is the same job:
 *
 *   1. Spawn the binary as a child process
 *   2. Open JSON-RPC over stdin/stdout (the `ndjson` framing the
 *      `@agentclientprotocol/sdk` uses)
 *   3. Call initialize → newSession → prompt
 *   4. Translate the SDK's `sessionUpdate` notifications into the
 *      canonical Stimulir trajectory event shape so downstream tools
 *      (Lemon Tasker, Verifiers rollouts, run analyzer) all see the
 *      same event types regardless of which agent produced them.
 *
 * This module owns step 1+2+4. Each adapter package (codex /
 * claude-code / opencode / vibe) provides the binary path + adapter
 * name + any per-agent prompt-prep, and gets back an
 * `AgentSessionLike` ready for `.subscribe()` and `.prompt()`.
 *
 * The Pi adapter does NOT go through this — it loads the Pi SDK
 * in-process for the cleanest trajectory stream (the original Lemon
 * Tasker reason for avoiding the ACP subprocess hop).
 */

import { spawn, type ChildProcess } from "node:child_process";

// ── Canonical event shape ──────────────────────────────────────────────
//
// Every adapter must translate its SDK's native events into one of
// these. The Pi SDK's event types are the reference (set by the rl-env
// runner's trajectory output) and we mirror them here.

export type CanonicalEventType =
	| "text_delta"
	| "message_start"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "tool_execution_error"
	| "tool_execution_killed"
	| "turn_start"
	| "turn_end"
	| "session_meta";

export interface CanonicalEvent {
	type: CanonicalEventType;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	text?: string;
	result?: unknown;
	isError?: boolean;
	[k: string]: unknown;
}

// ── ACP subprocess client ──────────────────────────────────────────────

export interface AcpSpawnOptions {
	/** Path to the ACP binary (e.g. resolved via require.resolve). */
	binaryPath: string;
	/** Extra CLI args for the binary (e.g. ["--append-system-prompt", "…"]). */
	args?: string[];
	/** Working dir for the subprocess. */
	cwd: string;
	/** Environment overrides (merged onto process.env). */
	env?: Record<string, string | undefined>;
	/** Maps an SDK-native sessionUpdate notification → canonical event.
	 *  Default: best-effort generic mapping that catches the common
	 *  `agent_message_chunk` / `tool_call_update` shapes. */
	translate?: (sdkNotification: unknown) => CanonicalEvent | null;
}

export interface AcpClient {
	/** Subscribe to canonical events from the agent. */
	subscribe(handler: (ev: CanonicalEvent) => void): void;
	/** Send a prompt to the agent. Resolves when the agent's turn ends. */
	prompt(text: string): Promise<void>;
	/** Send a cancel request to the agent. */
	cancel(): Promise<void>;
	/** Tear down the subprocess. */
	close(): Promise<void>;
	/** Underlying child process (advanced; for the watchdog's pgrep walks). */
	readonly child: ChildProcess;
	/** Session id returned by the agent on newSession. */
	readonly sessionId: string;
}

/**
 * Default best-effort event translator. Handles every sessionUpdate shape
 * defined by the @agentclientprotocol/sdk schema (zSessionUpdate):
 *
 *   user_message_chunk       → text_delta (channel=user)
 *   agent_message_chunk      → text_delta (channel=assistant)
 *   agent_thought_chunk      → text_delta (channel=thinking)
 *   tool_call                → tool_execution_start
 *   tool_call_update         → tool_execution_{start,update,end,error}
 *   plan                     → session_meta (carries goals + status)
 *   available_commands_update → session_meta
 *   current_mode_update      → session_meta
 *   config_option_update     → session_meta
 *   session_info_update      → session_meta
 *   usage_update             → session_meta
 *
 * Adapter-specific translators may extend this to handle SDK quirks
 * (e.g. Vibe's `ReasoningEvent`).
 */
export function defaultAcpTranslate(notif: unknown): CanonicalEvent | null {
	if (!notif || typeof notif !== "object") return null;
	const n = notif as Record<string, unknown>;
	const update = (n.sessionUpdate ?? n.update_type) as string | undefined;
	if (!update) {
		return { type: "session_meta", raw: n };
	}
	// Content chunks — text delta with channel tag so downstream tooling
	// can distinguish thinking vs assistant vs (echoed) user content.
	if (
		update === "agent_message_chunk" ||
		update === "agent_thought_chunk" ||
		update === "user_message_chunk"
	) {
		const content = n.content as Record<string, unknown> | undefined;
		const text = (content?.text as string | undefined) ?? "";
		const channel =
			update === "agent_thought_chunk"
				? "thinking"
				: update === "user_message_chunk"
					? "user"
					: "assistant";
		return { type: "text_delta", text, channel };
	}
	// Initial tool announcement — the Claude SDK emits this BEFORE the
	// tool runs. Map to tool_execution_start so watchdogs + analyzers
	// register the inflight call immediately. `title` carries the tool
	// label (Bash / Read / Edit etc.); `kind` is the ACP category
	// (execute / read / edit etc.). Either makes a reasonable toolName.
	if (update === "tool_call") {
		const toolCallId = (n.toolCallId ?? n.tool_call_id) as string | undefined;
		const toolName = (n.title ?? n.kind) as string | undefined;
		const args =
			(n.rawInput as Record<string, unknown> | undefined) ??
			(n.content as Record<string, unknown> | undefined) ??
			{};
		return { type: "tool_execution_start", toolCallId, toolName, args };
	}
	if (update === "tool_call_update") {
		const status = (n.status as string | undefined) ?? "in_progress";
		const toolCallId = (n.toolCallId ?? n.tool_call_id) as string | undefined;
		const fieldMeta = (n.fieldMeta ?? n.field_meta) as
			| Record<string, unknown>
			| undefined;
		const toolName = (n.title ??
			fieldMeta?.tool_name ??
			n.kind) as string | undefined;
		const args =
			(n.rawInput as Record<string, unknown> | undefined) ??
			(n.content as Record<string, unknown> | undefined) ??
			{};
		if (status === "pending" || status === "in_progress" || status === "started") {
			return { type: "tool_execution_start", toolCallId, toolName, args };
		}
		if (status === "completed") {
			return {
				type: "tool_execution_end",
				toolCallId,
				toolName,
				result: n.content ?? n.rawOutput,
			};
		}
		if (status === "error" || status === "failed") {
			return {
				type: "tool_execution_error",
				toolCallId,
				toolName,
				isError: true,
				result: n.content ?? n.rawOutput,
			};
		}
		return { type: "tool_execution_update", toolCallId, toolName, args };
	}
	if (update === "turn_end" || update === "agent_turn_end") {
		return { type: "turn_end" };
	}
	// Plan / mode / config / session_info / usage updates — preserve
	// the raw payload as session_meta so downstream consumers can opt
	// in if they care.
	return { type: "session_meta", raw: n };
}

/**
 * Spawn an ACP binary and return an AcpClient wrapping it. JSON-RPC is
 * speaking newline-delimited JSON over stdin/stdout (the
 * `@agentclientprotocol/sdk` `ndJsonStream` convention).
 *
 * IMPLEMENTATION NOTE: this is a minimal hand-rolled JSON-RPC client
 * scoped to what every ACP agent needs (initialize, newSession, prompt,
 * cancel, subscribe to sessionUpdate notifications). For full ACP
 * coverage (loadSession, forkSession, mode switches, etc.) callers
 * should fall back to `@agentclientprotocol/sdk`'s ClientSideConnection
 * directly via the `child` accessor.
 */
export async function spawnAcpClient(
	opts: AcpSpawnOptions,
): Promise<AcpClient> {
	const child = spawn(opts.binaryPath, opts.args ?? [], {
		cwd: opts.cwd,
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...process.env, ...opts.env },
	});
	const translate = opts.translate ?? defaultAcpTranslate;
	const subscribers: Array<(ev: CanonicalEvent) => void> = [];
	let sessionId = "";
	let nextId = 1;
	const pending = new Map<number, {
		resolve: (v: unknown) => void;
		reject: (e: unknown) => void;
	}>();

	// ── ndjson parser on stdout ──
	let buf = "";
	child.stdout!.on("data", (chunk: Buffer) => {
		buf += chunk.toString("utf-8");
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			// JSON-RPC response (has id)
			if (typeof msg.id === "number") {
				const p = pending.get(msg.id);
				if (p) {
					pending.delete(msg.id);
					if ("error" in msg) p.reject(msg.error);
					else p.resolve(msg.result);
				}
				continue;
			}
			// JSON-RPC notification (no id; has method)
			if (typeof msg.method === "string") {
				if (msg.method === "session/update" || msg.method === "sessionUpdate") {
					const params = msg.params as Record<string, unknown> | undefined;
					const update = params?.update ?? params;
					const ev = translate(update);
					if (ev) {
						for (const s of subscribers) s(ev);
					}
				}
			}
		}
	});

	function send(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = nextId++;
		const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			child.stdin!.write(msg);
		});
	}
	function notify(method: string, params: Record<string, unknown>): void {
		const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
		child.stdin!.write(msg);
	}

	// ── Handshake: initialize → session/new → session/set_mode ──
	//
	// The ACP zod schema (zNewSessionRequest in @agentclientprotocol/sdk)
	// requires BOTH `cwd: string` AND `mcpServers: McpServer[]`. Empty
	// array is the canonical "no MCP servers" form — leaving the field
	// off entirely makes the upstream binary reject the request with
	// "Invalid params" in <1s before any agent work begins. Bug reproed
	// against @rivet-dev/agent-os-claude@0.1.1 / claude-sdk-acp.
	await send("initialize", { protocolVersion: 1 });
	const sessRes = (await send("session/new", {
		cwd: opts.cwd,
		mcpServers: [],
	})) as Record<string, unknown> | undefined;
	sessionId = (sessRes?.sessionId as string) ?? `acp-${Date.now()}`;
	// New sessions default to mode='default' which means every tool call
	// triggers a `session/request_permission` callback to the client.
	// This hand-rolled client doesn't implement the permission handler
	// (full ACP server-side would), so any agent that respects modes
	// (Claude SDK does — opencode/codex/vibe ignore it) would hang
	// waiting for our reply. Setting bypassPermissions immediately lets
	// the agent run tools without round-tripping us for each one. If
	// the agent doesn't advertise bypassPermissions in availableModes
	// the SDK will reject the request — we swallow it as best-effort.
	const modes = sessRes?.modes as
		| { availableModes?: Array<{ id?: string }> }
		| undefined;
	const hasByPass = (modes?.availableModes ?? []).some(
		(m) => m?.id === "bypassPermissions",
	);
	if (hasByPass) {
		try {
			await send("session/set_mode", {
				sessionId,
				modeId: "bypassPermissions",
			});
		} catch {
			// best-effort — log via stderr would be noisier than helpful
		}
	}

	return {
		child,
		get sessionId() {
			return sessionId;
		},
		subscribe(handler) {
			subscribers.push(handler);
		},
		async prompt(text) {
			await send("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text }],
			});
		},
		async cancel() {
			notify("session/cancel", { sessionId });
		},
		async close() {
			try {
				notify("shutdown", {});
			} catch {
				// best effort
			}
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
					resolve();
				}, 3000);
			});
		},
	};
}
