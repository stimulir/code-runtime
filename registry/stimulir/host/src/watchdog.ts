/**
 * Per-tool-call watchdog.
 *
 * The Pi SDK (and equivalent agent SDKs) run bash commands as
 * child_process.spawn descendants of the host Node process. There's no
 * SDK-level hook to cancel an in-flight call, so we watch the trajectory
 * event stream from the OUTSIDE: a `tool_execution_start` opens a tracking
 * entry; `tool_execution_end` / `_error` closes it. If an entry outlives
 * `maxToolCallMs` we send SIGTERM to its descendant shell processes
 * (escalating to SIGKILL after 5s). The SDK observes its subprocess die
 * and reports the failure back to the agent as a normal tool error —
 * control returns to the agent loop with most of the run's budget intact.
 *
 * Reproducer this defends against: an agent runs `bash start_services.sh`
 * which starts nginx/Flask in the foreground. Bash blocks forever. The
 * agent's whole wall-clock budget burns on one call. Without the watchdog,
 * the run is dead.
 *
 * SOURCE: ported verbatim from rl-env/runner/src/run-task.ts lines
 * 161–224 (the Lemon Tasker golden standard).
 *
 * Platform: macOS / Linux only — uses `pgrep -P` + `ps -p <pid> -o comm=`.
 * Both are POSIX-standard CLIs present everywhere the runner ships.
 */

import { execSync } from "node:child_process";

/** Shell binaries we recognise as `tool_call`-spawned. */
const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * Find all shell-process descendants of `rootPid` (depth-first).
 * Returns the discovered PIDs, with the leaf-most last so the caller can
 * kill leaves before parents and avoid orphaning grandchildren.
 */
export function collectShellDescendants(rootPid: number): number[] {
	const out: number[] = [];
	const visit = (pid: number) => {
		let children: number[] = [];
		try {
			const raw = execSync(`pgrep -P ${pid}`, {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			children = raw
				? raw.split("\n").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n))
				: [];
		} catch {
			return; // no children
		}
		for (const childPid of children) {
			// comm = command basename, e.g. "bash"
			let comm = "";
			try {
				comm = execSync(`ps -p ${childPid} -o comm=`, {
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
			} catch {
				// Process already gone — skip.
				continue;
			}
			// Recurse FIRST so grandchildren appear before children in `out`.
			visit(childPid);
			const base = comm.split("/").pop() || "";
			if (SHELL_NAMES.has(base)) {
				out.push(childPid);
			}
		}
	};
	visit(rootPid);
	return out;
}

/** SIGTERM all shell descendants of `rootPid`; SIGKILL them after 5s. */
export function killShellDescendants(rootPid: number): number[] {
	const pids = collectShellDescendants(rootPid);
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// process already exited — fine
		}
	}
	// Escalate to SIGKILL after 5s for anything that ignored SIGTERM.
	if (pids.length > 0) {
		setTimeout(() => {
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// expected for processes that already died on SIGTERM
				}
			}
		}, 5000);
	}
	return pids;
}

/**
 * Tracks an in-flight tool call. Adapters call `markStart` on
 * `tool_execution_start` and `markEnd` on `_end`/`_error`. The watchdog
 * ticker reads `getStale(maxToolCallMs)` to find calls to kill.
 */
export interface InflightToolCall {
	toolCallId: string;
	toolName: string;
	command: string;
	startedAtMs: number;
}

export class InflightToolCallRegistry {
	private inflight = new Map<string, InflightToolCall>();

	markStart(call: Omit<InflightToolCall, "startedAtMs">): void {
		this.inflight.set(call.toolCallId, {
			...call,
			startedAtMs: Date.now(),
		});
	}

	markEnd(toolCallId: string): void {
		this.inflight.delete(toolCallId);
	}

	/** Returns every call older than `maxToolCallMs` (and forgets them). */
	consumeStale(maxToolCallMs: number): InflightToolCall[] {
		if (maxToolCallMs <= 0) return [];
		const now = Date.now();
		const stale: InflightToolCall[] = [];
		for (const call of Array.from(this.inflight.values())) {
			if (now - call.startedAtMs > maxToolCallMs) {
				stale.push(call);
				this.inflight.delete(call.toolCallId);
			}
		}
		return stale;
	}

	clear(): void {
		this.inflight.clear();
	}
}

/**
 * Convenience: start a watchdog ticker that polls every `pollMs` (default
 * 2s) and kills any shell call older than `maxToolCallMs`. Returns the
 * timer handle so callers can `clearInterval()` it in their finally block.
 *
 * `onKill` is fired AFTER the SIGTERM so the caller can write a synthetic
 * `tool_execution_killed` event into its trajectory.
 */
export interface WatchdogOptions {
	registry: InflightToolCallRegistry;
	rootPid: number;
	maxToolCallMs: number;
	pollMs?: number;
	onKill?: (call: InflightToolCall, killedPids: number[]) => void;
}

export function startWatchdog(opts: WatchdogOptions): NodeJS.Timeout {
	const { registry, rootPid, maxToolCallMs, pollMs = 2000, onKill } = opts;
	return setInterval(() => {
		const stale = registry.consumeStale(maxToolCallMs);
		for (const call of stale) {
			// Only intervene for shell-like tools. read/write/edit are pure JS
			// in most agent SDKs; killing their non-existent children is a
			// no-op but emitting a "killed" event would mislead the agent.
			const looksLikeShell =
				call.toolName === "bash" ||
				call.toolName === "sh" ||
				call.toolName === "shell";
			if (!looksLikeShell) continue;
			const killed = killShellDescendants(rootPid);
			if (onKill) onKill(call, killed);
		}
	}, pollMs);
}
