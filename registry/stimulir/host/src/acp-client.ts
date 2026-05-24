/**
 * ACP subprocess client wrapper.
 *
 * Every upstream `@rivet-dev/agent-os-*` adapter ships an ACP-compliant
 * binary (`pi-sdk-acp`, `codex-wasm-acp`, `claude-sdk-acp`,
 * `agent-os-opencode-acp`). Mistral's Vibe ships `vibe-acp`. Talking to
 * any of them is the same job:
 *
 *   1. Spawn the binary as a child process
 *   2. Open ACP over stdin/stdout via `@agentclientprotocol/sdk`'s
 *      ClientSideConnection + ndJsonStream
 *   3. Drive the Agent half (initialize → newSession → prompt) AND
 *      serve the Client half (sessionUpdate notifications,
 *      requestPermission RPCs, fs/* file I/O, terminal/* command exec)
 *   4. Translate the SDK's `sessionUpdate` notifications into the
 *      canonical Stimulir trajectory event shape so downstream tools
 *      (Lemon Tasker, Verifiers rollouts, run analyzer) all see the
 *      same event types regardless of which agent produced them.
 *
 * The Pi adapter does NOT go through this — it loads the Pi SDK
 * in-process for the cleanest trajectory stream (the original Lemon
 * Tasker reason for avoiding the ACP subprocess hop).
 *
 * HISTORY: v0.1.4 and below shipped a minimal hand-rolled JSON-RPC
 * client that only handled agent→client `sessionUpdate` notifications.
 * That left every client→agent RPC (terminal/create, fs/read_text_file,
 * session/request_permission, etc.) silently unanswered, which made
 * any mode-respecting agent (Claude SDK especially) hang on the first
 * tool call. v0.1.5 swaps in @agentclientprotocol/sdk's full
 * ClientSideConnection — see the LemonAcpClient class below for the
 * client-side method implementations (terminals proxied to local
 * child_process.spawn, fs proxied to node:fs/promises, permissions
 * auto-allowed).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
	ClientSideConnection,
	ndJsonStream,
	type Client,
	type Stream,
} from "@agentclientprotocol/sdk";
import type {
	CreateTerminalRequest,
	CreateTerminalResponse,
	KillTerminalRequest,
	KillTerminalResponse,
	ReadTextFileRequest,
	ReadTextFileResponse,
	ReleaseTerminalRequest,
	ReleaseTerminalResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
	TerminalOutputRequest,
	TerminalOutputResponse,
	WaitForTerminalExitRequest,
	WaitForTerminalExitResponse,
	WriteTextFileRequest,
	WriteTextFileResponse,
} from "@agentclientprotocol/sdk/dist/schema/types.gen.js";

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
	 *  Default: best-effort generic mapping that catches every shape in
	 *  the @agentclientprotocol/sdk zSessionUpdate union. */
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
	return { type: "session_meta", raw: n };
}

// ── Client implementation ──────────────────────────────────────────────
//
// Implements the @agentclientprotocol/sdk Client interface. The agent
// makes RPCs into us (via ClientSideConnection) for permissions, fs
// access, and terminal command execution. We auto-allow permissions
// (per-tool gating is enforced at the rl-env watchdog level), proxy
// fs through node:fs/promises, and spawn shell commands for terminals.

interface TerminalState {
	// child may be missing when spawn failed synchronously — methods
	// below tolerate a null child by treating the terminal as exited.
	child: ChildProcess | null;
	// Bounded ring of captured output. The agent polls via terminalOutput
	// without waiting; we truncate from the start once outputByteLimit
	// is exceeded so long-running processes don't OOM the runner.
	output: Buffer;
	outputByteLimit: number;
	truncated: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	exitPromise: Promise<void>;
}

class LemonAcpClient implements Client {
	private subscribers: Array<(ev: CanonicalEvent) => void> = [];
	private terminals = new Map<string, TerminalState>();
	constructor(
		private readonly translate: (
			n: unknown,
		) => CanonicalEvent | null = defaultAcpTranslate,
	) {}

	subscribe(handler: (ev: CanonicalEvent) => void): void {
		this.subscribers.push(handler);
	}

	// ── Client method: notifications ────────────────────────────────────

	async sessionUpdate(notif: SessionNotification): Promise<void> {
		// The SDK delivers SessionNotification = { sessionId, update: zSessionUpdate }.
		// Our translator works on the inner update payload.
		const update = (notif as unknown as { update?: unknown })?.update ?? notif;
		const ev = this.translate(update);
		if (ev) {
			for (const s of this.subscribers) {
				try {
					s(ev);
				} catch {
					// subscriber errors must not poison the stream
				}
			}
		}
	}

	// ── Client method: permissions ──────────────────────────────────────

