/**
 * @stimulir/code-runtime-software
 *
 * One-import meta-package over the entire upstream WASM software
 * library. Re-exports every package descriptor + provides named
 * bundles so consumers can register exactly the right tools with
 * AgentOs.create({software: […]}) without wrangling 25 imports.
 *
 * Bundles:
 *
 *   codingAgentBundle  — what every coding agent needs:
 *                        coreutils, common, git, curl, jq, ripgrep, fd,
 *                        findutils, sed, grep, gawk, tar, gzip, make,
 *                        diffutils, tree, file
 *
 *   dataAnalysisBundle — coding + data tools: + duckdb, sqlite3, yq
 *
 *   networkingBundle   — http/wget probe tools: curl, wget, http-get
 *
 *   archiveBundle      — tar, gzip, zip, unzip
 *
 *   everythingBundle   — every package upstream ships
 */

import buildEssential from "@rivet-dev/agent-os-build-essential";
import common from "@rivet-dev/agent-os-common";
import coreutils from "@rivet-dev/agent-os-coreutils";
import curl from "@rivet-dev/agent-os-curl";
import diffutils from "@rivet-dev/agent-os-diffutils";
import duckdb from "@rivet-dev/agent-os-duckdb";
import everything from "@rivet-dev/agent-os-everything";
import fd from "@rivet-dev/agent-os-fd";
import file from "@rivet-dev/agent-os-file";
import findutils from "@rivet-dev/agent-os-findutils";
import gawk from "@rivet-dev/agent-os-gawk";
import git from "@rivet-dev/agent-os-git";
import grep from "@rivet-dev/agent-os-grep";
import gzip from "@rivet-dev/agent-os-gzip";
import httpGet from "@rivet-dev/agent-os-http-get";
import jq from "@rivet-dev/agent-os-jq";
import make from "@rivet-dev/agent-os-make";
import ripgrep from "@rivet-dev/agent-os-ripgrep";
import sed from "@rivet-dev/agent-os-sed";
import sqlite3 from "@rivet-dev/agent-os-sqlite3";
import tar from "@rivet-dev/agent-os-tar";
import tree from "@rivet-dev/agent-os-tree";
import unzip from "@rivet-dev/agent-os-unzip";
import wget from "@rivet-dev/agent-os-wget";
import yq from "@rivet-dev/agent-os-yq";
import zip from "@rivet-dev/agent-os-zip";

// Individual re-exports — consumers picking specific tools.
export {
	buildEssential,
	common,
	coreutils,
	curl,
	diffutils,
	duckdb,
	everything,
	fd,
	file,
	findutils,
	gawk,
	git,
	grep,
	gzip,
	httpGet,
	jq,
	make,
	ripgrep,
	sed,
	sqlite3,
	tar,
	tree,
	unzip,
	wget,
	yq,
	zip,
};

// ── Named bundles ──────────────────────────────────────────────────────

/** Bare-minimum coding-agent toolset. Pass directly into
 *  AgentOs.create({software: codingAgentBundle}). */
export const codingAgentBundle = [
	coreutils,
	common,
	git,
	curl,
	jq,
	ripgrep,
	fd,
	findutils,
	sed,
	grep,
	gawk,
	tar,
	gzip,
	make,
	diffutils,
	tree,
	file,
];

/** Coding-agent toolset PLUS data-analysis primitives. */
export const dataAnalysisBundle = [
	...codingAgentBundle,
	duckdb,
	sqlite3,
	yq,
];

/** HTTP / probe utilities. */
export const networkingBundle = [curl, wget, httpGet];

/** Archive utilities. */
export const archiveBundle = [tar, gzip, zip, unzip];

/** Build toolchain (gcc, make, etc.). */
export const buildBundle = [buildEssential, make];

/** Everything upstream ships, in one array. Use sparingly — bloats
 *  the VM init time. */
export const everythingBundle = [
	buildEssential,
	common,
	coreutils,
	curl,
	diffutils,
	duckdb,
	everything,
	fd,
	file,
	findutils,
	gawk,
	git,
	grep,
	gzip,
	httpGet,
	jq,
	make,
	ripgrep,
	sed,
	sqlite3,
	tar,
	tree,
	unzip,
	wget,
	yq,
	zip,
];
