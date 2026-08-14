import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

/**
 * The provider-visible projection budget is deliberately invariant. A trusted
 * executor must opt into this exact version and budget; callers cannot enlarge
 * it per result or by role.
 */
export const TOOL_RESULT_INGRESS_BUDGET_BYTES = 4_096 as const;
export const TOOL_RESULT_INGRESS_METADATA_MAX_BYTES = 8_192 as const;
export const TRUSTED_RECOVERY_AUTHORITY_SCHEMA = "workbench-trusted-recovery-authority-v1" as const;
export const TOOL_RESULT_INGRESS_METADATA_SCHEMA = "workbench-tool-result-ingress-metadata-v1" as const;

export type TrustedRecoverySourceKind =
	| "finalized_recipe_run"
	| "executed_gate_run"
	| "immutable_comparison"
	| "completed_worker_report"
	| "finalized_run_page"
	| "run_id_gate_page";

export type TrustedRequiredFactValue = string | number | boolean | null;

export interface TrustedRequiredFact {
	readonly key: string;
	readonly value: TrustedRequiredFactValue;
}

export type TrustedRecoverySourceIdentity =
	| {
		readonly kind: "digest";
		readonly sha256: string;
	}
	| {
		readonly kind: "snapshot";
		readonly snapshotId: string;
		readonly byteLength: number;
		readonly modifiedNs: string;
		readonly device: number | null;
		readonly inode: number | null;
	};

/**
 * Private execution-layer authority. This is deliberately not inferred from a
 * tool result, receipt, current-state response, or caller-supplied details.
 */
export interface TrustedRecoveryAuthority {
	readonly schema: typeof TRUSTED_RECOVERY_AUTHORITY_SCHEMA;
	readonly sourceKind: TrustedRecoverySourceKind;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly sourcePath: string;
	readonly sourceIdentity: TrustedRecoverySourceIdentity;
	readonly finalized: 1;
	readonly budgetBytes: typeof TOOL_RESULT_INGRESS_BUDGET_BYTES;
	readonly requiredFacts: readonly TrustedRequiredFact[];
}

export interface ProjectToolResultIngressInput {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: unknown;
	readonly isError: boolean;
	readonly authority: unknown;
}

export interface ToolResultIngressTextBlock {
	readonly type: "text";
	readonly text: string;
}

export interface ToolResultIngressProjectionMetadata {
	readonly schema: typeof TOOL_RESULT_INGRESS_METADATA_SCHEMA;
	readonly sourceKind: TrustedRecoverySourceKind;
	readonly sourcePath: string;
	readonly sourceIdentityKind: TrustedRecoverySourceIdentity["kind"];
	readonly sourceIdentityHash: string;
	readonly authorityHash: string;
	readonly projectionHash: string;
	readonly originalBytes: number;
	readonly projectedBytes: number;
	readonly bodyShownBytes: number;
	readonly omittedBytes: number;
	readonly budgetBytes: typeof TOOL_RESULT_INGRESS_BUDGET_BYTES;
	readonly requiredFactCount: number;
}

export type ToolResultIngressUnchangedReason =
	| "invalid_input"
	| "error_result"
	| "invalid_authority"
	| "non_text_content"
	| "projection_budget_exhausted";

export type ToolResultIngressProjectionResult =
	| {
		readonly status: "projected";
		readonly changed: boolean;
		readonly content: readonly ToolResultIngressTextBlock[];
		readonly metadata: ToolResultIngressProjectionMetadata;
	}
	| {
		readonly status: "unchanged";
		readonly changed: false;
		readonly reason: ToolResultIngressUnchangedReason;
		readonly content: unknown;
	};

interface ParsedInput {
	toolCallId: string;
	toolName: string;
	content: unknown;
	isError: boolean;
	authority: unknown;
}

interface ValidatedAuthority extends TrustedRecoveryAuthority {
	requiredFacts: readonly TrustedRequiredFact[];
	sourceIdentityHash: string;
	sourceReference: string;
	authorityHash: string;
}

interface SelectedBody {
	text: string;
	shownBytes: number;
	omittedBytes: number;
}

