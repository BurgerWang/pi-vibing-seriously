/**
 * Production event adapter for one bounded automatic delivery continuation.
 *
 * Registration is intentionally split around the normal tool-result
 * middleware.  The pre-middleware handler captures only the guard-owned
 * delegation id while its checkout lease still exists.  The post-middleware
 * handlers run only after normal tool-result cleanup has settled/released the
 * parent operation.  Event/session messages remain bounded locators and
 * projections; durable readers injected below are the only authority.
 */

import { types as utilTypes } from "node:util";

import {
	delegationStatusToolActionV1,
	repairDelegationToolActionV1,
	reviewDelegationToolActionV1,
} from "./agent-next-action.ts";

import type {
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	createAutomaticDeliveryContinuationLifecycleV1,
	parseAutomaticDeliveryContinuationCandidateV1,
	parseAutomaticDeliveryContinuationSettledAuthorityV1,
	resolveAutomaticDeliveryContinuationLifecycleActionV1,
	type AutomaticDeliveryContinuationCandidateResolutionV1,
	type AutomaticDeliveryContinuationGateResultV1,
	type AutomaticDeliveryContinuationLifecycleDependenciesV1,
	type AutomaticDeliveryContinuationLifecycleResultV1,
	type AutomaticDeliveryContinuationSettledResultV1,
} from "./automatic-delivery-continuation-lifecycle.ts";
import {
	AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1,
	revalidateAutomaticDeliveryContinuationCandidateV1,
} from "./automatic-delivery-continuation-authority.ts";
import {
	runAutomaticSemanticReview,
	type AutomaticSemanticReviewResult,
} from "./automatic-semantic-review-service.ts";
import type { ExecFn } from "./config.ts";
import {
	coordinateDeliveryChainV1,
	DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
	type DeliveryChainCoordinatorResultV1,
} from "./delivery-chain-coordinator.ts";
import type {
	ExactRepairServiceRunnerV1,
	ExactRepairServiceResultV1,
} from "./exact-repair-service.ts";
import type { ExactRepairExistingSuccessorV1 } from "./exact-repair-successor.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import {
	recoverSettledGenericProjectCheckoutOperationV1,
	runProjectCheckoutOperationV1,
	type ProjectCheckoutOperationLeaseV1,
	type ProjectCheckoutOperationResultV1,
	type ProjectCheckoutOperationRunResultV1,
} from "./project-checkout-operation.ts";
import {
	COMMANDER_MODEL_ID,
	COMMANDER_PROVIDERS,
	WORKER_TOOL_NAME,
} from "./worker-policy.ts";

export const AUTOMATIC_DELIVERY_CONTINUATION_MESSAGE_TYPE_V1 =
	"workbench-automatic-delivery-continuation-v1" as const;
export const AUTOMATIC_DELIVERY_CONTINUATION_RECOVERY_SESSION_REASONS_V1 =
	Object.freeze(["startup", "reload", "resume"] as const);

const DELEGATION_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/u;
const MAX_PROJECTION_BYTES = 4_096;

export interface AutomaticDeliveryContinuationReviewOperationInputV1 {
	readonly project_root: string;
	readonly operation_kind: "command";
	readonly operation_id: string;
	readonly now: string;
	/** Closed metadata authority; never a grant to mutate product paths. */
	readonly allowed_paths: readonly [typeof AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1];
}

export type AutomaticDeliveryContinuationReviewOperationRunnerV1 = (
	input: AutomaticDeliveryContinuationReviewOperationInputV1,
	operation: (lease: Readonly<ProjectCheckoutOperationLeaseV1>) => Promise<AutomaticSemanticReviewResult>,
) => Promise<ProjectCheckoutOperationRunResultV1<AutomaticSemanticReviewResult>>;

