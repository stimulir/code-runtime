/**
 * @stimulir/code-runtime-sandbox-agentcore
 *
 * Bedrock AgentCore Code Interpreter sandbox provider for code-runtime.
 *
 * WHY: code-runtime + Pi run agent tool-execution IN-PROCESS. In a 2–4GB ECS
 * container, concurrent agent sessions stack their workspace + execution memory
 * in the same process → OOM. This provider offloads tool-execution to AWS-managed
 * per-session sandboxes, so the service container memory stays flat under
 * concurrency and scales horizontally.
 *
 * Proven: 8 concurrent 200MB workloads offloaded 1.6GB while the caller grew
 * +86MB (lemon-tasker scripts/agentcore_scalability_test.py, real eu-west-2).
 *
 * USAGE (two integration shapes):
 *
 *   1) Direct (today, no upstream interface needed) — drive the sandbox yourself
 *      from a consumer's tool-execution layer (e.g. stimulir-console's
 *      workspace_tool_runtime_orchestrator, or lemon-tasker's runner):
 *
 *        import { AgentCoreSandbox } from "@stimulir/code-runtime-sandbox-agentcore";
 *        const box = new AgentCoreSandbox({ region: "eu-west-2" });
 *        await box.exec("bash tests/test.sh");
 *        await box.writeFile("app/report.py", patched);
 *        await box.dispose();
 *
 *   2) agent-os provider (full integration) — register as a sandbox-mounting
 *      provider so Pi's read/write/edit/bash tools route here automatically:
 *
 *        import { createAgentCoreSandboxProvider } from "@stimulir/code-runtime-sandbox-agentcore";
 *        vm.addSandboxProvider(createAgentCoreSandboxProvider({ region }));
 *
 *      NOTE: shape (2) requires the upstream `@rivet-dev/agent-os-sandbox`
 *      provider interface, which is NOT vendored into the fork yet. The
 *      provider factory below is a typed stub against that interface — complete
 *      it once the upstream `addSandboxProvider` contract is vendored (see
 *      registry/stimulir/sandbox/src/index.ts for the vendoring note).
 */

export { AgentCoreSandbox } from "./agentcore.js";
export type {
	AgentCoreSandboxOptions,
	ExecResult,
} from "./agentcore.js";
export { createAgentCoreSandboxProvider } from "./provider.js";
export type { AgentCoreProviderConfig } from "./provider.js";
