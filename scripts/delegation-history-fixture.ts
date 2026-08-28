/**
 * Build privacy-safe replay projections from real Workbench delegation history.
 *
 * The output deliberately excludes committed generation payloads, prompts,
 * acceptance text, worker prose, reports, source bytes, accounts, and secrets.
 * It retains only the machine lifecycle facts consumed by the production path
 * lane classifier. Every project path is mapped segment-by-segment into a
 * synthetic namespace and every derived hash is recomputed after mapping.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	isDelegationEmptyRepairAttemptSupersessionV1,
	readDelegationInactiveBlockerClosureV2,
} from "../extensions/workbench-runtime/core/delegation-authority-closure.ts";
import { readDelegationCleanRepairAbandonmentV1 } from "../extensions/workbench-runtime/core/delegation-repair-abandonment.ts";
import {
	admitProjectDelegationPathLaneV1,
	type DelegationPathLaneAdmissionV1,
} from "../extensions/workbench-runtime/core/delegation-path-lane-admission.ts";
import {
	readProjectDelegationRepairClosureV1,
} from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import {
	hasDelegationSemanticReviewAuthorityV2,
	readDelegationCommittedGenerationV2,
	readDelegationCurrentSemanticRepairDecisionV1,
	readDelegationReviewV2,
	readDelegationSemanticRepairDecisionV1,
	type DelegationSemanticRepairDecisionV1,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	bindDelegationRepairLineageV1,
	delegationCommitMarker,
	DELEGATION_TRANSACTION_ID_RE,
	type DelegationRepairLineageV1,
	type DelegationTransactionRecord,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { readDelegationTransactionV2 } from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";

const FIXTURE_SCHEMA_VERSION = 1 as const;
const FIXTURE_KIND = "delegation-history-replay-fixture-v1" as const;
const SANITIZATION_VERSION = 1 as const;
const FIXED_CONTENT = Buffer.from("pi-workbench-replay-fixture-v1\n", "utf8");
const FIXED_CONTENT_SHA256 = createHash("sha256").update(FIXED_CONTENT).digest("hex");
const PROBE_PATH = "replay-probe/candidate.txt" as const;
const MAX_SESSION_FILES = 64;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;

const FAULT_CODES = [
	"CURRENT_BINDING_CHANGED",
	"DURABLE_REVIEW_INVALID",
	"SEMANTIC_REPAIR_SIDECAR_INVALID",
	"TERMINAL_REPAIR_SIDECAR_INVALID",
	"IMPLEMENTATION_DELTA_REQUIRED",
	"INVALID_COMMITTED_SCOPE",
	"PROJECT_AUTHORITY_CHANGED",
	"repair_lineage_continuation_invalid",
	"IDEMPOTENCY_REFUSED",
	"BLOCKED_RELOAD_REQUIRED",
	"LINEAGE_PRESENTATION_GAP",
	"PRESENTATION_UNAVAILABLE",
	"STALE",
	"WORKSPACE_DRIFT",
] as const;

interface SourceSpec {
	fixtureId: string;
	projectRoot: string;
	sessionDir?: string;
}

interface CliOptions {
	outputRoot: string;
	collectedAt: string;
	sources: SourceSpec[];
}

interface FixtureAuxiliaryFacts {
	inactive_closure: boolean;
	empty_repair_attempt_supersession: boolean;
	repair_abandonment: boolean;
	semantic_review_closure: boolean;
	semantic_repair_sidecar: boolean;
	terminal_negative_repair_sidecar: boolean;
}

interface FixtureImmutablePaths {
	changed_paths: string[];
	carried_paths: string[];
}

interface FixtureTransaction {
	state: DelegationTransactionRecord;
	semantic_repair_decision?: DelegationSemanticRepairDecisionV1;
	auxiliary: FixtureAuxiliaryFacts;
	immutable_paths?: FixtureImmutablePaths;
}

interface SessionFacts {
	file_count: number;
	fault_counts: Record<string, number>;
	runtime_source_hashes: string[];
}

interface ReplayFixture {
	schema_version: typeof FIXTURE_SCHEMA_VERSION;
	kind: typeof FIXTURE_KIND;
	fixture_id: string;
	source_project: string;
	collected_at: string;
	sanitization_version: typeof SANITIZATION_VERSION;
	synthetic_root: string;
	source_fingerprint: string;
	coverage: string[];
	inventory: {
		transaction_count: number;
		root_count: number;
		lineage_count: number;
		max_lineage_depth: number;
		sanitized_path_count: number;
		semantic_repair_sidecars: number;
		terminal_negative_repair_sidecars: number;
		inactive_closures: number;
		empty_attempt_supersessions: number;
		semantic_review_closures: number;
		session_file_count: number;
		fault_counts: Record<string, number>;
		runtime_source_hashes: string[];
	};
	fixed_content: {
		encoding: "base64";
		bytes: string;
		sha256: string;
	};
	expected: {
		probe_path: typeof PROBE_PATH;
		closure: Awaited<ReturnType<typeof readProjectDelegationRepairClosureV1>>;
		ordinary_blocker_ids: string[];
		repair_tip_ids: string[];
		blockers: DelegationPathLaneAdmissionV1["blockers"];
		decision: DelegationPathLaneAdmissionV1["decision"];
	};
	transactions: FixtureTransaction[];
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function byteSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort(byteCompare);
}

function fixedHash(label: unknown): string {
	return canonicalHash({ fixture_hash: label });
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactIsoTime(value: string): boolean {
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function parseAssignment(value: string, flag: string): { key: string; path: string } {
	const separator = value.indexOf("=");
	if (separator <= 0 || separator === value.length - 1) throw new Error(`${flag}_INVALID`);
	const key = value.slice(0, separator);
	const path = resolve(value.slice(separator + 1));
	if (!/^[a-z][a-z0-9-]{1,31}$/u.test(key)) throw new Error(`${flag}_ID_INVALID`);
	return { key, path };
}

function parseArgs(argv: readonly string[]): CliOptions {
	let outputRoot: string | undefined;
	let collectedAt: string | undefined;
	const sourceRoots = new Map<string, string>();
	const sessionDirs = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (value === undefined) throw new Error("ARGUMENT_VALUE_MISSING");
		if (flag === "--output") {
			if (outputRoot !== undefined) throw new Error("OUTPUT_DUPLICATE");
			outputRoot = resolve(value);
		} else if (flag === "--collected-at") {
			if (collectedAt !== undefined || !exactIsoTime(value)) throw new Error("COLLECTED_AT_INVALID");
			collectedAt = value;
		} else if (flag === "--source") {
			const parsed = parseAssignment(value, "SOURCE");
			if (sourceRoots.has(parsed.key)) throw new Error("SOURCE_DUPLICATE");
			sourceRoots.set(parsed.key, parsed.path);
		} else if (flag === "--session-dir") {
			const parsed = parseAssignment(value, "SESSION_DIR");
			if (sessionDirs.has(parsed.key)) throw new Error("SESSION_DIR_DUPLICATE");
			sessionDirs.set(parsed.key, parsed.path);
		} else {
			throw new Error("ARGUMENT_UNKNOWN");
		}
		index += 1;
	}
	if (outputRoot === undefined || collectedAt === undefined || sourceRoots.size === 0) {
		throw new Error("ARGUMENTS_INCOMPLETE");
	}
	for (const key of sessionDirs.keys()) {
		if (!sourceRoots.has(key)) throw new Error("SESSION_SOURCE_MISSING");
	}
	return {
		outputRoot,
		collectedAt,
		sources: [...sourceRoots].sort(([left], [right]) => byteCompare(left, right)).map(([fixtureId, projectRoot]) => ({
			fixtureId,
			projectRoot,
			...(sessionDirs.has(fixtureId) ? { sessionDir: sessionDirs.get(fixtureId)! } : {}),
		})),
	};
}

class SyntheticPathMapper {
	readonly #segments: Map<string, string>;

	constructor(paths: readonly string[]) {
		const segments = byteSorted(paths.flatMap((path) =>
			path.replace(/\/(?:\*\*)?$/u, "").split("/").filter((segment) => segment.length > 0 && segment !== "**")));
		this.#segments = new Map(segments.map((segment, index) => [segment, `s${String(index + 1).padStart(4, "0")}`]));
	}

	map(path: string): string {
		const glob = path.endsWith("/**");
		const trailingSlash = !glob && path.endsWith("/");
		const base = glob ? path.slice(0, -3) : trailingSlash ? path.slice(0, -1) : path;
		const mapped = base.split("/").map((segment) => {
			const token = this.#segments.get(segment);
			if (token === undefined) throw new Error("PATH_MAPPING_MISSING");
			return token;
		}).join("/");
		return glob ? `${mapped}/**` : trailingSlash ? `${mapped}/` : mapped;
	}

	mapList(paths: readonly string[]): string[] {
		return byteSorted(paths.map((path) => this.map(path)));
	}

	get size(): number {
		return this.#segments.size;
	}
}

function pathsFromState(state: DelegationTransactionRecord): string[] {
	return [
		...state.allowed_paths,
		...(state.terminal_outcome?.changed_paths ?? []),
		...(state.repair_lineage?.carried_paths ?? []),
	];
}

function sanitizeTransactionBase(
	state: DelegationTransactionRecord,
	fixtureId: string,
	paths: SyntheticPathMapper,
): DelegationTransactionRecord {
	const workerIdentity = {
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		worker_id: `fixture-${fixtureId}`,
	};
	const contractHash = fixedHash([fixtureId, state.delegation_id, "contract"]);
	const terminalOutcome = state.terminal_outcome === null ? null : {
		...state.terminal_outcome,
		worker_identity: workerIdentity,
		changed_paths: paths.mapList(state.terminal_outcome.changed_paths),
		delta_hash: state.terminal_outcome.delta_hash === null
			? null
			: fixedHash([fixtureId, state.delegation_id, "delta"]),
	};
	const committedProofWithoutMarker = state.committed_proof === null ? null : {
		...state.committed_proof,
		contract_hash: contractHash,
		worker_identity: workerIdentity,
		content_hash: fixedHash([fixtureId, state.delegation_id, "committed-content"]),
	};
	const committedProof = committedProofWithoutMarker === null ? null : {
		...committedProofWithoutMarker,
		commit_marker: delegationCommitMarker(committedProofWithoutMarker),
	};
	return {
		...state,
		contract_hash: contractHash,
		allowed_paths: paths.mapList(state.allowed_paths),
		worker_identity: workerIdentity,
		terminal_outcome: terminalOutcome,
		committed_proof: committedProof,
		review: state.review === null ? null : {
			...state.review,
			review_hash: fixedHash([fixtureId, state.delegation_id, "review"]),
		},
		abort_reason: state.abort_reason === null ? null : "fixture-abort",
		recovery_reason: state.recovery_reason === null ? null : "fixture-recovery",
		repair_lineage: undefined,
	};
}

function sanitizeDecision(
	decision: DelegationSemanticRepairDecisionV1,
	state: DelegationTransactionRecord,
	fixtureId: string,
): DelegationSemanticRepairDecisionV1 {
	const repairReason = "fixture repair required";
	const projection = {
		...decision,
		contract_hash: state.contract_hash,
		generation_content_hash: state.committed_proof?.content_hash ?? fixedHash([fixtureId, state.delegation_id, "uncommitted"]),
		base_review_hash: fixedHash([fixtureId, state.delegation_id, "base-review"]),
		expected_bound_diff_hash: fixedHash([fixtureId, state.delegation_id, "bound-diff"]),
		repair_reason: repairReason,
		repair_reason_hash: sha256(repairReason),
		reviewer: { provider: "openai", model: "gpt-5.6-sol" } as const,
	};
	const { decision_hash: _ignored, ...withoutHash } = projection;
	return { ...withoutHash, decision_hash: canonicalHash(withoutHash) };
}

function sanitizeLineages(input: {
	fixtureId: string;
	originals: ReadonlyMap<string, DelegationTransactionRecord>;
	states: Map<string, DelegationTransactionRecord>;
	decisions: ReadonlyMap<string, DelegationSemanticRepairDecisionV1>;
	auxiliary: ReadonlyMap<string, FixtureAuxiliaryFacts>;
	paths: SyntheticPathMapper;
}): void {
	const lineaged = [...input.originals.values()]
		.filter((state) => state.repair_lineage !== undefined)
		.sort((left, right) => left.repair_lineage!.depth - right.repair_lineage!.depth ||
			byteCompare(left.delegation_id, right.delegation_id));
	for (const original of lineaged) {
		const lineage = original.repair_lineage!;
		const superseded = input.auxiliary.get(original.delegation_id)?.empty_repair_attempt_supersession === true;
		const parentLineage = input.states.get(lineage.repair_of)?.repair_lineage;
		const supersededDecisionHash = fixedHash([input.fixtureId, original.delegation_id, "superseded-decision"]);
		const rootDecisionHash = superseded
			? supersededDecisionHash
			: input.decisions.get(lineage.root_delegation_id)?.decision_hash;
		const continuationDecisionHash = superseded
			? supersededDecisionHash
			: input.decisions.get(lineage.continuation_decision_delegation_id)?.decision_hash;
		if (rootDecisionHash === undefined || continuationDecisionHash === undefined) {
			throw new Error("LINEAGE_DECISION_MISSING");
		}
		const rebound = bindDelegationRepairLineageV1({
			schema_version: lineage.schema_version,
			kind: lineage.kind,
			root_delegation_id: lineage.root_delegation_id,
			repair_of: lineage.repair_of,
			root_decision_hash: rootDecisionHash,
			continuation_decision_delegation_id: lineage.continuation_decision_delegation_id,
			continuation_decision_hash: continuationDecisionHash,
			parent_lineage_hash: lineage.depth === 1
				? null
				: superseded
					? fixedHash([input.fixtureId, original.delegation_id, "superseded-parent-lineage"])
					: parentLineage?.lineage_hash ?? null,
			depth: lineage.depth,
			carried_paths: input.paths.mapList(lineage.carried_paths),
		});
		if (rebound === undefined) {
			throw new Error(`LINEAGE_REBIND_FAILED:${original.delegation_id}:depth-${lineage.depth}`);
		}
		const state = input.states.get(original.delegation_id);
		if (state === undefined) throw new Error("LINEAGE_STATE_MISSING");
		input.states.set(original.delegation_id, { ...state, repair_lineage: rebound });
	}
}

function collectStrings(value: unknown, output: string[]): void {
	if (typeof value === "string") output.push(value);
	else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
	else if (value !== null && typeof value === "object") {
		Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, output));
	}
}

async function collectSessionFacts(sessionDir: string | undefined): Promise<SessionFacts> {
	const faultCounts = Object.fromEntries(FAULT_CODES.map((code) => [code, 0])) as Record<string, number>;
	if (sessionDir === undefined) return { file_count: 0, fault_counts: faultCounts, runtime_source_hashes: [] };
	const entries = (await readdir(sessionDir, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.sort((left, right) => byteCompare(left.name, right.name));
	if (entries.length > MAX_SESSION_FILES) throw new Error("SESSION_FILE_LIMIT");
	const runtimeHashes: string[] = [];
	for (const entry of entries) {
		const path = join(sessionDir, entry.name);
		const metadata = await stat(path);
		if (!metadata.isFile() || metadata.size > MAX_SESSION_BYTES) throw new Error("SESSION_FILE_INVALID");
		for (const line of (await readFile(path, "utf8")).split("\n")) {
			if (line.length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const strings: string[] = [];
			collectStrings(parsed, strings);
			const joined = strings.join("\n");
			for (const code of FAULT_CODES) {
				const matches = joined.match(new RegExp(`(?:^|[^A-Za-z0-9_])${code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$|[^A-Za-z0-9_])`, "gu"));
				faultCounts[code] += matches?.length ?? 0;
			}
			for (const value of strings) {
				const matches = value.match(/sha256:[a-f0-9]{64}/gu) ?? [];
				for (const hash of matches) {
					if (value.includes("extension source") || value.includes("extension_source_hash")) {
						if (runtimeHashes.at(-1) !== hash) runtimeHashes.push(hash);
					}
				}
			}
		}
	}
	return { file_count: entries.length, fault_counts: faultCounts, runtime_source_hashes: runtimeHashes };
}

function coverageFor(input: {
	transactions: readonly FixtureTransaction[];
	rootCount: number;
	maxDepth: number;
	session: SessionFacts;
}): string[] {
	const coverage = new Set<string>();
	if (input.rootCount > 1) coverage.add("multiple-repair-roots");
	if (input.maxDepth > 5) coverage.add("deep-lineage");
	if (input.transactions.some((entry) => entry.auxiliary.empty_repair_attempt_supersession)) coverage.add("zero-delta-supersession");
	if (input.transactions.some((entry) => entry.auxiliary.terminal_negative_repair_sidecar)) coverage.add("terminal-negative-sidecar");
	if (input.transactions.some((entry) => entry.state.repair_lineage !== undefined && entry.auxiliary.semantic_review_closure)) {
		coverage.add("accepted-successor-closure");
	}
	if (input.transactions.some((entry) => entry.state.terminal_outcome?.worker_failure_code === "COMMAND_EFFECT_RUN_FAILED" &&
		entry.state.terminal_outcome.change_set_status === "WORKSPACE_DRIFT")) {
		coverage.add("command-outcome-vs-mutation-attribution");
	}
	const faultCoverage: Readonly<Record<string, string>> = {
		CURRENT_BINDING_CHANGED: "current-binding-changed",
		DURABLE_REVIEW_INVALID: "readable-invalid-derived-review",
		IMPLEMENTATION_DELTA_REQUIRED: "implementation-delta-required",
		INVALID_COMMITTED_SCOPE: "invalid-committed-scope",
		repair_lineage_continuation_invalid: "lineage-continuation-invalid",
		IDEMPOTENCY_REFUSED: "idempotency-refused",
		LINEAGE_PRESENTATION_GAP: "lineage-presentation-gap",
		PRESENTATION_UNAVAILABLE: "presentation-unavailable",
		STALE: "runtime-identity-stale",
	};
	for (const [code, label] of Object.entries(faultCoverage)) {
		if ((input.session.fault_counts[code] ?? 0) > 0) coverage.add(label);
	}
	return [...coverage].sort(byteCompare);
}

async function captureSource(spec: SourceSpec, collectedAt: string): Promise<ReplayFixture> {
	const delegationRoot = join(spec.projectRoot, ".pi", "workbench", "delegations");
	const ids = (await readdir(delegationRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && DELEGATION_TRANSACTION_ID_RE.test(entry.name))
		.map((entry) => entry.name)
		.sort(byteCompare);
	const originals = new Map<string, DelegationTransactionRecord>();
	for (const id of ids) {
		const read = await readDelegationTransactionV2(spec.projectRoot, id);
		if (!read.ok || read.value.delegation_id !== id) throw new Error("TRANSACTION_READ_FAILED");
		originals.set(id, read.value);
	}
	const sourceAdmission = await admitProjectDelegationPathLaneV1({
		project_root: spec.projectRoot,
		allowed_paths: [PROBE_PATH],
	});
	const sourceClosure = await readProjectDelegationRepairClosureV1(spec.projectRoot);
	if (!sourceClosure.ok) throw new Error("SOURCE_CLOSURE_INVALID");
	const allPaths = [
		...([...originals.values()].flatMap(pathsFromState)),
		...sourceAdmission.blockers.flatMap((blocker) => blocker.kind === "known"
			? [...blocker.changed_paths, ...blocker.carried_paths]
			: []),
	];
	const paths = new SyntheticPathMapper(allPaths);
	const states = new Map([...originals].map(([id, state]) => [id, sanitizeTransactionBase(state, spec.fixtureId, paths)]));
	const originalDecisions = new Map<string, DelegationSemanticRepairDecisionV1>();
	for (const state of originals.values()) {
		if (state.status === "PENDING_REVIEW") {
			const read = await readDelegationSemanticRepairDecisionV1(spec.projectRoot, state.delegation_id);
			if (!read.ok) throw new Error("SEMANTIC_DECISION_READ_FAILED");
			if (read.value !== undefined) originalDecisions.set(state.delegation_id, read.value);
		} else if (state.status === "FAILED" || state.status === "INTERRUPTED") {
			const committed = await readDelegationCommittedGenerationV2(spec.projectRoot, state.delegation_id);
			if (!committed.ok) throw new Error("COMMITTED_READ_FAILED");
			const read = await readDelegationCurrentSemanticRepairDecisionV1(spec.projectRoot, committed.value);
			if (!read.ok) throw new Error("TERMINAL_DECISION_READ_FAILED");
			if (read.value !== undefined) originalDecisions.set(state.delegation_id, read.value);
		}
	}
	const decisions = new Map([...originalDecisions].map(([id, decision]) => {
		const state = states.get(id);
		if (state === undefined) throw new Error("DECISION_STATE_MISSING");
		return [id, sanitizeDecision(decision, state, spec.fixtureId)];
	}));
	const auxiliary = new Map<string, FixtureAuxiliaryFacts>();
	for (const state of originals.values()) {
		const inactive = await readDelegationInactiveBlockerClosureV2(spec.projectRoot, state);
		if (!inactive.ok) throw new Error("INACTIVE_CLOSURE_READ_FAILED");
		const emptySupersession = inactive.value !== undefined &&
			isDelegationEmptyRepairAttemptSupersessionV1(state, inactive.value);
		let semanticReviewClosure = false;
		if (state.status === "REVIEWED") {
			const review = await readDelegationReviewV2(spec.projectRoot, state.delegation_id);
			if (!review.ok) throw new Error("SEMANTIC_REVIEW_READ_FAILED");
			semanticReviewClosure = review.value.finalized && hasDelegationSemanticReviewAuthorityV2(review.value);
		}
		let repairAbandonment = false;
		const rootId = state.repair_lineage?.root_delegation_id ?? state.delegation_id;
		const rootDecision = originalDecisions.get(rootId);
		if (rootDecision !== undefined) {
			const abandonment = await readDelegationCleanRepairAbandonmentV1(spec.projectRoot, state, rootDecision);
			if (!abandonment.ok) throw new Error("REPAIR_ABANDONMENT_READ_FAILED");
			repairAbandonment = abandonment.value !== undefined;
		}
		auxiliary.set(state.delegation_id, {
			inactive_closure: inactive.value !== undefined,
			empty_repair_attempt_supersession: emptySupersession,
			repair_abandonment: repairAbandonment,
			semantic_review_closure: semanticReviewClosure,
			semantic_repair_sidecar: state.status === "PENDING_REVIEW" && originalDecisions.has(state.delegation_id),
			terminal_negative_repair_sidecar:
				(state.status === "FAILED" || state.status === "INTERRUPTED") && originalDecisions.has(state.delegation_id),
		});
	}
	sanitizeLineages({ fixtureId: spec.fixtureId, originals, states, decisions, auxiliary, paths });
	const blockerPaths = new Map(sourceAdmission.blockers.map((blocker) => [blocker.delegation_id, blocker]));
	const transactions: FixtureTransaction[] = ids.map((id) => {
		const state = states.get(id);
		const facts = auxiliary.get(id);
		if (state === undefined || facts === undefined) throw new Error("FIXTURE_TRANSACTION_MISSING");
		const blocker = blockerPaths.get(id);
		return {
			state,
			...(decisions.has(id) ? { semantic_repair_decision: decisions.get(id)! } : {}),
			auxiliary: facts,
			...(blocker?.kind === "known" ? {
				immutable_paths: {
					changed_paths: paths.mapList(blocker.changed_paths),
					carried_paths: paths.mapList(blocker.carried_paths),
				},
			} : {}),
		};
	});
	const session = await collectSessionFacts(spec.sessionDir);
	const maxDepth = transactions.reduce((maximum, entry) =>
		Math.max(maximum, entry.state.repair_lineage?.depth ?? 0), 0);
	const sanitizedBlockers = sourceAdmission.blockers.map((blocker) => blocker.kind === "known"
		? {
			...blocker,
			changed_paths: paths.mapList(blocker.changed_paths),
			carried_paths: paths.mapList(blocker.carried_paths),
		}
		: blocker);
	const sanitizedDecision = {
		...sourceAdmission.decision,
		normalized_allowed_paths: [PROBE_PATH],
		conflicts: sourceAdmission.decision.conflicts.map((conflict) => ({
			...conflict,
			requested_path: conflict.requested_path === PROBE_PATH ? PROBE_PATH : paths.map(conflict.requested_path),
			blocking_path: paths.map(conflict.blocking_path),
		})),
		maintenance_warnings: sourceAdmission.decision.maintenance_warnings.map((warning) => ({
			...warning,
			relevant_paths: paths.mapList(warning.relevant_paths),
		})),
	};
	return {
		schema_version: FIXTURE_SCHEMA_VERSION,
		kind: FIXTURE_KIND,
		fixture_id: spec.fixtureId,
		source_project: basename(spec.projectRoot),
		collected_at: collectedAt,
		sanitization_version: SANITIZATION_VERSION,
		synthetic_root: `/fixture/${spec.fixtureId}`,
		source_fingerprint: canonicalHash({
			transactions: [...originals.values()].map((state) => canonicalHash(state)),
			authority_hash: sourceAdmission.authority_hash,
		}),
		coverage: coverageFor({ transactions, rootCount: sourceClosure.rootCount, maxDepth, session }),
		inventory: {
			transaction_count: transactions.length,
			root_count: sourceClosure.rootCount,
			lineage_count: sourceClosure.lineageCount,
			max_lineage_depth: maxDepth,
			sanitized_path_count: paths.size,
			semantic_repair_sidecars: transactions.filter((entry) => entry.auxiliary.semantic_repair_sidecar).length,
			terminal_negative_repair_sidecars: transactions.filter((entry) => entry.auxiliary.terminal_negative_repair_sidecar).length,
			inactive_closures: transactions.filter((entry) => entry.auxiliary.inactive_closure).length,
			empty_attempt_supersessions: transactions.filter((entry) => entry.auxiliary.empty_repair_attempt_supersession).length,
			semantic_review_closures: transactions.filter((entry) => entry.auxiliary.semantic_review_closure).length,
			session_file_count: session.file_count,
			fault_counts: session.fault_counts,
			runtime_source_hashes: session.runtime_source_hashes,
		},
		fixed_content: {
			encoding: "base64",
			bytes: FIXED_CONTENT.toString("base64"),
			sha256: FIXED_CONTENT_SHA256,
		},
		expected: {
			probe_path: PROBE_PATH,
			closure: sourceClosure,
			ordinary_blocker_ids: [...sourceAdmission.ordinary_blocker_ids],
			repair_tip_ids: [...sourceAdmission.repair_tip_ids],
			blockers: sanitizedBlockers,
			decision: sanitizedDecision,
		},
		transactions,
	};
}

async function main(argv: readonly string[]): Promise<void> {
	const options = parseArgs(argv);
	// Complete every read/sanitize/rebind pass before creating the destination.
	// A bad source snapshot must never leave a plausible partial fixture set.
	const fixtures: Array<{ source: SourceSpec; fixture: ReplayFixture }> = [];
	for (const source of options.sources) {
		fixtures.push({ source, fixture: await captureSource(source, options.collectedAt) });
	}
	await mkdir(options.outputRoot, { recursive: false });
	for (const { source, fixture } of fixtures) {
		const directory = join(options.outputRoot, source.fixtureId);
		await mkdir(directory, { recursive: false });
		await writeFile(join(directory, "history.json"), `${JSON.stringify(fixture, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o644,
		});
	}
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		const code = error instanceof Error ? error.message : "UNKNOWN";
		process.stderr.write(`delegation-history-fixture: ${code}\n`);
		process.exitCode = 1;
	});
}
