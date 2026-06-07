/**
 * Bedrock AgentCore Code Interpreter client — the execution backend.
 *
 * This is the AgentCore-specific core: it manages a managed code-execution
 * session and maps the agent's filesystem + exec operations onto AgentCore's
 * InvokeCodeInterpreter tools. Every operation runs IN the AWS-managed sandbox
 * (a separate process pool), so the calling service's memory never grows with
 * the workload — the fix for the in-process OOM.
 *
 * Proven against real AgentCore (eu-west-2): 8 concurrent 200MB workloads
 * offloaded 1.6GB while the caller grew +86MB. See
 * scripts/agentcore_scalability_test.py in lemon-tasker.
 *
 * The five Code Interpreter tools used:
 *   executeCommand  → bash
 *   executeCode     → run python/js
 *   readFiles       → read
 *   writeFiles      → write / edit
 *   (list/start/stop session lifecycle)
 */

import {
	BedrockAgentCoreClient,
	StartCodeInterpreterSessionCommand,
	StopCodeInterpreterSessionCommand,
	InvokeCodeInterpreterCommand,
	type ToolName,
} from "@aws-sdk/client-bedrock-agentcore";

const DEFAULT_INTERPRETER = "aws.codeinterpreter.v1";

export interface AgentCoreSandboxOptions {
	/** AWS region. AgentCore Code Interpreter is available in us-east-1, eu-west-2, … */
	region: string;
	/** Built-in or custom interpreter id. Defaults to aws.codeinterpreter.v1. */
	interpreterId?: string;
	/** Session idle timeout (seconds). */
	sessionTimeoutSeconds?: number;
	/** Human label for the session. */
	name?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	isError: boolean;
}

/**
 * One AgentCore Code Interpreter session = one isolated sandbox. Create per
 * agent run; dispose() frees the managed sandbox in AWS.
 */
export class AgentCoreSandbox {
	private client: BedrockAgentCoreClient;
	private readonly interpreterId: string;
	private readonly opts: AgentCoreSandboxOptions;
	private sessionId: string | null = null;

	constructor(opts: AgentCoreSandboxOptions) {
		this.opts = opts;
		this.interpreterId = opts.interpreterId ?? DEFAULT_INTERPRETER;
		this.client = new BedrockAgentCoreClient({ region: opts.region });
	}

	/** Start the managed sandbox session. Idempotent. */
	async start(): Promise<string> {
		if (this.sessionId) return this.sessionId;
		const res = await this.client.send(
			new StartCodeInterpreterSessionCommand({
				codeInterpreterIdentifier: this.interpreterId,
				name: this.opts.name ?? "code-runtime-sandbox",
				sessionTimeoutSeconds: this.opts.sessionTimeoutSeconds ?? 900,
			}),
		);
		if (!res.sessionId) throw new Error("AgentCore: no sessionId returned");
		this.sessionId = res.sessionId;
		return this.sessionId;
	}

	/** Separated stdout/stderr/exitCode that executeCommand/executeCode return alongside content. */
	private static readonly STRUCTURED_KEY = "structuredContent";

