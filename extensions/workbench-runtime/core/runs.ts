/**
 * Workbench run records — run IDs and reading run artifacts. Pure logic.
 *
 * Each run writes to `<project-root>/<CONFIG_DIR_NAME>/workbench/runs/<run-id>/`:
 *   manifest.json, command.json, environment.json, stdout.log, stderr.log,
 *   summary.json
 *
 * Never stores API keys, tokens, or full environment values in these records.
 */

import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { truncateTail } from "@earendil-works/pi-coding-agent";

import { runsDir } from "./config.ts";

export const RUN_SCHEMA_VERSION = 1;

export const RUN_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/;

export function makeRunId(date: Date): string {
	const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
	const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
	return `${stamp}-${rand}`;
}

/** Validate a run id strictly (also protects against path traversal). */
export function isValidRunId(runId: string): boolean {
	return RUN_ID_RE.test(runId);
}

export function runDirFor(projectRoot: string, runId: string): string {
	if (!isValidRunId(runId)) throw new Error(`invalid run id "${runId}"`);
	return join(runsDir(projectRoot), runId);
}

export interface RunRecord {
	schema_version: number;
	run_id: string;
	recipe: string;
	profile: string | undefined;
	started_at: string;
	finished_at: string;
	duration_ms: number;
	cwd: string;
	argv: string[];
	exit_code: number | null;
	timed_out: boolean;
	cancelled: boolean;
	git_commit: string | null;
	git_dirty: boolean;
	artifact_paths: string[];
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	mode: string;
	expected_exit_codes: number[];
	declared_writes: string[];
	environment_names: string[];
}

export async function readManifest(projectRoot: string, runId: string): Promise<RunRecord | null> {
	const dir = runDirFor(projectRoot, runId);
	try {
		const raw = await readFile(join(dir, "manifest.json"), "utf8");
		const parsed = JSON.parse(raw) as RunRecord;
		return parsed.schema_version === RUN_SCHEMA_VERSION ? parsed : null;
	} catch {
		return null;
	}
}

export interface RunSummaryRecord {
	run_id: string;
	recipe: string;
	profile: string | undefined;
	started_at: string;
	finished_at: string;
	duration_ms: number;
	cwd: string;
	argv: string[];
	exit_code: number | null;
	timed_out: boolean;
	cancelled: boolean;
	git_commit: string | null;
	git_dirty: boolean;
	artifact_paths: string[];
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	stdout: string;
	stderr: string;
	stdout_log: string;
	stderr_log: string;
}

export async function readSummary(projectRoot: string, runId: string): Promise<RunSummaryRecord | null> {
	const dir = runDirFor(projectRoot, runId);
	try {
		const raw = await readFile(join(dir, "summary.json"), "utf8");
		return JSON.parse(raw) as RunSummaryRecord;
	} catch {
		return null;
	}
}

/** List runs newest-first, optionally capped. */
export async function listRuns(projectRoot: string, limit = 10): Promise<RunRecord[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(runsDir(projectRoot), { withFileTypes: true });
	} catch {
		return [];
	}
	const records: RunRecord[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
		const manifest = await readManifest(projectRoot, entry.name);
		if (manifest) records.push(manifest);
	}
	records.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
	return records.slice(0, limit);
}

export interface LogSnippetOptions {
	maxLines?: number;
	maxBytes?: number;
}

export const DEFAULT_SNIPPET_LINES = 200;
export const DEFAULT_SNIPPET_BYTES = 20 * 1024;

/**
 * Read a bounded tail of a run log — never the full log — for model/UI
 * display. The full log stays on disk at the returned path.
 */
export async function readLogSnippet(
	projectRoot: string,
	runId: string,
	stream: "stdout" | "stderr",
	options?: LogSnippetOptions,
): Promise<{ content: string; truncated: boolean; path: string }> {
	const dir = runDirFor(projectRoot, runId);
	const path = join(dir, `${stream}.log`);
	try {
		const full = await readFile(path, "utf8");
		const result = truncateTail(full, {
			maxLines: options?.maxLines ?? DEFAULT_SNIPPET_LINES,
			maxBytes: options?.maxBytes ?? DEFAULT_SNIPPET_BYTES,
		});
		return { content: result.content, truncated: result.truncated, path };
	} catch {
		return { content: "", truncated: false, path };
	}
}
