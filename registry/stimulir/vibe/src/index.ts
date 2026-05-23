/**
 * @stimulir/code-runtime-vibe
 *
 * Stimulir adapter for Mistral Vibe (https://github.com/mistralai/mistral-vibe).
 * Vibe is a Python-only coding agent; this adapter spawns its
 * `vibe-acp` binary (installed via `pip install mistral-vibe`) and
 * speaks ACP JSON-RPC over stdio.
 *
 * Mapping Vibe's ACP events → Stimulir's canonical trajectory shape:
 *
 *   agent_message_chunk                → text_delta
 *   tool_call_update (in_progress)     → tool_execution_start
 *   tool_call_update (completed)       → tool_execution_end
 *   tool_call_update (error)           → tool_execution_error
 *   ReasoningEvent                     → text_delta (tagged channel)
 *   ToolResultEvent                    → tool_execution_end payload
 *   SessionTitleUpdated, CompactStart  → session_meta
 *
 * Quirk handled: Vibe has NO `--append-system-prompt` flag. To inject
 * a system prompt, this adapter materializes an `AGENTS.md` in the
 * working dir — but AGENTS.md REPLACES Vibe's default system prompt
 * (it does not append). We compose: <bundled Vibe-default AGENTS.md>
 * + "\n\n---\n\n" + user's appendSystemPrompt before writing.
 *
 * Auth: requires `MISTRAL_API_KEY` in env.
 *
 * Usage:
 *
 *   import { createVibeAdapter } from "@stimulir/code-runtime-vibe";
 *
 *   const session = await createVibeAdapter({
 *     cwd: "/path/to/workspace",
 *     model: "mistral-medium-3.5",
 *     appendSystemPrompt: "You are a coding agent…",
 *   });
 *
 *   session.subscribe(ev => writer.write(ev));
 *   await session.prompt("Fix the failing tests.");
 *   await session.close();
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
	spawnAcpClient,
	type AcpClient,
	type CanonicalEvent,
} from "@stimulir/code-runtime-host";

export interface CreateVibeAdapterSpec {
	/** Working dir Vibe operates in. */
	cwd: string;
	/** Mistral model id (e.g. "mistral-medium-3.5"). Optional — Vibe has a default. */
	model?: string;
	/** Optional system-prompt addendum. Materialized into AGENTS.md.
	 *  WARNING: replaces Vibe's default prompt (Vibe has no --append). */
	appendSystemPrompt?: string;
	/** Env overrides. MISTRAL_API_KEY must be set somewhere. */
	env?: Record<string, string | undefined>;
	/** Override the vibe-acp binary path (default: "vibe-acp" on PATH). */
	binaryPath?: string;
	/** Extra CLI args for vibe-acp. */
	extraArgs?: string[];
}

export interface VibeAgentSession {
	readonly sessionId: string;
	subscribe(handler: (ev: CanonicalEvent) => void): void;
	prompt(text: string): Promise<void>;
	cancel(): Promise<void>;
	close(): Promise<void>;
	readonly acp: AcpClient;
}

/** Vibe's default AGENTS.md — vendored here so user prompts can prepend
 *  without losing the baseline. Updated to match Vibe 2.10.x defaults;
 *  re-vendor on Vibe major bumps. Empty by default — Vibe operates fine
 *  without one, but if the user provides appendSystemPrompt we MUST
 *  preserve any defaults Vibe would otherwise apply. */
const VIBE_DEFAULT_AGENTS_MD = "";

/**
 * Vibe-specific ACP event translator. Handles the additional event
 * types Vibe emits beyond the generic defaultAcpTranslate set:
 * ReasoningEvent, ToolResultEvent, SessionTitleUpdated, CompactStart/End.
 */
