/** Shared bounded presentation helpers for public workbench tools. */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { boundedCommandText, boundedInlineDetail, COMMAND_OUTPUT_MAX_BYTES, COMMAND_OUTPUT_MAX_LINES } from "./command-output.ts";
import { displayRelative } from "./recipe-runner.ts";
import type { ValidationComponent } from "./recipe-schema.ts";
import type { Gate, GateStatus } from "./gate-schema.ts";
import type { runGates } from "./gate-engine.ts";
import type { GateToolDetails, InspectToolDetails } from "./render.ts";

const TOOL_ERROR_MAX_BYTES = 8_192;
const TOOL_ERROR_MAX_LINES = 120;
const GATE_DETAILS_MAX_ROWS = 24;
const GATE_DETAILS_MAX_FAILED_CHECKS = 12;

export function fixedToolFailure(tool: string, code: string, sourcePath?: string): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	const safeCode = boundedInlineDetail(code, 128) || "runtime_error";
	const text = boundedCommandText(
		`${tool}: ${safeCode}${sourcePath ? ` source=${boundedInlineDetail(sourcePath, 512)}` : ""}`,
		TOOL_ERROR_MAX_BYTES,
		TOOL_ERROR_MAX_LINES,
	);
	return {
		content: [{ type: "text", text }],
		details: {
			ok: false,
			error: safeCode,
			...(sourcePath ? { source_path: boundedInlineDetail(sourcePath, 512) } : {}),
		},
	};
}

export function boundedCoverageMap(
	recipes: readonly { name: string; validation_components: readonly ValidationComponent[] }[],
): NonNullable<InspectToolDetails["recipe_validation_components"]> {
	const shown = recipes.slice(0, 24);
	const output: NonNullable<InspectToolDetails["recipe_validation_components"]> = {
		__original_items__: recipes.length,
		__shown_items__: shown.length,
		__omitted_items__: recipes.length - shown.length,
	};
	for (const recipe of shown) {
		let key = boundedInlineDetail(recipe.name, 128) || "(unnamed)";
		let suffix = 1;
		while (Object.prototype.hasOwnProperty.call(output, key)) key = `${boundedInlineDetail(recipe.name, 112)}#${suffix++}`;
		output[key] = recipe.validation_components.slice(0, 16);
	}
	return output;
}

export function boundedGateDetails(
	result: Awaited<ReturnType<typeof runGates>>,
	projectRoot: string,
): GateToolDetails {
	const nonPass = result.gates.filter((gate) => gate.status !== "PASS");
	const pass = result.gates.filter((gate) => gate.status === "PASS");
	const selected = [...nonPass, ...pass].slice(0, GATE_DETAILS_MAX_ROWS);
	const gates = selected.map((gate) => {
		const failedChecks = gate.checks.filter((check) => check.status === "FAIL").map((check) => check.check_id);
		const shownChecks = failedChecks.slice(0, GATE_DETAILS_MAX_FAILED_CHECKS).map((check) => boundedInlineDetail(check, 128));
		return {
			id: boundedInlineDetail(gate.id, 96),
			status: gate.status,
			title: boundedInlineDetail(gate.title, 256),
			failure_reason: gate.failure_reason ? boundedInlineDetail(gate.failure_reason, 512) : null,
			blocked_reason: gate.blocked_reason ? boundedInlineDetail(gate.blocked_reason, 512) : null,
			failed_checks: shownChecks,
			failed_check_count: failedChecks.length,
			failed_checks_omitted: failedChecks.length - shownChecks.length,
		};
	});
	return {
		ok: result.ok,
		status: result.status,
		run_id: boundedInlineDetail(result.runId, 128),
		requested: result.requested.slice(0, 16).map((selector) => boundedInlineDetail(selector, 128)),
		profile: result.profile ? boundedInlineDetail(result.profile, 128) : undefined,
		gates,
		counts: {
			pass: result.gates.filter((gate) => gate.status === "PASS").length,
			fail: result.gates.filter((gate) => gate.status === "FAIL").length,
			blocked: result.gates.filter((gate) => gate.status === "BLOCKED").length,
			not_run: result.gates.filter((gate) => gate.status === "NOT_RUN").length,
			total: result.gates.length,
			shown: gates.length,
			omitted: result.gates.length - gates.length,
		},
		log_path: boundedInlineDetail(displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${result.runId}`), 512),
		phase: "finished",
	};
}

export function renderGateListPresentation(
	gates: readonly Gate[],
	statuses: Readonly<Record<string, { status: GateStatus | "UNKNOWN"; run_id: string; unavailable_reason?: string }>>,
): { text: string; shownGates: Gate[] } {
	const maximum = Math.min(gates.length, 24);
	for (let shown = maximum; shown >= 0; shown -= 1) {
		const selected = gates.slice(0, shown);
		const lines = [
			`${gates.length} gate(s) for this project; shown=${shown}; omitted=${gates.length - shown}:`,
			...selected.map((gate) => {
				const latest = statuses[gate.id];
				const status = latest
					? `${latest.status} (run ${boundedInlineDetail(latest.run_id, 96)})${latest.unavailable_reason ? ` reason=${boundedInlineDetail(latest.unavailable_reason, 192)}` : ""}`
					: "NOT_RUN (never run)";
				const prereqs = gate.prerequisites.length > 0 ? boundedInlineDetail(gate.prerequisites.join(","), 256) : "(none)";
				return `  ${boundedInlineDetail(gate.id, 96)} ${status} ${boundedInlineDetail(gate.title, 256)} prereqs=${prereqs}`;
			}),
			`omissions: ${gates.length - shown} gate row(s) omitted`,
			"source: .pi/workbench/gates.yaml + builtin ladder",
		];
		const text = lines.join("\n");
		if (Buffer.byteLength(text, "utf8") <= COMMAND_OUTPUT_MAX_BYTES && lines.length <= COMMAND_OUTPUT_MAX_LINES) {
			return { text, shownGates: [...selected] };
		}
	}
	return {
		text: "workbench_list_gates: bounded rendering unavailable\nsource: .pi/workbench/gates.yaml + builtin ladder",
		shownGates: [],
	};
}
