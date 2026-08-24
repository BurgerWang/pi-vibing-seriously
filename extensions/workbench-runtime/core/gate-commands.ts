/** User-facing gate, evidence and gate-report command controller. */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { boundedCommandText, boundedInlineDetail } from "./command-output.ts";
import type { ExecFn } from "./config.ts";
import { reviewBlockReason, type DelegationState } from "./delegation-state.ts";
import {
	GateSetupError,
	loadGates,
	preflightGateManualEvidence,
	runGates,
} from "./gate-engine.ts";
import type { WorkerFirstGateFacts } from "./gate-schema.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { displayRelative } from "./recipe-runner.ts";
import {
	buildRunReport,
	latestGateStatuses,
	readGateEvidenceView,
	renderGateDefinitionPage,
	resolveRunTarget,
} from "./report.ts";
import { buildGateParentSummary } from "./result-summary.ts";
import { isPureLegacyRunForDiagnostic, isValidRunId, readCommittedManifest, readManifest } from "./runs.ts";
import { renderGatePreflightLines, type GatePreflightToolDetails } from "./render.ts";
import type { RecipeMutationFacts } from "./worker-policy.ts";

export interface GateCommandController {
	pi: Pick<ExtensionAPI, "registerCommand">;
	getMode(): WorkbenchMode;
	getDelegationState(): DelegationState;
	getActorFacts(): RecipeMutationFacts;
	getProjectAuthorityBlockReason(action: "verify"): string | undefined;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<unknown>;
	buildWorkerFirstFacts(projectRoot: string, now: string): Promise<WorkerFirstGateFacts>;
	exec: ExecFn;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
	refreshStatus(ctx: ExtensionCommandContext): void | Promise<void>;
	refreshWidget(ctx: ExtensionCommandContext): void | Promise<void>;
	now?(): string;
}

export interface ParsedGateArgs {
	selector: string;
	manualEvidence: Record<string, string>;
	preflight: boolean;
}

export function parseGateCommandArgs(args: string): ParsedGateArgs {
	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
	let selector = "";
	let preflight = false;
	const manualEvidence: Record<string, string> = {};
	for (const token of tokens) {
		if (token === "--preflight") {
			preflight = true;
			continue;
		}
		const separator = token.indexOf("=");
		if (separator > 0 && token.slice(0, separator).startsWith("manual:")) {
			manualEvidence[token.slice("manual:".length, separator)] = token.slice(separator + 1);
			continue;
		}
		if (!selector) selector = token;
	}
	return { selector, manualEvidence, preflight };
}

