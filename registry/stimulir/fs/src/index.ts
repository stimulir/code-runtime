/**
 * @stimulir/code-runtime-fs
 *
 * One-import aggregator for every filesystem mount driver Stimulir
 * consumers (Lemon Tasker, downstream apps) need:
 *
 *   - createHostDirBackend  — local host directory (from agent-os-core)
 *   - createS3Backend       — S3 buckets (agent-os-s3)
 *   - createGoogleDriveBackend — Google Drive (agent-os-google-drive)
 *
 * Plus a convenience `createFsBackend(kind, options)` factory so
 * callers can pick a driver by string at runtime (e.g. when wiring up
 * a UI dropdown over mount options).
 */

export { createHostDirBackend, type HostDirBackendOptions } from "@rivet-dev/agent-os-core";
export {
	createS3Backend,
	type S3FsOptions,
	type S3Credentials,
	type S3MountPluginConfig,
} from "@rivet-dev/agent-os-s3";

// Re-export everything from agent-os-google-drive verbatim (it's a
// beta package with a small surface; user-facing names may shift in
// future versions, so star-export keeps us in sync).
export * from "@rivet-dev/agent-os-google-drive";

import { createHostDirBackend, type HostDirBackendOptions } from "@rivet-dev/agent-os-core";
import { createS3Backend, type S3FsOptions } from "@rivet-dev/agent-os-s3";

/**
 * Runtime-string FS factory. Picks a driver by kind, validates options,
 * returns the same MountDriver the underlying packages produce.
 *
 *   const driver = createFsBackend("local", { path: "/workspace" });
 *   const driver = createFsBackend("s3", { bucket: "…", prefix: "…" });
 *
 * Google Drive callers should use createGoogleDriveBackend directly
 * (its options are stable but vary across beta versions; not worth
 * narrowing here).
 */
export type FsBackendKind = "local" | "s3";

export interface FsBackendOptionsByKind {
	local: HostDirBackendOptions;
	s3: S3FsOptions;
}

export function createFsBackend<K extends FsBackendKind>(
	kind: K,
	options: FsBackendOptionsByKind[K],
): unknown {
	switch (kind) {
		case "local":
			return createHostDirBackend(options as HostDirBackendOptions);
		case "s3":
			return createS3Backend(options as S3FsOptions);
		default: {
			const _: never = kind;
			throw new Error(`Unknown fs backend kind: ${String(_)}`);
		}
	}
}
