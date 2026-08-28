/**
 * UI-free lifecycle scheduling for one bounded automatic delivery continuation.
 *
 * Event data is never authority. `tool_execution_end` contributes only a
 * bounded delegation-id locator. Every decision which can start a successor is
 * rebuilt by the injected durable candidate resolver, reconciler and settled
 * authority reader. Production event registration intentionally lives outside
 * this module so listener ordering can be verified independently.
 */

import { isAbsolute, posix } from "node:path";
import { types as utilTypes } from "node:util";

import {
	DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
	type DeliveryChainCoordinatorResultV1,
} from "./delivery-chain-coordinator.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	delegationLifecycleSnapshotFromAutomaticContinuationCandidateV1,
	resolveDelegationLifecycleV1,
	type DelegationLifecycleResolutionV1,
} from "./delegation-lifecycle-resolver.ts";
import { DELEGATION_TRANSACTION_ID_RE } from "./delegation-transaction.ts";
import {
	COMMANDER_MODEL_ID,
	COMMANDER_PROVIDERS,
	WORKER_TOOL_NAME,
} from "./worker-policy.ts";

export const AUTOMATIC_DELIVERY_CONTINUATION_PROCESS_STATE_SYMBOL_V1 =
	Symbol.for("pi.workbench.automatic-delivery-continuation-lifecycle.v1");

const SHA256_RE = /^[a-f0-9]{64}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const MAX_MACHINE_DETAIL_KEYS = 40;
const MAX_MACHINE_DETAIL_KEY_BYTES = 128;
export const AUTOMATIC_DELIVERY_CONTINUATION_MAX_TOOL_LOCATORS_V1 = 8 as const;

export type AutomaticDeliveryContinuationTriggerV1 = "agent_settled" | "before_agent_start";

export interface AutomaticDeliveryContinuationGateFactsV1 {
	readonly schema_version: 1;
	readonly mode: "DEV";
	readonly trusted: true;
	readonly runtime_current: true;
	readonly commander_provider: "openai" | "openai-codex";
	readonly commander_model: typeof COMMANDER_MODEL_ID;
	readonly aborted: false;
	readonly has_pending_messages: false;
	readonly compaction_pending: false;
}

export type AutomaticDeliveryContinuationGateResultV1 =
	| { readonly ok: true; readonly value: Readonly<AutomaticDeliveryContinuationGateFactsV1> }
	| { readonly ok: false; readonly code: string };

export type AutomaticDeliveryContinuationReconcileResultV1 =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: string };

export interface AutomaticDeliveryContinuationCandidateV1 {
	readonly schema_version: 1;
	readonly project_root: string;
	readonly delegation_id: string;
	/** Hash of the complete strict tip/review-stage/admission authority snapshot. */
	readonly authority_hash: string;
	readonly bound_diff_hash: string;
	/** Exact path grant already admitted by the durable candidate reader. */
	readonly affected_paths: readonly string[];
	readonly lineage_depth: number;
	readonly review_authority: "DURABLE_REPAIR_SIDECAR" | "ELIGIBLE_TERMINAL_NEEDS_REVIEW";
	readonly sidecar_kind: "semantic-repair" | "terminal-negative-repair" | "none";
	readonly durable_decision: "REPAIR" | "NEEDS_REVIEW";
	readonly strict_sidecar: boolean;
	readonly terminal_status: "FAILED" | "INTERRUPTED" | null;
	readonly unique_unresolved_tip: true;
	readonly path_admission: "ALLOW";
	readonly path_admission_authority_hash: string;
}

export type AutomaticDeliveryContinuationCandidateResolutionV1 =
	| {
		readonly status: "CANDIDATE";
		readonly candidate: Readonly<AutomaticDeliveryContinuationCandidateV1>;
	}
	| {
		readonly status: "NOOP";
		readonly code: "NO_CANDIDATE" | "NO_DURABLE_REPAIR_SIDECAR";
	}
	| { readonly status: "DEFER"; readonly code: string }
	| { readonly status: "BLOCKED"; readonly code: string };

export interface AutomaticDeliveryContinuationSettledAuthorityV1 {
	readonly schema_version: 1;
	readonly project_root: string;
	readonly delegation_id: string;
	readonly authority_hash: string;
	readonly bound_diff_hash: string;
	readonly lineage_depth: 0;
	readonly authority_confirmed: true;
	readonly no_active_lane: true;
}

export type AutomaticDeliveryContinuationSettledResultV1 =
	| { readonly ok: true; readonly value: Readonly<AutomaticDeliveryContinuationSettledAuthorityV1> }
	| { readonly ok: false; readonly code: string };

export interface AutomaticDeliveryContinuationHookInputV1 {
	readonly signal?: AbortSignal;
	/** Opaque event context consumed only by the runtime dependency adapter. */
	readonly runtime_context?: unknown;
}

