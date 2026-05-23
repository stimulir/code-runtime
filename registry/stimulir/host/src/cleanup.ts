/**
 * End-of-run host process cleanup.
 *
 * The per-tool-call watchdog only kills shell descendants. But when a
 * shell tool call did `bash start_services.sh &`, the `&` detaches its
 * children (nginx, python3, etc.) from the bash subprocess. Killing bash
 * leaves the daemons running, reparented to PID 1. They hold ports and
 * confuse the NEXT run on the same workspace.
 *
 * Reproducer: a single failed nginx_config_debug run leaks an `nginx
 * master` + `nginx worker` + `python3 backend/app.py` for 17 minutes
 * past run end, holding ports 8080 and 5000.
 *
 * Solution: at start-of-run AND end-of-run, sweep host processes whose
 * command-line argv references the bundle's workspace path. Match by
 * exact path substring → only processes spawned by THIS workspace get
 * touched; never an unrelated nginx.
 *
 * Critical safety: walks the FULL ancestor chain of the current process
 * via `ps ppid` and EXCLUDES every ancestor from the kill list. Without
 * this, the function would kill its own parents (the runner's own argv
 * contains `--workspace-dir <path>`).
 *
 * SOURCE: ported verbatim from rl-env/runner/src/run-task.ts lines
 * 226–305 (the Lemon Tasker golden standard).
 *
 * Platform: macOS / Linux only — uses `ps -ax -o pid=,ppid=,args=`.
 */

import { execSync } from "node:child_process";

/**
 * SIGTERM every host process whose argv references `workspacePath`,
 * excluding the current process and all its ancestors. SIGKILL escalation
 * after 5s. Returns the PIDs that received SIGTERM.
 *
 * Used both at start-of-run (self-heal previous crashes' leaks) and at
 * end-of-run (clean up our own backgrounded children).
 */
export function killProcessesReferencingPath(workspacePath: string): number[] {
	let listing = "";
	try {
		listing = execSync(`ps -ax -o pid=,ppid=,args=`, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch {
		return [];
	}

	// Build the FULL ancestor chain of this process. We must NOT kill any
	// ancestor — the runner is started by pnpm (parent), which was started
	// by Python's tasker (grandparent), etc. All of these have the
	// workspace path in their argv because the runner takes
	// --workspace-dir as a CLI flag. Walk up using ppid until we hit
	// PID 1 (init) or fail to find a parent.
	const ppidByPid = new Map<number, number>();
	const argsByPid = new Map<number, string>();
	for (const line of listing.split("\n")) {
		const m = line.trimStart().match(/^(\d+)\s+(\d+)\s+(.*)$/);
		if (!m) continue;
		const pid = parseInt(m[1], 10);
		const ppid = parseInt(m[2], 10);
		if (!Number.isFinite(pid)) continue;
		ppidByPid.set(pid, ppid);
		argsByPid.set(pid, m[3]);
	}

	const ancestors = new Set<number>();
	let cursor: number | undefined = process.pid;
	while (cursor && cursor !== 1) {
		ancestors.add(cursor);
		const next = ppidByPid.get(cursor);
		if (!next || next === cursor) break;
		cursor = next;
	}

	const targetPids: number[] = [];
	for (const [pid, args] of argsByPid.entries()) {
		if (ancestors.has(pid)) continue;
		if (!args.includes(workspacePath)) continue;
		// Defensively skip our own pgrep / ps calls if they happen to appear.
		if (args.startsWith("ps -ax") || args.startsWith("pgrep ")) continue;
		targetPids.push(pid);
	}

	// SIGTERM first, SIGKILL escalation 5s later.
	for (const pid of targetPids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// process gone
		}
	}
	if (targetPids.length > 0) {
		setTimeout(() => {
			for (const pid of targetPids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// expected
				}
			}
		}, 5000);
	}
	return targetPids;
}
