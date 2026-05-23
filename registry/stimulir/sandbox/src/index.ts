/**
 * @stimulir/code-runtime-sandbox
 *
 * Re-exports the upstream `@rivet-dev/agent-os-sandbox` toolkit so
 * Stimulir consumers can mount it via `AgentOs.create({toolKits: […]})`
 * without depending on the rivet-dev scope directly.
 *
 * The upstream sandbox-mounting DRIVERS (`local`, `docker`, `e2b`,
 * `daytona`, `modal`, `vercel`, `computesdk`, `sprites`) live in
 * `rivet-dev/rivet/agent-os/packages` and are NOT currently vendored
 * into the code-runtime fork. When a driver is needed:
 *
 *   - Local + Docker: vendor the relevant agent-os-sandbox-{local,docker}
 *     packages into registry/agent-os-sandbox-<name>/ and update
 *     pnpm-workspace.yaml. Then re-export from this package.
 *
 *   - Cloud (e2b/daytona/modal): install directly from npm in your
 *     consumer app (`pnpm add @rivet-dev/agent-os-sandbox-e2b`) and
 *     register via `vm.addSandboxProvider(…)` per upstream docs.
 */

export * from "@rivet-dev/agent-os-sandbox";
