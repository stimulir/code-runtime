# @stimulir/code-runtime-sandbox-agentcore

Bedrock AgentCore Code Interpreter sandbox provider for code-runtime.

## Why this exists

`code-runtime` + Pi run agent tool-execution **in-process**. In a 2–4GB ECS
container (stimulir-console prod), concurrent agent sessions stack their
workspace + execution memory in the **same process** → **OOM crash**. Scaling up
just moves the ceiling; it's a shared-process design flaw.

This provider offloads tool-execution (`bash` / `read` / `write` / `edit` / run
code) to **AWS-managed, per-session AgentCore sandboxes**. The service keeps only
lightweight session handles; all heavy execution runs in AWS.

**Verified, real AgentCore (eu-west-2):**
- *Scalability:* 8 concurrent 200MB workloads offloaded **1.6GB** while the calling
  process grew **+86MB**, 8/8 in 1.9s — OOM source eliminated
  (`lemon-tasker/scripts/agentcore_scalability_test.py`).
- *TS client:* `exec` / `run` / `writeFile` + `readFile` round-trip all pass against
  a live Code Interpreter session, and a non-zero command surfaces its **exact**
  exit code (`exit 3` → `exitCode 3`, from `structuredContent` — not coerced from
  the tool-level `isError` flag). `scripts/agentcore-smoke.mjs`,
  `AWS_REGION=eu-west-2 node scripts/agentcore-smoke.mjs`.
- *Staging:* `writeFiles` auto-creates nested dirs (`tests/test.sh`) and shares the
  working directory with `executeCommand`, so a staged bundle + `bash tests/test.sh`
  works directly (default cwd `/opt/amazon/genesis1p-tools/var`).

## Two integration shapes

**(1) Direct** — works today, no upstream interface needed. Drive the sandbox
from a consumer's tool-execution layer:

```ts
import { AgentCoreSandbox } from "@stimulir/code-runtime-sandbox-agentcore";
const box = new AgentCoreSandbox({ region: "eu-west-2" });
await box.writeFile("app/report.py", patched);
const r = await box.exec("bash tests/test.sh");
await box.dispose();   // frees the AWS sandbox
```

**(2) agent-os provider** — register so Pi's tools route here automatically:

```ts
import { createAgentCoreSandboxProvider } from "@stimulir/code-runtime-sandbox-agentcore";
vm.addSandboxProvider(createAgentCoreSandboxProvider({ region: "eu-west-2" }));
```

Shape (2) needs the upstream `@rivet-dev/agent-os-sandbox` provider interface,
which isn't vendored into the fork yet (see `registry/stimulir/sandbox/src/index.ts`).
`src/provider.ts` is the single seam to finish once that interface lands; the
`AgentCoreSandbox` core it delegates to (`src/agentcore.ts`) is complete + proven.

## Architecture

```
  SERVICE (ECS, stays flat)          AGENTCORE (AWS-managed, scales)
  ─────────────────────────          ──────────────────────────────
  Pi reasoning / LLM calls    ──→    per-session Code Interpreter sandbox
  tool-call orchestration            bash · read · write · run · test.sh
  session handles only               execute IN the sandbox (200MB+ each)
  +86MB for 8 sessions               Start → Invoke → Stop
```

Maps the 5 Code Interpreter tools: `executeCommand`→bash, `executeCode`→run,
`readFiles`→read, `writeFiles`→write/edit, plus session lifecycle.

## Rollout

1. **Publish** this package to GitHub Packages (`pnpm -F @stimulir/code-runtime-sandbox-agentcore build && npm publish`).
2. **lemon-tasker** — add the dep; in `runner/src/sandbox.ts` add a
   `bedrock-agentcore` provider that wraps `AgentCoreSandbox`. Select via
   `SANDBOX_PROVIDER=bedrock-agentcore`. Replaces the local-host execution.
3. **stimulir-console** — the Python backend's `workspace_tool_runtime_orchestrator`
   calls the TS code-runtime host. Either (a) the host uses provider shape (2),
   or (b) add a thin Python AgentCore client mirroring `agentcore.ts`
   (boto3 `bedrock-agentcore`: start/invoke/stop) and route tool-execution there.
   Result: ECS container memory goes flat; no more OOM.

## Tradeoffs

| | In-process (today) | AgentCore |
|---|---|---|
| Service memory | grows → **OOM** | **flat** |
| Isolation | none | **per-session** |
| Scale | vertical wall (2–4GB) | **horizontal** |
| Latency | ~0 | +~1s session start |
| Cost | container only | + per-session AgentCore |

The +1s and per-session cost buy elimination of OOM + true horizontal scale —
a clear win for a service that's crashing.

## Requirements

- AWS creds with `bedrock-agentcore:*CodeInterpreterSession*` + `InvokeCodeInterpreter`
- AgentCore Code Interpreter region (verified: us-east-1, eu-west-2)
- `@aws-sdk/client-bedrock-agentcore`
