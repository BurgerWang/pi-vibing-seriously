/**
 * P6-A/P6-B cache doctor — health and hygiene checks for the prompt-cache
 * telemetry setup. Read-only: it inspects the current model registry facts,
 * the current fingerprints and the telemetry records, and reports
 * ok/warn/fail/skip per check. It never modifies anything.
 *
 * Checks cover (P6-A): provider/model facts, usage validity, cost metadata,
 * models.json/auth.json non-involvement, forbidden telemetry fields and
 * file size. P6-B adds the stable-prefix section: the current
 * systemPromptHash / activeToolNamesHash / activeToolOrderHash /
 * activeToolSchemaHash, same-mode mutation counts, expected vs unexpected
 * invalidation counts, and churn counters (model/thinking/mode/reload/
 * compaction). Rendering supports print (text lines) and json output.
 */

import { hasForbiddenTelemetryFields, MAX_TELEMETRY_RECORD_BYTES } from "./cache-store.ts";
import { cacheHitRatioFromTotals, type TelemetryRecord } from "./cache-types.ts";
import { fingerprintTools, type ToolInfoLike } from "./prompt-fingerprint.ts";
import { invalidationClass } from "./invalidation-classifier.ts";
import { matchedDynamicMarkerIds, DYNAMIC_MARKERS, staticToolMetadataIssues } from "./stable-prefix.ts";
import { sha256Hex } from "./canonical-hash.ts";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
	id: string;
	status: DoctorStatus;
	message: string;
}

export interface DoctorFacts {
	provider: string | null;
	model: string | null;
	apiKind: string | null;
	modelCostPresent: boolean;
	modelCostRatesValid: boolean;
	systemPrompt: string;
	activeToolNames: readonly string[];
	tools: readonly ToolInfoLike[];
	records: readonly TelemetryRecord[];
	telemetryEnabled: boolean;
	telemetryBytes: number;
	telemetryMaxBytes: number;
	rotatedFiles: number;
	/** Strict chronological source quality. Omitted fields default to a complete, untruncated in-memory input. */
	sourceIncomplete?: boolean;
	skippedRecords?: number;
	truncatedRecords?: number;
	filesRead?: number;
	sourceUnavailable?: string | null;
	/**
	 * P6-E: "extension" (default) runs the full Pi-context checks;
	 * "cli" (scripts/cache-benchmark.ts doctor) runs the offline subset —
	 * no live system prompt, no live tool registry, no model registry.
	 * Offline checks are skipped, never silently passed.
	 */
	context?: "extension" | "cli";
}

/** Churn thresholds (documented heuristics, not gates). */
const MAX_CHURN_TOTAL = 20;
const MAX_CHURN_SINGLE = 10;
const TELEMETRY_WRITE_GAP_EVENT = "telemetry_write_gap";
const EXPLICIT_PROMPT_CACHE_BREAKPOINTS_APPLIED_EVENT = "explicit_prompt_cache_breakpoints_applied";

interface DoctorCacheRecordFacts {
	historyProjectionSegmentSeals: number;
	historyProjectionEpochTransitions: number;
	explicitBreakpointAppliedRequests: number;
	explicitBreakpointEligibleAppliedRequests: number;
	explicitBreakpointErroredEligibleAppliedRequests: number;
	explicitBreakpointVerifiedUsage: {
		requestCount: number;
		input: number;
		cacheRead: number;
		cacheWrite: number;
		hitRatio: number | null;
	};
}

function isPublicOpenAiExplicitBreakpointEligible(record: TelemetryRecord): boolean {
	return record.provider === "openai"
		&& record.apiKind === "openai-responses"
		&& (record.model === "gpt-5.6" || record.model.startsWith("gpt-5.6-"));
}