	/** Read the streamed content out of an InvokeCodeInterpreter response. */
	private async drain(stream: AsyncIterable<unknown>): Promise<{
		text: string;
		isError: boolean;
		/**
		 * Present for executeCommand/executeCode: the faithful, separated
		 * streams + the REAL process exit code. Absent for readFiles/writeFiles
		 * (which return only content blocks). When present this is the source of
		 * truth for exitCode — do NOT infer the exit code from `isError`, which
		 * is a tool-level flag, not the command's exit status.
		 */
		structured?: { stdout: string; stderr: string; exitCode: number };
	}> {
		const parts: string[] = [];
		let isError = false;
		let structured: { stdout: string; stderr: string; exitCode: number } | undefined;
		for await (const ev of stream as AsyncIterable<Record<string, unknown>>) {
			const result = ev["result"] as
				| {
						content?: Array<Record<string, unknown>>;
						isError?: boolean;
						structuredContent?: { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
				  }
				| undefined;
			if (!result) continue;
			if (result.isError) isError = true;
			const sc = result[AgentCoreSandbox.STRUCTURED_KEY] as
				| { stdout?: unknown; stderr?: unknown; exitCode?: unknown }
				| undefined;
			if (sc && typeof sc.exitCode === "number") {
				structured = {
					stdout: typeof sc.stdout === "string" ? sc.stdout : "",
					stderr: typeof sc.stderr === "string" ? sc.stderr : "",
					exitCode: sc.exitCode,
				};
			}
			for (const item of result.content ?? []) {
				// executeCommand/executeCode return plain text blocks.
				if (item["type"] === "text" && typeof item["text"] === "string") {
					parts.push(item["text"] as string);
					continue;
				}
				// readFiles returns embedded-resource blocks: the file body lives
				// in resource.text (uri/mimeType alongside), NOT a top-level text block.
				if (item["type"] === "resource") {
					const resource = item["resource"] as { text?: unknown } | undefined;
					if (resource && typeof resource.text === "string") {
						parts.push(resource.text);
					}
				}
			}
		}
		return { text: parts.join(""), isError, structured };
	}

	private async invoke(
		name: ToolName,
		args: Record<string, unknown>,
	): Promise<{
		text: string;
		isError: boolean;
		structured?: { stdout: string; stderr: string; exitCode: number };
	}> {
		const sid = await this.start();
		const res = await this.client.send(
			new InvokeCodeInterpreterCommand({
				codeInterpreterIdentifier: this.interpreterId,
				sessionId: sid,
				name,
				arguments: args,
			}),
		);
		// The SDK exposes the event stream as an async iterable.
		return this.drain(res.stream as AsyncIterable<unknown>);
	}

	/** Run a shell command in the sandbox (the agent's `bash` tool). */
	async exec(command: string): Promise<ExecResult> {
		const { text, isError, structured } = await this.invoke("executeCommand", { command });
		return this.toExecResult(text, isError, structured);
	}

	/**
	 * Run code in the sandbox (executeCode).
	 *
	 * NOTE: executeCode runs in an IPython kernel, so the script's own exit
	 * status is not faithfully reflected (e.g. `sys.exit(5)` surfaces as
	 * exitCode 1). For exact process exit codes, drive a real command via
	 * exec() instead.
	 */
	async run(code: string, language = "python"): Promise<ExecResult> {
		const { text, isError, structured } = await this.invoke("executeCode", { language, code });
		return this.toExecResult(text, isError, structured);
	}

	/**
	 * Build the ExecResult. structuredContent (when present) is the source of
	 * truth: it carries the REAL exit code + separated stdout/stderr. Only when
	 * it is absent do we fall back to the joined text + the tool-level isError
	 * flag (which is NOT the command's exit status).
	 */
	private toExecResult(
		text: string,
		isError: boolean,
		structured?: { stdout: string; stderr: string; exitCode: number },
	): ExecResult {
		if (structured) {
			// AgentCore sometimes routes a failing command's whole output to
			// stderr and leaves stdout empty; keep the joined text as a fallback
			// so callers never lose the output entirely.
			const stdout = structured.stdout || (structured.stderr ? "" : text);
			return { stdout, stderr: structured.stderr, exitCode: structured.exitCode, isError };
		}
		return { stdout: text, stderr: isError ? text : "", exitCode: isError ? 1 : 0, isError };
	}

	/** Read a file from the sandbox (the agent's `read` tool). */
	async readFile(path: string): Promise<string> {
		const { text } = await this.invoke("readFiles", { paths: [path] });
		return text;
	}

	/** Write a file into the sandbox (the agent's `write` / `edit` tool). */
	async writeFile(path: string, content: string): Promise<void> {
		await this.invoke("writeFiles", {
			content: [{ path, text: content }],
		});
	}

	/** Stop the session — frees the managed sandbox in AWS. */
	async dispose(): Promise<void> {
		if (!this.sessionId) return;
		try {
			await this.client.send(
				new StopCodeInterpreterSessionCommand({
					codeInterpreterIdentifier: this.interpreterId,
					sessionId: this.sessionId,
				}),
			);
		} finally {
			this.sessionId = null;
		}
	}
}
