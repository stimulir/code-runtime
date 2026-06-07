/**
 * agent-os sandbox provider factory (integration shape #2).
 *
 * Wraps AgentCoreSandbox in the `addSandboxProvider` contract so Pi's
 * read/write/edit/bash tools route to AgentCore automatically when a session
 * selects this provider.
 *
 * STATUS: the exact upstream `@rivet-dev/agent-os-sandbox` provider interface is
 * not vendored into the fork yet (see registry/stimulir/sandbox/src/index.ts).
 * This factory is structured against the documented provider shape and is the
 * single seam to complete once that interface lands — the AgentCoreSandbox core
 * (agentcore.ts) it delegates to is already proven and complete.
 */

import { AgentCoreSandbox } from "./agentcore.js";

export interface AgentCoreProviderConfig {
	region: string;
	interpreterId?: string;
	sessionTimeoutSeconds?: number;
	/** Provider id surfaced to the agent-os VM (SANDBOX_PROVIDER=bedrock-agentcore). */
	id?: string;
}

/**
 * Create a sandbox provider backed by AgentCore. Returns an object shaped for
 * `vm.addSandboxProvider(...)`.
 *
 * The provider's lifecycle:
 *   createSession()  → new AgentCoreSandbox().start()
 *   fs/exec ops      → delegate to the AgentCoreSandbox methods
 *   closeSession()   → sandbox.dispose()
 */
export function createAgentCoreSandboxProvider(config: AgentCoreProviderConfig) {
	const id = config.id ?? "bedrock-agentcore";

	return {
		id,
		/**
		 * Open a managed sandbox for one agent session. The returned handle
		 * exposes the fs/exec surface agent-os mounts onto the agent's tools.
		 */
		async createSandbox() {
			const box = new AgentCoreSandbox({
				region: config.region,
				interpreterId: config.interpreterId,
				sessionTimeoutSeconds: config.sessionTimeoutSeconds,
			});
			await box.start();
			return {
				exec: (command: string) => box.exec(command),
				run: (code: string, language?: string) => box.run(code, language),
				readFile: (path: string) => box.readFile(path),
				writeFile: (path: string, content: string) => box.writeFile(path, content),
				dispose: () => box.dispose(),
			};
		},
	};
}
