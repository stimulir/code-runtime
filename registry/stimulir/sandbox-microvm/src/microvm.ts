/**
 * MicrovmSandbox — an AWS Lambda MicroVM (Firecracker) sandbox provider for
 * code-runtime. Drop-in surface-compatible with AgentCoreSandbox
 * (start/exec/run/readFile/writeFile/dispose), so a consumer that drives the
 * AgentCore sandbox directly can swap to this by construction.
 *
 * WHY over AgentCore Code Interpreter:
 *   - bring-your-own image: Chromium, Python, any apt package baked in (browser-use
 *     runs INSIDE the sandbox — no separate browser-service).
 *   - native per-session secret injection: vault keys ride `runHookPayload`
 *     (unique per MicroVM, 16KB) to the /run hook, which exports them — the exact
 *     thing AgentCore's env-less executeCommand could not do.
 *   - 8h suspend/resume, VM-level isolation (dedicated kernel/memory/disk).
 *
 * Model: your image serves an exec-server on port 8080 (see image/exec-server.mjs).
 * The control plane (run/token/terminate) uses @aws-sdk/client-lambda-microvms;
 * exec/read/write are HTTPS calls to the running VM's endpoint with the JWE
 * `X-aws-proxy-auth` token. Availability: eu-west-1 (NOT eu-west-2).
 */
