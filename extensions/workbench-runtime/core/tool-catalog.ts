/**
 * P6-B Workbench tool catalog — the single source of truth for the static
 * metadata of every workbench custom tool.
 *
 * Stable-prefix contract (docs/cache/stable-prefix-contract.md):
 *   - `WORKBENCH_TOOL_NAMES` is the EXPLICIT registration-order constant.
 *     The extension registers tools in exactly this order (asserted by
 *     tests/p6-b-stable-prefix.test.ts against extensions/.../index.ts).
 *   - name / label / description / promptSnippet / promptGuidelines are
 *     static at runtime: no cwd, no date, no mode, no project path, no
 *     run/task/gate id ever appears in them (audited by tests via
 *     stable-prefix.staticToolMetadataIssues).
 *   - parameter JSON schemas (WORKBENCH_TOOL_PARAMETERS) are constructed in
 *     source order (typebox preserves key insertion order), so
 *     `canonicalHash(parameters)` is stable across runs and installs.
 *
 * The catalog is pure (only typebox) so tests can hash the metadata without
 * a Pi runtime. The extension's registerTool calls spread these definitions
 * and attach their `execute` implementations.
 */

import { Type } from "typebox";

/**
 * Explicit registration order of the workbench custom tools (P6-B). The
 * `as const` tuple keeps the literal union so index access stays precise.
 */
export const WORKBENCH_TOOL_NAMES = [
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
	"workbench_run_gate",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
] as const;

export interface WorkbenchToolMeta {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

/**
 * Parameter schemas, keyed by tool name. `as const` preserves the exact
 * typebox types so the extension's registerTool calls infer the params type
 * for their execute handlers. Key order here is source order (stable).
 */
export const WORKBENCH_TOOL_PARAMETERS = {
	workbench_project_inspect: Type.Object({}),
	workbench_run_recipe: Type.Object({
		recipe: Type.String({ description: "Name of a declared recipe in .pi/workbench/recipes.yaml" }),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
				description: "Recipe parameters declared in the recipe schema (substituted into argv placeholders)",
			}),
		),
		cache: Type.Optional(
			Type.Union([Type.Literal("default"), Type.Literal("no-cache"), Type.Literal("refresh-cache")], {
				description: "P6-C action-cache mode: default (read/write per the recipe's cache policy), no-cache (execute, never read or write), refresh-cache (execute and (re)write)",
			}),
		),
	}),
	workbench_read_run: Type.Object({
		run_id: Type.String({ description: "Run id, e.g. 20260101-120000-abcd" }),
		include: Type.Optional(
			Type.Union([Type.Literal("summary"), Type.Literal("manifest"), Type.Literal("logs"), Type.Literal("all")], {
				description: "What to include (default: all, with bounded log tails)",
			}),
		),
		max_lines: Type.Optional(Type.Integer({ description: "Log snippet line cap (default 200)", minimum: 1, maximum: 2000 })),
		max_bytes: Type.Optional(Type.Integer({ description: "Log snippet byte cap (default 20KB)", minimum: 1, maximum: 512000 })),
	}),
	workbench_run_gate: Type.Object({
		gates: Type.String({ description: "Gate selector: a gate id (e.g. \"b0\"), comma-separated ids, or base|quant|all" }),
		manual_evidence: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Manual evidence notes keyed by check id — recorded as manual evidence, never as machine verification",
			}),
		),
	}),
	workbench_read_gate: Type.Object({
		run_id: Type.Optional(Type.String({ description: "Run id of a gate run (e.g. 20260101-120000-abcd)" })),
		gate_id: Type.Optional(Type.String({ description: "Gate id (e.g. b0, q3)" })),
	}),
	workbench_list_gates: Type.Object({}),
	workbench_compare_runs: Type.Object({
		a: Type.String({ description: "First run id, e.g. 20260101-120000-abcd" }),
		b: Type.String({ description: "Second run id, e.g. 20260102-120000-efgh" }),
	}),
} as const;

type WorkbenchToolName = (typeof WORKBENCH_TOOL_NAMES)[number];

