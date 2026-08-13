#!/usr/bin/env tsx
/** Formal offline nine-scenario context-output benchmark artifact writer. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildBenchmarkReport,
	runContextOutputEvidence,
	writeJsonAtomic,
} from "./context-output-evidence.ts";

export const CONTEXT_OUTPUT_BENCHMARK_ARTIFACT = ".pi/workbench/runs/context-output-benchmark/context-output-benchmark.json";

export async function runContextOutputBenchmark(repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")): Promise<Record<string, unknown>> {
	const temporary = await mkdtemp(join(tmpdir(), "pi-context-output-benchmark-"));
	try {
		const evidence = await runContextOutputEvidence(temporary);
		const report = await buildBenchmarkReport(repoRoot, evidence);
		await writeJsonAtomic(join(repoRoot, CONTEXT_OUTPUT_BENCHMARK_ARTIFACT), report);
		return report;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

function boundedError(error: unknown): string {
	const raw = error instanceof Error ? error.message : "unknown error";
	let output = "";
	for (const scalar of raw.replace(/[\u0000-\u001f\u007f]/g, " ")) {
		if (Buffer.byteLength(output + scalar, "utf8") > 512) break;
		output += scalar;
	}
	return output || "unknown error";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
	try {
		const report = await runContextOutputBenchmark();
		const acceptance = report.acceptance as { passed?: unknown } | undefined;
		process.stdout.write(`${JSON.stringify({ schema: report.schema, artifact: CONTEXT_OUTPUT_BENCHMARK_ARTIFACT, scenarios: 9, acceptance_passed: acceptance?.passed === true, note: report.note })}\n`);
		if (acceptance?.passed !== true) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`context-output benchmark failed: ${boundedError(error)}\n`);
		process.exitCode = 1;
	}
}