const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const INPUT_KEYS = ["toolCallId", "toolName", "content", "isError", "authority"] as const;
const AUTHORITY_KEYS = [
	"schema",
	"sourceKind",
	"toolCallId",
	"toolName",
	"sourcePath",
	"sourceIdentity",
	"finalized",
	"budgetBytes",
	"requiredFacts",
] as const;
const DIGEST_KEYS = ["kind", "sha256"] as const;
const SNAPSHOT_KEYS = ["kind", "snapshotId", "byteLength", "modifiedNs", "device", "inode"] as const;
const FACT_KEYS = ["key", "value"] as const;
const TEXT_BLOCK_KEYS = ["type", "text"] as const;

const MAX_TOOL_ID_BYTES = 512;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_SOURCE_PATH_BYTES = 512;
const MAX_REQUIRED_FACTS = 16;
const MAX_FACT_KEY_BYTES = 64;
const MAX_FACT_STRING_BYTES = 256;
const MAX_RENDERED_FACT_BYTES = 1_024;
const BODY_OMISSION_MARKER = "\n[bounded body omitted]\n";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const SAFE_FACT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/+\-]+$/;
const CANONICAL_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SENSITIVE_FACT_KEYS = new Set([
	"api_key",
	"argv",
	"authorization",
	"command",
	"cookie",
	"password",
	"raw",
	"secret",
	"token",
]);

const EXPECTED_TOOL_BY_SOURCE: Readonly<Record<TrustedRecoverySourceKind, string>> = Object.freeze({
	finalized_recipe_run: "workbench_run_recipe",
	executed_gate_run: "workbench_run_gate",
	immutable_comparison: "workbench_compare_runs",
	completed_worker_report: "workbench_delegate_worker",
	finalized_run_page: "workbench_read_run",
	run_id_gate_page: "workbench_read_gate",
});

const SOURCE_KINDS = new Set<TrustedRecoverySourceKind>(
	Object.keys(EXPECTED_TOOL_BY_SOURCE) as TrustedRecoverySourceKind[],
);

type DataRecord = Readonly<Record<string, unknown>>;

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function unchanged(content: unknown, reason: ToolResultIngressUnchangedReason): ToolResultIngressProjectionResult {
	return { status: "unchanged", changed: false, reason, content };
}

function isOrdinaryDataDescriptor(descriptor: PropertyDescriptor | undefined, enumerable: boolean): boolean {
	return descriptor !== undefined
		&& descriptor.enumerable === enumerable
		&& Object.prototype.hasOwnProperty.call(descriptor, "value");
}

/**
 * Inspect only own data descriptors. Proxies, accessors, symbols, exotic
 * prototypes, missing keys, and extra keys are rejected before any value is
 * consumed.
 */
function exactPlainRecord(value: unknown, expectedKeys: readonly string[]): DataRecord | undefined {
	if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== OBJECT_PROTOTYPE && prototype !== null) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string")) return undefined;
	const expected = new Set(expectedKeys);
	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const key of keys) {
		if (typeof key !== "string" || !expected.has(key)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!isOrdinaryDataDescriptor(descriptor, true)) return undefined;
		output[key] = descriptor!.value;
	}
	return output;
}

function exactPlainArray(value: unknown, maxItems: number): readonly unknown[] | undefined {
	if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Array.isArray(value)) return undefined;
	if (Object.getPrototypeOf(value) !== ARRAY_PROTOTYPE) return undefined;
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (!isOrdinaryDataDescriptor(lengthDescriptor, false)
		|| typeof lengthDescriptor!.value !== "number"
		|| !Number.isSafeInteger(lengthDescriptor!.value)
		|| lengthDescriptor!.value < 0
		|| lengthDescriptor!.value > maxItems) return undefined;
	const length = lengthDescriptor!.value as number;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) return undefined;
	const output: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!isOrdinaryDataDescriptor(descriptor, true)) return undefined;
		output.push(descriptor!.value);
	}
	return output;
}

function isScalarString(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function isBoundedInline(value: string, maxBytes: number): boolean {
	return value.length > 0
		&& utf8Bytes(value) <= maxBytes
		&& isScalarString(value)
		&& !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function isAbsoluteLike(value: string): boolean {
	return value.startsWith("/")
		|| /^[A-Za-z]:[\\/]/.test(value)
		|| value.startsWith("\\\\")
		|| value.startsWith("//");
}

function isSafeProjectRelativePath(value: unknown): value is string {
	if (typeof value !== "string"
		|| !isBoundedInline(value, MAX_SOURCE_PATH_BYTES)
		|| !SAFE_PATH_PATTERN.test(value)
		|| isAbsoluteLike(value)
		|| value.includes("\\")) return false;
	const segments = value.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
	if (segments.some((segment) => /^receipts?(?:\.|$)/i.test(segment))) return false;
	return value.startsWith(".pi/workbench/");
}

function hasSafeRecordId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,191}$/.test(value);
}