/** Keyed by tool name; literal access is precisely typed (no undefined). */
export const WORKBENCH_TOOL_METADATA: { [K in WorkbenchToolName]: WorkbenchToolMeta } = {
	workbench_project_inspect: {
		name: "workbench_project_inspect",
		label: "Workbench project inspect",
		description:
			"Inspect the current project's workbench setup: project root, git state, detected language/package manager, workbench profile, declared recipes, and configuration errors. Never outputs secrets.",
		promptSnippet: "Inspect workbench project configuration (root, git, stack, profile, recipes, config errors)",
		promptGuidelines: [
			"Use workbench_project_inspect before running or designing recipes to learn the project profile and available recipe names.",
		],
	},
	workbench_run_recipe: {
		name: "workbench_run_recipe",
		label: "Workbench run recipe",
		description:
			"Run a declared recipe from .pi/workbench/recipes.yaml by name with schema-approved parameters. Only declared recipes run — arbitrary commands are never accepted. Full output is written to the run directory; a truncated summary is returned. Use workbench_project_inspect to list recipes.",
		promptSnippet: "Run a declared workbench recipe by name (controlled execution)",
		promptGuidelines: [
			"Use workbench_run_recipe instead of bash for project commands that are declared as recipes — the model must not improvise shell commands in VERIFY mode.",
			"Only pass parameters declared in the recipe's params schema.",
		],
	},
	workbench_read_run: {
		name: "workbench_read_run",
		label: "Workbench read run",
		description:
			"Read a workbench run record by run_id: manifest metadata, summary, and bounded log snippets. Full logs are never sent inline; use the returned log paths with read/grep when more detail is needed.",
		promptSnippet: "Read a workbench run record (manifest, summary, bounded logs) by run_id",
		promptGuidelines: [
			"Use workbench_read_run to inspect previous recipe runs; default output is deliberately bounded.",
		],
	},
	workbench_run_gate: {
		name: "workbench_run_gate",
		label: "Workbench run gate",
		description:
			"Run a gate selector (gate id, comma-separated ids, or base|quant|all) from the validation ladder. Only declared recipes run; the gate engine never trusts model prose — manual evidence supplied here is recorded with type \"manual\" and can never masquerade as machine verification.",
		promptSnippet: "Run validation gates (base/quant ladder) for the project",
		promptGuidelines: [
			"Use workbench_list_gates or /q-gates to see the gates available for the current profile.",
			"Manual evidence for manual checks must be passed as manual_evidence keyed by check id; it is recorded as type \"manual\" only.",
		],
	},
	workbench_read_gate: {
		name: "workbench_read_gate",
		label: "Workbench read gate",
		description:
			"Read a gate run record by run_id (gates.json summary) or a gate definition by gate_id (with its latest persisted status). Provide exactly one of run_id / gate_id.",
		promptSnippet: "Read a gate run record or gate definition",
		promptGuidelines: [
			"Use workbench_read_gate with run_id to inspect the per-gate statuses of a gate run.",
			"Use workbench_read_gate with gate_id to see the gate definition and its latest status.",
		],
	},
	workbench_list_gates: {
		name: "workbench_list_gates",
		label: "Workbench list gates",
		description: "List the validation gates available for the current project/profile with their latest persisted status.",
		promptSnippet: "List available validation gates and their latest status",
		promptGuidelines: [
			"Use workbench_list_gates before running gates to see which gates the current profile loads (base b0-b5 always; quant q0-q5 only for quant-research profiles).",
		],
	},
	workbench_compare_runs: {
		name: "workbench_compare_runs",
		label: "Workbench compare runs",
		description:
			"Compare two workbench run records by run_id: exit code, duration, artifact changes, gate delta, and (when both runs carry a valid quant-result artifact) benchmark/return/drawdown/turnover/cost/fold deltas and parameter changes. All facts come from the runs' own JSON records; deltas are descriptive — a higher return is never automatically interpreted as a better strategy.",
		promptSnippet: "Compare two workbench run records (exit code, duration, artifacts, gates, quant metrics)",
		promptGuidelines: [
			"Use workbench_compare_runs to diff two persisted run records; use /q-runs or workbench_read_run to discover run ids first.",
			"Deltas are descriptive facts — do not treat a higher return as automatically better without risk-adjusted and out-of-sample evidence.",
		],
	},
};

/** Metadata + parameter schema in the explicit registration order. */
export function workbenchToolMetadataOrdered(): readonly (WorkbenchToolMeta & { parameters: unknown })[] {
	return WORKBENCH_TOOL_NAMES.map((name) => ({
		...(WORKBENCH_TOOL_METADATA[name] as WorkbenchToolMeta),
		parameters: WORKBENCH_TOOL_PARAMETERS[name],
	}));
}

/** True when the name is a workbench custom tool. */
export function isWorkbenchToolName(name: string): boolean {
	return (WORKBENCH_TOOL_NAMES as readonly string[]).includes(name);
}