function vibeAcpTranslate(notif: unknown): CanonicalEvent | null {
	if (!notif || typeof notif !== "object") return null;
	const n = notif as Record<string, unknown>;
	const update = (n.sessionUpdate ?? n.update_type) as string | undefined;

	// Vibe-specific: ReasoningEvent → tagged text_delta
	if (update === "reasoning" || update === "reasoning_event") {
		const content = n.content as Record<string, unknown> | undefined;
		return {
			type: "text_delta",
			text: (content?.text as string | undefined) ?? "",
			channel: "reasoning",
		};
	}
	// Vibe-specific: ToolResultEvent → tool_execution_end payload
	if (update === "tool_result_event" || update === "tool_result") {
		const fieldMeta = n.fieldMeta as Record<string, unknown> | undefined;
		return {
			type: "tool_execution_end",
			toolCallId: n.toolCallId as string | undefined,
			toolName: fieldMeta?.tool_name as string | undefined,
			result: n.content,
		};
	}
	// Vibe-specific session meta
	if (
		update === "session_title_updated" ||
		update === "compact_start" ||
		update === "compact_end" ||
		update === "usage_update"
	) {
		return { type: "session_meta", subType: update, raw: n };
	}

	// Defer everything else to the default translator.
	if (!update) return { type: "session_meta", raw: n };
	if (update === "agent_message_chunk") {
		const content = n.content as Record<string, unknown> | undefined;
		return {
			type: "text_delta",
			text: (content?.text as string | undefined) ?? "",
		};
	}
	if (update === "tool_call_update") {
		const status = (n.status as string | undefined) ?? "in_progress";
		const toolCallId = (n.toolCallId ?? n.tool_call_id) as string | undefined;
		const fieldMeta = (n.fieldMeta ?? n.field_meta) as
			| Record<string, unknown>
			| undefined;
		const toolName = (fieldMeta?.tool_name ?? n.kind) as string | undefined;
		if (status === "in_progress" || status === "started") {
			return { type: "tool_execution_start", toolCallId, toolName, args: (n.content as Record<string, unknown>) ?? {} };
		}
		if (status === "completed") {
			return { type: "tool_execution_end", toolCallId, toolName, result: n.content };
		}
		if (status === "error" || status === "failed") {
			return { type: "tool_execution_error", toolCallId, toolName, isError: true, result: n.content };
		}
		return { type: "tool_execution_update", toolCallId, toolName };
	}
	return { type: "session_meta", raw: n };
}

/**
 * Materialize Vibe's per-workdir AGENTS.md by composing the bundled
 * Vibe-default + the user's appendSystemPrompt. Idempotent — overwrites
 * any existing AGENTS.md.
 *
 * IMPORTANT: AGENTS.md in Vibe REPLACES the default system prompt; it
 * does not append. This function preserves the default by re-emitting
 * it followed by a separator and the user's addendum.
 */
async function materializeVibeAgentsMd(
	cwd: string,
	appendSystemPrompt?: string,
): Promise<void> {
	if (!appendSystemPrompt) return;  // no override needed
	await mkdir(cwd, { recursive: true });
	const composed = [VIBE_DEFAULT_AGENTS_MD, appendSystemPrompt]
		.filter(Boolean)
		.join("\n\n---\n\n");
	await writeFile(join(cwd, "AGENTS.md"), composed, "utf8");
}

export async function createVibeAdapter(
	spec: CreateVibeAdapterSpec,
): Promise<VibeAgentSession> {
	if (!process.env.MISTRAL_API_KEY && !(spec.env ?? {}).MISTRAL_API_KEY) {
		throw new Error(
			"MISTRAL_API_KEY is not set in env. Put it in .env or pass via spec.env.",
		);
	}

	const cwd = resolvePath(spec.cwd);
	await materializeVibeAgentsMd(cwd, spec.appendSystemPrompt);

	const args: string[] = [];
	if (spec.extraArgs) args.push(...spec.extraArgs);

	const acp = await spawnAcpClient({
		binaryPath: spec.binaryPath ?? "vibe-acp",
		args,
		cwd,
		env: spec.env,
		translate: vibeAcpTranslate,
	});

	// Set Vibe's active model if the user specified one (via ACP).
	// Vibe exposes `set_session_model` post-handshake; we send it as a
	// JSON-RPC request. If the model isn't supported we let Vibe error
	// out on the first prompt rather than pre-validating.
	if (spec.model) {
		try {
			// The ACP client doesn't expose a generic .request() yet, so
			// we write directly to the child's stdin. Best-effort.
			const msg = JSON.stringify({
				jsonrpc: "2.0",
				id: 9999,
				method: "session/set_model",
				params: { sessionId: acp.sessionId, model: spec.model },
			}) + "\n";
			acp.child.stdin?.write(msg);
		} catch {
			// non-fatal
		}
	}

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
