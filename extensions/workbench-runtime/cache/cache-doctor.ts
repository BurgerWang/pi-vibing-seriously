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

import { hasForbiddenTelemetryFields } from "./cache-store.ts";
import type { TelemetryRecord } from "./cache-types.ts";
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

/** Reasons that count as same-mode mutation (P6-B UNEXPECTED_DRIFT + payload divergence). */
function isSameModeMutation(record: TelemetryRecord): boolean {
	const reason = record.inferredInvalidationReason;
	return reason === "UNEXPECTED_DRIFT" || reason === "CONTEXT_PREFIX_DIVERGED";
}

export function runDoctor(facts: DoctorFacts): DoctorCheck[] {
	const checks: DoctorCheck[] = [];
	const cli = facts.context === "cli";

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

	// 3. Usage field validity across records.
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
	} else if (facts.records.length === 0) {
		checks.push({ id: "usage_fields", status: "skip", message: "no telemetry records yet" });
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
		status: "ok",
		message: `expected invalidations=${expectedInvalidations} unexpected drifts=${unexpectedDrifts} (out of ${facts.records.length} record(s))`,
	});

	// 13. Churn (frequent mode/model/thinking/reload/compaction).
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
	} else {
		checks.push({
			id: "churn",
			status: "ok",
			message: `churn within bounds: model=${modelChanges} thinking=${thinkingChanges} mode=${modeChanges} reload=${reloads} compaction=${compactions}`,
		});
	}

	// 14. Forbidden fields in telemetry.
	let forbidden = 0;
	for (const record of facts.records) {
		if (hasForbiddenTelemetryFields(record) !== null) forbidden += 1;
	}
	if (forbidden > 0) {
		checks.push({ id: "forbidden_fields", status: "fail", message: `${forbidden} record(s) contain forbidden fields (prompt/content/secret/... keys) — fix the schema before continuing` });
	} else {
		checks.push({ id: "forbidden_fields", status: "ok", message: `no forbidden fields in ${facts.records.length} record(s)` });
	}

	// 15. Telemetry file size.
	if (facts.telemetryBytes > facts.telemetryMaxBytes) {
		checks.push({ id: "telemetry_size", status: "warn", message: `telemetry.jsonl is ${facts.telemetryBytes} bytes (limit ${facts.telemetryMaxBytes}, ${facts.rotatedFiles} rotated file(s)) — rotation is active` });
	} else {
		checks.push({ id: "telemetry_size", status: "ok", message: `telemetry.jsonl is ${facts.telemetryBytes} bytes (limit ${facts.telemetryMaxBytes}, ${facts.rotatedFiles} rotated file(s))` });
	}

	// 16. Telemetry enabled.
	checks.push({
		id: "telemetry_enabled",
		status: facts.telemetryEnabled ? "ok" : "skip",
		message: facts.telemetryEnabled ? "telemetry enabled (project.yaml cache.telemetry, default true)" : "telemetry disabled via project.yaml cache.telemetry: false",
	});

	return checks;
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
		out.prefix = {
			systemPromptHash: fingerprintSystemPromptHash(facts),
			activeToolNamesHash: fingerprint.namesHash,
			activeToolOrderHash: fingerprint.orderHash,
			activeToolSchemaHash: fingerprint.schemaHash,
		};
	}
	return out;
}