export interface AutomaticDeliveryContinuationRuntimeControllerDependenciesV1 {
	readonly pi: Pick<ExtensionAPI, "on" | "sendMessage">;
	/** Guard-owned map; the pre-middleware listener reads but never mutates it. */
	readonly pendingCheckoutOperationHandles: ReadonlyMap<string, ProjectCheckoutOperationLeaseV1>;
	readonly exec: ExecFn;
	readonly secrets: readonly string[];
	readonly getMode: () => WorkbenchMode;
	readonly runtimeCurrentOrError: (ctx: ExtensionContext) => string | undefined;
	readonly compactionPending: (ctx: ExtensionContext) => boolean;
	readonly projectRootFor: (ctx: ExtensionContext) => Promise<string>;
	readonly recoverSettledCheckoutOperation?: (input: {
		readonly project_root: string;
	}) => Promise<ProjectCheckoutOperationResultV1<"absent" | "recovered" | "delegation_cas_pending">>;
	readonly reconcileProjectAuthority: (input: {
		readonly project_root: string;
		readonly now: string;
		readonly runtime_context: ExtensionContext;
	}) => Promise<boolean>;
	/** Full project scan. It must filter closed/reviewed locators before counting. */
	readonly resolveCandidate: (
		input: Parameters<AutomaticDeliveryContinuationLifecycleDependenciesV1["resolveCandidate"]>[0],
	) => Promise<AutomaticDeliveryContinuationCandidateResolutionV1>;
	/** Immutable candidate readback while the metadata writer lane is held. */
	readonly revalidateCandidate?: typeof revalidateAutomaticDeliveryContinuationCandidateV1;
	/** Strict durable authority plus real no-active-lane proof. */
	readonly confirmSettled: (
		input: Parameters<AutomaticDeliveryContinuationLifecycleDependenciesV1["confirmSettled"]>[0],
	) => Promise<AutomaticDeliveryContinuationSettledResultV1>;
	readonly exactRepair: ExactRepairServiceRunnerV1;
	readonly review?: typeof runAutomaticSemanticReview;
	readonly coordinate?: typeof coordinateDeliveryChainV1;
	readonly runReviewOperation?: AutomaticDeliveryContinuationReviewOperationRunnerV1;
	readonly now?: () => Date;
	/** Test-only isolation for process-global lifecycle state. */
	readonly processStateSymbol?: symbol;
}

export interface AutomaticDeliveryContinuationProjectionV1 {
	readonly schema_version: 1;
	readonly non_authoritative: true;
	readonly trigger: "agent_settled" | "before_agent_start";
	readonly status: AutomaticDeliveryContinuationLifecycleResultV1["status"];
	readonly code: string | null;
	readonly delegation_id: string | null;
	readonly authority_hash: string | null;
	readonly lifecycle_action: string | null;
	readonly lifecycle_reason: string | null;
	readonly lifecycle_snapshot_hash: string | null;
	readonly chain_status: DeliveryChainCoordinatorResultV1["status"] | null;
	readonly successor_attempts_used: 0 | 1 | null;
	readonly successor_delegation_id: string | null;
	readonly successor_status: string | null;
	readonly successor_disposition: string | null;
	readonly next_action: string | null;
	readonly nested_usage: {
		readonly input: number;
		readonly output: number;
		readonly cache_read: number;
		readonly cache_write: number;
		readonly total_tokens: number;
	} | null;
}

export interface AutomaticDeliveryContinuationRuntimeControllerV1 {
	/** Register before registerToolResultMiddleware(). */
	registerToolResultLocatorCaptureBeforeMiddleware(): void;
	/** Register after registerToolResultMiddleware(). */
	registerLifecycleListenersAfterMiddleware(): void;
	/** Claim-guard suppression seam for a pending reload continuation. */
	hasPendingBeforeAgentContinuation(): boolean;
}