export function gateParentSummaryLines(result: Awaited<ReturnType<typeof runGates>>, projectRoot: string): string[] {
	const summary = buildGateParentSummary({
		runId: result.runId,
		requested: result.requested,
		profile: result.profile,
		status: result.status,
		gates: result.gates.map((gate) => ({
			id: gate.id,
			status: gate.status,
			title: gate.title,
			failure_reason: gate.failure_reason,
			blocked_reason: gate.blocked_reason,
		})),
		recordPath: displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${result.runId}`),
	});
	return boundedCommandText(summary.text).split("\n");
}

/** Register formal/preflight gate execution and its read-only views. */
export function registerGateCommands(controller: GateCommandController): void {
	const now = controller.now ?? (() => new Date().toISOString());

	controller.pi.registerCommand("q-gate", {
		description: "Run gates: /q-gate <gate-id|base|quant|all> [--preflight] [manual:<check-id>=<evidence> ...]",
		handler: async (args, ctx) => {
			const { selector, manualEvidence, preflight } = parseGateCommandArgs(args);
			if (!selector) {
				controller.output(ctx, ["/q-gate: usage: /q-gate <gate-id|base|quant|all> [--preflight] [manual:<check-id>=<evidence> ...]"]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			if (!preflight) await controller.reconcileProjectAuthority(projectRoot, now());
			const gateBlock = controller.getProjectAuthorityBlockReason("verify")
				?? reviewBlockReason(controller.getDelegationState(), "verify");
			if (!preflight && controller.getMode() === "VERIFY" && gateBlock) {
				controller.output(ctx, [`/q-gate: ${gateBlock}`]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-gate: ${trustError}`]);
				return;
			}
			try {
				if (preflight) {
					const preflightResult = await preflightGateManualEvidence({ projectRoot, selector, manualEvidence });
					const details: GatePreflightToolDetails = {
						preflight: true,
						selector: preflightResult.selector,
						requested: preflightResult.requested,
						profile: preflightResult.profile,
						manual_evidence_ready: preflightResult.manual_evidence_ready,
						required_manual_checks: preflightResult.required_manual_checks,
						provided_manual_evidence: preflightResult.provided_required_ids,
						missing_manual_evidence: preflightResult.missing_required_ids,
						gate_run_created: false,
						recipes_executed: 0,
						gate_status_assigned: false,
					};
					controller.output(ctx, renderGatePreflightLines(details, true));
					return;
				}
				const workerFirstFacts = await controller.buildWorkerFirstFacts(projectRoot, now());
				const result = await runGates({
					projectRoot,
					selector,
					mode: controller.getMode(),
					exec: controller.exec,
					signal: ctx.signal,
					manualEvidence,
					manualEvidenceProvenance: "user-command",
					workerFirstFacts,
					actorFacts: controller.getActorFacts(),
				});
				controller.output(ctx, gateParentSummaryLines(result, projectRoot));
				void controller.refreshStatus(ctx);
				void controller.refreshWidget(ctx);
			} catch (error) {
				const message = error instanceof GateSetupError
					? error.message
					: `failed to run gates: ${(error as Error).message}`;
				controller.output(ctx, [`/q-gate: ${message}`]);
			}
		},
	});

	controller.pi.registerCommand("q-gates", {
		description: "List the gates available for this project with their latest status",
		handler: async (_args, ctx) => {
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-gates: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			try {
				const gates = await loadGates(projectRoot);
				if (gates.length === 0) {
					controller.output(ctx, ["No gates available for this project/profile."]);
					return;
				}
				const lines = [`${gates.length} gate(s) for this project:`];
				const latest = await latestGateStatuses(projectRoot, gates.map((gate) => gate.id));
				for (const gate of gates) {
					const record = latest[gate.id];
					const status = record
						? `${record.status} (run ${record.run_id})${record.unavailable_reason ? ` — ${record.unavailable_reason}` : ""}`
						: "NOT_RUN (never run)";
					const prerequisites = gate.prerequisites.length > 0 ? ` needs: ${gate.prerequisites.join(",")}` : "";
					lines.push(`  ${gate.id.padEnd(4)} ${status.padEnd(42)} ${gate.title}${prerequisites}`);
				}
				controller.output(ctx, lines);
			} catch (error) {
				controller.output(ctx, [`/q-gates: ${error instanceof GateSetupError ? error.message : (error as Error).message}`]);
			}
		},
	});

	controller.pi.registerCommand("q-gate-show", {
		description: "Show a gate definition: /q-gate-show <gate-id>",
		handler: async (args, ctx) => {
			const gateId = args.trim();
			if (!gateId) {
				controller.output(ctx, ["/q-gate-show: usage: /q-gate-show <gate-id>"]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-gate-show: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			try {
				const gates = await loadGates(projectRoot);
				const gate = gates.find((candidate) => candidate.id === gateId);
				if (!gate) {
					const known = gates.map((candidate) => candidate.id).join(", ") || "(none)";
					controller.output(ctx, [`/q-gate-show: gate "${gateId}" not found. Available: ${known}`]);
					return;
				}
				const latest = (await latestGateStatuses(projectRoot, [gate.id]))[gate.id];
				const page = renderGateDefinitionPage({
					gate,
					latestStatus: latest?.status,
					latestRunId: latest?.run_id,
					include: "checks",
					maxLines: 320,
				});
				controller.output(ctx, page.text.split("\n"));
			} catch (error) {
				controller.output(ctx, [`/q-gate-show: ${error instanceof GateSetupError ? error.message : (error as Error).message}`]);
			}
		},
	});

	controller.pi.registerCommand("q-evidence", {
		description: "Show the evidence of a gate run: /q-evidence <run-id>",
		handler: async (args, ctx) => {
			const emit = (value: unknown): void => controller.output(ctx, boundedCommandText(value).split("\n"));
			const runId = args.trim();
			if (!isValidRunId(runId)) {
				emit("/q-evidence: usage: /q-evidence <run-id> (e.g. 20260101-120000-abcd)");
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				emit(`/q-evidence: ${trustError}`);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const manifest = await readManifest(projectRoot, runId);
			if (!manifest) {
				emit(`/q-evidence: run ${runId} not found`);
				return;
			}
			const committedV2 = await readCommittedManifest(projectRoot, runId);
			const pureLegacyDiagnostic = committedV2 === null
				&& await isPureLegacyRunForDiagnostic(projectRoot, runId);
			if (committedV2 === null && !pureLegacyDiagnostic) {
				emit("/q-evidence: committed run identity unavailable");
				return;
			}
			const authoritativeManifest = committedV2 ?? manifest;
			if (authoritativeManifest.recipe !== "gate") {
				emit(`/q-evidence: run ${runId} is a recipe run (recipe "${boundedInlineDetail(authoritativeManifest.recipe, 256)}") — it has no gate evidence`);
				return;
			}
			try {
				const evidence = await readGateEvidenceView(
					projectRoot,
					runId,
					undefined,
					{ requireCommittedAuthority: committedV2 !== null },
				);
				emit(evidence.text);
			} catch {
				emit("/q-evidence: gate evidence unavailable");
			}
		},
	});

	controller.pi.registerCommand("q-report", {
		description: "Show a run report: /q-report latest | /q-report <run-id> (manifest, gates, quant facts)",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				controller.output(ctx, ["/q-report: usage: /q-report latest | /q-report <run-id> (e.g. 20260101-120000-abcd)"]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-report: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const runId = await resolveRunTarget(projectRoot, target);
			if (!runId) {
				controller.output(ctx, [
					`/q-report: ${isValidRunId(target) ? `run ${target} not found` : `unknown target "${target}" (use "latest" or a run id)`}`,
				]);
				return;
			}
			const lines = await buildRunReport(projectRoot, runId);
			controller.output(ctx, lines ?? [`/q-report: run ${runId} not found`]);
		},
	});
}
