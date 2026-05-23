/**
 * Trajectory writer — append agent-OS session events as JSONL.
 *
 * Each line is one event with a tiny wrapper for downstream tooling:
 *   {
 *     "ts": "2026-05-16T19:00:00.000Z",
 *     "agent": "pi",
 *     "task_id": "tb_type5_bugfix_regression_sample_001",
 *     "session_id": "...",
 *     "seq": 0,
 *     "event": { ... raw agent-OS event ... }
 *   }
 *
 * This is the lossless canonical form. Format-specific exporters (SWE-bench,
 * Verifiers) will read this JSONL and re-emit; we don't lose information.
 *
 * SOURCE: ported verbatim from rl-env/runner/src/trajectory.ts (the Lemon
 * Tasker golden standard). Kept here so every Stimulir adapter can produce
 * trajectories in the same shape — critical for the Lemon Tasker swap-test
 * gate where any adapter must be drop-in-able behind --agent <name>.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface TrajectoryHeader {
	agent: string;
	taskId: string;
	sessionId: string;
}

export class TrajectoryWriter {
	private stream: WriteStream;
	private seq = 0;
	constructor(
		private readonly path: string,
		private readonly header: TrajectoryHeader,
	) {
		this.stream = createWriteStream(path, { flags: "w", encoding: "utf-8" });
	}

	static async open(
		path: string,
		header: TrajectoryHeader,
	): Promise<TrajectoryWriter> {
		await mkdir(dirname(path), { recursive: true });
		return new TrajectoryWriter(path, header);
	}

	write(event: unknown): void {
		const line =
			JSON.stringify({
				ts: new Date().toISOString(),
				agent: this.header.agent,
				task_id: this.header.taskId,
				session_id: this.header.sessionId,
				seq: this.seq++,
				event,
			}) + "\n";
		this.stream.write(line);
	}

	async close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.stream.end((err?: Error | null) =>
				err ? reject(err) : resolve(),
			);
		});
	}

	get eventCount(): number {
		return this.seq;
	}
}