export interface AutomaticDeliveryContinuationResolveInputV1 {
	readonly project_root: string;
	readonly trigger: AutomaticDeliveryContinuationTriggerV1;
	/** Canonical UTF-8 byte-order set; empty only for reload scans. */
	readonly locator_delegation_ids: readonly string[];
	readonly require_unique_unresolved_tip: true;
	readonly require_strict_repair_sidecar: true;
	readonly require_full_path_admission: true;
	/** Only an exact post-tool locator may admit an eligible terminal without a sidecar. */
	readonly allow_exact_terminal_needs_review: boolean;
}

export interface AutomaticDeliveryContinuationRunInputV1 {
	readonly project_root: string;
	readonly trigger: AutomaticDeliveryContinuationTriggerV1;
	readonly candidate: Readonly<AutomaticDeliveryContinuationCandidateV1>;
	readonly settled_authority: Readonly<AutomaticDeliveryContinuationSettledAuthorityV1>;
	readonly lifecycle_resolution: DelegationLifecycleResolutionV1;
	readonly max_successor_attempts: typeof DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1;
	readonly signal?: AbortSignal;
	readonly runtime_context?: unknown;
}

export interface AutomaticDeliveryContinuationRunResultV1 {
	/** Strict post-review authority hash; may differ after NEEDS_REVIEW publishes its sidecar. */
	readonly authority_hash: string;
	readonly chain: DeliveryChainCoordinatorResultV1;
}

export interface AutomaticDeliveryContinuationLifecycleDependenciesV1 {
	/** Must return the realpath/canonical checkout root used by durable readers. */
	readonly canonicalProjectRoot: (input: {
		readonly trigger: AutomaticDeliveryContinuationTriggerV1;
		readonly runtime_context?: unknown;
	}) => Promise<string>;
	/** Runs normal durable reconciliation; it must never borrow a live tool lease. */
	readonly reconcile: (input: {
		readonly project_root: string;
		readonly trigger: AutomaticDeliveryContinuationTriggerV1;
		readonly locator_delegation_ids: readonly string[];
		readonly runtime_context?: unknown;
	}) => Promise<AutomaticDeliveryContinuationReconcileResultV1>;
	/** Supplies closed runtime/trust/mode/model/queue/compaction gate facts. */
	readonly checkGates: (input: {
		readonly project_root: string;
		readonly trigger: AutomaticDeliveryContinuationTriggerV1;
		readonly signal?: AbortSignal;
		readonly runtime_context?: unknown;
	}) => Promise<AutomaticDeliveryContinuationGateResultV1>;
	/**
	 * Performs the full project-authority/path-admission scan. Normally a
	 * CANDIDATE requires an immutable REPAIR sidecar. The sole exception is an
	 * exact `agent_settled` locator for a strictly eligible FAILED/INTERRUPTED
	 * terminal; reload scans must still return NOOP while that sidecar is absent.
	 */
	readonly resolveCandidate: (
		input: AutomaticDeliveryContinuationResolveInputV1,
	) => Promise<AutomaticDeliveryContinuationCandidateResolutionV1>;
	/** Re-reads the candidate authority and proves that no parent lane is live. */
	readonly confirmSettled: (input: {
		readonly project_root: string;
		readonly delegation_id: string;
		readonly expected_authority_hash: string;
		readonly expected_bound_diff_hash: string;
		readonly required_lineage_depth: 0;
	}) => Promise<AutomaticDeliveryContinuationSettledResultV1>;
	/** Bound delivery-chain coordinator. It may perform one child attempt only. */
	readonly runChain: (
		input: AutomaticDeliveryContinuationRunInputV1,
	) => Promise<AutomaticDeliveryContinuationRunResultV1>;
	/** Test-only isolation seam. Production omits this and uses Symbol.for above. */
	readonly processStateSymbol?: symbol;
}

export type AutomaticDeliveryContinuationLocatorResultV1 =
	| { readonly status: "RECORDED"; readonly delegation_id: string }
	| { readonly status: "IGNORED"; readonly code: "NOT_DELEGATE_TOOL" | "INVALID_MACHINE_DETAILS" }
	| { readonly status: "BLOCKED"; readonly code: "TOOL_LOCATOR_OVERFLOW" };

interface LifecycleResultBaseV1 {
	readonly trigger: AutomaticDeliveryContinuationTriggerV1;
}