function sourcePathMatchesKind(sourceKind: TrustedRecoverySourceKind, sourcePath: string): boolean {
	const parts = sourcePath.split("/");
	if (sourceKind === "immutable_comparison") {
		return parts.length === 5
			&& parts[0] === ".pi"
			&& parts[1] === "workbench"
			&& parts[2] === "comparisons"
			&& /^cmp1-[0-9a-f]{64}$/.test(parts[3] ?? "")
			&& parts[4] === "comparison.json";
	}
	if (sourceKind === "completed_worker_report") {
		return parts.length === 5
			&& parts[0] === ".pi"
			&& parts[1] === "workbench"
			&& parts[2] === "delegations"
			&& hasSafeRecordId(parts[3] ?? "")
			&& parts[4] === "worker-report.md";
	}
	if (parts.length !== 5
		|| parts[0] !== ".pi"
		|| parts[1] !== "workbench"
		|| parts[2] !== "runs"
		|| !hasSafeRecordId(parts[3] ?? "")) return false;
	const fileName = parts[4] ?? "";
	if (sourceKind === "run_id_gate_page") return fileName === "gates.json";
	if (sourceKind === "executed_gate_run") {
		return new Set(["manifest.json", "summary.json", "gates.json", "evidence.json", "stdout.log", "stderr.log"])
			.has(fileName);
	}
	return new Set(["manifest.json", "summary.json", "run.json", "stdout.log", "stderr.log"])
		.has(fileName);
}

function validateToolIdentity(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && isBoundedInline(value, maxBytes);
}

function validateNullableIdentityNumber(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function validateSourceIdentity(value: unknown): {
	identity: TrustedRecoverySourceIdentity;
	hash: string;
	reference: string;
} | undefined {
	const possibleDigest = exactPlainRecord(value, DIGEST_KEYS);
	if (possibleDigest) {
		if (possibleDigest.kind !== "digest"
			|| typeof possibleDigest.sha256 !== "string"
			|| !SHA256_PATTERN.test(possibleDigest.sha256)) return undefined;
		const identity: TrustedRecoverySourceIdentity = { kind: "digest", sha256: possibleDigest.sha256 };
		return { identity, hash: possibleDigest.sha256, reference: `digest:${possibleDigest.sha256.slice(0, 16)}` };
	}

	const possibleSnapshot = exactPlainRecord(value, SNAPSHOT_KEYS);
	if (!possibleSnapshot
		|| possibleSnapshot.kind !== "snapshot"
		|| typeof possibleSnapshot.snapshotId !== "string"
		|| !SHA256_PATTERN.test(possibleSnapshot.snapshotId)
		|| typeof possibleSnapshot.byteLength !== "number"
		|| !Number.isSafeInteger(possibleSnapshot.byteLength)
		|| possibleSnapshot.byteLength < 0
		|| typeof possibleSnapshot.modifiedNs !== "string"
		|| possibleSnapshot.modifiedNs.length > 32
		|| !CANONICAL_INTEGER_PATTERN.test(possibleSnapshot.modifiedNs)
		|| !validateNullableIdentityNumber(possibleSnapshot.device)
		|| !validateNullableIdentityNumber(possibleSnapshot.inode)
		|| ((possibleSnapshot.device === null) !== (possibleSnapshot.inode === null))) return undefined;
	const identity: TrustedRecoverySourceIdentity = {
		kind: "snapshot",
		snapshotId: possibleSnapshot.snapshotId,
		byteLength: possibleSnapshot.byteLength,
		modifiedNs: possibleSnapshot.modifiedNs,
		device: possibleSnapshot.device,
		inode: possibleSnapshot.inode,
	};
	const canonical = JSON.stringify([
		identity.kind,
		identity.snapshotId,
		identity.byteLength,
		identity.modifiedNs,
		identity.device,
		identity.inode,
	]);
	return { identity, hash: sha256(canonical), reference: `snapshot:${identity.snapshotId.slice(0, 16)}` };
}

function validateFactValue(value: unknown): value is TrustedRequiredFactValue {
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0);
	if (typeof value !== "string"
		|| !isBoundedInline(value, MAX_FACT_STRING_BYTES)
		|| isAbsoluteLike(value)) return false;
	return true;
}

