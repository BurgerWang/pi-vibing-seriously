/** Public gate execution, gate-page read and gate inventory tool controller. */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { boundedCommandText, boundedInlineDetail } from "./command-output.ts";
import type { ExecFn } from "./config.ts";
import { blocksVerify, type DelegationState } from "./delegation-state.ts";
import { gateParentSummaryLines } from "./gate-commands.ts";
import { loadGates, preflightGateManualEvidence, runGates } from "./gate-engine.ts";
import type { GateStatus, WorkerFirstGateFacts } from "./gate-schema.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import {
	GATE_READ_MAX_BYTES,
	latestGateStatuses,
	readGateRunPage,
	renderGateDefinitionPage,
} from "./report.ts";
import { renderGatePreflightLines, type GatePreflightToolDetails } from "./render.ts";
import { isPureLegacyRunForDiagnostic, isValidRunId, readCommittedManifest, readManifest } from "./runs.ts";
import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "./tool-catalog.ts";
import { boundedGateDetails, fixedToolFailure, renderGateListPresentation } from "./tool-presentation.ts";
import { buildTrustedRecoveryAuthority } from "./trusted-recovery-authority.ts";
import type { TrustedRecoveryAuthority } from "./tool-result-ingress-projection.ts";
import { workbenchToolRenderer } from "../ui/tool-renderers.ts";

interface OutputAuthorizationReservation {
	readonly allowed: boolean;
	readonly allocatedBytes: number;
}

export interface GateToolIdentity {
	readonly role?: string;
	readonly provider?: string;
	readonly model?: string;
}

export interface GateToolsController<TIngress> {
	pi: Pick<ExtensionAPI, "registerTool">;
	getMode(): WorkbenchMode;
	getDelegationState(): DelegationState;
	getIdentity(): GateToolIdentity;
	exec: ExecFn;
	trustedOrError(ctx: ExtensionContext): string | undefined;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<unknown>;
	getProjectAuthorityBlockReason(action: "verify"): string | undefined;
	buildWorkerFirstGateFacts(projectRoot: string, now: string): Promise<WorkerFirstGateFacts>;
	peekOutputAuthorization(toolCallId: unknown, toolName: unknown): OutputAuthorizationReservation | undefined;
	rememberTrustedGateContinuation(toolCallId: unknown, cursor: unknown): void;
	bindTrustedIngressAuthority(authority: TrustedRecoveryAuthority | undefined, content: unknown): TIngress | undefined;
	rememberTrustedIngressAuthority(toolCallId: unknown, toolName: unknown, bound: TIngress | undefined): void;
}