function dataRecord(value: unknown): value is Record<string, unknown> {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function ownDataValue(value: unknown, field: string): unknown {
	if (!dataRecord(value)) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function safeNow(now: (() => Date) | undefined): string {
	try {
		const value = (now ?? (() => new Date()))();
		if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	} catch {
		// Fall through to the real completion-boundary clock.
	}
	return new Date().toISOString();
}

function contextFrom(value: unknown): ExtensionContext | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as Partial<ExtensionContext>;
	return typeof candidate.cwd === "string" && typeof candidate.isProjectTrusted === "function" &&
		typeof candidate.hasPendingMessages === "function" && candidate.modelRegistry !== undefined
		? value as ExtensionContext
		: undefined;
}

function gateFailure(code: string) {
	return { ok: false as const, code };
}

function checkRuntimeGates(
	dependencies: AutomaticDeliveryContinuationRuntimeControllerDependenciesV1,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): AutomaticDeliveryContinuationGateResultV1 {
	if (signal !== ctx.signal) return gateFailure("SIGNAL_CONTEXT_MISMATCH");
	if (signal?.aborted === true) return gateFailure("ABORTED");
	if (dependencies.getMode() !== "DEV") return gateFailure("MODE_NOT_DEV");
	let trusted: boolean;
	try { trusted = ctx.isProjectTrusted(); } catch { return gateFailure("TRUST_UNAVAILABLE"); }
	if (!trusted) return gateFailure("UNTRUSTED");
	let runtimeError: string | undefined;
	try { runtimeError = dependencies.runtimeCurrentOrError(ctx); } catch { return gateFailure("RUNTIME_UNAVAILABLE"); }
	if (runtimeError !== undefined) return gateFailure("RUNTIME_NOT_CURRENT");
	if (ctx.model?.id !== COMMANDER_MODEL_ID || !COMMANDER_PROVIDERS.includes(ctx.model.provider)) {
		return gateFailure("MODEL_NOT_SOL");
	}
	let pendingMessages: boolean;
	try { pendingMessages = ctx.hasPendingMessages(); } catch { return gateFailure("QUEUE_UNAVAILABLE"); }
	if (pendingMessages) return gateFailure("PENDING_MESSAGES");
	let compactionPending: boolean;
	try { compactionPending = dependencies.compactionPending(ctx); } catch { return gateFailure("COMPACTION_UNAVAILABLE"); }
	if (compactionPending) return gateFailure("COMPACTION_PENDING");
	return {
		ok: true as const,
		value: {
			schema_version: 1 as const,
			mode: "DEV" as const,
			trusted: true as const,
			runtime_current: true as const,
			commander_provider: ctx.model.provider as "openai" | "openai-codex",
			commander_model: COMMANDER_MODEL_ID,
			aborted: false as const,
			has_pending_messages: false as const,
			compaction_pending: false as const,
		},
	};
}

function defaultReviewOperationRunner(
	input: AutomaticDeliveryContinuationReviewOperationInputV1,
	operation: (lease: Readonly<ProjectCheckoutOperationLeaseV1>) => Promise<AutomaticSemanticReviewResult>,
): Promise<ProjectCheckoutOperationRunResultV1<AutomaticSemanticReviewResult>> {
	if (input.allowed_paths.length !== 1 ||
		input.allowed_paths[0] !== AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1) {
		return Promise.resolve({
			ok: false,
			error: { code: "invalid_input", message: "automatic review metadata lane is invalid" },
		});
	}
	return runProjectCheckoutOperationV1({
		project_root: input.project_root,
		operation_kind: input.operation_kind,
		operation_id: input.operation_id,
		now: input.now,
	}, operation);
}

function closedSuccessor(result: AutomaticDeliveryContinuationLifecycleResultV1): {
	readonly delegation_id: string;
	readonly status: "REVIEWED";
	readonly disposition: "CHAIN_CLOSED";
} | undefined {
	if (result.status !== "CHAIN_RESULT" || result.chain.status !== "SUCCESSOR_RECORDED") return undefined;
	const successor = result.chain.repair.successor;
	return successor.status === "REVIEWED" && successor.disposition === "CHAIN_CLOSED"
		? { delegation_id: successor.delegation_id, status: "REVIEWED", disposition: "CHAIN_CLOSED" }
		: undefined;
}

function freshlyDeliveredSuccessor(result: AutomaticDeliveryContinuationLifecycleResultV1):
	ReturnType<typeof closedSuccessor> {
	const closed = closedSuccessor(result);
	if (closed === undefined || result.status !== "CHAIN_RESULT" || result.chain.status !== "SUCCESSOR_RECORDED") {
		return undefined;
	}
	const repair = result.chain.repair;
	return repair.replayed === false && repair.execution_attempted === true &&
		repair.execution_outcome === "returned" && repair.execution_status === "completed"
		? closed
		: undefined;
}

function lifecycleCode(result: AutomaticDeliveryContinuationLifecycleResultV1): string | null {
	return "code" in result ? result.code : null;
}

function chainNextAction(chain: DeliveryChainCoordinatorResultV1): string | null {
	if ("next_action" in chain) return chain.next_action;
	if (chain.status !== "SUCCESSOR_RECORDED") return null;
	const successor = chain.repair.successor;
	switch (successor.disposition) {
		case "CHAIN_CLOSED":
			return successor.status === "REVIEWED" ? null : delegationStatusToolActionV1();
		case "REVIEW_PENDING":
			return successor.status === "PENDING_REVIEW" || successor.status === "INTERRUPTED"
				? reviewDelegationToolActionV1(successor.delegation_id)
				: delegationStatusToolActionV1();
		case "REPAIR_PENDING":
		case "EXACT_REPAIR_PENDING":
			return repairDelegationToolActionV1(successor.delegation_id);
		case "ACTIVE":
		case "BLOCKED":
			return delegationStatusToolActionV1();
	}
}

function exactRepairSuccessor(
	repair: ExactRepairServiceResultV1 | undefined,
): Readonly<ExactRepairExistingSuccessorV1> | undefined {
	return repair !== undefined && "successor" in repair ? repair.successor : undefined;
}

function projection(result: AutomaticDeliveryContinuationLifecycleResultV1): AutomaticDeliveryContinuationProjectionV1 {
	const chain = result.status === "CHAIN_RESULT" ? result.chain : undefined;
	const successor = chain?.status === "SUCCESSOR_RECORDED"
		? chain.repair.successor
		: chain?.status === "REPAIR_PENDING"
			? exactRepairSuccessor(chain.repair)
			: undefined;
	const usage = chain !== undefined && "review" in chain && chain.review !== undefined
		? chain.review.nested_usage
		: undefined;
	return Object.freeze({
		schema_version: 1,
		non_authoritative: true,
		trigger: result.trigger,
		status: result.status,
		code: lifecycleCode(result),
		delegation_id: "delegation_id" in result ? result.delegation_id ?? null : null,
		authority_hash: "authority_hash" in result ? result.authority_hash ?? null : null,
		lifecycle_action: result.status === "CHAIN_RESULT" ? result.lifecycle_resolution.primary_action.action : null,
		lifecycle_reason: result.status === "CHAIN_RESULT" ? result.lifecycle_resolution.primary_action.reason : null,
		lifecycle_snapshot_hash: result.status === "CHAIN_RESULT" ? result.lifecycle_resolution.primary_action.snapshot_hash : null,
		chain_status: chain?.status ?? null,
		successor_attempts_used: chain?.successor_attempts_used ?? null,
		successor_delegation_id: successor?.delegation_id ?? null,
		successor_status: successor?.status ?? null,
		successor_disposition: successor?.disposition ?? null,
		next_action: chain === undefined ? (result.status === "BLOCKED" ? delegationStatusToolActionV1() : null) : chainNextAction(chain),
		nested_usage: usage === undefined ? null : Object.freeze({
			input: usage.input,
			output: usage.output,
			cache_read: usage.cacheRead,
			cache_write: usage.cacheWrite,
			total_tokens: usage.totalTokens,
		}),
	});
}

function boundedMessage(
	result: AutomaticDeliveryContinuationLifecycleResultV1,
): { readonly content: string; readonly details: AutomaticDeliveryContinuationProjectionV1 } | undefined {
	if (result.status === "NOOP") return undefined;
	const details = projection(result);
	const terminal = closedSuccessor(result);
	const content = terminal === undefined
		? `Automatic delivery continuation: ${details.status}${details.code === null ? "" : `/${details.code}`}.` +
			(details.next_action === null ? " Durable authority remains unchanged; await a later strict retry." : ` Durable next action: ${details.next_action}.`)
		: `Durable automatic successor ${terminal.delegation_id} is ${terminal.status} with strict ${terminal.disposition} authority. Continue the preserved development objective from durable state; do not rerun the parent repair.`;
	if (Buffer.byteLength(content, "utf8") > MAX_PROJECTION_BYTES ||
		Buffer.byteLength(JSON.stringify(details), "utf8") > MAX_PROJECTION_BYTES) return undefined;
	return { content, details };
}

function validReviewLease(
	lease: Readonly<ProjectCheckoutOperationLeaseV1>,
	projectRoot: string,
): boolean {
	return lease.schema_version === 1 && lease.project_root === projectRoot &&
		lease.operation_kind === "command" && lease.mode === "exclusive";
}

/**
 * Build an unregistered runtime. Production calls the pre-registration method,
 * installs the normal tool-result middleware, then calls the post method.
 */
export function createAutomaticDeliveryContinuationRuntimeControllerV1(
	dependencies: AutomaticDeliveryContinuationRuntimeControllerDependenciesV1,
): AutomaticDeliveryContinuationRuntimeControllerV1 {
	const review = dependencies.review ?? runAutomaticSemanticReview;
	const coordinate = dependencies.coordinate ?? coordinateDeliveryChainV1;
	const runReviewOperation = dependencies.runReviewOperation ?? defaultReviewOperationRunner;
	const revalidateCandidate = dependencies.revalidateCandidate ?? revalidateAutomaticDeliveryContinuationCandidateV1;
	const recoverSettledCheckoutOperation = dependencies.recoverSettledCheckoutOperation ??
		(async ({ project_root: projectRoot }) => recoverSettledGenericProjectCheckoutOperationV1(projectRoot));

	const lifecycle = createAutomaticDeliveryContinuationLifecycleV1({
		canonicalProjectRoot: async ({ runtime_context: runtimeContext }) => {
			const ctx = contextFrom(runtimeContext);
			if (ctx === undefined) throw new Error("runtime context unavailable");
			return dependencies.projectRootFor(ctx);
		},
		reconcile: async ({ project_root: projectRoot, runtime_context: runtimeContext }) => {
			const ctx = contextFrom(runtimeContext);
			if (ctx === undefined) return { ok: false, code: "RUNTIME_CONTEXT_UNAVAILABLE" };
			try {
				const recovered = await recoverSettledCheckoutOperation({ project_root: projectRoot });
				if (!recovered.ok) return { ok: false, code: "CHECKOUT_OPERATION_RECOVERY_FAILED" };
				return await dependencies.reconcileProjectAuthority({
					project_root: projectRoot,
					now: safeNow(dependencies.now),
					runtime_context: ctx,
				}) ? { ok: true } : { ok: false, code: "PROJECT_AUTHORITY_RECOVERY_FAILED" };
			} catch {
				return { ok: false, code: "PROJECT_AUTHORITY_RECOVERY_FAILED" };
			}
		},
		checkGates: async ({ signal, runtime_context: runtimeContext }) => {
			const ctx = contextFrom(runtimeContext);
			return ctx === undefined ? gateFailure("RUNTIME_CONTEXT_UNAVAILABLE") : checkRuntimeGates(dependencies, ctx, signal);
		},
		resolveCandidate: dependencies.resolveCandidate,
		confirmSettled: dependencies.confirmSettled,
		runChain: async (input) => {
			const ctx = contextFrom(input.runtime_context);
			if (ctx === undefined || input.max_successor_attempts !== DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1) {
				throw new Error("automatic continuation runtime context is invalid");
			}
			const requestedLifecycle = resolveAutomaticDeliveryContinuationLifecycleActionV1(input.candidate);
			if (requestedLifecycle === undefined ||
				requestedLifecycle.resolution_hash !== input.lifecycle_resolution.resolution_hash) {
				throw new Error("automatic continuation lifecycle action is invalid");
			}
			const lane = await runReviewOperation({
				project_root: input.project_root,
				operation_kind: "command",
				operation_id: `command:auto-delivery-review:${input.candidate.delegation_id}:${input.candidate.authority_hash.slice(0, 16)}`,
				now: safeNow(dependencies.now),
				allowed_paths: [AUTOMATIC_DELIVERY_CONTINUATION_METADATA_LANE_V1],
			}, async (lease) => {
				if (!validReviewLease(lease, input.project_root)) throw new Error("automatic review checkout lease is invalid");
				// Revalidate the same strict candidate while this metadata-only writer
				// operation owns the fixed checkout lane. The event locator is absent
				// from the authority hash and cannot expand the metadata path grant.
				const revalidated = await revalidateCandidate({ candidate: input.candidate });
				const revalidatedLifecycle = revalidated.resolution.status === "CANDIDATE"
					? resolveAutomaticDeliveryContinuationLifecycleActionV1(revalidated.resolution.candidate)
					: undefined;
				if (revalidated.schema_version !== 1 || revalidated.unchanged !== true ||
					revalidated.expected_authority_hash !== input.candidate.authority_hash ||
					revalidated.observed_authority_hash !== input.candidate.authority_hash ||
					revalidated.resolution.status !== "CANDIDATE" || revalidatedLifecycle === undefined ||
					revalidatedLifecycle.resolution_hash !== requestedLifecycle.resolution_hash) {
					throw new Error("automatic review authority changed after lane acquisition");
				}
				return review({
					project_root: input.project_root,
					delegation_id: input.candidate.delegation_id,
					exec: dependencies.exec,
					model_registry: ctx.modelRegistry,
					secrets: dependencies.secrets,
					signal: input.signal,
					now: dependencies.now,
				});
			});
			if (!lane.ok || lane.release !== "released") {
				throw new Error(lane.ok ? "automatic review lane release requires recovery" : `automatic review lane ${lane.error.code}`);
			}

			const reviewResult = lane.value;
			let refreshed = input.candidate;
			let postReviewSettled: ReturnType<typeof parseAutomaticDeliveryContinuationSettledAuthorityV1>;
			if (reviewResult.status === "REPAIR") {
				const readback = await dependencies.resolveCandidate({
					project_root: input.project_root,
					trigger: input.trigger,
					locator_delegation_ids: [input.candidate.delegation_id],
					require_unique_unresolved_tip: true,
					require_strict_repair_sidecar: true,
					require_full_path_admission: true,
					allow_exact_terminal_needs_review: false,
				});
				const parsed = readback.status === "CANDIDATE"
					? parseAutomaticDeliveryContinuationCandidateV1(readback.candidate)
					: undefined;
				if (parsed === undefined || parsed.project_root !== input.project_root ||
					parsed.delegation_id !== input.candidate.delegation_id ||
					parsed.review_authority !== "DURABLE_REPAIR_SIDECAR" ||
					parsed.bound_diff_hash !== reviewResult.bound_diff_hash ||
					(input.candidate.review_authority === "ELIGIBLE_TERMINAL_NEEDS_REVIEW" &&
						parsed.authority_hash === input.candidate.authority_hash)) {
					throw new Error("durable semantic REPAIR sidecar readback is unavailable");
				}
				refreshed = parsed;
				const confirmed = await dependencies.confirmSettled({
					project_root: input.project_root,
					delegation_id: refreshed.delegation_id,
					expected_authority_hash: refreshed.authority_hash,
					expected_bound_diff_hash: refreshed.bound_diff_hash,
					required_lineage_depth: 0,
				});
				postReviewSettled = confirmed.ok
					? parseAutomaticDeliveryContinuationSettledAuthorityV1(confirmed.value, refreshed)
					: undefined;
				if (postReviewSettled === undefined) {
					throw new Error("post-review parent authority is not settled after metadata lane release");
				}
			}

			const chain = await coordinate({
				review: {
					project_root: input.project_root,
					delegation_id: input.candidate.delegation_id,
					exec: dependencies.exec,
					model_registry: ctx.modelRegistry,
					secrets: dependencies.secrets,
					signal: input.signal,
					now: dependencies.now,
				},
				exact_repair_execution: {
					signal: input.signal,
					on_update: undefined,
					execution_context: ctx,
				},
				max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
			}, {
				review: async () => reviewResult,
				confirmParentSettled: async (confirmation) => {
					// This is the final no-side-effect gate immediately before the
					// coordinator is allowed to call the exact successor service.
					const secondGate = checkRuntimeGates(dependencies, ctx, input.signal);
					if (!secondGate.ok) return { ok: false, code: secondGate.code };
					const confirmed = await dependencies.confirmSettled({
						project_root: confirmation.project_root,
						delegation_id: confirmation.delegation_id,
						expected_authority_hash: refreshed.authority_hash,
						expected_bound_diff_hash: confirmation.bound_diff_hash,
						required_lineage_depth: 0,
					});
					if (!confirmed.ok) return confirmed;
					const settled = parseAutomaticDeliveryContinuationSettledAuthorityV1(confirmed.value, refreshed);
					return settled === undefined
						? { ok: false, code: "PARENT_SETTLED_AUTHORITY_INVALID" }
						: {
							ok: true,
							value: {
								schema_version: 1,
								project_root: settled.project_root,
								delegation_id: settled.delegation_id,
								bound_diff_hash: settled.bound_diff_hash,
								parent_lineage_depth: 0,
								authority_confirmed: true,
								no_active_lane: true,
							},
						};
				},
				repair: dependencies.exactRepair,
			});
			return { authority_hash: refreshed.authority_hash, chain };
		},
		processStateSymbol: dependencies.processStateSymbol,
	});

	let preRegistered = false;
	let postRegistered = false;

	return Object.freeze({
		registerToolResultLocatorCaptureBeforeMiddleware() {
			if (preRegistered) throw new Error("automatic continuation pre-middleware listener already registered");
			preRegistered = true;
			dependencies.pi.on("tool_result", (event) => {
				if (event.toolName !== WORKER_TOOL_NAME) return undefined;
				const lease = dependencies.pendingCheckoutOperationHandles.get(event.toolCallId);
				if (lease === undefined || ownDataValue(lease, "operation_kind") !== "delegation") return undefined;
				const delegationId = ownDataValue(lease, "delegation_id");
				if (typeof delegationId !== "string" || !DELEGATION_ID_RE.test(delegationId)) return undefined;
				lifecycle.observeToolExecutionEnd({
					tool_name: WORKER_TOOL_NAME,
					machine_details: { delegation_id: delegationId },
				});
				return undefined;
			});
		},
		registerLifecycleListenersAfterMiddleware() {
			if (postRegistered) throw new Error("automatic continuation post-middleware listeners already registered");
			postRegistered = true;
			dependencies.pi.on("tool_execution_end", (event) => {
				if (event.toolName !== WORKER_TOOL_NAME) return undefined;
				lifecycle.observeToolExecutionEnd({
					tool_name: event.toolName,
					machine_details: ownDataValue(event.result, "details"),
				});
				return undefined;
			});
			dependencies.pi.on("session_start", (event) => {
				if ((AUTOMATIC_DELIVERY_CONTINUATION_RECOVERY_SESSION_REASONS_V1 as readonly string[]).includes(event.reason)) {
					lifecycle.markReloadPending();
				}
				return undefined;
			});
			dependencies.pi.on("before_agent_start", async (_event, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
				const message = boundedMessage(await lifecycle.onBeforeAgentStart({ signal: ctx.signal, runtime_context: ctx }));
				return message === undefined ? undefined : {
					message: {
						customType: AUTOMATIC_DELIVERY_CONTINUATION_MESSAGE_TYPE_V1,
						content: message.content,
						display: false,
						details: message.details,
					},
				};
			});
			dependencies.pi.on("agent_settled", async (_event, ctx) => {
				const result = await lifecycle.onAgentSettled({ signal: ctx.signal, runtime_context: ctx });
				const message = boundedMessage(result);
				if (message === undefined) return undefined;
				const resume = freshlyDeliveredSuccessor(result) !== undefined;
				try {
					dependencies.pi.sendMessage({
						customType: AUTOMATIC_DELIVERY_CONTINUATION_MESSAGE_TYPE_V1,
						content: message.content,
						display: false,
						details: message.details,
					}, { deliverAs: "followUp", triggerTurn: resume });
				} catch {
					// Session mirror delivery is advisory and never changes durable state.
				}
				return undefined;
			});
		},
		hasPendingBeforeAgentContinuation() {
			return lifecycle.hasPendingBeforeAgentContinuation();
		},
	});
}
