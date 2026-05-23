/**
 * @stimulir/code-runtime-git
 *
 * Re-exports the upstream @rivet-dev/agent-os-git WASM software package
 * descriptor + adds typed JS helpers for the most common git operations
 * (clone, commit, diff, status, branch).
 *
 * The helpers don't EXECUTE git themselves — they format the right argv
 * + return it as a `GitCommand` you can pass to the agent-OS shell exec
 * primitive or shell out to any installed `git` (via the WASM binary
 * the upstream package registers, or a host-installed git).
 *
 * Usage inside an agent-OS VM:
 *
 *   import gitPkg, { gitClone, gitCommit } from "@stimulir/code-runtime-git";
 *   const vm = await AgentOs.create({ software: [gitPkg, …] });
 *   await vm.exec(gitClone({ url: "https://github.com/foo/bar.git", into: "/workspace" }));
 *   await vm.exec(gitCommit({ message: "Refactor", all: true }));
 */

import gitPkg from "@rivet-dev/agent-os-git";

/** Default-export the upstream descriptor so `software: [gitPkg]` works. */
export default gitPkg;

/** Shaped command — argv ready for any shell-exec primitive. */
export interface GitCommand {
	argv: string[];
	cwd?: string;
}

export interface GitCloneOpts {
	url: string;
	into?: string;
	branch?: string;
	depth?: number;
	cwd?: string;
}
export function gitClone(opts: GitCloneOpts): GitCommand {
	const argv = ["git", "clone"];
	if (opts.branch) argv.push("--branch", opts.branch);
	if (opts.depth) argv.push("--depth", String(opts.depth));
	argv.push(opts.url);
	if (opts.into) argv.push(opts.into);
	return { argv, cwd: opts.cwd };
}

export interface GitCommitOpts {
	message: string;
	all?: boolean;
	author?: string;
	cwd?: string;
}
export function gitCommit(opts: GitCommitOpts): GitCommand {
	const argv = ["git", "commit"];
	if (opts.all) argv.push("-a");
	if (opts.author) argv.push(`--author=${opts.author}`);
	argv.push("-m", opts.message);
	return { argv, cwd: opts.cwd };
}

export interface GitDiffOpts {
	staged?: boolean;
	paths?: string[];
	cwd?: string;
}
export function gitDiff(opts: GitDiffOpts = {}): GitCommand {
	const argv = ["git", "diff"];
	if (opts.staged) argv.push("--staged");
	if (opts.paths && opts.paths.length) argv.push("--", ...opts.paths);
	return { argv, cwd: opts.cwd };
}

export interface GitStatusOpts {
	porcelain?: boolean;
	cwd?: string;
}
export function gitStatus(opts: GitStatusOpts = {}): GitCommand {
	const argv = ["git", "status"];
	if (opts.porcelain) argv.push("--porcelain");
	return { argv, cwd: opts.cwd };
}

export interface GitBranchOpts {
	list?: boolean;
	create?: string;
	cwd?: string;
}
export function gitBranch(opts: GitBranchOpts = {}): GitCommand {
	const argv = ["git", "branch"];
	if (opts.list) argv.push("--list");
	if (opts.create) argv.push(opts.create);
	return { argv, cwd: opts.cwd };
}

export { gitPkg };
