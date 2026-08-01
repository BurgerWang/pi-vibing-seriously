/**
 * Shared test helpers for workbench tests (P1 + P3).
 * Mirrors pi.exec's semantics: spawn with shell=false, argv, timeout, signal.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** Real spawn-based exec (shell=false) for integration-style tests. */
export function spawnExec(
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
): Promise<ExecResultLike> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let killed = false;
		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		const kill = (): void => {
			killed = true;
			proc.kill("SIGTERM");
		};
		if (options?.timeout !== undefined) setTimeout(kill, options.timeout);
		if (options?.signal) {
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
		proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0, killed }));
		proc.on("error", () => resolve({ stdout, stderr, code: 1, killed }));
	});
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "workbench-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Write a workbench config file under <root>/.pi/workbench/. */
export async function writeConfigFile(projectRoot: string, file: string, content: string): Promise<void> {
	const path = join(projectRoot, CONFIG_DIR_NAME, "workbench", file);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

/** A quant-result artifact that conforms to the contract (unless mutated). */
export function makeValidQuantResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: "1.0",
		run_id: "20260101-120000-abcd",
		strategy_type: "stock-selection",
		frequency: "daily",
		universe: { name: "test universe", point_in_time: true },
		data_range: { start: "2015-01-01", end: "2025-12-31" },
		split: { method: "walk-forward", test: { start: "2023-01-01", end: "2025-12-31" } },
		benchmark: { name: "index", return: 0.08 },
		costs: { fees_bps: 5, slippage_bps: 10 },
		metrics: {
			return: 0.12,
			volatility: 0.15,
			drawdown: -0.18,
			sharpe: 0.8,
			turnover: 0.6,
			exposure: 0.95,
			benchmark_delta: 0.04,
			return_pre_cost: 0.14,
			return_post_cost: 0.12,
		},
		folds: [
			{ id: "f1", status: "passed", period: { start: "2015-01-01", end: "2017-12-31" }, metrics: { return: 0.1, sharpe: 0.7 } },
			{ id: "f2", status: "passed", period: { start: "2018-01-01", end: "2020-12-31" }, metrics: { return: 0.11, sharpe: 0.75 } },
			{ id: "f3", status: "passed", period: { start: "2021-01-01", end: "2022-12-31" }, metrics: { return: 0.09, sharpe: 0.65 } },
		],
		parameters: { lookback: 20, top_n: 50, seed: 42 },
		artifacts: ["results/quant-result.json"],
		warnings: [],
		semantics: { signal_execution_delay: "next-bar", no_future_leakage: true },
		...overrides,
	};
}
