#!/usr/bin/env tsx

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectGovernanceRollback } from "../extensions/workbench-runtime/core/governance-rollback.ts";

const USAGE = "Usage: npm run governance:rollback-check -- [--project <root>] [--json]";

export async function main(argv = process.argv.slice(2)): Promise<number> {
	let projectRoot = process.cwd();
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") json = true;
		else if (arg === "--project" && argv[index + 1] !== undefined) projectRoot = resolve(argv[++index]!);
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write(`${USAGE}\n`);
			return 0;
		} else {
			process.stderr.write(`${USAGE}\n`);
			return 2;
		}
	}

	const report = await inspectGovernanceRollback(projectRoot);
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		process.stdout.write(`v1 rollback: ${report.safe_for_v1_rollback ? "SAFE" : "BLOCKED"}\n`);
		process.stdout.write(`delegations: v1=${report.delegations.legacy_v1} v2=${report.delegations.v2} unclassified=${report.delegations.unclassified}\n`);
		process.stdout.write(`runs: v1=${report.runs.legacy_v1} v2=${report.runs.v2} unclassified=${report.runs.unclassified}\n`);
		if (report.blockers.length > 0) process.stdout.write(`blockers: ${report.blockers.join(",")}\n`);
	}
	return report.safe_for_v1_rollback ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = await main();
}
