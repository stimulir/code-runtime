/**
 * Pi-tools-on-AgentCore smoke — proves the per-tool seam (src/ops.ts), built.
 *
 * NO LLM. We construct Pi's real AgentTools with AgentCore-backed operations
 * (imported from the BUILT dist), then invoke each tool's `execute(toolCallId,
 * params, signal?, onUpdate?)` DIRECTLY and assert the effect happened INSIDE
 * AgentCore (eu-west-2):
 *
 *   - write : writes probe.txt with known content into AgentCore
 *   - read  : reads probe.txt back (exact content)
 *   - bash  : `echo hi; exit 0`  → resolves, output contains "hi"  (exitCode 0)
 *   - bash  : `exit 7`           → rejects with EXACT exit code 7
 *   - edit  : replaces content; read confirms the new content
 *   - find  : locates probe.txt via in-sandbox find
 *   - ls    : lists probe.txt via in-sandbox ls
 *
 * Cross-checks via bash that the file the WRITE tool created is the same file
 * bash sees (same AgentCore session), proving the tools share one sandbox.
 *
 * Run (AWS creds in the ambient default profile):
 *   AWS_REGION=eu-west-2 node scripts/ops-smoke.mjs
 *
 * Exit 0 all-pass, 1 on failure (clear message), 2 if no AWS creds.
 */

import { AgentCoreSandbox } from "@stimulir/code-runtime-sandbox-agentcore";
import { createAgentCorePiTools } from "../dist/index.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGION =
  process.env.AWS_REGION ?? process.env.BEDROCK_AGENTCORE_REGION ?? "eu-west-2";
// Sentinel cwd: the factories resolve user paths against this; our ops strip it
// to derive sandbox-relative paths. It never touches the host filesystem.
const CWD = "/sandbox";

function haveCreds() {
  // Env-var credentials, OR a populated shared credentials file (the SDK's
  // default chain reads ~/.aws/credentials), OR container/web-identity roles.
  const sharedCreds =
    process.env.AWS_SHARED_CREDENTIALS_FILE ??
    join(homedir(), ".aws", "credentials");
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_SESSION_TOKEN ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      existsSync(sharedCreds),
  );
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** Invoke a tool's execute() and return the joined text content. */
async function callText(tool, params) {
  const res = await tool.execute(`smoke-${Date.now()}`, params);
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

async function main() {
  if (!haveCreds()) {
    process.stderr.write(
      "[pi-agentcore-ops-smoke] SKIP: no AWS creds. Run:\n" +
        "  AWS_REGION=eu-west-2 node scripts/ops-smoke.mjs\n",
    );
    return 2;
  }

  const log = (m) => process.stdout.write(`[pi-agentcore-ops-smoke] ${m}\n`);
  const sandbox = new AgentCoreSandbox({ region: REGION, name: "pi-ops-smoke" });

  log(`starting AgentCore session in ${REGION} …`);
  const sessionId = await sandbox.start();
  log(`session: ${sessionId}`);

  const tools = createAgentCorePiTools(sandbox, CWD);
  const PROBE = "probe.txt";
  const CONTENT_V1 = "lemon agentcore pi-ops v1\n";

  try {
    // ── 1. WRITE → AgentCore ────────────────────────────────────────────
    const writeOut = await callText(tools.write, { path: PROBE, content: CONTENT_V1 });
    assert(/Successfully wrote/.test(writeOut), `write should report success, got: ${writeOut}`);
    log(`PASS write: ${writeOut.trim()}`);

    // ── 2. READ ← AgentCore ─────────────────────────────────────────────
    const readOut = await callText(tools.read, { path: PROBE });
    assert(
      readOut.includes("lemon agentcore pi-ops v1"),
      `read should return written content, got: ${JSON.stringify(readOut)}`,
    );
    log(`PASS read: file content round-tripped through AgentCore`);

    // ── 2b. Cross-check: bash sees the SAME file the write tool created ──
    const catOut = await callText(tools.bash, { command: `cat ${PROBE}` });
    assert(
      catOut.includes("lemon agentcore pi-ops v1"),
      `bash cat should see the write tool's file (shared session), got: ${JSON.stringify(catOut)}`,
    );
    log(`PASS shared-session: bash cat sees the write tool's probe.txt`);

    // ── 3. BASH exit 0 ──────────────────────────────────────────────────
    const echoOut = await callText(tools.bash, { command: "echo hi; exit 0" });
    assert(echoOut.includes("hi"), `bash output should contain "hi", got: ${JSON.stringify(echoOut)}`);
    log(`PASS bash exit0: output "${echoOut.trim()}" with clean resolve (exitCode 0)`);

    // ── 4. BASH exit 7 (EXACT code) ─────────────────────────────────────
    // The bash tool REJECTS on non-zero exit, embedding "exited with code N".
    let rejected = false;
    let exitMsg = "";
    try {
      await callText(tools.bash, { command: "exit 7" });
    } catch (e) {
      rejected = true;
      exitMsg = e.message;
    }
    assert(rejected, "bash `exit 7` should reject (non-zero exit)");
    assert(
      /exited with code 7\b/.test(exitMsg),
      `bash exit-7 should surface EXACT code 7, got: ${JSON.stringify(exitMsg)}`,
    );
    log(`PASS bash exit7: exact exit code 7 threaded from AgentCore`);

    // ── 5. EDIT → read confirms ─────────────────────────────────────────
    await callText(tools.edit, {
      path: PROBE,
      oldText: "pi-ops v1",
      newText: "pi-ops v2-edited",
    });
    const readEdited = await callText(tools.read, { path: PROBE });
    assert(
      readEdited.includes("lemon agentcore pi-ops v2-edited"),
      `read after edit should show new content, got: ${JSON.stringify(readEdited)}`,
    );
    log(`PASS edit: content changed in AgentCore and read back confirms it`);

    // ── 6. FIND (in-sandbox glob) ───────────────────────────────────────
    const findOut = await callText(tools.find, { pattern: "*.txt" });
    assert(
      findOut.includes("probe.txt"),
      `find should locate probe.txt in AgentCore, got: ${JSON.stringify(findOut)}`,
    );
    log(`PASS find: located probe.txt via in-sandbox find`);

    // ── 7. LS (in-sandbox readdir) ──────────────────────────────────────
    const lsOut = await callText(tools.ls, { path: "." });
    assert(
      lsOut.includes("probe.txt"),
      `ls should list probe.txt in AgentCore, got: ${JSON.stringify(lsOut)}`,
    );
    log(`PASS ls: listed probe.txt via in-sandbox ls`);

    log("ALL PASS — Pi tools executed inside AgentCore.");
    return 0;
  } catch (err) {
    process.stderr.write(`[pi-agentcore-ops-smoke] FAIL: ${err.message}\n`);
    return 1;
  } finally {
    try {
      await sandbox.dispose();
      log("session disposed.");
    } catch (e) {
      process.stderr.write(`[pi-agentcore-ops-smoke] dispose warning: ${e.message}\n`);
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`[pi-agentcore-ops-smoke] UNCAUGHT: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