	async requestPermission(
		params: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		// Auto-select the first "allow" option. Falls back to optionId[0]
		// if no explicitly-named allow exists. Rl-env's per-tool-call
		// watchdog (in run-code-runtime-task.ts) is the real safety net;
		// asking the user per-tool would defeat the whole automation.
		const options = (params as unknown as { options?: Array<{ optionId?: string; kind?: string }> })
			.options ?? [];
		const pick =
			options.find((o) => o.kind === "allow_always" || o.kind === "allow_once") ??
			options[0];
		const optionId = (pick?.optionId as string) ?? "allow";
		return {
			outcome: { outcome: "selected", optionId },
		} as RequestPermissionResponse;
	}

	// ── Client method: filesystem ───────────────────────────────────────

	async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		const p = params as unknown as { path: string; line?: number; limit?: number };
		const raw = await fs.readFile(p.path, "utf-8");
		// Honor line + limit per spec (1-indexed line, count chars).
		let content = raw;
		if (typeof p.line === "number" || typeof p.limit === "number") {
			const lines = raw.split("\n");
			const start = Math.max(0, (p.line ?? 1) - 1);
			const end = typeof p.limit === "number" ? start + p.limit : lines.length;
			content = lines.slice(start, end).join("\n");
		}
		return { content } as ReadTextFileResponse;
	}

	async writeTextFile(
		params: WriteTextFileRequest,
	): Promise<WriteTextFileResponse> {
		const p = params as unknown as { path: string; content: string };
		await fs.writeFile(p.path, p.content, "utf-8");
		return {} as WriteTextFileResponse;
	}

	// ── Client method: terminals ────────────────────────────────────────

	async createTerminal(
		params: CreateTerminalRequest,
	): Promise<CreateTerminalResponse> {
		const p = params as unknown as {
			command: string;
			args?: string[];
			cwd?: string | null;
			env?: Array<{ name: string; value: string }>;
			outputByteLimit?: number | null;
		};
		const env = { ...process.env } as Record<string, string>;
		for (const e of p.env ?? []) {
			if (e?.name) env[e.name] = String(e.value ?? "");
		}
		// Decide between direct exec and shell exec:
		//   - If args is non-empty → agent gave us a clean argv pair, exec
		//     directly via spawn(command, args) — fastest path, no shell.
		//   - If args is empty/missing → agent gave us a single command
		//     string that may contain shell metacharacters (pipes, redirects,
		//     `cd && ...`, etc.). Mistral Vibe and OpenCode both send their
		//     Bash tool calls this way. Run through `sh -c` so the shell
		//     parses the line correctly.
		const needsShell = !p.args || p.args.length === 0;
		const spawnCommand = needsShell ? "/bin/sh" : p.command;
		const spawnArgs = needsShell ? ["-c", p.command] : (p.args ?? []);
		const limit = p.outputByteLimit ?? 1_048_576; // 1 MiB default
		const state: TerminalState = {
			child: null as unknown as ChildProcess, // populated below
			output: Buffer.alloc(0),
			outputByteLimit: limit,
			truncated: false,
			exitCode: null,
			signal: null,
			exitPromise: Promise.resolve(),
		};
		let exitResolve!: () => void;
		state.exitPromise = new Promise<void>((resolve) => {
			exitResolve = resolve;
		});
		let child: ChildProcess;
		try {
			child = spawn(spawnCommand, spawnArgs, {
				cwd: p.cwd ?? undefined,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			// Synchronous spawn failure (e.g. EACCES on the binary path).
			// Surface as a non-zero exitCode rather than throwing — the
			// agent then sees the tool result as a normal command failure
			// and can recover (which is what real shells would do).
			state.exitCode = 127;
			exitResolve();
			const terminalId = randomUUID();
			state.output = Buffer.from(`spawn error: ${(e as Error).message}\n`);
			this.terminals.set(terminalId, state);
			return { terminalId } as CreateTerminalResponse;
		}
		state.child = child;
		// CRITICAL: bind an 'error' listener so an ENOENT (binary not
		// found, etc.) doesn't bubble as an unhandled 'error' event and
		// crash the host. The agent will see the non-zero exitCode via
		// terminalOutput / waitForTerminalExit and recover.
		child.on("error", (err) => {
			const msg = `spawn error: ${(err as Error).message}\n`;
			state.output = Buffer.concat([state.output, Buffer.from(msg)]);
			if (state.exitCode === null) {
				state.exitCode = 127;
				exitResolve();
			}
		});
		child.on("exit", (code, signal) => {
			state.exitCode = code;
			state.signal = signal;
			exitResolve();
		});
		const append = (chunk: Buffer) => {
			state.output = Buffer.concat([state.output, chunk]);
			if (state.output.byteLength > state.outputByteLimit) {
				// Truncate from the start so the most recent output is
				// retained — that's where most tool consumers look.
				state.output = state.output.subarray(
					state.output.byteLength - state.outputByteLimit,
				);
				state.truncated = true;
			}
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		const terminalId = randomUUID();
		this.terminals.set(terminalId, state);
		return { terminalId } as CreateTerminalResponse;
	}

	async terminalOutput(
		params: TerminalOutputRequest,
	): Promise<TerminalOutputResponse> {
		const p = params as unknown as { terminalId: string };
		const t = this.terminals.get(p.terminalId);
		if (!t) {
			throw new Error(`Unknown terminalId: ${p.terminalId}`);
		}
		const exitStatus =
			t.exitCode !== null || t.signal !== null
				? {
						exitCode: t.exitCode,
						signal: t.signal,
					}
				: null;
		return {
			output: t.output.toString("utf-8"),
			truncated: t.truncated,
			exitStatus,
		} as TerminalOutputResponse;
	}

	async waitForTerminalExit(
		params: WaitForTerminalExitRequest,
	): Promise<WaitForTerminalExitResponse> {
		const p = params as unknown as { terminalId: string };
		const t = this.terminals.get(p.terminalId);
		if (!t) {
			throw new Error(`Unknown terminalId: ${p.terminalId}`);
		}
		await t.exitPromise;
		return {
			exitCode: t.exitCode,
			signal: t.signal,
		} as WaitForTerminalExitResponse;
	}

	async killTerminal(
		params: KillTerminalRequest,
	): Promise<KillTerminalResponse> {
		const p = params as unknown as { terminalId: string };
		const t = this.terminals.get(p.terminalId);
		if (!t || !t.child) return {} as KillTerminalResponse;
		try {
			t.child.kill("SIGTERM");
		} catch {
			// already dead
		}
		// Escalate to SIGKILL after 3s
		const child = t.child;
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 3000).unref();
		return {} as KillTerminalResponse;
	}

	async releaseTerminal(
		params: ReleaseTerminalRequest,
	): Promise<ReleaseTerminalResponse> {
		const p = params as unknown as { terminalId: string };
		const t = this.terminals.get(p.terminalId);
		if (t && t.child) {
			try {
				t.child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
		}
		this.terminals.delete(p.terminalId);
		return {} as ReleaseTerminalResponse;
	}

	// Killswitch for session teardown — release every terminal we still hold.
	releaseAll(): void {
		for (const [id, t] of this.terminals) {
			if (t.child) {
				try {
					t.child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
			}
			this.terminals.delete(id);
		}
	}
}

// ── Spawn ─────────────────────────────────────────────────────────────

/**
 * Spawn an ACP binary and return an AcpClient wrapping it. Uses
 * @agentclientprotocol/sdk's ClientSideConnection for full ACP coverage
 * (every method in the Agent + Client interfaces, schema-validated).
 *
 * Capabilities advertised:
 *   fs.readTextFile = true       (LemonAcpClient.readTextFile)
 *   fs.writeTextFile = true      (LemonAcpClient.writeTextFile)
 *   terminal = true              (LemonAcpClient.createTerminal et al.)
 *
 * Mode: bypassPermissions (when advertised by the agent). The rl-env
 * watchdog enforces per-tool-call wall-time limits + workspace-scoped
 * process cleanup, which is the right place for safety in an automated
 * eval pipeline.
 */
export async function spawnAcpClient(
	opts: AcpSpawnOptions,
): Promise<AcpClient> {
	const child = spawn(opts.binaryPath, opts.args ?? [], {
		cwd: opts.cwd,
		// inherit stderr so upstream binary's diagnostics surface to the
		// parent runner's tty / scorecard.
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...process.env, ...opts.env },
	});
	if (!child.stdin || !child.stdout) {
		throw new Error("spawn returned child without stdin/stdout pipes");
	}

	// Bridge Node streams ↔ Web streams. Node 22+ has these built in.
	const stream: Stream = ndJsonStream(
		Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
		Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
	);

	const client = new LemonAcpClient(opts.translate ?? defaultAcpTranslate);
	const conn = new ClientSideConnection(() => client, stream);

	// ── Handshake ──
	// Advertise full capability set so the agent uses our terminals + fs
	// rather than spawning its own (Claude SDK respects this; codex/
	// opencode/vibe partially respect it).
	await conn.initialize({
		protocolVersion: 1,
		clientCapabilities: {
			fs: { readTextFile: true, writeTextFile: true },
			terminal: true,
		},
	});
	const sessRes = await conn.newSession({
		cwd: opts.cwd,
		mcpServers: [],
	});
	const sessionId = sessRes.sessionId;

	// Bypass per-tool permission prompts. The rl-env watchdog enforces
	// time + process-leak limits at a layer the agent can't see, which
	// is the right enforcement point for batched eval runs.
	const modes = (sessRes as unknown as {
		modes?: { availableModes?: Array<{ id?: string }> };
	}).modes;
	const hasBypass = (modes?.availableModes ?? []).some(
		(m) => m?.id === "bypassPermissions",
	);
	if (hasBypass) {
		try {
			await conn.setSessionMode({
				sessionId,
				modeId: "bypassPermissions",
			});
		} catch {
			// best-effort
		}
	}

	return {
		child,
		get sessionId() {
			return sessionId;
		},
		subscribe(handler) {
			client.subscribe(handler);
		},
		async prompt(text) {
			await conn.prompt({
				sessionId,
				prompt: [{ type: "text", text }],
			});
		},
		async cancel() {
			await conn.cancel({ sessionId });
		},
		async close() {
			client.releaseAll();
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
				}, 3000).unref();
			});
		},
	};
}
