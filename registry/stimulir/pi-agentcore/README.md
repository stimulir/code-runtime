# @stimulir/code-runtime-pi-agentcore

AgentCore-backed Pi coding tools, plus a direct Pi `AgentSession` that runs them.

## What it is

This package ports the proven AgentCore-backed Pi tooling out of lemon-tasker's
runner so both **lemon-tasker** and **stimulir-console** can consume it.

It supplies:

- **AgentCore-backed Pi coding tools** — `bash` / `read` / `write` / `edit` /
  `find` / `grep` / `ls`. Pi's tool factories accept pluggable `*Operations`;
  this package wires those operations onto an AWS Bedrock AgentCore Code
  Interpreter session (`@stimulir/code-runtime-sandbox-agentcore`), so the same
  Pi tools execute **inside** a managed AgentCore sandbox rather than on the host.
- **A direct Pi `AgentSession`** constructed with `baseToolsOverride` — Pi's
  built-in coding tools are fully replaced by the AgentCore-backed bundle, so a
  live LLM turn drives bash/read/write/edit/find/grep/ls and every one of those
  operations runs in AgentCore.

## Why

code-runtime + Pi run agent tool-execution **in-process**. In a 2–4GB container,
concurrent agent sessions stack their workspace + execution memory in the same
process → OOM. Offloading the agent's live tool calls to AWS-managed per-session
AgentCore sandboxes keeps the caller's container memory flat under concurrency
and scales horizontally — the OOM-free alternative to an in-process VM.

This lets a **lightweight, in-process Pi agent** keep its full coding toolset
while the heavy lifting (filesystem + shell) happens in AgentCore.

## Two entry points

### 1. Tools

```ts
import { AgentCoreSandbox } from "@stimulir/code-runtime-sandbox-agentcore";
import {
  createAgentCorePiTools,
  createAgentCoreGrepTool,
} from "@stimulir/code-runtime-pi-agentcore";

const sandbox = new AgentCoreSandbox({ region: "eu-west-2" });
await sandbox.start();

// cwd is a sentinel the Pi factories resolve paths against; it never touches
// the host filesystem — it only anchors path relativization into the sandbox.
const tools = createAgentCorePiTools(sandbox, "/sandbox");
// tools.bash / read / write / edit / find / grep / ls

// NOTE: the factory `tools.grep` is non-functional against AgentCore (Pi's
// createGrepTool always spawns a LOCAL ripgrep). Use the in-sandbox replacement:
const grep = createAgentCoreGrepTool(sandbox, "/sandbox");
```

Wire these into your own `AgentSession`'s `baseToolsOverride` (swapping in the
in-sandbox `grep`), or invoke each tool's `execute()` directly.

### 2. Full session

```ts
import { AgentCoreSandbox } from "@stimulir/code-runtime-sandbox-agentcore";
import { createAgentCorePiSession } from "@stimulir/code-runtime-pi-agentcore";

const sandbox = new AgentCoreSandbox({ region: "eu-west-2" });
await sandbox.start();

const { session, activeToolNames } = await createAgentCorePiSession({
  sandbox,
  cwd: "/tmp/empty-real-dir", // must be a real host dir (managers read it)
  agentDir,                   // host dir with models.json + settings.json
  provider: "openrouter",
  modelId: "openai/gpt-4o-mini",
});

// activeToolNames === the 7 AgentCore tools. Subscribe + prompt; every live
// tool call runs in AgentCore.
```

This builds a real Pi `AgentSession` with the AgentCore tool bundle injected via
`baseToolsOverride` (grep already swapped for the in-sandbox tool) and all 7
tools active.

## Verified against live AgentCore

These modules are proven against real AgentCore (eu-west-2):

- **`pi-agentcore-ops-smoke`** — 8/8 tool ops executed in-sandbox (write/read/
  shared-session/bash exit0/bash exit7/edit/find/ls). Ported here as
  `scripts/ops-smoke.mjs`: `AWS_REGION=eu-west-2 node scripts/ops-smoke.mjs`.
- **`pi-agentcore-turn-smoke`** — a live LLM turn drove the tools end-to-end.