export type AutomaticDeliveryContinuationLifecycleResultV1 =
	| (LifecycleResultBaseV1 & {
		readonly status: "NOOP";
		readonly code:
			| "NO_TOOL_LOCATOR"
			| "NO_RELOAD_PENDING"
			| "NO_CANDIDATE"
			| "NO_DURABLE_REPAIR_SIDECAR"
			| "LINEAGE_DEPTH_LIMIT"
			| "AUTHORITY_ALREADY_CONTINUED";
		readonly delegation_id?: string;
		readonly authority_hash?: string;
	})
	| (LifecycleResultBaseV1 & {
		readonly status: "DEFER";
		readonly code:
			| "ROOT_UNAVAILABLE"
			| "RECONCILE_FAILED"
			| "GATE_NOT_READY"
			| "ABORTED"
			| "CANDIDATE_NOT_READY"
			| "PARENT_NOT_SETTLED"
			| "CHAIN_FAILED"
			| "ROOT_CONTINUATION_IN_FLIGHT";
		readonly detail_code?: string;
		readonly delegation_id?: string;
	})
	| (LifecycleResultBaseV1 & {
		readonly status: "BLOCKED";
		readonly code:
			| "TOOL_LOCATOR_OVERFLOW"
			| "PROCESS_STATE_INVALID"
			| "RECONCILE_RESULT_INVALID"
			| "GATE_RESULT_INVALID"
			| "CANDIDATE_RESULT_INVALID"
			| "LOCATOR_AUTHORITY_MISMATCH"
			| "CANDIDATE_AUTHORITY_INVALID"
			| "PARENT_SETTLED_AUTHORITY_INVALID"
			| "CHAIN_RESULT_INVALID";
		readonly delegation_id?: string;
	})
	| (LifecycleResultBaseV1 & {
		readonly status: "CHAIN_RESULT";
		readonly delegation_id: string;
		readonly authority_hash: string;
		readonly lifecycle_resolution: DelegationLifecycleResolutionV1;
		readonly chain: DeliveryChainCoordinatorResultV1;
	});

export interface AutomaticDeliveryContinuationLifecycleV1 {
	observeToolExecutionEnd(input: {
		readonly tool_name: unknown;
		readonly machine_details: unknown;
	}): AutomaticDeliveryContinuationLocatorResultV1;
	/** `session_start` uses this only to mark; it must not execute a chain. */
	markReloadPending(): void;
	/** Lets an earlier claim-guard listener suppress contradictory raw-repair advice. */
	hasPendingBeforeAgentContinuation(): boolean;
	onAgentSettled(
		input?: AutomaticDeliveryContinuationHookInputV1,
	): Promise<AutomaticDeliveryContinuationLifecycleResultV1>;
	onBeforeAgentStart(
		input?: AutomaticDeliveryContinuationHookInputV1,
	): Promise<AutomaticDeliveryContinuationLifecycleResultV1>;
}

interface ProcessInFlightV1 {
	readonly locator_delegation_ids: readonly string[];
	readonly promise: Promise<AutomaticDeliveryContinuationLifecycleResultV1>;
}

interface ProcessStateV1 {
	readonly schema_version: 1;
	readonly in_flight_by_root: Map<string, ProcessInFlightV1>;
	readonly last_authority_by_root: Map<string, {
		readonly authority_hash: string;
		readonly session_epoch: number;
	}>;
	session_epoch: number;
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function ownDataValue(value: unknown, field: string): unknown {
	if (!isDataRecord(value)) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function exactDataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
	if (!isDataRecord(value)) return undefined;
	try {
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Object.keys(descriptors).sort();
		const expected = [...fields].sort();
		if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return undefined;
		const record: Record<string, unknown> = Object.create(null);
		for (const field of fields) {
			const descriptor = descriptors[field];
			if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
			record[field] = descriptor.value;
		}
		return record;
	} catch {
		return undefined;
	}
}

function validCode(value: unknown): value is string {
	return typeof value === "string" && CODE_RE.test(value);
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function validCanonicalRoot(value: unknown): value is string {
	return typeof value === "string" && value.length > 1 && value.length <= 4_096 &&
		!value.includes("\0") && isAbsolute(value);
}

function canonicalAffectedPaths(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > 500) return undefined;
	const paths: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0 || entry.length > 400 || entry !== entry.trim() ||
			isAbsolute(entry) || entry.includes("\\") || entry.includes("\0")) return undefined;
		const subtree = entry.endsWith("/**");
		const base = subtree ? entry.slice(0, -3) : entry;
		if (base.length === 0 || posix.normalize(base) !== base || base === "." || base === ".." || base.startsWith("../")) {
			return undefined;
		}
		paths.push(entry);
	}
	return paths.every((path, index) => index === 0 || byteCompare(paths[index - 1]!, path) < 0)
		? Object.freeze(paths)
		: undefined;
}

