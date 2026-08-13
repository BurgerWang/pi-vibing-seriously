import {
	COMMANDER_TURN_MAX_BYTES,
	MAX_TOOL_CALLS_PER_TURN,
	WORKER_TURN_MAX_BYTES,
	resolveToolOutputPolicy,
	type OutputPolicyId,
	type ToolOutputPolicy,
} from "./output-policy.ts";

export type TurnRole = "commander" | "worker" | "other";
export type TurnBudgetBlockCode = "turn_call_limit" | "turn_output_budget";
export type OutputReservationStatus = "reserved" | "blocked" | "consumed" | "released";

export interface TurnToolCall {
	toolCallId: string;
	toolName: string;
	args?: unknown;
}

export interface OutputReservation {
	toolCallId: string;
	toolName: string;
	policyId: OutputPolicyId;
	desiredBytes: number;
	minimumBytes: number;
	allocatedBytes: number;
	controlAllocatedBytes: number;
	sourceOrdinal: number;
	status: OutputReservationStatus;
	blockCode?: TurnBudgetBlockCode;
}

export interface TurnBudgetPlan {
	schema: "workbench-turn-output-v1";
	turnSerial: number;
	role: TurnRole;
	maxBytes: number;
	reservations: ReadonlyArray<Readonly<OutputReservation>>;
	/** Executable reservations plus blocked-control reservations. */
	reservedBytes: number;
	/** Explicit alias used by invariants and telemetry. */
	totalReservedBytes: number;
	consumedBytes: number;
	controlConsumedBytes: number;
}

export interface PlanTurnOutputBudgetInput {
	turnSerial: unknown;
	role: unknown;
	calls: unknown;
	maxCalls?: unknown;
	maxBytes?: unknown;
}

export interface StartTurnOutputBudgetInput {
	turnSerial: unknown;
	role: unknown;
}

export interface TurnAuthorizationInput {
	toolCallId: unknown;
	toolName: unknown;
	args?: unknown;
}

export interface TurnOutputAuthorization {
	authorizationId?: string;
	toolCallId: string;
	toolName: string;
	policyId: OutputPolicyId;
	sourceOrdinal?: number;
	planned: boolean;
	allowed: boolean;
	allocatedBytes: number;
	controlAllocatedBytes: number;
	blockCode?: TurnBudgetBlockCode;
	controlText?: string;
}

export interface ResultAccountingInput {
	authorizationId: unknown;
	actualBytes: unknown;
}

export interface ResultAccounting {
	accepted: boolean;
	allowedBytes: number;
	accountedBytes: number;
	truncated: boolean;
	control: boolean;
}

export interface TurnBudgetTelemetry {
	schema: "workbench-turn-output-telemetry-v1";
	turnSerial: number;
	role: TurnRole;
	planned: boolean;
	maxBytes: number;
	reservationCount: number;
	blockedCalls: number;
	consumedCalls: number;
	releasedCalls: number;
	reservedBytes: number;
	consumedBytes: number;
	controlConsumedBytes: number;
	totalAccountedBytes: number;
	releasedBytes: number;
	unusedBytes: number;
}

export const DEFENSIVE_DYNAMIC_RESERVATION_BYTES = 2_048 as const;
export const TURN_CALL_LIMIT_CONTROL_TEXT = "[workbench-output blocked code=turn_call_limit]" as const;
export const TURN_OUTPUT_BUDGET_CONTROL_TEXT = "[workbench-output blocked code=turn_output_budget]" as const;
export const MAX_BLOCK_CONTROL_BYTES = 512 as const;

// A malicious sparse array must not make a pure planning pass unbounded. If
// this guard is exceeded, every represented call fails closed and any later
// runtime call has no matching authorization.
const MAX_INPUT_CALL_RECORDS = 2_048;
const MAX_CALL_KEY_CODE_UNITS = 512;

const POLICY_IDS = new Set<OutputPolicyId>([
	"native-read-page",
	"native-search",
	"run-summary",
	"run-log-page",
	"gate-summary",
	"gate-read",
	"diff-review",
	"compare",
	"worker-handoff",
	"recovery",
	"default",
]);

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function normalizeRole(value: unknown): TurnRole {
	return value === "commander" || value === "worker" ? value : "other";
}

