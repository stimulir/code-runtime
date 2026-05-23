/**
 * @stimulir/code-runtime-host
 *
 * Portable host-side runtime primitives shared by every Stimulir adapter
 * that runs OUTSIDE the agent-OS V8 isolate (i.e., direct-SDK adapters
 * like Pi, Codex, Claude Code, OpenCode, Vibe in their Lemon Tasker
 * deployment mode).
 *
 * What's here:
 *   • TrajectoryWriter        — JSONL event stream with the canonical
 *                               wrapper shape (ts/agent/task_id/session_id
 *                               /seq/event). Every adapter writes
 *                               trajectories in this shape so they're
 *                               drop-in-able in Lemon Tasker.
 *
 *   • Watchdog primitives     — InflightToolCallRegistry, startWatchdog,
 *                               collectShellDescendants, killShellDescendants.
 *                               Defends against the single biggest agent
 *                               failure mode: a foreground service command
 *                               (`bash start_services.sh`) eating the
 *                               entire wall-clock budget.
 *
 *   • End-of-run cleanup      — killProcessesReferencingPath sweeps host
 *                               processes that the agent's bash tools
 *                               leaked across `&`/nohup boundaries. Runs
 *                               at start-of-run (self-heal previous
 *                               leaks) and end-of-run (this run's own).
 *
 * SOURCE: every primitive here was originally written + proven inside
 * rl-env (Lemon Tasker). Extracted here so every Stimulir adapter — and
 * any downstream consumer — gets the same battle-tested behaviour
 * without copy-pasting.
 */

export {
	TrajectoryWriter,
	type TrajectoryHeader,
} from "./trajectory.js";

export {
	collectShellDescendants,
	killShellDescendants,
	InflightToolCallRegistry,
	startWatchdog,
	type InflightToolCall,
	type WatchdogOptions,
} from "./watchdog.js";

export { killProcessesReferencingPath } from "./cleanup.js";
