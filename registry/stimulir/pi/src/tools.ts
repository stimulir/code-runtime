/**
 * Host-direct Pi tool bundle.
 *
 * The local-filesystem counterpart to
 * ``@stimulir/code-runtime-pi-agentcore``'s ``createAgentCorePiTools(sandbox, cwd)``.
 * Pi's coding-tool factories (``@mariozechner/pi-coding-agent``) default their
 * ``*Operations`` to the LOCAL filesystem + shell, so passing NO operations
 * yields the seven tools (bash/read/write/edit/find/grep/ls) executing directly
 * on the host, rooted at ``cwd`` — which MUST be an absolute host path (the real
 * project directory the runtime was launched against).
 *
 * This is the ``host-direct`` execution mode (the Lemon Tasker mode this package
 * targets): same seven tools, host filesystem instead of a remote AgentCore
 * sandbox. Unlike the AgentCore variant, grep works here (local ripgrep runs
 * against a path that actually exists). Wire these into an AgentSession's
 * ``baseToolsOverride`` exactly as the AgentCore tools are wired.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
} from "@mariozechner/pi-coding-agent";

/** The seven host-direct Pi tools — same shape as AgentCorePiTools. */
export interface LocalPiTools {
	bash: AgentTool<any>;
	read: AgentTool<any>;
	write: AgentTool<any>;
	edit: AgentTool<any>;
	find: AgentTool<any>;
	grep: AgentTool<any>;
	ls: AgentTool<any>;
}

/**
 * Build the host-direct Pi tool bundle. ``cwd`` MUST be an absolute host path;
 * the factories resolve every tool path against it and read/write/exec on the
 * host filesystem directly (no sandbox, no path relativization).
 */
export function createLocalPiTools(cwd: string): LocalPiTools {
	return {
		bash: createBashTool(cwd),
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
		edit: createEditTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}
