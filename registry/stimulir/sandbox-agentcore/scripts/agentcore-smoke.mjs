// Runtime smoke against real AgentCore, importing the BUILT dist (no tsx needed).
//   AWS_REGION=eu-west-2 node scripts/agentcore-smoke.mjs
import { AgentCoreSandbox } from "../dist/index.js";

const REGION = process.env.AWS_REGION ?? "eu-west-2";
const assert = (c, m) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); };

async function main() {
	const marker = `agentcore-smoke-${process.pid}`;
	const box = new AgentCoreSandbox({ region: REGION, name: marker });
	try {
		const sid = await box.start();
		assert(!!sid, "start() returned a sessionId");
		process.stdout.write(`[smoke] session: ${sid}\n`);

		const echoed = await box.exec("echo hello-from-agentcore");
		process.stdout.write(`[smoke] exec stdout=${JSON.stringify(echoed.stdout)} isError=${echoed.isError}\n`);
		assert(!echoed.isError, "exec echo did not error");
		assert(echoed.stdout.includes("hello-from-agentcore"), "exec echo round-tripped stdout");

		const ran = await box.run("print(6 * 7)", "python");
		process.stdout.write(`[smoke] run stdout=${JSON.stringify(ran.stdout)} isError=${ran.isError}\n`);
		assert(!ran.isError, "run python did not error");
		assert(ran.stdout.includes("42"), "run python computed 42");

		const path = "smoke.txt";
		const content = `payload-${marker}`;
		await box.writeFile(path, content);
		const readBack = await box.readFile(path);
		process.stdout.write(`[smoke] readFile=${JSON.stringify(readBack)}\n`);
		assert(readBack.includes(content), "writeFile/readFile round-tripped content");

		// Regression guard (the original smoke only checked happy-path exit 0):
		// the REAL non-zero exit code must surface, not a coerced 1.
		const failed = await box.exec("echo out; echo err >&2; exit 3");
		process.stdout.write(`[smoke] exit-3 exitCode=${failed.exitCode} stderr=${JSON.stringify(failed.stderr)}\n`);
		assert(failed.exitCode === 3, `non-zero exit surfaces exact code (got ${failed.exitCode})`);

		process.stdout.write("[smoke] PASS\n");
		return 0;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/credential|token|ExpiredToken|security token|Unauthorized|UnrecognizedClient/i.test(msg)) {
			process.stderr.write(`[smoke] SKIP: no usable AWS creds (${msg})\n`);
			return 2;
		}
		process.stderr.write(`[smoke] FAIL: ${msg}\n`);
		if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
		return 1;
	} finally {
		await box.dispose().catch(() => {});
	}
}
main().then((c) => process.exit(c));
