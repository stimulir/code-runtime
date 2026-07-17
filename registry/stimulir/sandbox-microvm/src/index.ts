/**
 * @stimulir/code-runtime-sandbox-microvm
 *
 * AWS Lambda MicroVM (Firecracker) sandbox provider for code-runtime — the
 * substrate replacement for @stimulir/code-runtime-sandbox-agentcore.
 *
 * WHY over AgentCore Code Interpreter:
 *   - bring-your-own image (Chromium, Python, any apt package) → browser-use runs
 *     INSIDE the sandbox; no separate browser-service.
 *   - native per-session secret injection via runHookPayload → vault keys reach
 *     the skill's process (AgentCore's executeCommand took no env).
 *   - 8h suspend/resume, VM-level isolation (dedicated kernel/memory/disk).
 *
 * Availability: eu-west-1 (and us-east-1, …) — NOT eu-west-2.
 *
 * USAGE (direct — surface-compatible with AgentCoreSandbox):
 *
 *     import { MicrovmSandbox } from "@stimulir/code-runtime-sandbox-microvm";
 *     const box = new MicrovmSandbox({
 *       region: "eu-west-1",
 *       imageIdentifier: "arn:aws:lambda:eu-west-1:ACCT:microvm-image:stimulir-sandbox",
 *       secrets: { SERPER_API_KEY: "...", STIMULIR_API_KEY: "..." },
 *     });
 *     await box.exec("python3 /workspace/.skills/deep-research/helpers/search_serper.py 'q'");
 *     await box.dispose();
 *
 * The image (image/Dockerfile + image/exec-server.mjs) is built once via
 * create-microvm-image and referenced by ARN. See README.md for the build steps.
 */
export { MicrovmSandbox } from "./microvm.js";
export type { MicrovmSandboxOptions, ExecResult } from "./microvm.js";