function strictMachineDelegationId(details: unknown): string | undefined {
	if (!isDataRecord(details)) return undefined;
	try {
		if (Object.getOwnPropertySymbols(details).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(details);
		const names = Object.keys(descriptors);
		if (names.length === 0 || names.length > MAX_MACHINE_DETAIL_KEYS) return undefined;
		for (const name of names) {
			const descriptor = descriptors[name];
			if (Buffer.byteLength(name, "utf8") > MAX_MACHINE_DETAIL_KEY_BYTES ||
				descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
		}
		const delegationId = descriptors.delegation_id?.value;
		return typeof delegationId === "string" && DELEGATION_TRANSACTION_ID_RE.test(delegationId)
			? delegationId
			: undefined;
	} catch {
		return undefined;
	}
}

function validGateFacts(value: unknown): value is AutomaticDeliveryContinuationGateFactsV1 {
	const record = exactDataRecord(value, [
		"schema_version", "mode", "trusted", "runtime_current", "commander_provider",
		"commander_model", "aborted", "has_pending_messages", "compaction_pending",
	]);
	return record !== undefined && record.schema_version === 1 && record.mode === "DEV" &&
		record.trusted === true && record.runtime_current === true &&
		typeof record.commander_provider === "string" && COMMANDER_PROVIDERS.includes(record.commander_provider) &&
		record.commander_model === COMMANDER_MODEL_ID && record.aborted === false &&
		record.has_pending_messages === false && record.compaction_pending === false;
}

export function parseAutomaticDeliveryContinuationCandidateV1(
	value: unknown,
): Readonly<AutomaticDeliveryContinuationCandidateV1> | undefined {
	const record = exactDataRecord(value, [
		"schema_version", "project_root", "delegation_id", "authority_hash", "bound_diff_hash",
		"affected_paths",
		"lineage_depth", "review_authority", "sidecar_kind", "durable_decision", "strict_sidecar", "terminal_status",
		"unique_unresolved_tip", "path_admission", "path_admission_authority_hash",
	]);
	const affectedPaths = record === undefined ? undefined : canonicalAffectedPaths(record.affected_paths);
	if (record === undefined || affectedPaths === undefined || record.schema_version !== 1 || !validCanonicalRoot(record.project_root) ||
		typeof record.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(record.delegation_id) ||
		typeof record.authority_hash !== "string" || !SHA256_RE.test(record.authority_hash) ||
		typeof record.bound_diff_hash !== "string" || !SHA256_RE.test(record.bound_diff_hash) ||
		!Number.isSafeInteger(record.lineage_depth) || (record.lineage_depth as number) < 0 ||
		record.unique_unresolved_tip !== true || record.path_admission !== "ALLOW" ||
		typeof record.path_admission_authority_hash !== "string" ||
		!SHA256_RE.test(record.path_admission_authority_hash)) return undefined;
	const durableRepair = record.review_authority === "DURABLE_REPAIR_SIDECAR" &&
		(record.sidecar_kind === "semantic-repair" || record.sidecar_kind === "terminal-negative-repair") &&
		record.durable_decision === "REPAIR" && record.strict_sidecar === true && record.terminal_status === null;
	const terminalNeedsReview = record.review_authority === "ELIGIBLE_TERMINAL_NEEDS_REVIEW" &&
		record.sidecar_kind === "none" && record.durable_decision === "NEEDS_REVIEW" &&
		record.strict_sidecar === false && (record.terminal_status === "FAILED" || record.terminal_status === "INTERRUPTED");
	if (!durableRepair && !terminalNeedsReview) return undefined;
	return Object.freeze({
		schema_version: 1,
		project_root: record.project_root,
		delegation_id: record.delegation_id,
		authority_hash: record.authority_hash,
		bound_diff_hash: record.bound_diff_hash,
		affected_paths: affectedPaths,
		lineage_depth: record.lineage_depth as number,
		review_authority: record.review_authority as AutomaticDeliveryContinuationCandidateV1["review_authority"],
		sidecar_kind: record.sidecar_kind as AutomaticDeliveryContinuationCandidateV1["sidecar_kind"],
		durable_decision: record.durable_decision as AutomaticDeliveryContinuationCandidateV1["durable_decision"],
		strict_sidecar: record.strict_sidecar as boolean,
		terminal_status: record.terminal_status as AutomaticDeliveryContinuationCandidateV1["terminal_status"],
		unique_unresolved_tip: true,
		path_admission: "ALLOW",
		path_admission_authority_hash: record.path_admission_authority_hash,
	});
}

/**
 * Canonical action adapter shared by the scheduler and the writer-lane CAS.
 * It grants no authority: only a strict candidate accepted by the parser can
 * yield the one matching review or exact-repair action.
 */
export function resolveAutomaticDeliveryContinuationLifecycleActionV1(
	value: unknown,
): DelegationLifecycleResolutionV1 | undefined {
	const candidate = parseAutomaticDeliveryContinuationCandidateV1(value);
	if (candidate === undefined) return undefined;
	const snapshot = delegationLifecycleSnapshotFromAutomaticContinuationCandidateV1({ candidate });
	const resolution = resolveDelegationLifecycleV1(snapshot, {
		schema_version: 1,
		kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
		event: "OBSERVE",
		expected_snapshot_hash: null,
	});
	const expectedAction = candidate.durable_decision === "NEEDS_REVIEW"
		? "REVIEW_CANDIDATE" : "EXECUTE_EXACT_REPAIR";
	return resolution.primary_action.action === expectedAction &&
		resolution.primary_action.safe_automatic && !resolution.primary_action.requires_user_authorization &&
		resolution.primary_action.exact_target.kind === "DELEGATION" &&
		resolution.primary_action.exact_target.id === candidate.delegation_id
		? resolution
		: undefined;
}

export function parseAutomaticDeliveryContinuationSettledAuthorityV1(
	value: unknown,
	candidate: Readonly<AutomaticDeliveryContinuationCandidateV1>,
): Readonly<AutomaticDeliveryContinuationSettledAuthorityV1> | undefined {
	const record = exactDataRecord(value, [
		"schema_version", "project_root", "delegation_id", "authority_hash", "bound_diff_hash",
		"lineage_depth", "authority_confirmed", "no_active_lane",
	]);
	if (record === undefined || record.schema_version !== 1 || record.project_root !== candidate.project_root ||
		record.delegation_id !== candidate.delegation_id || record.authority_hash !== candidate.authority_hash ||
		record.bound_diff_hash !== candidate.bound_diff_hash || record.lineage_depth !== 0 ||
		record.authority_confirmed !== true || record.no_active_lane !== true) return undefined;
	return Object.freeze({
		schema_version: 1,
		project_root: candidate.project_root,
		delegation_id: candidate.delegation_id,
		authority_hash: candidate.authority_hash,
		bound_diff_hash: candidate.bound_diff_hash,
		lineage_depth: 0,
		authority_confirmed: true,
		no_active_lane: true,
	});
}

function validChainResult(
	value: unknown,
	candidate: Readonly<AutomaticDeliveryContinuationCandidateV1>,
): value is DeliveryChainCoordinatorResultV1 {
	if (!isDataRecord(value) || ownDataValue(value, "delegation_id") !== candidate.delegation_id ||
		ownDataValue(value, "max_successor_attempts") !== DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1) return false;
	const status = ownDataValue(value, "status");
	const attempts = ownDataValue(value, "successor_attempts_used");
	if (status === "SUCCESSOR_RECORDED") return attempts === 1;
	if (status === "REPAIR_PENDING") return attempts === 0 || attempts === 1;
	if (status === "REVIEW_RETRYABLE" || status === "AUTHORITY_ERROR") return attempts === 0;
	// ACCEPT is forbidden for an eligible terminal and impossible for a
	// finalized durable REPAIR candidate under the same authority hash.
	return false;
}

function processState(symbol: symbol): ProcessStateV1 | undefined {
	const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
	const existing = host[symbol];
	if (existing === undefined) {
		const created: ProcessStateV1 = {
			schema_version: 1,
			in_flight_by_root: new Map(),
			last_authority_by_root: new Map(),
			session_epoch: 0,
		};
		host[symbol] = created;
		return created;
	}
	if (!isDataRecord(existing) || ownDataValue(existing, "schema_version") !== 1 ||
		!(ownDataValue(existing, "in_flight_by_root") instanceof Map) ||
		!(ownDataValue(existing, "last_authority_by_root") instanceof Map) ||
		!Number.isSafeInteger(ownDataValue(existing, "session_epoch")) ||
		(ownDataValue(existing, "session_epoch") as number) < 0) return undefined;
	return existing as unknown as ProcessStateV1;
}

function detailCode(value: unknown): string | undefined {
	return validCode(value) ? value : undefined;
}

function shouldRetainPending(result: AutomaticDeliveryContinuationLifecycleResultV1): boolean {
	return result.status === "DEFER" ||
		(result.status === "CHAIN_RESULT" &&
			(result.chain.status === "REVIEW_RETRYABLE" ||
				(result.chain.status === "REPAIR_PENDING" && result.chain.successor_attempts_used === 0)));
}

/**
 * Create an unregistered lifecycle controller. Production wiring must install
 * its `agent_settled` listener after the tool-result middleware's settled-lane
 * listener and use `session_start` only to call `markReloadPending()`.
 */
export function createAutomaticDeliveryContinuationLifecycleV1(
	dependencies: AutomaticDeliveryContinuationLifecycleDependenciesV1,
): AutomaticDeliveryContinuationLifecycleV1 {
	const pendingToolLocators = new Set<string>();
	let toolLocatorOverflow = false;
	let reloadPending = false;
	const stateSymbol = dependencies.processStateSymbol ?? AUTOMATIC_DELIVERY_CONTINUATION_PROCESS_STATE_SYMBOL_V1;
	let lifecycleSessionEpoch = processState(stateSymbol)?.session_epoch ?? 0;

	const execute = async (
		trigger: AutomaticDeliveryContinuationTriggerV1,
		locatorDelegationIds: readonly string[],
		input: AutomaticDeliveryContinuationHookInputV1,
	): Promise<AutomaticDeliveryContinuationLifecycleResultV1> => {
		let projectRoot: string;
		try {
			projectRoot = await dependencies.canonicalProjectRoot({
				trigger,
				runtime_context: input.runtime_context,
			});
		} catch {
			return { trigger, status: "DEFER", code: "ROOT_UNAVAILABLE" };
		}
		if (!validCanonicalRoot(projectRoot)) {
			return { trigger, status: "DEFER", code: "ROOT_UNAVAILABLE" };
		}

		const state = processState(stateSymbol);
		if (state === undefined) return { trigger, status: "BLOCKED", code: "PROCESS_STATE_INVALID" };
		const invocationSessionEpoch = lifecycleSessionEpoch;
			const active = state.in_flight_by_root.get(projectRoot);
			if (active !== undefined) {
				// A joiner never inherits the owner's actionable result. Returning
				// the owner promise let two event handlers emit the same continuation
				// follow-up and bypassed the joiner's own queue/compaction gate facts.
				return {
					trigger,
					status: "DEFER",
					code: "ROOT_CONTINUATION_IN_FLIGHT",
				};
			}

		const run = (async (): Promise<AutomaticDeliveryContinuationLifecycleResultV1> => {
			let reconciled: AutomaticDeliveryContinuationReconcileResultV1;
			try {
					reconciled = await dependencies.reconcile({
						project_root: projectRoot,
						trigger,
						locator_delegation_ids: locatorDelegationIds,
						runtime_context: input.runtime_context,
					});
			} catch {
				return { trigger, status: "DEFER", code: "RECONCILE_FAILED" };
			}
			const reconcileRecord = exactDataRecord(reconciled, reconciled.ok ? ["ok"] : ["ok", "code"]);
			if (reconcileRecord === undefined || (reconciled.ok && reconcileRecord.ok !== true) ||
				(!reconciled.ok && (reconcileRecord.ok !== false || !validCode(reconcileRecord.code)))) {
				return { trigger, status: "BLOCKED", code: "RECONCILE_RESULT_INVALID" };
			}
			if (!reconciled.ok) {
				return {
					trigger,
					status: "DEFER",
					code: "RECONCILE_FAILED",
					detail_code: reconciled.code,
				};
			}

			let gates: AutomaticDeliveryContinuationGateResultV1;
			try {
				gates = await dependencies.checkGates({
					project_root: projectRoot,
					trigger,
					signal: input.signal,
					runtime_context: input.runtime_context,
				});
			} catch {
				return { trigger, status: "DEFER", code: "GATE_NOT_READY" };
			}
			const gateRecord = exactDataRecord(gates, gates.ok ? ["ok", "value"] : ["ok", "code"]);
			if (gateRecord === undefined || (gates.ok && !validGateFacts(gates.value)) ||
				(!gates.ok && !validCode(gates.code))) {
				return { trigger, status: "BLOCKED", code: "GATE_RESULT_INVALID" };
			}
			if (!gates.ok) {
				return {
					trigger,
					status: "DEFER",
					code: "GATE_NOT_READY",
					detail_code: gates.code,
				};
			}
			if (input.signal?.aborted === true) return { trigger, status: "DEFER", code: "ABORTED" };

			let resolution: AutomaticDeliveryContinuationCandidateResolutionV1;
			try {
				resolution = await dependencies.resolveCandidate({
					project_root: projectRoot,
					trigger,
					locator_delegation_ids: locatorDelegationIds,
					require_unique_unresolved_tip: true,
					require_strict_repair_sidecar: true,
					require_full_path_admission: true,
					allow_exact_terminal_needs_review: trigger === "agent_settled" && locatorDelegationIds.length > 0,
				});
			} catch {
				return { trigger, status: "DEFER", code: "CANDIDATE_NOT_READY" };
			}
			const resolutionStatus = ownDataValue(resolution, "status");
			if (resolutionStatus === "NOOP") {
				const code = ownDataValue(resolution, "code");
				if (code !== "NO_CANDIDATE" && code !== "NO_DURABLE_REPAIR_SIDECAR") {
					return { trigger, status: "BLOCKED", code: "CANDIDATE_RESULT_INVALID" };
				}
				return { trigger, status: "NOOP", code };
			}
			if (resolutionStatus === "DEFER" || resolutionStatus === "BLOCKED") {
				const code = detailCode(ownDataValue(resolution, "code"));
				if (code === undefined) return { trigger, status: "BLOCKED", code: "CANDIDATE_RESULT_INVALID" };
				return resolutionStatus === "DEFER"
					? { trigger, status: "DEFER", code: "CANDIDATE_NOT_READY", detail_code: code }
					: { trigger, status: "BLOCKED", code: "CANDIDATE_AUTHORITY_INVALID" };
			}
			if (resolutionStatus !== "CANDIDATE") {
				return { trigger, status: "BLOCKED", code: "CANDIDATE_RESULT_INVALID" };
			}
			const candidate = parseAutomaticDeliveryContinuationCandidateV1(ownDataValue(resolution, "candidate"));
			if (candidate === undefined || candidate.project_root !== projectRoot) {
				return { trigger, status: "BLOCKED", code: "CANDIDATE_AUTHORITY_INVALID" };
			}
			if (locatorDelegationIds.length > 0 && !locatorDelegationIds.includes(candidate.delegation_id)) {
				return {
					trigger,
					status: "BLOCKED",
					code: "LOCATOR_AUTHORITY_MISMATCH",
					delegation_id: candidate.delegation_id,
				};
			}
			if (candidate.review_authority === "ELIGIBLE_TERMINAL_NEEDS_REVIEW" &&
				(trigger !== "agent_settled" || locatorDelegationIds.length === 0)) {
				return {
					trigger,
					status: "NOOP",
					code: "NO_DURABLE_REPAIR_SIDECAR",
					delegation_id: candidate.delegation_id,
				};
			}
			if (candidate.lineage_depth >= 1) {
				return {
					trigger,
					status: "NOOP",
					code: "LINEAGE_DEPTH_LIMIT",
					delegation_id: candidate.delegation_id,
					authority_hash: candidate.authority_hash,
				};
			}
			if (candidate.lineage_depth !== 0) {
				return { trigger, status: "BLOCKED", code: "CANDIDATE_AUTHORITY_INVALID" };
			}
			const lifecycleResolution = resolveAutomaticDeliveryContinuationLifecycleActionV1(candidate);
			if (lifecycleResolution === undefined) {
				return { trigger, status: "BLOCKED", code: "CANDIDATE_AUTHORITY_INVALID", delegation_id: candidate.delegation_id };
			}
			const priorAuthority = state.last_authority_by_root.get(projectRoot);
			if (priorAuthority?.session_epoch === invocationSessionEpoch &&
				priorAuthority.authority_hash === candidate.authority_hash) {
				return {
					trigger,
					status: "NOOP",
					code: "AUTHORITY_ALREADY_CONTINUED",
					delegation_id: candidate.delegation_id,
					authority_hash: candidate.authority_hash,
				};
			}

			let confirmed: AutomaticDeliveryContinuationSettledResultV1;
			try {
				confirmed = await dependencies.confirmSettled({
					project_root: projectRoot,
					delegation_id: candidate.delegation_id,
					expected_authority_hash: candidate.authority_hash,
					expected_bound_diff_hash: candidate.bound_diff_hash,
					required_lineage_depth: 0,
				});
			} catch {
				return {
					trigger,
					status: "DEFER",
					code: "PARENT_NOT_SETTLED",
					delegation_id: candidate.delegation_id,
				};
			}
			const confirmRecord = exactDataRecord(confirmed, confirmed.ok ? ["ok", "value"] : ["ok", "code"]);
			if (confirmRecord === undefined || (!confirmed.ok && !validCode(confirmed.code))) {
				return {
					trigger,
					status: "BLOCKED",
					code: "PARENT_SETTLED_AUTHORITY_INVALID",
					delegation_id: candidate.delegation_id,
				};
			}
			if (!confirmed.ok) {
				return {
					trigger,
					status: "DEFER",
					code: "PARENT_NOT_SETTLED",
					detail_code: confirmed.code,
					delegation_id: candidate.delegation_id,
				};
			}
			const settled = parseAutomaticDeliveryContinuationSettledAuthorityV1(confirmed.value, candidate);
			if (settled === undefined) {
				return {
					trigger,
					status: "BLOCKED",
					code: "PARENT_SETTLED_AUTHORITY_INVALID",
					delegation_id: candidate.delegation_id,
				};
			}

			// Record the side-effect attempt before entering the review/repair
			// chain. RETRYABLE, attempts=0 and lost-response outcomes must not
			// hot-loop an expensive nested review in the same session epoch.
			state.last_authority_by_root.set(projectRoot, {
				authority_hash: candidate.authority_hash,
				session_epoch: invocationSessionEpoch,
			});
			let runResult: AutomaticDeliveryContinuationRunResultV1;
			try {
				runResult = await dependencies.runChain({
					project_root: projectRoot,
					trigger,
					candidate,
					settled_authority: settled,
					lifecycle_resolution: lifecycleResolution,
					max_successor_attempts: DELIVERY_CHAIN_MAX_SUCCESSOR_ATTEMPTS_V1,
					signal: input.signal,
					runtime_context: input.runtime_context,
				});
			} catch {
				return {
					trigger,
					status: "DEFER",
					code: "CHAIN_FAILED",
					delegation_id: candidate.delegation_id,
				};
			}
			const runAuthorityHash = ownDataValue(runResult, "authority_hash");
			const chain = ownDataValue(runResult, "chain");
			if (typeof runAuthorityHash !== "string" || !SHA256_RE.test(runAuthorityHash) ||
				!validChainResult(chain, candidate) ||
				(candidate.review_authority === "ELIGIBLE_TERMINAL_NEEDS_REVIEW" &&
					chain.status !== "REVIEW_RETRYABLE" && chain.status !== "AUTHORITY_ERROR" &&
					runAuthorityHash === candidate.authority_hash)) {
				return {
					trigger,
					status: "BLOCKED",
					code: "CHAIN_RESULT_INVALID",
					delegation_id: candidate.delegation_id,
				};
			}
			// NEEDS_REVIEW changes authority when the sidecar is published. Store
			// the strict post-review hash returned by the runtime so the same new
			// authority is also single-attempt within this epoch.
			state.last_authority_by_root.set(projectRoot, {
				authority_hash: runAuthorityHash,
				session_epoch: invocationSessionEpoch,
			});
			return {
				trigger,
				status: "CHAIN_RESULT",
				delegation_id: candidate.delegation_id,
				authority_hash: runAuthorityHash,
				lifecycle_resolution: lifecycleResolution,
				chain,
			};
		})();

		const record: ProcessInFlightV1 = { locator_delegation_ids: locatorDelegationIds, promise: run };
		state.in_flight_by_root.set(projectRoot, record);
		try {
			return await run;
		} finally {
			if (state.in_flight_by_root.get(projectRoot) === record) state.in_flight_by_root.delete(projectRoot);
		}
	};

	const finishToolTrigger = (
		locators: readonly string[],
		result: AutomaticDeliveryContinuationLifecycleResultV1,
	): AutomaticDeliveryContinuationLifecycleResultV1 => {
		if (!shouldRetainPending(result)) {
			for (const locator of locators) pendingToolLocators.delete(locator);
			if (pendingToolLocators.size === 0) toolLocatorOverflow = false;
		}
		return result;
	};

	return {
		observeToolExecutionEnd(input) {
			if (input.tool_name !== WORKER_TOOL_NAME) {
				return { status: "IGNORED", code: "NOT_DELEGATE_TOOL" };
			}
			const delegationId = strictMachineDelegationId(input.machine_details);
			if (delegationId === undefined) {
				return { status: "IGNORED", code: "INVALID_MACHINE_DETAILS" };
			}
			if (!pendingToolLocators.has(delegationId) &&
				pendingToolLocators.size >= AUTOMATIC_DELIVERY_CONTINUATION_MAX_TOOL_LOCATORS_V1) {
				toolLocatorOverflow = true;
				return { status: "BLOCKED", code: "TOOL_LOCATOR_OVERFLOW" };
			}
			pendingToolLocators.add(delegationId);
			return { status: "RECORDED", delegation_id: delegationId };
		},
		markReloadPending() {
			reloadPending = true;
			const state = processState(stateSymbol);
			if (state !== undefined) {
				state.session_epoch = state.session_epoch >= Number.MAX_SAFE_INTEGER ? 1 : state.session_epoch + 1;
				lifecycleSessionEpoch = state.session_epoch;
			}
		},
		hasPendingBeforeAgentContinuation() {
			return reloadPending || toolLocatorOverflow || pendingToolLocators.size > 0;
		},
		async onAgentSettled(input = {}) {
			if (toolLocatorOverflow) {
				// Preserve the bounded locator evidence and overflow marker. Dropping
				// them here would turn a fail-closed ambiguity into a false clean state.
				// A fresh runtime/session may perform its independent durable scan.
				return { trigger: "agent_settled", status: "BLOCKED", code: "TOOL_LOCATOR_OVERFLOW" };
			}
			if (pendingToolLocators.size === 0) {
				return { trigger: "agent_settled", status: "NOOP", code: "NO_TOOL_LOCATOR" };
			}
			const locators = Object.freeze([...pendingToolLocators].sort(byteCompare));
			return finishToolTrigger(locators, await execute("agent_settled", locators, input));
		},
		async onBeforeAgentStart(input = {}) {
			if (!reloadPending) {
				return { trigger: "before_agent_start", status: "NOOP", code: "NO_RELOAD_PENDING" };
			}
			const result = await execute("before_agent_start", Object.freeze([]), input);
			if (!shouldRetainPending(result)) reloadPending = false;
			return result;
		},
	};
}