function renderFactValue(value: TrustedRequiredFactValue): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value) ?? "\"\"";
	return String(value);
}

function validateRequiredFacts(value: unknown): readonly TrustedRequiredFact[] | undefined {
	const items = exactPlainArray(value, MAX_REQUIRED_FACTS);
	if (!items || items.length === 0) return undefined;
	const facts: TrustedRequiredFact[] = [];
	const seen = new Set<string>();
	let renderedBytes = 0;
	for (const item of items) {
		const record = exactPlainRecord(item, FACT_KEYS);
		if (!record
			|| typeof record.key !== "string"
			|| utf8Bytes(record.key) > MAX_FACT_KEY_BYTES
			|| !SAFE_FACT_KEY_PATTERN.test(record.key)
			|| SENSITIVE_FACT_KEYS.has(record.key)
			|| seen.has(record.key)
			|| !validateFactValue(record.value)) return undefined;
		seen.add(record.key);
		const fact = { key: record.key, value: record.value } as TrustedRequiredFact;
		renderedBytes += utf8Bytes(`fact.${fact.key}=${renderFactValue(fact.value)}\n`);
		if (renderedBytes > MAX_RENDERED_FACT_BYTES) return undefined;
		facts.push(fact);
	}
	return facts.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function validateAuthority(
	value: unknown,
	toolCallId: string,
	toolName: string,
): ValidatedAuthority | undefined {
	const record = exactPlainRecord(value, AUTHORITY_KEYS);
	if (!record
		|| record.schema !== TRUSTED_RECOVERY_AUTHORITY_SCHEMA
		|| typeof record.sourceKind !== "string"
		|| !SOURCE_KINDS.has(record.sourceKind as TrustedRecoverySourceKind)
		|| !validateToolIdentity(record.toolCallId, MAX_TOOL_ID_BYTES)
		|| !validateToolIdentity(record.toolName, MAX_TOOL_NAME_BYTES)
		|| !SAFE_TOOL_NAME_PATTERN.test(record.toolName)
		|| record.toolCallId !== toolCallId
		|| record.toolName !== toolName
		|| record.finalized !== 1
		|| record.budgetBytes !== TOOL_RESULT_INGRESS_BUDGET_BYTES
		|| !isSafeProjectRelativePath(record.sourcePath)) return undefined;
	const sourceKind = record.sourceKind as TrustedRecoverySourceKind;
	if (EXPECTED_TOOL_BY_SOURCE[sourceKind] !== record.toolName
		|| !sourcePathMatchesKind(sourceKind, record.sourcePath)) return undefined;
	const sourceIdentity = validateSourceIdentity(record.sourceIdentity);
	const requiredFacts = validateRequiredFacts(record.requiredFacts);
	if (!sourceIdentity || !requiredFacts) return undefined;

	const authorityBase: TrustedRecoveryAuthority = {
		schema: TRUSTED_RECOVERY_AUTHORITY_SCHEMA,
		sourceKind,
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		sourcePath: record.sourcePath,
		sourceIdentity: sourceIdentity.identity,
		finalized: 1,
		budgetBytes: TOOL_RESULT_INGRESS_BUDGET_BYTES,
		requiredFacts,
	};
	const canonical = JSON.stringify({
		schema: authorityBase.schema,
		sourceKind: authorityBase.sourceKind,
		toolCallId: authorityBase.toolCallId,
		toolName: authorityBase.toolName,
		sourcePath: authorityBase.sourcePath,
		sourceIdentity: authorityBase.sourceIdentity,
		finalized: authorityBase.finalized,
		budgetBytes: authorityBase.budgetBytes,
		requiredFacts: authorityBase.requiredFacts,
	});
	return {
		...authorityBase,
		sourceIdentityHash: sourceIdentity.hash,
		sourceReference: sourceIdentity.reference,
		authorityHash: sha256(canonical),
	};
}

function parseInput(value: unknown): ParsedInput | undefined {
	const record = exactPlainRecord(value, INPUT_KEYS);
	if (!record
		|| !validateToolIdentity(record.toolCallId, MAX_TOOL_ID_BYTES)
		|| !validateToolIdentity(record.toolName, MAX_TOOL_NAME_BYTES)
		|| !SAFE_TOOL_NAME_PATTERN.test(record.toolName)
		|| typeof record.isError !== "boolean") return undefined;
	return {
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		content: record.content,
		isError: record.isError,
		authority: record.authority,
	};
}

function parseTextContent(value: unknown): { blocks: readonly ToolResultIngressTextBlock[]; text: string } | undefined {
	const items = exactPlainArray(value, 64);
	if (!items || items.length === 0) return undefined;
	const blocks: ToolResultIngressTextBlock[] = [];
	for (const item of items) {
		const record = exactPlainRecord(item, TEXT_BLOCK_KEYS);
		if (!record || record.type !== "text" || typeof record.text !== "string") return undefined;
		blocks.push({ type: "text", text: record.text });
	}
	// Pi provider adapters insert one LF between separate text blocks. Project
	// that exact provider-visible source, rather than measuring blocks in
	// isolation and hiding separator amplification.
	return { blocks, text: blocks.map((block) => block.text).join("\n") };
}

/** Same ordered-block binding used by the private execution-side content digest. */
function exactTextContentHash(blocks: readonly ToolResultIngressTextBlock[], joined: string): string {
	return sha256(JSON.stringify({
		joined,
		blocks: blocks.map((block) => ["text", block.text] as const),
	}));
}

function scalarAt(value: string, index: number): { text: string; next: number } {
	const unit = value.charCodeAt(index);
	if (unit >= 0xd800 && unit <= 0xdbff) {
		const next = value.charCodeAt(index + 1);
		if (next >= 0xdc00 && next <= 0xdfff) return { text: value.slice(index, index + 2), next: index + 2 };
		return { text: "\ufffd", next: index + 1 };
	}
	if (unit >= 0xdc00 && unit <= 0xdfff) return { text: "\ufffd", next: index + 1 };
	return { text: value[index]!, next: index + 1 };
}

function scalarBefore(value: string, end: number): { text: string; previous: number } {
	const unit = value.charCodeAt(end - 1);
	if (unit >= 0xdc00 && unit <= 0xdfff) {
		const previous = value.charCodeAt(end - 2);
		if (previous >= 0xd800 && previous <= 0xdbff) return { text: value.slice(end - 2, end), previous: end - 2 };
		return { text: "\ufffd", previous: end - 1 };
	}
	if (unit >= 0xd800 && unit <= 0xdbff) return { text: "\ufffd", previous: end - 1 };
	return { text: value[end - 1]!, previous: end - 1 };
}

function scalarPrefix(value: string, maxBytes: number): string {
	let output = "";
	let used = 0;
	for (let index = 0; index < value.length;) {
		const scalar = scalarAt(value, index);
		const size = utf8Bytes(scalar.text);
		if (used + size > maxBytes) break;
		output += scalar.text;
		used += size;
		index = scalar.next;
	}
	return output;
}

function scalarSuffix(value: string, maxBytes: number): string {
	const scalars: string[] = [];
	let used = 0;
	for (let end = value.length; end > 0;) {
		const scalar = scalarBefore(value, end);
		const size = utf8Bytes(scalar.text);
		if (used + size > maxBytes) break;
		scalars.push(scalar.text);
		used += size;
		end = scalar.previous;
	}
	return scalars.reverse().join("");
}

function scalarText(value: string): string {
	let output = "";
	for (let index = 0; index < value.length;) {
		const scalar = scalarAt(value, index);
		output += scalar.text;
		index = scalar.next;
	}
	return output;
}

function selectBody(source: string, originalBytes: number, maxBytes: number): SelectedBody {
	if (maxBytes <= 0) return { text: "", shownBytes: 0, omittedBytes: originalBytes };
	if (originalBytes <= maxBytes) {
		const text = scalarText(source);
		return { text, shownBytes: originalBytes, omittedBytes: 0 };
	}
	const markerBytes = utf8Bytes(BODY_OMISSION_MARKER);
	if (maxBytes <= markerBytes) return { text: "", shownBytes: 0, omittedBytes: originalBytes };
	const sourceBudget = maxBytes - markerBytes;
	const head = scalarPrefix(source, Math.ceil(sourceBudget / 2));
	const headBytes = utf8Bytes(head);
	const tail = scalarSuffix(source, sourceBudget - headBytes);
	const shownBytes = headBytes + utf8Bytes(tail);
	return {
		text: `${head}${BODY_OMISSION_MARKER}${tail}`,
		shownBytes,
		omittedBytes: Math.max(0, originalBytes - shownBytes),
	};
}

function renderPrefix(authority: ValidatedAuthority): string {
	const factLines = authority.requiredFacts
		.map((fact) => `fact.${fact.key}=${renderFactValue(fact.value)}`)
		.join("\n");
	return [
		"[workbench-tool-result-ingress v1]",
		`authority_hash=${authority.authorityHash}`,
		"[required-facts]",
		factLines,
		"[/required-facts]",
		"[bounded-result-body]",
	].join("\n") + "\n";
}

function renderRecoverySuffix(
	authority: ValidatedAuthority,
	originalBytes: number,
	bodyShownBytes: number,
	projectedBytes: number,
	omittedBytes: number,
): string {
	return [
		"",
		"[/bounded-result-body]",
		"[workbench-recovery v1]",
		`source_kind=${authority.sourceKind}`,
		`source_path=${authority.sourcePath}`,
		`source_ref=${authority.sourceReference}`,
		`original_bytes=${originalBytes}`,
		`body_bytes=${bodyShownBytes}`,
		`projected_bytes=${projectedBytes}`,
		`omitted_bytes=${omittedBytes}`,
		"[/workbench-recovery]",
	].join("\n") + "\n";
}

function buildMetadata(
	authority: ValidatedAuthority,
	projectionHash: string,
	originalBytes: number,
	projectedBytes: number,
	bodyShownBytes: number,
	omittedBytes: number,
): ToolResultIngressProjectionMetadata | undefined {
	const metadata: ToolResultIngressProjectionMetadata = {
		schema: TOOL_RESULT_INGRESS_METADATA_SCHEMA,
		sourceKind: authority.sourceKind,
		sourcePath: authority.sourcePath,
		sourceIdentityKind: authority.sourceIdentity.kind,
		sourceIdentityHash: authority.sourceIdentityHash,
		authorityHash: authority.authorityHash,
		projectionHash,
		originalBytes,
		projectedBytes,
		bodyShownBytes,
		omittedBytes,
		budgetBytes: TOOL_RESULT_INGRESS_BUDGET_BYTES,
		requiredFactCount: authority.requiredFacts.length,
	};
	return utf8Bytes(JSON.stringify(metadata)) <= TOOL_RESULT_INGRESS_METADATA_MAX_BYTES ? metadata : undefined;
}

function parseSafeInteger(value: string): number | undefined {
	if (!CANONICAL_INTEGER_PATTERN.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function recognizeExistingProjection(
	content: unknown,
	blocks: readonly ToolResultIngressTextBlock[],
	text: string,
	authority: ValidatedAuthority,
): ToolResultIngressProjectionResult | undefined {
	if (blocks.length !== 1 || utf8Bytes(text) > TOOL_RESULT_INGRESS_BUDGET_BYTES) return undefined;
	const prefix = renderPrefix(authority);
	if (!text.startsWith(prefix)) return undefined;
	const footerStart = text.lastIndexOf("\n[workbench-recovery v1]\n");
	if (footerStart < prefix.length) return undefined;
	const tail = text.slice(footerStart + 1);
	const match = /^\[workbench-recovery v1\]\nsource_kind=([^\n]+)\nsource_path=([^\n]+)\nsource_ref=(digest|snapshot):([0-9a-f]{16})\noriginal_bytes=([0-9]+)\nbody_bytes=([0-9]+)\nprojected_bytes=([0-9]+)\nomitted_bytes=([0-9]+)\n\[\/workbench-recovery\]\nprojection_hash=([0-9a-f]{64})\n$/u.exec(tail);
	if (!match
		|| match[1] !== authority.sourceKind
		|| match[2] !== authority.sourcePath
		|| `${match[3]}:${match[4]}` !== authority.sourceReference) return undefined;
	const originalBytes = parseSafeInteger(match[5]!);
	const bodyShownBytes = parseSafeInteger(match[6]!);
	const projectedBytes = parseSafeInteger(match[7]!);
	const omittedBytes = parseSafeInteger(match[8]!);
	const projectionHash = match[9]!;
	if (originalBytes === undefined
		|| bodyShownBytes === undefined
		|| projectedBytes === undefined
		|| omittedBytes === undefined
		|| bodyShownBytes > originalBytes
		|| omittedBytes !== originalBytes - bodyShownBytes
		|| projectedBytes !== utf8Bytes(text)) return undefined;
	const hashLine = `projection_hash=${projectionHash}\n`;
	if (!text.endsWith(hashLine) || sha256(text.slice(0, -hashLine.length)) !== projectionHash) return undefined;
	const metadata = buildMetadata(
		authority,
		projectionHash,
		originalBytes,
		projectedBytes,
		bodyShownBytes,
		omittedBytes,
	);
	if (!metadata) return undefined;
	return {
		status: "projected",
		changed: false,
		content: content as readonly ToolResultIngressTextBlock[],
		metadata,
	};
}

function renderProjection(
	sourceText: string,
	authority: ValidatedAuthority,
): { text: string; metadata: ToolResultIngressProjectionMetadata } | undefined {
	const originalBytes = utf8Bytes(sourceText);
	const prefix = renderPrefix(authority);
	const worstCounter = originalBytes;
	const conservativeSuffix = renderRecoverySuffix(
		authority,
		originalBytes,
		worstCounter,
		TOOL_RESULT_INGRESS_BUDGET_BYTES,
		worstCounter,
	);
	const hashLineBytes = utf8Bytes(`projection_hash=${"0".repeat(64)}\n`);
	const bodyBudget = TOOL_RESULT_INGRESS_BUDGET_BYTES
		- utf8Bytes(prefix)
		- utf8Bytes(conservativeSuffix)
		- hashLineBytes;
	if (bodyBudget < 1) return undefined;
	const body = selectBody(sourceText, originalBytes, bodyBudget);

	let projectedBytes: number = TOOL_RESULT_INGRESS_BUDGET_BYTES;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const suffix = renderRecoverySuffix(
			authority,
			originalBytes,
			body.shownBytes,
			projectedBytes,
			body.omittedBytes,
		);
		const withoutHash = `${prefix}${body.text}${suffix}`;
		const projectionHash = sha256(withoutHash);
		const text = `${withoutHash}projection_hash=${projectionHash}\n`;
		const actualBytes = utf8Bytes(text);
		if (actualBytes > TOOL_RESULT_INGRESS_BUDGET_BYTES) return undefined;
		if (actualBytes === projectedBytes) {
			const metadata = buildMetadata(
				authority,
				projectionHash,
				originalBytes,
				actualBytes,
				body.shownBytes,
				body.omittedBytes,
			);
			return metadata ? { text, metadata } : undefined;
		}
		projectedBytes = actualBytes;
	}
	return undefined;
}

/**
 * Freeze a trusted, recoverable text result into its first provider-visible
 * bounded form. This helper is pure, copy-on-write and role-neutral. Any
 * uncertainty returns the original content reference and never throws.
 */
export function projectToolResultIngress(input: ProjectToolResultIngressInput): ToolResultIngressProjectionResult {
	let fallbackContent: unknown;
	try {
		const parsed = parseInput(input);
		if (!parsed) return unchanged(undefined, "invalid_input");
		fallbackContent = parsed.content;
		if (parsed.isError) return unchanged(fallbackContent, "error_result");
		const authority = validateAuthority(parsed.authority, parsed.toolCallId, parsed.toolName);
		if (!authority) return unchanged(fallbackContent, "invalid_authority");
		const textContent = parseTextContent(parsed.content);
		if (!textContent) return unchanged(fallbackContent, "non_text_content");
		const existing = recognizeExistingProjection(
			parsed.content,
			textContent.blocks,
			textContent.text,
			authority,
		);
		if (existing) return existing;
		const exactBytes = utf8Bytes(textContent.text);
		if (exactBytes <= TOOL_RESULT_INGRESS_BUDGET_BYTES) {
			const metadata = buildMetadata(
				authority,
				exactTextContentHash(textContent.blocks, textContent.text),
				exactBytes,
				exactBytes,
				exactBytes,
				0,
			);
			if (!metadata) return unchanged(fallbackContent, "projection_budget_exhausted");
			return {
				status: "projected",
				changed: false,
				content: parsed.content as readonly ToolResultIngressTextBlock[],
				metadata,
			};
		}
		const projection = renderProjection(textContent.text, authority);
		if (!projection) return unchanged(fallbackContent, "projection_budget_exhausted");
		return {
			status: "projected",
			changed: true,
			content: [{ type: "text", text: projection.text }],
			metadata: projection.metadata,
		};
	} catch {
		return unchanged(fallbackContent, "invalid_input");
	}
}