/** Numeric facts only; no record content, marker text, payload, or projection hash is retained. */
function summarizeCacheRecordFacts(records: readonly TelemetryRecord[]): DoctorCacheRecordFacts {
	let historyProjectionSegmentSeals = 0;
	let historyProjectionEpochTransitions = 0;
	let explicitBreakpointAppliedRequests = 0;
	let explicitBreakpointEligibleAppliedRequests = 0;
	let explicitBreakpointErroredEligibleAppliedRequests = 0;
	const verifiedUsage = { requestCount: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
	for (const record of records) {
		if (record.inferredInvalidationReason === "HISTORY_PROJECTION_SEGMENT_SEALED") historyProjectionSegmentSeals += 1;
		if (record.inferredInvalidationReason === "HISTORY_PROJECTION_EPOCH_CHANGED") historyProjectionEpochTransitions += 1;
		if (record.precedingEvent !== EXPLICIT_PROMPT_CACHE_BREAKPOINTS_APPLIED_EVENT) continue;
		explicitBreakpointAppliedRequests += 1;
		if (!isPublicOpenAiExplicitBreakpointEligible(record)) continue;
		explicitBreakpointEligibleAppliedRequests += 1;
		if (record.messageStatus === "error") {
			explicitBreakpointErroredEligibleAppliedRequests = Math.min(
				Number.MAX_SAFE_INTEGER,
				explicitBreakpointErroredEligibleAppliedRequests + 1,
			);
		}
		if (record.messageStatus !== "ok" || record.usageSemanticStatus !== "verified") continue;
		verifiedUsage.requestCount += 1;
		verifiedUsage.input += record.usage.input;
		verifiedUsage.cacheRead += record.usage.cacheRead;
		verifiedUsage.cacheWrite += record.usage.cacheWrite;
	}
	return {
		historyProjectionSegmentSeals,
		historyProjectionEpochTransitions,
		explicitBreakpointAppliedRequests,
		explicitBreakpointEligibleAppliedRequests,
		explicitBreakpointErroredEligibleAppliedRequests,
		explicitBreakpointVerifiedUsage: {
			...verifiedUsage,
			hitRatio: verifiedUsage.requestCount > 0 ? cacheHitRatioFromTotals(verifiedUsage) : null,
		},
	};
}

function telemetryWriteGapObserved(records: readonly TelemetryRecord[]): boolean {
	return records.some((record) => record.precedingEvent === TELEMETRY_WRITE_GAP_EVENT);
}

/** Reasons that count as same-mode mutation (P6-B UNEXPECTED_DRIFT + payload divergence). */
function isSameModeMutation(record: TelemetryRecord): boolean {
	const reason = record.inferredInvalidationReason;
	return reason === "UNEXPECTED_DRIFT" || reason === "CONTEXT_PREFIX_DIVERGED";
}

export function runDoctor(facts: DoctorFacts): DoctorCheck[] {
	const checks: DoctorCheck[] = [];
	const cli = facts.context === "cli";
	const skippedRecords = safeCount(facts.skippedRecords);
	const truncatedRecords = safeCount(facts.truncatedRecords);
	const filesRead = safeCount(facts.filesRead);
	const writeGapObserved = telemetryWriteGapObserved(facts.records);
	const sourceIncomplete = facts.sourceIncomplete === true || skippedRecords > 0 || Boolean(facts.sourceUnavailable) || writeGapObserved;
	const observationIncomplete = sourceIncomplete || truncatedRecords > 0;
	const qualityDetail = `files=${filesRead} skipped=${skippedRecords} bounded-oldest-omitted=${truncatedRecords} telemetry-write-gap=${writeGapObserved ? "yes" : "no"}`;
	const cacheRecordFacts = summarizeCacheRecordFacts(facts.records);

	// Offline derivation: in CLI mode the live Pi model is unavailable, so
	// provider/model/apiKind come from the last telemetry record instead.
	const lastRecord = facts.records[facts.records.length - 1];
	const provider = cli ? (lastRecord?.provider ?? null) : facts.provider;
	const model = cli ? (lastRecord?.model ?? null) : facts.model;
	const apiKind = cli ? (lastRecord?.apiKind ?? null) : facts.apiKind;

	// 1. Current provider/model.
	if (provider && model) {
		checks.push({ id: "current_model", status: "ok", message: `provider=${provider} model=${model}${cli ? " (from telemetry — no live Pi context)" : ""}` });
	} else {
		checks.push({ id: "current_model", status: "warn", message: "no provider/model observed yet — telemetry has no requests" });
	}

	// 2. API kind.
	if (apiKind) {
		checks.push({ id: "api_kind", status: "ok", message: `api kind: ${apiKind}${cli ? " (from telemetry)" : ""}` });
	} else {
		checks.push({ id: "api_kind", status: "skip", message: "api kind unknown — model metadata does not provide it" });
	}

	// 3. Source completeness. Missing/corrupt/unavailable records and an
	// intentionally truncated oldest window bound every historical claim.
	if (sourceIncomplete) {
		checks.push({
			id: "telemetry_source_quality",
			status: "warn",
			message: `PARTIAL telemetry evidence (${qualityDetail}${facts.sourceUnavailable ? ` unavailable=${facts.sourceUnavailable}` : ""}) — absence-of-drift claims are suppressed`,
		});
	} else if (truncatedRecords > 0) {
		checks.push({
			id: "telemetry_source_quality",
			status: "warn",
			message: `bounded telemetry window (${qualityDetail}) — retained records are valid, but omitted history prevents whole-history absence claims`,
		});
	} else {
		checks.push({ id: "telemetry_source_quality", status: "ok", message: `complete retained telemetry evidence (${qualityDetail})` });
	}

	// 4. Usage field validity across records.
	let usageInvalid = 0;
	let usageInconsistent = 0;
	for (const record of facts.records) {
		const u = record.usage;
		const fields = [u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens, u.cost];
		if (fields.some((n) => !Number.isFinite(n) || n < 0)) usageInvalid += 1;
		if (u.totalTokens !== u.input + u.output + u.cacheRead + u.cacheWrite) usageInconsistent += 1;
	}
	if (usageInvalid > 0 || usageInconsistent > 0) {
		checks.push({
			id: "usage_fields",
			status: "fail",
			message: `${usageInvalid} record(s) with invalid (non-finite/negative) usage, ${usageInconsistent} with inconsistent totalTokens`,
		});
	} else if (facts.records.length === 0 && !observationIncomplete) {
		checks.push({ id: "usage_fields", status: "skip", message: "no telemetry records yet" });
	} else if (observationIncomplete) {
		checks.push({ id: "usage_fields", status: "warn", message: `${facts.records.length} retained record(s) have valid usage; partial/omitted evidence prevents a whole-source validity claim` });
	} else {
		checks.push({ id: "usage_fields", status: "ok", message: `${facts.records.length} record(s): all usage fields finite, non-negative and internally consistent` });
	}

	// 4. Model registry cost metadata.
	if (cli) {
		checks.push({
			id: "model_cost_metadata",
			status: "skip",
			message: "no Pi model registry in CLI mode — estimated avoided cost requires an explicit --cost-map (never hardcoded)",
		});
	} else if (!facts.modelCostPresent) {
		checks.push({ id: "model_cost_metadata", status: "warn", message: "current model has no cost metadata in the registry — estimated avoided cost stays null" });
	} else if (!facts.modelCostRatesValid) {
		checks.push({ id: "model_cost_metadata", status: "warn", message: "registry cost rates present but cacheRead rate is missing/non-finite — estimated avoided cost stays null" });
	} else {
		checks.push({ id: "model_cost_metadata", status: "ok", message: "registry provides cacheRead rate (USD per 1M tokens, same rates Pi uses for usage.cost)" });
	}

	// 5. models.json / models-store.json misuse.
	checks.push({
		id: "models_json",
		status: "ok",
		message: "workbench never reads or writes models.json / models-store.json — the provider comes from Pi's built-in registry",
	});

	// 6. auth.json access.
	checks.push({
		id: "auth_json",
		status: "ok",
		message: "auth.json is never read, modified or recorded by the workbench; credentials stay in Pi's auth store",
	});

	// 7. System prompt dynamics (marker ids only, never the prompt text).
	if (cli) {
		checks.push({
			id: "system_prompt_dynamics",
			status: "skip",
			message: "system prompt not available outside Pi — run /q-cache-doctor for this check",
		});
	} else {
		const matched = matchedDynamicMarkerIds(facts.systemPrompt, DYNAMIC_MARKERS);
		if (matched.length === 0) {
			checks.push({ id: "system_prompt_dynamics", status: "ok", message: "no timestamp/run-id/status markers found in the system prompt" });
		} else {
			checks.push({
				id: "system_prompt_dynamics",
				status: "warn",
				message: `system prompt contains dynamic markers: ${matched.join(", ")} (a timestamped system prompt re-hashes every minute and defeats caching)`,
			});
		}
	}

	// 8. P6-B: stable-prefix hashes (facts, not pass/fail). In CLI mode the
	// live fingerprint is unavailable, so the LAST RECORD's hashes are shown
	// instead (still facts, never fabricated).
	const fingerprint = fingerprintTools(facts.activeToolNames, facts.tools);
	if (cli) {
		checks.push({
			id: "prefix_hashes",
			status: "ok",
			message:
				`last-record systemPromptHash=${lastRecord?.systemPromptHash ?? "(none)"} ` +
				`activeToolNamesHash=${lastRecord?.activeToolNamesHash ?? "(none)"} ` +
				`activeToolOrderHash=${lastRecord?.activeToolOrderHash ?? "(none)"} ` +
				`activeToolSchemaHash=${lastRecord?.activeToolSchemaHash ?? "(none)"} (from telemetry — no live Pi context)`,
		});
	} else {
		checks.push({
			id: "prefix_hashes",
			status: "ok",
			message:
				`systemPromptHash=${fingerprintSystemPromptHash(facts)} ` +
				`activeToolNamesHash=${fingerprint.namesHash} ` +
				`activeToolOrderHash=${fingerprint.orderHash} ` +
				`activeToolSchemaHash=${fingerprint.schemaHash ?? "(degraded)"}`,
		});
	}

	// 9. Tool metadata static audit (P6-B): descriptions/snippets/guidelines
	// must never carry dynamic values (cwd, date, mode, path, ids).
	if (cli) {
		checks.push({
			id: "tool_metadata_static",
			status: "skip",
			message: "tool registry not available outside Pi — run /q-cache-doctor for this check",
		});
	} else {
		const toolIssues: string[] = [];
		for (const tool of facts.tools) {
			toolIssues.push(...staticToolMetadataIssues(tool));
		}
		if (toolIssues.length > 0) {
			checks.push({ id: "tool_metadata_static", status: "warn", message: `tool metadata contains dynamic values: ${toolIssues.join("; ")}` });
		} else {
			checks.push({ id: "tool_metadata_static", status: "ok", message: "tool description/promptSnippet/promptGuidelines are static (no dynamic values)" });
		}
	}

	// 10. Tool stability (current fingerprints vs the last record).
	const last = facts.records[facts.records.length - 1];
	if (cli) {
		checks.push({
			id: "tool_stability",
			status: "skip",
			message: "live tool fingerprint not available outside Pi — run /q-cache-doctor for this check",
		});
	} else if (last && fingerprint.schemaHash !== null && last.activeToolSchemaHash !== null) {
		if (fingerprint.schemaHash === last.activeToolSchemaHash) {
			checks.push({ id: "tool_stability", status: "ok", message: "active tool name/order/schema hash matches the last recorded request" });
		} else {
			checks.push({ id: "tool_stability", status: "warn", message: "active tool fingerprint differs from the last recorded request (tool set/order/schema drifted)" });
		}
	} else {
		checks.push({ id: "tool_stability", status: "skip", message: "no recorded request to compare against yet" });
	}

	// 11. P6-B: same-mode mutations (records invalidated by drift while the
	// workbench mode did not change).
	let sameModeMutations = 0;
	const driftSources = new Map<string, number>();
	for (let i = 1; i < facts.records.length; i += 1) {
		const prev = facts.records[i - 1] as TelemetryRecord;
		const cur = facts.records[i] as TelemetryRecord;
		if (prev.workbenchMode !== cur.workbenchMode) continue;
		if (isSameModeMutation(cur)) {
			sameModeMutations += 1;
			if (cur.driftSource) driftSources.set(cur.driftSource, (driftSources.get(cur.driftSource) ?? 0) + 1);
		}
	}
	if (sameModeMutations > 0) {
		const sources = [...driftSources.entries()].map(([s, n]) => `${s}=${n}`).join(" ") || "(no driftSource recorded)";
		checks.push({
			id: "same_mode_drift",
			status: "warn",
			message: `${sameModeMutations} same-mode mutation(s) — the context prefix changed without a mode switch (${sources})`,
		});
	} else if (observationIncomplete) {
		checks.push({ id: "same_mode_drift", status: "warn", message: "no same-mode mutations observed in retained records, but partial/omitted telemetry prevents a no-drift conclusion" });
	} else {
		checks.push({ id: "same_mode_drift", status: "ok", message: "no same-mode mutations — the context prefix is stable within each mode" });
	}

	// 12. P6-B: expected vs unexpected invalidation counts.
	let expectedInvalidations = 0;
	let unexpectedDrifts = 0;
	for (const record of facts.records) {
		const klass = invalidationClass(record.inferredInvalidationReason);
		if (klass === "expected") expectedInvalidations += 1;
		else if (klass === "unexpected") unexpectedDrifts += 1;
	}
	checks.push({
		id: "expected_vs_unexpected",
		status: observationIncomplete ? "warn" : "ok",
		message: `expected invalidations=${expectedInvalidations} unexpected drifts=${unexpectedDrifts} (out of ${facts.records.length} retained record(s)${observationIncomplete ? "; partial window" : ""})`,
	});

	// 13. Projection lifecycle counts. Same-epoch segment seals and epoch
	// transitions are separate record facts; neither exposes in-memory hashes.
	checks.push({
		id: "history_projection_events",
		status: observationIncomplete ? "warn" : "ok",
		message: `history projection segment seals=${cacheRecordFacts.historyProjectionSegmentSeals} epoch transitions=${cacheRecordFacts.historyProjectionEpochTransitions}${observationIncomplete ? " (retained partial/bounded observation; no clean whole-history verdict)" : ""}`,
	});

	// 14. Explicit breakpoint evidence is the exact persisted preceding-event
	// signal plus provider-reported usage. No applied record means skip (not a
	// warning) for Codex/DeepSeek; cacheRead=0 is a valid provider fact.
	const explicit = cacheRecordFacts.explicitBreakpointVerifiedUsage;
	const explicitRatio = observationIncomplete ? null : explicit.hitRatio;
	const explicitDetail = `applied=${cacheRecordFacts.explicitBreakpointAppliedRequests} eligible=${cacheRecordFacts.explicitBreakpointEligibleAppliedRequests} verified=${explicit.requestCount} errored eligible=${cacheRecordFacts.explicitBreakpointErroredEligibleAppliedRequests} input=${explicit.input} cacheRead=${explicit.cacheRead} cacheWrite=${explicit.cacheWrite} ratio=${formatRatio(explicitRatio)}`;
	if (observationIncomplete) {
		checks.push({
			id: "explicit_breakpoint_usage",
			status: "warn",
			message: `${explicitDetail} (retained partial/bounded observation; no clean application or usage verdict)`,
		});
	} else if (cacheRecordFacts.explicitBreakpointAppliedRequests === 0) {
		checks.push({
			id: "explicit_breakpoint_usage",
			status: "skip",
			message: "no explicit prompt-cache breakpoint application record observed; unsupported/default-disabled providers are not treated as failures",
		});
	} else if (cacheRecordFacts.explicitBreakpointErroredEligibleAppliedRequests > 0) {
		checks.push({
			id: "explicit_breakpoint_usage",
			status: "warn",
			message: `${explicitDetail} — one or more eligible applied requests ended with messageStatus=error; failed-request usage is excluded and is not provider-success authority`,
		});
	} else if (cacheRecordFacts.explicitBreakpointEligibleAppliedRequests !== cacheRecordFacts.explicitBreakpointAppliedRequests) {
		checks.push({
			id: "explicit_breakpoint_usage",
			status: "warn",
			message: `${explicitDetail} — one or more applied records are not eligible public OpenAI GPT-5.6 openai-responses traffic`,
		});
	} else if (explicit.requestCount !== cacheRecordFacts.explicitBreakpointEligibleAppliedRequests) {
		checks.push({
			id: "explicit_breakpoint_usage",
			status: "warn",
			message: `${explicitDetail} — provider usage semantics were not verified for every eligible applied request`,
		});
	} else {
		checks.push({
			id: "explicit_breakpoint_usage",
			status: "ok",
			message: `${explicitDetail} (provider usage is authoritative; cacheRead=0 is not a failure)`,
		});
	}

	// 15. Churn (frequent mode/model/thinking/reload/compaction).
	let modelChanges = 0;
	let thinkingChanges = 0;
	let modeChanges = 0;
	let reloads = 0;
	let compactions = 0;
	for (let i = 1; i < facts.records.length; i += 1) {
		const prev = facts.records[i - 1] as TelemetryRecord;
		const cur = facts.records[i] as TelemetryRecord;
		if (prev.model !== cur.model) modelChanges += 1;
		if (prev.thinkingLevel !== null && cur.thinkingLevel !== null && prev.thinkingLevel !== cur.thinkingLevel) thinkingChanges += 1;
		if (prev.workbenchMode !== cur.workbenchMode) modeChanges += 1;
	}
	for (const record of facts.records) {
		if (record.inferredInvalidationReason === "PACKAGE_RELOADED") reloads += 1;
		if (record.inferredInvalidationReason === "COMPACTION") compactions += 1;
	}
	const churnTotal = modelChanges + thinkingChanges + modeChanges + reloads + compactions;
	if (churnTotal > MAX_CHURN_TOTAL || Math.max(modelChanges, thinkingChanges, modeChanges, reloads, compactions) > MAX_CHURN_SINGLE) {
		checks.push({
			id: "churn",
			status: "warn",
			message: `high churn: model=${modelChanges} thinking=${thinkingChanges} mode=${modeChanges} reload=${reloads} compaction=${compactions} (each cache invalidation resets the provider cache)`,
		});
	} else if (observationIncomplete) {
		checks.push({
			id: "churn",
			status: "warn",
			message: `observed churn: model=${modelChanges} thinking=${thinkingChanges} mode=${modeChanges} reload=${reloads} compaction=${compactions}; partial/omitted telemetry prevents a whole-history bounds claim`,
		});
	} else {
		checks.push({
			id: "churn",
			status: "ok",
			message: `churn within bounds: model=${modelChanges} thinking=${thinkingChanges} mode=${modeChanges} reload=${reloads} compaction=${compactions}`,
		});
	}

	// 16. Forbidden fields in telemetry.
	let forbidden = 0;
	for (const record of facts.records) {
		if (hasForbiddenTelemetryFields(record) !== null) forbidden += 1;
	}
	if (forbidden > 0) {
		checks.push({ id: "forbidden_fields", status: "fail", message: `${forbidden} record(s) contain forbidden fields (prompt/content/secret/... keys) — fix the schema before continuing` });
	} else if (observationIncomplete) {
		checks.push({ id: "forbidden_fields", status: "warn", message: `no forbidden fields in ${facts.records.length} retained record(s); partial/omitted telemetry prevents a whole-source conclusion` });
	} else {
		checks.push({ id: "forbidden_fields", status: "ok", message: `no forbidden fields in ${facts.records.length} record(s)` });
	}

	// 17. Telemetry file size.
	const telemetrySetCapacity = (facts.telemetryMaxBytes + MAX_TELEMETRY_RECORD_BYTES) * Math.max(1, facts.rotatedFiles + 1);
	if (facts.telemetryBytes > telemetrySetCapacity) {
		checks.push({ id: "telemetry_size", status: "warn", message: `telemetry set is ${facts.telemetryBytes} bytes (per-file limit ${facts.telemetryMaxBytes}, ${facts.rotatedFiles} rotated file(s)) — observed total exceeds the expected rotation-set capacity` });
	} else {
		checks.push({ id: "telemetry_size", status: "ok", message: `telemetry set is ${facts.telemetryBytes} bytes (per-file limit ${facts.telemetryMaxBytes}, ${facts.rotatedFiles} rotated file(s))` });
	}

	// 18. Telemetry enabled.
	checks.push({
		id: "telemetry_enabled",
		status: facts.telemetryEnabled ? "ok" : "skip",
		message: facts.telemetryEnabled ? "telemetry enabled (project.yaml cache.telemetry, default true)" : "telemetry disabled via project.yaml cache.telemetry: false",
	});

	return checks;
}

function safeCount(value: number | undefined): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function formatRatio(value: number | null): string {
	return value === null ? "N/A" : `${Math.round(value * 100)}%`;
}

function fingerprintSystemPromptHash(facts: DoctorFacts): string {
	// Hash-only: the prompt text itself never leaves this module.
	return sha256Hex(facts.systemPrompt);
}

/** Text rendering (print mode). */
export function renderDoctor(checks: readonly DoctorCheck[]): string[] {
	const lines = [`cache doctor: ${checks.filter((c) => c.status === "fail").length} fail(s), ${checks.filter((c) => c.status === "warn").length} warning(s)`];
	for (const check of checks) {
		lines.push(`  [${check.status.padEnd(4)}] ${check.id.padEnd(24)} ${check.message}`);
	}
	return lines;
}

/** JSON rendering (json mode) — plain data, never secrets. */
export function doctorToJson(checks: readonly DoctorCheck[], facts?: DoctorFacts): Record<string, unknown> {
	const out: Record<string, unknown> = {
		checks: checks.map((c) => ({ id: c.id, status: c.status, message: c.message })),
		fail_count: checks.filter((c) => c.status === "fail").length,
		warn_count: checks.filter((c) => c.status === "warn").length,
	};
	if (facts) {
		const fingerprint = fingerprintTools(facts.activeToolNames, facts.tools);
		const sourceIncomplete = facts.sourceIncomplete === true
				|| safeCount(facts.skippedRecords) > 0
				|| Boolean(facts.sourceUnavailable)
				|| telemetryWriteGapObserved(facts.records);
		const truncatedRecords = safeCount(facts.truncatedRecords);
		out.telemetry_quality = {
			sourceIncomplete,
			skippedRecords: safeCount(facts.skippedRecords),
			truncatedRecords,
			filesRead: safeCount(facts.filesRead),
			sourceUnavailable: facts.sourceUnavailable ?? null,
		};
		const recordFacts = summarizeCacheRecordFacts(facts.records);
		out.history_projection = {
			segmentSeals: recordFacts.historyProjectionSegmentSeals,
			epochTransitions: recordFacts.historyProjectionEpochTransitions,
		};
		out.explicit_breakpoints = {
			appliedRequests: recordFacts.explicitBreakpointAppliedRequests,
			eligibleAppliedRequests: recordFacts.explicitBreakpointEligibleAppliedRequests,
			erroredEligibleAppliedRequests: recordFacts.explicitBreakpointErroredEligibleAppliedRequests,
			verifiedUsage: {
				...recordFacts.explicitBreakpointVerifiedUsage,
				hitRatio: sourceIncomplete || truncatedRecords > 0
					? null
					: recordFacts.explicitBreakpointVerifiedUsage.hitRatio,
			},
		};
		out.prefix = {
			systemPromptHash: fingerprintSystemPromptHash(facts),
			activeToolNamesHash: fingerprint.namesHash,
			activeToolOrderHash: fingerprint.orderHash,
			activeToolSchemaHash: fingerprint.schemaHash,
		};
	}
	return out;
}