function roleCap(role: TurnRole): number {
	return role === "commander" ? COMMANDER_TURN_MAX_BYTES : WORKER_TURN_MAX_BYTES;
}

function normalizeSerial(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeOptionalLowerCap(value: unknown, fallback: number, ceiling: number, readable: boolean): number {
	// Only an actually omitted option inherits the role/default hard cap. An
	// unreadable or explicitly invalid option is untrusted input and must not
	// amplify into that default.
	if (!readable) return 0;
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	const floored = Math.floor(value);
	return floored >= 1 ? Math.min(floored, ceiling) : 0;
}

function safeProperty(value: unknown, key: string): { ok: boolean; value?: unknown } {
	try {
		if (typeof value !== "object" || value === null) return { ok: false };
		return { ok: true, value: (value as Record<string, unknown>)[key] };
	} catch {
		return { ok: false };
	}
}

function boundedCallKey(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_CALL_KEY_CODE_UNITS ? value : undefined;
}

interface NormalizedCall {
	toolCallId: string;
	toolName: string;
	args: unknown;
	valid: boolean;
	sourceOrdinal: number;
}

function normalizeCall(value: unknown, sourceOrdinal: number): NormalizedCall {
	const callId = safeProperty(value, "toolCallId");
	const fallbackId = callId.ok && callId.value === undefined ? safeProperty(value, "id") : { ok: true, value: undefined };
	const callName = safeProperty(value, "toolName");
	const fallbackName = callName.ok && callName.value === undefined ? safeProperty(value, "name") : { ok: true, value: undefined };
	const callArgs = safeProperty(value, "args");
	const fallbackArgs = callArgs.ok && callArgs.value === undefined ? safeProperty(value, "arguments") : { ok: true, value: undefined };
	const id = boundedCallKey(callId.value ?? fallbackId.value);
	const name = boundedCallKey(callName.value ?? fallbackName.value);
	const valid = callId.ok && fallbackId.ok && callName.ok && fallbackName.ok && callArgs.ok && fallbackArgs.ok && id !== undefined && name !== undefined;
	return {
		toolCallId: id ?? "",
		toolName: name ?? "",
		args: callArgs.value ?? fallbackArgs.value,
		valid,
		sourceOrdinal,
	};
}

function normalizeCalls(value: unknown): { calls: NormalizedCall[]; oversized: boolean } {
	try {
		if (!Array.isArray(value)) return { calls: [], oversized: value !== undefined && value !== null };
		const length = value.length;
		if (!Number.isSafeInteger(length) || length < 0) return { calls: [], oversized: true };
		const count = Math.min(length, MAX_INPUT_CALL_RECORDS);
		const calls: NormalizedCall[] = [];
		for (let ordinal = 0; ordinal < count; ordinal += 1) {
			let item: unknown;
			try { item = value[ordinal]; }
			catch { item = undefined; }
			calls.push(normalizeCall(item, ordinal));
		}
		return { calls, oversized: length > MAX_INPUT_CALL_RECORDS };
	} catch {
		return { calls: [], oversized: true };
	}
}

function safePolicy(call: NormalizedCall, role: TurnRole): ToolOutputPolicy {
	try {
		return resolveToolOutputPolicy({ toolName: call.toolName, args: call.args, role });
	} catch {
		return resolveToolOutputPolicy({ toolName: "", args: undefined, role });
	}
}

export function blockedControlText(code: TurnBudgetBlockCode): string {
	return code === "turn_call_limit" ? TURN_CALL_LIMIT_CONTROL_TEXT : TURN_OUTPUT_BUDGET_CONTROL_TEXT;
}

function controlBytes(code: TurnBudgetBlockCode): number {
	const size = utf8Bytes(blockedControlText(code));
	return size < MAX_BLOCK_CONTROL_BYTES ? size : 0;
}

function freezeReservation(value: OutputReservation): Readonly<OutputReservation> {
	return Object.freeze({ ...value });
}

function freezePlan(value: Omit<TurnBudgetPlan, "reservations"> & { reservations: OutputReservation[] }): TurnBudgetPlan {
	const reservations = Object.freeze(value.reservations.map(freezeReservation));
	return Object.freeze({ ...value, reservations });
}

/**
 * Deterministically reserve a complete assistant tool batch before any tool
 * starts. Block-control output is part of the same hard batch cap.
 */
export function planTurnOutputBudget(input: PlanTurnOutputBudgetInput): TurnBudgetPlan {
	const roleRead = safeProperty(input, "role");
	const serialRead = safeProperty(input, "turnSerial");
	const callsRead = safeProperty(input, "calls");
	const maxCallsRead = safeProperty(input, "maxCalls");
	const maxBytesRead = safeProperty(input, "maxBytes");
	const topLevelReadable = roleRead.ok && serialRead.ok && callsRead.ok && maxCallsRead.ok && maxBytesRead.ok;
	const rawRole = topLevelReadable ? roleRead.value : "other";
	const rawSerial = topLevelReadable ? serialRead.value : 0;
	const rawCalls = topLevelReadable ? callsRead.value : undefined;
	const rawMaxCalls = topLevelReadable ? maxCallsRead.value : undefined;
	const rawMaxBytes = topLevelReadable ? maxBytesRead.value : undefined;
	const role = normalizeRole(rawRole);
	const hardCap = roleCap(role);
	const maxBytes = safeOptionalLowerCap(rawMaxBytes, hardCap, hardCap, topLevelReadable);
	const maxCalls = safeOptionalLowerCap(rawMaxCalls, MAX_TOOL_CALLS_PER_TURN, MAX_TOOL_CALLS_PER_TURN, topLevelReadable);
	const normalized = normalizeCalls(rawCalls);
	const duplicateCounts = new Map<string, number>();
	for (const call of normalized.calls) {
		if (call.valid) duplicateCounts.set(call.toolCallId, (duplicateCounts.get(call.toolCallId) ?? 0) + 1);
	}

	const reservations: OutputReservation[] = normalized.calls.map((call) => {
		const policy = safePolicy(call, role);
		const safeDesired = Number.isFinite(policy.maxTextBytes) && policy.maxTextBytes > 0
			? Math.floor(policy.maxTextBytes)
			: 0;
		const rawMinimum = Number.isFinite(policy.minReservationBytes) && policy.minReservationBytes > 0
			? Math.floor(policy.minReservationBytes)
			: 0;
		const minimumBytes = Math.min(rawMinimum, safeDesired);
		let blockCode: TurnBudgetBlockCode | undefined;
		if (call.sourceOrdinal >= maxCalls) blockCode = "turn_call_limit";
		else if (normalized.oversized || !call.valid || (duplicateCounts.get(call.toolCallId) ?? 0) > 1) blockCode = "turn_output_budget";
		return {
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			policyId: policy.id,
			desiredBytes: safeDesired,
			minimumBytes,
			allocatedBytes: 0,
			controlAllocatedBytes: 0,
			sourceOrdinal: call.sourceOrdinal,
			status: blockCode ? "blocked" : "reserved",
			...(blockCode ? { blockCode } : {}),
		};
	});

	let remaining = maxBytes;
	let executablePrefixOpen = true;
	let controlPrefixOpen = true;
	for (const reservation of reservations) {
		if (reservation.status === "reserved") {
			if (executablePrefixOpen && reservation.minimumBytes > 0 && remaining >= reservation.minimumBytes) {
				reservation.allocatedBytes = reservation.minimumBytes;
				remaining -= reservation.minimumBytes;
				continue;
			}
			executablePrefixOpen = false;
			reservation.status = "blocked";
			reservation.blockCode = "turn_output_budget";
		}
		const needed = controlBytes(reservation.blockCode ?? "turn_output_budget");
		if (controlPrefixOpen && needed > 0 && remaining >= needed) {
			reservation.controlAllocatedBytes = needed;
			remaining -= needed;
		} else {
			controlPrefixOpen = false;
		}
	}

	const executable = reservations.filter((reservation) => reservation.status === "reserved");
	const totalExtraNeed = executable.reduce(
		(sum, reservation) => sum + Math.max(0, reservation.desiredBytes - reservation.minimumBytes),
		0,
	);
	const distributable = Math.min(remaining, totalExtraNeed);
	let distributed = 0;
	if (distributable > 0 && totalExtraNeed > 0) {
		for (const reservation of executable) {
			const need = Math.max(0, reservation.desiredBytes - reservation.minimumBytes);
			const share = Math.floor((distributable * need) / totalExtraNeed);
			reservation.allocatedBytes += share;
			distributed += share;
		}
		let integerRemainder = distributable - distributed;
		while (integerRemainder > 0) {
			let progressed = false;
			for (const reservation of executable) {
				if (integerRemainder <= 0) break;
				if (reservation.allocatedBytes >= reservation.desiredBytes) continue;
				reservation.allocatedBytes += 1;
				integerRemainder -= 1;
				progressed = true;
			}
			if (!progressed) break;
		}
	}

	const totalReservedBytes = reservations.reduce(
		(sum, reservation) => sum + reservation.allocatedBytes + reservation.controlAllocatedBytes,
		0,
	);
	return freezePlan({
		schema: "workbench-turn-output-v1",
		turnSerial: normalizeSerial(rawSerial),
		role,
		maxBytes,
		reservations,
		reservedBytes: totalReservedBytes,
		totalReservedBytes,
		consumedBytes: 0,
		controlConsumedBytes: 0,
	});
}

interface InternalReservation extends OutputReservation {
	authorizationId: string;
	authorized: boolean;
	settled: boolean;
	dynamic: boolean;
	executableAccountedBytes: number;
	controlAccountedBytes: number;
}

function pairKey(toolCallId: string, toolName: string): string {
	return JSON.stringify([toolCallId, toolName]);
}

function frozenAuthorization(value: TurnOutputAuthorization): TurnOutputAuthorization {
	return Object.freeze({ ...value });
}

function rejectedAuthorization(
	toolCallId: string,
	toolName: string,
	planned: boolean,
	blockCode: TurnBudgetBlockCode = "turn_output_budget",
): TurnOutputAuthorization {
	return frozenAuthorization({
		toolCallId,
		toolName,
		policyId: "default",
		planned,
		allowed: false,
		allocatedBytes: 0,
		controlAllocatedBytes: 0,
		blockCode,
	});
}

function observedBytes(value: unknown, allowedBytes: number): { bytes: number; invalid: boolean } {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { bytes: allowedBytes, invalid: true };
	return { bytes: Math.floor(value), invalid: false };
}

function frozenAccounting(value: ResultAccounting): ResultAccounting {
	return Object.freeze({ ...value });
}

function emptyAccounting(control = false): ResultAccounting {
	return frozenAccounting({ accepted: false, allowedBytes: 0, accountedBytes: 0, truncated: true, control });
}

/** Stateful accounting facade. All allocation decisions remain in the plan. */
export class TurnOutputBudgetState {
	private turnSerial = 0;
	private role: TurnRole = "other";
	// Explicitly widen the compile-time literal cap: role changes and installed
	// validated plans legitimately assign other numeric values here.
	private maxBytes: number = WORKER_TURN_MAX_BYTES;
	private planned = false;
	private ended = false;
	private records: InternalReservation[] = [];
	private queues = new Map<string, InternalReservation[]>();
	private queueOffsets = new Map<string, number>();
	private authorizations = new Map<string, InternalReservation>();
	private dynamicPairs = new Set<string>();
	private dynamicAttempts = 0;
	private dynamicCommittedBytes = 0;
	private consumedBytes = 0;
	private controlConsumedBytes = 0;
	private lastTelemetry?: TurnBudgetTelemetry;

	start(input: StartTurnOutputBudgetInput): TurnBudgetPlan {
		this.reset();
		let rawRole: unknown;
		let rawSerial: unknown;
		try { rawRole = input?.role; rawSerial = input?.turnSerial; } catch { rawRole = "other"; rawSerial = 0; }
		this.role = normalizeRole(rawRole);
		this.turnSerial = normalizeSerial(rawSerial);
		this.maxBytes = roleCap(this.role);
		return this.snapshot();
	}

	startTurn(input: StartTurnOutputBudgetInput): TurnBudgetPlan { return this.start(input); }

	reset(): void {
		this.turnSerial = 0;
		this.role = "other";
		this.maxBytes = WORKER_TURN_MAX_BYTES;
		this.planned = false;
		this.ended = false;
		this.records = [];
		this.queues.clear();
		this.queueOffsets.clear();
		this.authorizations.clear();
		this.dynamicPairs.clear();
		this.dynamicAttempts = 0;
		this.dynamicCommittedBytes = 0;
		this.consumedBytes = 0;
		this.controlConsumedBytes = 0;
		this.lastTelemetry = undefined;
	}

	private failClosedInstall(): false {
		this.records = [];
		this.queues.clear();
		this.queueOffsets.clear();
		this.authorizations.clear();
		this.dynamicPairs.clear();
		this.dynamicAttempts = 0;
		this.dynamicCommittedBytes = 0;
		this.consumedBytes = 0;
		this.controlConsumedBytes = 0;
		this.planned = true;
		this.ended = false;
		return false;
	}

	install(plan: unknown): boolean {
		try {
			if (typeof plan !== "object" || plan === null) return this.failClosedInstall();
			const source = plan as TurnBudgetPlan;
			if (source.schema !== "workbench-turn-output-v1" || !Array.isArray(source.reservations)) return this.failClosedInstall();
			const role = normalizeRole(source.role);
			if (source.role !== role || !Number.isSafeInteger(source.maxBytes) || source.maxBytes < 0 || source.maxBytes > roleCap(role)) return this.failClosedInstall();
			if (source.reservations.length > MAX_INPUT_CALL_RECORDS) return this.failClosedInstall();
			const records: InternalReservation[] = [];
			const ordinals = new Set<number>();
			let sum = 0;
			for (const raw of source.reservations) {
				if (typeof raw !== "object" || raw === null) return this.failClosedInstall();
				const id = boundedCallKey(raw.toolCallId);
				const name = boundedCallKey(raw.toolName);
				const policyId = raw.policyId;
				const ordinal = raw.sourceOrdinal;
				const desired = raw.desiredBytes;
				const minimum = raw.minimumBytes;
				const allocated = raw.allocatedBytes;
				const control = raw.controlAllocatedBytes;
				const status = raw.status;
				const code = raw.blockCode;
				if (!id || !name || !POLICY_IDS.has(policyId) || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinals.has(ordinal)) return this.failClosedInstall();
				if (![desired, minimum, allocated, control].every((value) => Number.isSafeInteger(value) && value >= 0)) return this.failClosedInstall();
				if (minimum > desired || allocated > desired) return this.failClosedInstall();
				if (status !== "reserved" && status !== "blocked") return this.failClosedInstall();
				if (status === "reserved" && (code !== undefined || control !== 0 || allocated < minimum)) return this.failClosedInstall();
				if (status === "blocked" && (allocated !== 0 || (code !== "turn_call_limit" && code !== "turn_output_budget"))) return this.failClosedInstall();
				if (control > 0 && control !== controlBytes(code ?? "turn_output_budget")) return this.failClosedInstall();
				ordinals.add(ordinal);
				sum += allocated + control;
				records.push({
					toolCallId: id,
					toolName: name,
					policyId,
					desiredBytes: desired,
					minimumBytes: minimum,
					allocatedBytes: allocated,
					controlAllocatedBytes: control,
					sourceOrdinal: ordinal,
					status,
					...(code ? { blockCode: code } : {}),
					authorizationId: `${normalizeSerial(source.turnSerial)}:${ordinal}`,
					authorized: false,
					settled: false,
					dynamic: false,
					executableAccountedBytes: 0,
					controlAccountedBytes: 0,
				});
			}
			const duplicateIds = new Map<string, number>();
			for (const record of records) duplicateIds.set(record.toolCallId, (duplicateIds.get(record.toolCallId) ?? 0) + 1);
			if (records.some((record) => (duplicateIds.get(record.toolCallId) ?? 0) > 1 && record.status !== "blocked")) return this.failClosedInstall();
			if (sum > source.maxBytes || source.reservedBytes !== sum || source.totalReservedBytes !== sum) return this.failClosedInstall();
			records.sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
			this.reset();
			this.turnSerial = normalizeSerial(source.turnSerial);
			this.role = role;
			this.maxBytes = source.maxBytes;
			this.planned = true;
			this.records = records;
			for (const record of records) {
				const key = pairKey(record.toolCallId, record.toolName);
				const queue = this.queues.get(key) ?? [];
				queue.push(record);
				this.queues.set(key, queue);
			}
			return true;
		} catch {
			return this.failClosedInstall();
		}
	}

	installPlan(plan: unknown): boolean { return this.install(plan); }

	private authorizeDynamicLimit(normalized: NormalizedCall, sourceOrdinal: number): TurnOutputAuthorization {
		const policy = normalized.valid
			? safePolicy(normalized, this.role)
			: resolveToolOutputPolicy({ toolName: "", args: undefined, role: this.role });
		const remaining = Math.max(0, this.maxBytes - this.dynamicCommittedBytes);
		const blockCode: TurnBudgetBlockCode = "turn_call_limit";
		const needed = controlBytes(blockCode);
		const controlAllocatedBytes = needed > 0 && remaining >= needed ? needed : 0;
		if (controlAllocatedBytes <= 0) {
			return rejectedAuthorization(normalized.toolCallId, normalized.toolName, false, blockCode);
		}
		const authorizationId = `${this.turnSerial}:dynamic:${sourceOrdinal}`;
		const record: InternalReservation = {
			toolCallId: normalized.toolCallId,
			toolName: normalized.toolName,
			policyId: policy.id,
			desiredBytes: 0,
			minimumBytes: 0,
			allocatedBytes: 0,
			controlAllocatedBytes,
			sourceOrdinal,
			status: "blocked",
			blockCode,
			authorizationId,
			authorized: true,
			settled: false,
			dynamic: true,
			executableAccountedBytes: 0,
			controlAccountedBytes: 0,
		};
		this.records.push(record);
		this.authorizations.set(authorizationId, record);
		this.dynamicCommittedBytes += controlAllocatedBytes;
		return frozenAuthorization({
			authorizationId,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			policyId: record.policyId,
			sourceOrdinal,
			planned: false,
			allowed: false,
			allocatedBytes: 0,
			controlAllocatedBytes,
			blockCode,
			controlText: blockedControlText(blockCode),
		});
	}

	authorize(input: TurnAuthorizationInput): TurnOutputAuthorization {
		if (this.ended) return rejectedAuthorization("", "", this.planned);
		let normalized: NormalizedCall;
		try { normalized = normalizeCall(input, 0); }
		catch { normalized = { toolCallId: "", toolName: "", args: undefined, valid: false, sourceOrdinal: 0 }; }
		if (!this.planned) {
			const sourceOrdinal = this.dynamicAttempts;
			if (this.dynamicAttempts < Number.MAX_SAFE_INTEGER) this.dynamicAttempts += 1;
			normalized.sourceOrdinal = sourceOrdinal;
			if (sourceOrdinal >= MAX_TOOL_CALLS_PER_TURN) return this.authorizeDynamicLimit(normalized, sourceOrdinal);
			if (!normalized.valid) return rejectedAuthorization(normalized.toolCallId, normalized.toolName, false);
		} else if (!normalized.valid) {
			return rejectedAuthorization(normalized.toolCallId, normalized.toolName, true);
		}
		const key = pairKey(normalized.toolCallId, normalized.toolName);
		if (this.planned) {
			const queue = this.queues.get(key);
			const offset = this.queueOffsets.get(key) ?? 0;
			const record = queue?.[offset];
			if (!record) return rejectedAuthorization(normalized.toolCallId, normalized.toolName, true);
			this.queueOffsets.set(key, offset + 1);
			record.authorized = true;
			this.authorizations.set(record.authorizationId, record);
			const isAllowed = record.status === "reserved";
			return frozenAuthorization({
				authorizationId: record.authorizationId,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				policyId: record.policyId,
				sourceOrdinal: record.sourceOrdinal,
				planned: true,
				allowed: isAllowed,
				allocatedBytes: isAllowed ? record.allocatedBytes : 0,
				controlAllocatedBytes: isAllowed ? 0 : record.controlAllocatedBytes,
				...(record.blockCode ? { blockCode: record.blockCode } : {}),
				...(!isAllowed && record.controlAllocatedBytes > 0 && record.blockCode
					? { controlText: blockedControlText(record.blockCode) }
					: {}),
			});
		}

		if (this.dynamicPairs.has(key)) return rejectedAuthorization(normalized.toolCallId, normalized.toolName, false);
		this.dynamicPairs.add(key);
		const policy = safePolicy(normalized, this.role);
		const remaining = Math.max(0, this.maxBytes - this.dynamicCommittedBytes);
		const allocation = Math.min(DEFENSIVE_DYNAMIC_RESERVATION_BYTES, policy.maxTextBytes);
		const ordinal = normalized.sourceOrdinal;
		let status: OutputReservationStatus = "reserved";
		let blockCode: TurnBudgetBlockCode | undefined;
		let controlAllocatedBytes = 0;
		let allocatedBytes = 0;
		if (allocation > 0 && remaining >= allocation) allocatedBytes = allocation;
		else {
			status = "blocked";
			blockCode = "turn_output_budget";
			const needed = controlBytes(blockCode);
			if (remaining >= needed) controlAllocatedBytes = needed;
		}
		const authorizationId = `${this.turnSerial}:dynamic:${ordinal}`;
		const record: InternalReservation = {
			toolCallId: normalized.toolCallId,
			toolName: normalized.toolName,
			policyId: policy.id,
			desiredBytes: Math.max(0, Math.floor(policy.maxTextBytes)),
			minimumBytes: allocation,
			allocatedBytes,
			controlAllocatedBytes,
			sourceOrdinal: ordinal,
			status,
			...(blockCode ? { blockCode } : {}),
			authorizationId,
			authorized: true,
			settled: false,
			dynamic: true,
			executableAccountedBytes: 0,
			controlAccountedBytes: 0,
		};
		this.records.push(record);
		this.authorizations.set(authorizationId, record);
		this.dynamicCommittedBytes += allocatedBytes + controlAllocatedBytes;
		return frozenAuthorization({
			authorizationId,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			policyId: record.policyId,
			sourceOrdinal: record.sourceOrdinal,
			planned: false,
			allowed: status === "reserved",
			allocatedBytes,
			controlAllocatedBytes,
			...(blockCode ? { blockCode, ...(controlAllocatedBytes > 0 ? { controlText: blockedControlText(blockCode) } : {}) } : {}),
		});
	}

	authorizeToolCall(input: TurnAuthorizationInput): TurnOutputAuthorization { return this.authorize(input); }

	private findAuthorization(value: unknown): InternalReservation | undefined {
		if (typeof value !== "string" || value.length === 0 || value.length > 1_024) return undefined;
		return this.authorizations.get(value);
	}

	consume(input: ResultAccountingInput): ResultAccounting {
		const record = this.findAuthorization(input?.authorizationId);
		if (!record || record.settled || record.status !== "reserved") return emptyAccounting(false);
		const observed = observedBytes(input?.actualBytes, record.allocatedBytes);
		const accounted = Math.min(observed.bytes, record.allocatedBytes);
		record.settled = true;
		record.status = "consumed";
		record.executableAccountedBytes = accounted;
		this.consumedBytes += accounted;
		return frozenAccounting({
			accepted: true,
			allowedBytes: record.allocatedBytes,
			accountedBytes: accounted,
			truncated: observed.invalid || observed.bytes > record.allocatedBytes,
			control: false,
		});
	}

	consumeResult(input: ResultAccountingInput): ResultAccounting { return this.consume(input); }

	release(input: { authorizationId: unknown }): boolean {
		const record = this.findAuthorization(input?.authorizationId);
		if (!record || record.settled || record.status !== "reserved") return false;
		record.settled = true;
		record.status = "released";
		return true;
	}

	releaseAuthorization(input: { authorizationId: unknown }): boolean { return this.release(input); }

	accountImmediateResult(input: ResultAccountingInput): ResultAccounting {
		const record = this.findAuthorization(input?.authorizationId);
		if (!record || record.settled) return emptyAccounting(record?.status === "blocked");
		const control = record.status === "blocked";
		const allowedBytes = control ? record.controlAllocatedBytes : record.allocatedBytes;
		const observed = observedBytes(input?.actualBytes, allowedBytes);
		const accounted = Math.min(observed.bytes, allowedBytes);
		record.settled = true;
		if (control) {
			record.controlAccountedBytes = accounted;
			this.controlConsumedBytes += accounted;
		} else {
			record.status = "consumed";
			record.executableAccountedBytes = accounted;
			this.consumedBytes += accounted;
		}
		return frozenAccounting({
			accepted: true,
			allowedBytes,
			accountedBytes: accounted,
			truncated: observed.invalid || observed.bytes > allowedBytes,
			control,
		});
	}

	accountImmediate(input: ResultAccountingInput): ResultAccounting { return this.accountImmediateResult(input); }

	snapshot(): TurnBudgetPlan {
		const reservations = this.records.map((record) => ({
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			policyId: record.policyId,
			desiredBytes: record.desiredBytes,
			minimumBytes: record.minimumBytes,
			allocatedBytes: record.allocatedBytes,
			controlAllocatedBytes: record.controlAllocatedBytes,
			sourceOrdinal: record.sourceOrdinal,
			status: record.status,
			...(record.blockCode ? { blockCode: record.blockCode } : {}),
		}));
		const totalReservedBytes = reservations.reduce((sum, record) => sum + record.allocatedBytes + record.controlAllocatedBytes, 0);
		return freezePlan({
			schema: "workbench-turn-output-v1",
			turnSerial: this.turnSerial,
			role: this.role,
			maxBytes: this.maxBytes,
			reservations,
			reservedBytes: totalReservedBytes,
			totalReservedBytes,
			consumedBytes: this.consumedBytes,
			controlConsumedBytes: this.controlConsumedBytes,
		});
	}

	turnEnd(): TurnBudgetTelemetry {
		if (this.lastTelemetry) return this.lastTelemetry;
		this.ended = true;
		let consumedCalls = 0;
		let releasedCalls = 0;
		let blockedCalls = 0;
		let reservedBytes = 0;
		for (const record of this.records) {
			reservedBytes += record.allocatedBytes + record.controlAllocatedBytes;
			if (record.status === "blocked") blockedCalls += 1;
			if (record.executableAccountedBytes > 0 || record.controlAccountedBytes > 0 || (record.settled && record.status === "consumed")) consumedCalls += 1;
			if (!record.settled && record.status === "reserved") {
				record.status = "released";
				record.settled = true;
			}
			if (record.status === "released") releasedCalls += 1;
		}
		this.queues.clear();
		this.queueOffsets.clear();
		this.authorizations.clear();
		const totalAccountedBytes = this.consumedBytes + this.controlConsumedBytes;
		const telemetry: TurnBudgetTelemetry = Object.freeze({
			schema: "workbench-turn-output-telemetry-v1",
			turnSerial: this.turnSerial,
			role: this.role,
			planned: this.planned,
			maxBytes: this.maxBytes,
			reservationCount: this.records.length,
			blockedCalls,
			consumedCalls,
			releasedCalls,
			reservedBytes,
			consumedBytes: this.consumedBytes,
			controlConsumedBytes: this.controlConsumedBytes,
			totalAccountedBytes,
			releasedBytes: Math.max(0, reservedBytes - totalAccountedBytes),
			unusedBytes: Math.max(0, this.maxBytes - totalAccountedBytes),
		});
		this.lastTelemetry = telemetry;
		return telemetry;
	}

	endTurn(): TurnBudgetTelemetry { return this.turnEnd(); }
}

export function createTurnOutputBudgetState(): TurnOutputBudgetState {
	return new TurnOutputBudgetState();
}