import {
	LambdaMicrovmsClient,
	RunMicrovmCommand,
	GetMicrovmCommand,
	CreateMicrovmAuthTokenCommand,
	TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";

export interface MicrovmSandboxOptions {
	/** AWS region. Lambda MicroVMs is in eu-west-1 (and us-east-1, …) — NOT eu-west-2. */
	region: string;
	/** ARN of a CREATED MicroVM image (from create-microvm-image). */
	imageIdentifier: string;
	/** IAM role granting the MicroVM runtime AWS permissions (optional). */
	executionRoleArn?: string;
	/** Per-session secrets → delivered to the /run hook as runHookPayload JSON. */
	secrets?: Record<string, string>;
	/** Extra per-session config merged alongside `secrets` into the run payload. */
	runConfig?: Record<string, unknown>;
	/** Port the in-VM exec-server listens on (default 8080, Lambda's default route). */
	port?: number;
	/** Idle policy — suspend after N idle seconds, auto-resume on traffic. */
	idlePolicy?: {
		autoResumeEnabled?: boolean;
		maxIdleDurationSeconds?: number;
		suspendedDurationSeconds?: number;
	};
	/** Hard cap on VM lifetime, 1..28800s (8h). Defaults to 3600. */
	maximumDurationInSeconds?: number;
	/** Auth-token TTL in minutes (default 60). */
	authTokenTtlMinutes?: number;
	/** How long to wait for RUNNING before failing (ms, default 120000). */
	startTimeoutMs?: number;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	isError: boolean;
}

const RUNNING = "RUNNING";
const TERMINAL_BAD = new Set(["FAILED", "TERMINATED", "TERMINATING"]);

export class MicrovmSandbox {
	private readonly client: LambdaMicrovmsClient;
	private readonly opts: MicrovmSandboxOptions;
	private readonly port: number;

	private microvmId: string | null = null;
	private endpoint: string | null = null;
	private authToken: string | null = null;
	private startPromise: Promise<string> | null = null;

	constructor(opts: MicrovmSandboxOptions) {
		this.opts = opts;
		this.port = opts.port ?? 8080;
		this.client = new LambdaMicrovmsClient({ region: opts.region });
	}

	private connectorArn(name: "ALL_INGRESS" | "INTERNET_EGRESS"): string {
		return `arn:aws:lambda:${this.opts.region}:aws:network-connector:aws-network-connector:${name}`;
	}

	/** Idempotent: launch the MicroVM, wait for RUNNING, mint an auth token. */
	async start(): Promise<string> {
		if (this.microvmId && this.endpoint && this.authToken) return this.microvmId;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this._start();
		try {
			return await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	private async _start(): Promise<string> {
		const runPayload = JSON.stringify({
			secrets: this.opts.secrets ?? {},
			...(this.opts.runConfig ?? {}),
		});

		const run = await this.client.send(
			new RunMicrovmCommand({
				imageIdentifier: this.opts.imageIdentifier,
				executionRoleArn: this.opts.executionRoleArn,
				ingressNetworkConnectors: [this.connectorArn("ALL_INGRESS")],
				egressNetworkConnectors: [this.connectorArn("INTERNET_EGRESS")],
				maximumDurationInSeconds: this.opts.maximumDurationInSeconds ?? 3600,
				idlePolicy: {
					autoResumeEnabled: this.opts.idlePolicy?.autoResumeEnabled ?? true,
					maxIdleDurationSeconds: this.opts.idlePolicy?.maxIdleDurationSeconds ?? 900,
					suspendedDurationSeconds: this.opts.idlePolicy?.suspendedDurationSeconds ?? 1800,
				},
				runHookPayload: runPayload,
			}),
		);

		const id = run.microvmId;
		const endpoint = run.endpoint;
		if (!id || !endpoint) throw new Error("run-microvm returned no microvmId/endpoint");
		this.microvmId = id;
		this.endpoint = endpoint;

		await this.waitForRunning(id);

		const tok = await this.client.send(
			new CreateMicrovmAuthTokenCommand({
				microvmIdentifier: id,
				expirationInMinutes: this.opts.authTokenTtlMinutes ?? 60,
				allowedPorts: [{ allPorts: {} }],
			}),
		);
		// authToken is a header map: { "X-aws-proxy-auth": "<jwe>" }
		const header = (tok.authToken as Record<string, string> | undefined)?.["X-aws-proxy-auth"];
		if (!header) throw new Error("create-microvm-auth-token returned no X-aws-proxy-auth");
		this.authToken = header;
		return id;
	}

	private async waitForRunning(id: string): Promise<void> {
		const deadline = Date.now() + (this.opts.startTimeoutMs ?? 120_000);
		while (Date.now() < deadline) {
			const got = await this.client.send(new GetMicrovmCommand({ microvmIdentifier: id }));
			const state = String(got.state ?? "");
			if (state === RUNNING) return;
			if (TERMINAL_BAD.has(state)) {
				throw new Error(`MicroVM ${id} entered ${state}: ${got.stateReason ?? "no reason"}`);
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
		throw new Error(`MicroVM ${id} did not reach RUNNING within timeout`);
	}

	/** POST a JSON body to the in-VM exec-server and return its JSON response. */
	private async request(path: string, body: unknown): Promise<any> {
		await this.start();
		const resp = await fetch(`https://${this.endpoint}${path}`, {
			method: "POST",
			headers: {
				"X-aws-proxy-auth": this.authToken as string,
				"X-aws-proxy-port": String(this.port),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!resp.ok) {
			const text = await resp.text().catch(() => "");
			throw new Error(`exec-server ${path} HTTP ${resp.status}: ${text.slice(0, 300)}`);
		}
		return resp.json();
	}

	/** Run a shell command in the sandbox (the agent's `bash` tool). */
	async exec(command: string): Promise<ExecResult> {
		const r = await this.request("/exec", { command });
		const exitCode = typeof r.exitCode === "number" ? r.exitCode : r.isError ? 1 : 0;
		return {
			stdout: String(r.stdout ?? ""),
			stderr: String(r.stderr ?? ""),
			exitCode,
			isError: exitCode !== 0,
		};
	}

	/** Run code in a given language (executeCode analog). */
	async run(code: string, language = "python"): Promise<ExecResult> {
		const r = await this.request("/run-code", { language, code });
		const exitCode = typeof r.exitCode === "number" ? r.exitCode : r.isError ? 1 : 0;
		return {
			stdout: String(r.stdout ?? ""),
			stderr: String(r.stderr ?? ""),
			exitCode,
			isError: exitCode !== 0,
		};
	}

	async readFile(path: string): Promise<string> {
		const r = await this.request("/read", { path });
		if (r.ok === false) throw new Error(`read ${path}: ${r.error ?? "failed"}`);
		return String(r.content ?? "");
	}

	async writeFile(path: string, content: string): Promise<void> {
		const r = await this.request("/write", { path, content });
		if (r.ok === false) throw new Error(`write ${path}: ${r.error ?? "failed"}`);
	}

	/** Terminate the MicroVM, releasing all resources and stopping charges. */
	async dispose(): Promise<void> {
		const id = this.microvmId;
		this.microvmId = null;
		this.endpoint = null;
		this.authToken = null;
		if (!id) return;
		try {
			await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
		} catch {
			// Best-effort — the idle policy's suspendedDurationSeconds is the backstop
			// that auto-terminates a leaked VM, so a failed terminate is not a leak.
		}
	}
}
