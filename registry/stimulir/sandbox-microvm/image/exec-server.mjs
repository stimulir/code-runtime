#!/usr/bin/env node
/**
 * In-VM exec-server for the MicroVM sandbox image. Listens on port 8080 (the
 * Lambda MicroVM default route) and gives the MicrovmSandbox provider its
 * exec/read/write surface, plus the required Lambda MicroVM lifecycle hooks.
 *
 * Secret injection: the /run lifecycle hook receives `runHookPayload` — the
 * JSON the provider set on RunMicrovm — which carries this session's vault
 * secrets. We parse them ONCE here and merge them into the env of every /exec
 * and /run-code. This is the native, per-VM secret path (unique per MicroVM,
 * never shared across sessions like image-level env would be).
 *
 * Node stdlib only — no deps, so it adds nothing to the image beyond node.
 */
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import os from "node:os";

const PORT = Number(process.env.EXEC_SERVER_PORT || 8080);
const WORKSPACE = process.env.WORKSPACE_DIR || "/workspace";
const HOOK_BASE = "/aws/lambda-microvms/runtime/v1";

// Secrets from the /run hook's runHookPayload. Merged into every exec env.
let sessionSecrets = {};

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function json(res, code, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(code, { "Content-Type": "application/json" });
	res.end(body);
}

function runShell(command) {
	return new Promise((resolve) => {
		const env = { ...process.env, ...sessionSecrets };
		execFile(
			"/bin/bash",
			["-lc", command],
			{ cwd: WORKSPACE, env, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 },
			(err, stdout, stderr) => {
				const exitCode = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
			},
		);
	});
}

async function runCode(language, code) {
	const ext = language === "python" ? "py" : language === "node" || language === "javascript" ? "mjs" : "txt";
	const interp = ext === "py" ? "python3" : ext === "mjs" ? "node" : null;
	if (!interp) return { stdout: "", stderr: `unsupported language ${language}`, exitCode: 2 };
	const file = resolve(os.tmpdir(), `snippet-${Date.now()}.${ext}`);
	await writeFile(file, code, "utf-8");
	return runShell(`${interp} ${file}`);
}

const server = http.createServer(async (req, res) => {
	try {
		const url = req.url || "/";
		const body = req.method === "POST" ? await readBody(req) : "";

		// ── Lifecycle hooks ────────────────────────────────────────────────
		if (url.startsWith(HOOK_BASE)) {
			const hook = url.slice(HOOK_BASE.length);
			if (hook === "/run") {
				// { microvmId, runHookPayload } — runHookPayload is our JSON string.
				try {
					const parsed = body ? JSON.parse(body) : {};
					const payload = parsed.runHookPayload ? JSON.parse(parsed.runHookPayload) : {};
					sessionSecrets = payload.secrets && typeof payload.secrets === "object" ? payload.secrets : {};
				} catch {
					sessionSecrets = {};
				}
				await mkdir(WORKSPACE, { recursive: true }).catch(() => {});
			}
			// /ready, /validate, /resume, /suspend, /terminate — 200 is sufficient.
			return json(res, 200, { ok: true });
		}

		// ── Exec surface ───────────────────────────────────────────────────
		if (req.method === "POST" && url === "/exec") {
			const { command } = JSON.parse(body || "{}");
			return json(res, 200, await runShell(String(command ?? "")));
		}
		if (req.method === "POST" && url === "/run-code") {
			const { language, code } = JSON.parse(body || "{}");
			return json(res, 200, await runCode(String(language ?? "python"), String(code ?? "")));
		}
		if (req.method === "POST" && url === "/read") {
			const { path } = JSON.parse(body || "{}");
			try {
				const content = await readFile(resolve(WORKSPACE, path), "utf-8");
				return json(res, 200, { ok: true, content });
			} catch (e) {
				return json(res, 200, { ok: false, error: String(e) });
			}
		}
		if (req.method === "POST" && url === "/write") {
			const { path, content } = JSON.parse(body || "{}");
			try {
				const abs = resolve(WORKSPACE, path);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, String(content ?? ""), "utf-8");
				return json(res, 200, { ok: true });
			} catch (e) {
				return json(res, 200, { ok: false, error: String(e) });
			}
		}

		// Health / anything else.
		if (url === "/health") return json(res, 200, { ok: true });
		return json(res, 404, { ok: false, error: "not found" });
	} catch (e) {
		return json(res, 500, { ok: false, error: String(e) });
	}
});

server.listen(PORT, () => {
	console.log(`exec-server listening on :${PORT} (workspace ${WORKSPACE})`);
});