/** Register run_gate, read_gate and list_gates in catalog order. */
export function registerGateTools<TIngress>(controller: GateToolsController<TIngress>): void {
	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_run_gate,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_run_gate,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let trustedIngress: TIngress | undefined;
			try {
				const trustError = controller.trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_run_gate", "untrusted_project");
				const projectRoot = await controller.projectRootFor(ctx);
				if (params.preflight === true) {
					const preflight = await preflightGateManualEvidence({
						projectRoot,
						selector: params.gates,
						manualEvidence: params.manual_evidence,
					});
					const details: GatePreflightToolDetails = {
						preflight: true,
						selector: preflight.selector,
						requested: preflight.requested,
						profile: preflight.profile,
						manual_evidence_ready: preflight.manual_evidence_ready,
						required_manual_checks: preflight.required_manual_checks,
						provided_manual_evidence: preflight.provided_required_ids,
						missing_manual_evidence: preflight.missing_required_ids,
						gate_run_created: false,
						recipes_executed: 0,
						gate_status_assigned: false,
					};
					const text = boundedCommandText(renderGatePreflightLines(details, true).join("\n"));
					return { content: [{ type: "text", text }], details };
				}
				await controller.reconcileProjectAuthority(projectRoot, new Date().toISOString());
				if (
					controller.getMode() === "VERIFY"
					&& (controller.getProjectAuthorityBlockReason("verify") !== undefined || blocksVerify(controller.getDelegationState()))
				) {
					const result = fixedToolFailure("workbench_run_gate", "review_blocked");
					result.details.blocked_reason = "review_blocked";
					return result;
				}
				onUpdate?.({
					content: [{ type: "text", text: "Running declared gates..." }],
					details: { phase: "started", gates: boundedInlineDetail(params.gates, 256) },
				});
				const workerFirstFacts = await controller.buildWorkerFirstGateFacts(projectRoot, new Date().toISOString());
				const result = await runGates({
					projectRoot,
					selector: params.gates,
					mode: controller.getMode(),
					exec: controller.exec,
					signal,
					manualEvidence: params.manual_evidence ?? {},
					manualEvidenceProvenance: "model-tool",
					workerFirstFacts,
					actorFacts: controller.getIdentity(),
				});
				const text = boundedCommandText(gateParentSummaryLines(result, projectRoot).join("\n"));
				const details = boundedGateDetails(result, projectRoot);
				onUpdate?.({ content: [{ type: "text", text }], details: { ...details } });
				const toolResult = { content: [{ type: "text" as const, text }], details };
				const authority = await buildTrustedRecoveryAuthority({
					projectRoot,
					sourceKind: "executed_gate_run",
					toolCallId,
					toolName: "workbench_run_gate",
					sourcePath: `${CONFIG_DIR_NAME}/workbench/runs/${result.runId}/gates.json`,
					requiredFacts: [
						{ key: "run_id", value: result.runId },
						{ key: "status", value: result.status },
						{ key: "gate_count", value: result.gates.length },
					],
				});
				trustedIngress = controller.bindTrustedIngressAuthority(authority, toolResult.content);
				return toolResult;
			} catch {
				return fixedToolFailure("workbench_run_gate", "runtime_error");
			} finally {
				controller.rememberTrustedIngressAuthority(toolCallId, "workbench_run_gate", trustedIngress);
			}
		},
		...workbenchToolRenderer("gate", "workbench_run_gate"),
	});

	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_read_gate,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_read_gate,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			let trustedIngress: TIngress | undefined;
			try {
				const pendingAuthorization = controller.peekOutputAuthorization(toolCallId, "workbench_read_gate");
				const maxOutputBytes = pendingAuthorization === undefined
					? GATE_READ_MAX_BYTES
					: pendingAuthorization.allowed
						? Math.min(GATE_READ_MAX_BYTES, pendingAuthorization.allocatedBytes)
						: 0;
				if (maxOutputBytes <= 0) return fixedToolFailure("workbench_read_gate", "output_allocation_unavailable");
				const trustError = controller.trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_read_gate", "untrusted_project");
				const runId = params.run_id;
				const hasRun = runId !== undefined;
				const hasGate = params.gate_id !== undefined;
				if (hasRun === hasGate) return fixedToolFailure("workbench_read_gate", "invalid_target");
				const projectRoot = await controller.projectRootFor(ctx);
				if (runId !== undefined) {
					if (!isValidRunId(runId)) return fixedToolFailure("workbench_read_gate", "invalid_run_id");
					const manifest = await readManifest(projectRoot, runId);
					if (!manifest) return fixedToolFailure("workbench_read_gate", "run_not_found");
					const committedV2 = await readCommittedManifest(projectRoot, runId);
					const pureLegacyDiagnostic = committedV2 === null
						&& await isPureLegacyRunForDiagnostic(projectRoot, runId);
					// A loose manifest which merely looks like schema v1 is not enough
					// to enter the diagnostic compatibility path. Any mixed v2 marker,
					// invalid transaction identity, or concurrent marker appearance must
					// remain fail-closed instead of being downgraded to "legacy".
					if (committedV2 === null && !pureLegacyDiagnostic) {
						return fixedToolFailure("workbench_read_gate", "committed_run_identity_unavailable");
					}
					const authoritativeManifest = committedV2 ?? manifest;
					if (authoritativeManifest.recipe !== "gate") return fixedToolFailure("workbench_read_gate", "not_a_gate_run");
					const page = await readGateRunPage({
						projectRoot,
						runId,
						include: params.include,
						cursor: params.cursor,
						maxBytes: maxOutputBytes,
						maxLines: params.max_lines,
						requireCommittedAuthority: committedV2 !== null,
					});
					if (!page.ok) return fixedToolFailure("workbench_read_gate", page.code, page.details.source_path);
					if (page.details.next_cursor) controller.rememberTrustedGateContinuation(toolCallId, page.details.next_cursor);
					const toolResult = {
						content: [{ type: "text" as const, text: boundedCommandText(page.text, maxOutputBytes, 320) }],
						details: page.details,
					};
					const authority = committedV2 === null ? undefined : await buildTrustedRecoveryAuthority({
						projectRoot,
						sourceKind: "run_id_gate_page",
						toolCallId,
						toolName: "workbench_read_gate",
						sourcePath: `${CONFIG_DIR_NAME}/workbench/runs/${runId}/gates.json`,
						requiredFacts: [
							{ key: "run_id", value: runId },
							{ key: "include", value: params.include ?? "failures" },
							{ key: "page", value: page.details.remaining_count },
						],
					});
					trustedIngress = controller.bindTrustedIngressAuthority(authority, toolResult.content);
					return toolResult;
				}
				const gates = await loadGates(projectRoot);
				const gate = gates.find((candidate) => candidate.id === params.gate_id);
				if (!gate) return fixedToolFailure("workbench_read_gate", "gate_not_found", ".pi/workbench/gates.yaml + builtin ladder");
				const latest = (await latestGateStatuses(projectRoot, [gate.id]))[gate.id];
				const page = renderGateDefinitionPage({
					gate,
					latestStatus: latest?.status,
					latestRunId: latest?.run_id,
					include: params.include,
					cursor: params.cursor,
					maxBytes: maxOutputBytes,
					maxLines: params.max_lines,
				});
				if (!page.ok) return fixedToolFailure("workbench_read_gate", page.code, page.details.source_path);
				if (page.details.next_cursor) controller.rememberTrustedGateContinuation(toolCallId, page.details.next_cursor);
				return {
					content: [{ type: "text", text: boundedCommandText(page.text, maxOutputBytes, 320) }],
					details: page.details,
				};
			} catch {
				return fixedToolFailure("workbench_read_gate", "runtime_error");
			} finally {
				controller.rememberTrustedIngressAuthority(toolCallId, "workbench_read_gate", trustedIngress);
			}
		},
	});

	controller.pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_list_gates,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_list_gates,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const trustError = controller.trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_list_gates", "untrusted_project");
				const projectRoot = await controller.projectRootFor(ctx);
				const gates = await loadGates(projectRoot);
				const latest = await latestGateStatuses(projectRoot, gates.map((gate) => gate.id));
				const presentation = renderGateListPresentation(gates, latest);
				const statuses: Record<string, GateStatus | "UNKNOWN"> = {};
				for (const gate of presentation.shownGates) {
					let key = boundedInlineDetail(gate.id, 96) || "(unnamed)";
					let suffix = 1;
					while (Object.prototype.hasOwnProperty.call(statuses, key)) key = `${boundedInlineDetail(gate.id, 80)}#${suffix++}`;
					statuses[key] = latest[gate.id]?.status ?? "NOT_RUN";
				}
				return {
					content: [{ type: "text", text: boundedCommandText(presentation.text) }],
					details: {
						gate_count: gates.length,
						shown_count: presentation.shownGates.length,
						omitted_count: gates.length - presentation.shownGates.length,
						statuses,
						source_path: ".pi/workbench/gates.yaml + builtin ladder",
					},
				};
			} catch {
				return fixedToolFailure("workbench_list_gates", "runtime_error", ".pi/workbench/gates.yaml + builtin ladder");
			}
		},
	});
}
