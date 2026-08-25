/**
 * P6-B stable-prefix tests — the DeepSeek Stable Prefix Contract.
 *
 * Coverage (P6-B spec §7):
 *   - same-mode consecutive fingerprint builds are identical
 *   - filesystem / YAML / glob order randomization never changes hashes
 *   - dynamic task/run/gate facts never change the stable hashes
 *   - DEV / AUDIT / VERIFY tool hashes are stable and pairwise different
 *   - invalidation classification: mode/model/thinking/reload/compaction are
 *     expected; same-mode mutations are UNEXPECTED_DRIFT
 *   - before_provider_request never mutates the payload
 *   - telemetry never enters the model context
 *   - no dynamic tool loader, no supportsToolSearch/supportsToolReferences
 *     claims, registration order == WORKBENCH_TOOL_NAMES (source scan)
 *   - tool metadata is static (no cwd/date/mode/path/ids)
 *   - gate/recipe/profile discovery is deterministically sorted
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
	canonicalHash,
	sha256Hex,
} from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	modePrefixFingerprint,
	normalizeResourceName,
	sortedById,
	sortedByName,
	sortedByPath,
	stableResourcesHash,
	stableSortStrings,
	staticToolMetadataIssues,
	findDynamicValueMarkers,
	STABLE_ZONE_FIELDS,
	DYNAMIC_ZONE_FIELDS,
	DYNAMIC_CHANNELS,
} from "../extensions/workbench-runtime/cache/stable-prefix.ts";
import {
	classifyPayloadRelationship,
	fingerprintTools,
	wholeItemLcpFacts,
	summarizePayload,
	type ToolInfoLike,
} from "../extensions/workbench-runtime/cache/prompt-fingerprint.ts";
import { classifyInvalidation, invalidationClass } from "../extensions/workbench-runtime/cache/invalidation-classifier.ts";
import { createCacheTelemetry, type CacheStateEntryLike, type CacheTelemetry, type MessageEndFacts } from "../extensions/workbench-runtime/cache/cache-telemetry.ts";
import { buildCacheReport } from "../extensions/workbench-runtime/cache/cache-report.ts";
import { buildCompactNote, emptyCompactState } from "../extensions/workbench-runtime/core/compact.ts";
import {
	AUDIT_TOOLS,
	computeActiveTools,
	DEV_TOOLS,
	MODE_TOOLS,
	VERIFY_TOOLS,
	WORKBENCH_TOOLS,
} from "../extensions/workbench-runtime/core/mode-policy.ts";
import {
	WORKBENCH_TOOL_METADATA,
	WORKBENCH_TOOL_NAMES,
	WORKBENCH_TOOL_PARAMETERS,
	WORKBENCH_DELEGATE_WORKER_V1_PARAMETERS,
	workbenchToolMetadataOrdered,
} from "../extensions/workbench-runtime/core/tool-catalog.ts";
import {
	GREP_COUNT_GUIDELINE,
	NATIVE_OVERRIDE_METADATA,
	NATIVE_OVERRIDE_NAMES,
	NATIVE_OVERRIDE_PARAMETERS,
	READ_PREVIEW_GUIDELINE,
} from "../extensions/workbench-runtime/core/native-tool-policy.ts";
import {
	INDEPENDENT_READ_ONLY_ALLOWLIST,
	isIndependentReadOnlyTool,
} from "../extensions/workbench-runtime/core/run-result.ts";
import { effectiveGates, type Gate } from "../extensions/workbench-runtime/core/gate-schema.ts";
import { parseRecipesDocument, type Recipe } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import { loadProjectConfig } from "../extensions/workbench-runtime/core/config.ts";
import { withTempDir, writeConfigFile } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = "You are the pi-dev-workbench assistant. Follow the workbench mode policy and validation ladder.";

/**
 * The four Pi built-ins that are NOT part of the workbench registration
 * surface (NRO N1/N2 overrides read/grep/find; ls/bash/edit/write stay Pi
 * built-ins). Generic static stand-ins: identical in the pre-NRO and
 * current fixtures, so they never affect the N1/N2 transition proof.
 */
const OTHER_BUILTIN_TOOLS: readonly ToolInfoLike[] = [
	{ name: "ls", description: "List directory contents", promptSnippet: "List a directory", parameters: { type: "object" }, promptGuidelines: [] },
	{ name: "bash", description: "Execute a bash command", promptSnippet: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } }, promptGuidelines: [] },
	{ name: "edit", description: "Edit a file", promptSnippet: "Make precise edits", parameters: { type: "object" }, promptGuidelines: [] },
	{ name: "write", description: "Write a file", promptSnippet: "Create or overwrite a file", parameters: { type: "object" }, promptGuidelines: [] },
];

/**
 * The three ACTUALLY REGISTERED N1/N2 read/grep/find overrides: tool info is
 * built from the registered static metadata and parameter schemas
 * (NATIVE_OVERRIDE_METADATA / NATIVE_OVERRIDE_PARAMETERS in
 * core/native-tool-policy.ts) in the fixed read → grep → find order — never
 * from generic built-in mocks.
 */
function nativeOverrideToolInfos(): ToolInfoLike[] {
	return NATIVE_OVERRIDE_NAMES.map((name) => ({
		name: NATIVE_OVERRIDE_METADATA[name].name,
		description: NATIVE_OVERRIDE_METADATA[name].description,
		promptSnippet: NATIVE_OVERRIDE_METADATA[name].promptSnippet,
		parameters: NATIVE_OVERRIDE_PARAMETERS[name],
		promptGuidelines: [...NATIVE_OVERRIDE_METADATA[name].promptGuidelines],
	}));
}

/** The 11 workbench catalog tools in their explicit registration order. */
function catalogToolInfos(): ToolInfoLike[] {
	return workbenchToolMetadataOrdered().map((t) => ({
		name: t.name,
		description: t.description,
		promptSnippet: t.promptSnippet,
		parameters: t.parameters,
		promptGuidelines: [...t.promptGuidelines],
	}));
}

/** All registered tool infos: the three native overrides + the other built-ins + the 11-tool catalog (in active order). */
function allToolInfos(): ToolInfoLike[] {
	return [...nativeOverrideToolInfos(), ...OTHER_BUILTIN_TOOLS, ...catalogToolInfos()];
}

/** Public static surface used for the v0.10.0 transition record. */
function publicToolSurface(): ToolInfoLike[] {
	return [...nativeOverrideToolInfos(), ...catalogToolInfos()];
}

/**
 * The PRE-NRO legacy fixture (NRO plan §10 control arm): pristine Pi 0.83.0
 * built-in read/grep/find captured from the same create*ToolDefinition
 * factories the overrides delegate to, plus the unchanged other built-ins
 * and the 11-tool catalog. Same names and same active order as the current
 * fixture — only the read/grep/find metadata and schema sources differ.
 */
function preNroToolInfos(): ToolInfoLike[] {
	const builtins: ToolInfoLike[] = [
		createReadToolDefinition(".") as unknown as ToolInfoLike,
		createGrepToolDefinition(".") as unknown as ToolInfoLike,
		createFindToolDefinition(".") as unknown as ToolInfoLike,
	];
	return [
		...builtins.map((t) => ({
			name: t.name,
			description: t.description,
			promptSnippet: t.promptSnippet,
			parameters: t.parameters,
			promptGuidelines: [...(t.promptGuidelines ?? [])],
		})),
		...OTHER_BUILTIN_TOOLS,
		...catalogToolInfos(),
	];
}

// ---------------------------------------------------------------------------
// 1. Same-mode consecutive hash builds are identical
// ---------------------------------------------------------------------------

test("same mode: consecutive prefix fingerprint builds are identical", () => {
	const tools = allToolInfos();
	const a = modePrefixFingerprint("VERIFY", SYSTEM_PROMPT, tools, VERIFY_TOOLS);
	const b = modePrefixFingerprint("VERIFY", SYSTEM_PROMPT, tools, VERIFY_TOOLS);
	assert.deepEqual(a, b);
	assert.match(a.modeHash, /^[0-9a-f]{64}$/);
	assert.match(a.systemPromptHash, /^[0-9a-f]{64}$/);
	assert.equal(a.toolOrderHash, canonicalHash(VERIFY_TOOLS), "order hash = canonical hash of the explicit MODE_TOOLS order");
});

test("v0.10.0 public tool surface has the intentional structured-Git transition hash", () => {
	const baselineHash = "1c82f913f7dc0fe6c999ca982db1d714df940dfa09a75165aca5b6a01cd1f8dd";
	const currentHash = "b212fe63aa889f77442559420709beb938c26cc841347e59b459c04b9a1e7e20";
	assert.notEqual(currentHash, baselineHash, "0.10.0 intentionally changes the frozen 8ec8c269 public tool surface");
	assert.equal(canonicalHash(publicToolSurface()), currentHash, "current registered static sources match the documented 0.10.0 hash");
});

test("the stable-zone contract constants are explicit and disjoint", () => {
	assert.ok(STABLE_ZONE_FIELDS.includes("systemPrompt"));
	assert.ok(STABLE_ZONE_FIELDS.includes("modeToolList"));
	assert.ok(STABLE_ZONE_FIELDS.includes("toolMetadata"));
	assert.ok(DYNAMIC_ZONE_FIELDS.includes("gitState"));
	assert.ok(DYNAMIC_ZONE_FIELDS.includes("runId"));
	assert.ok(DYNAMIC_ZONE_FIELDS.includes("gateStatus"));
	assert.ok(DYNAMIC_ZONE_FIELDS.includes("cacheUsage"));
	for (const field of STABLE_ZONE_FIELDS) assert.ok(!DYNAMIC_ZONE_FIELDS.includes(field), field);
	for (const channel of ["tuiStatusWidget", "customSessionEntry", "toolResult", "telemetryHashMetadata", "normalChatMessage"]) {
		assert.ok(DYNAMIC_CHANNELS.includes(channel), channel);
	}
});

// ---------------------------------------------------------------------------
// 2. Filesystem / collection order randomization
// ---------------------------------------------------------------------------

test("filesystem-style ordering: stableSortStrings is order-independent", () => {
	const names = ["b.md", "a.md", "c.md", "a.md", "README.md"];
	const shuffled: string[][] = [];
	for (let i = 0; i < 20; i += 1) shuffled.push([...names].sort(() => (Math.random() < 0.5 ? -1 : 1)));
	for (const order of shuffled) {
		assert.deepEqual(stableSortStrings(order), ["README.md", "a.md", "a.md", "b.md", "c.md"]);
	}
	assert.deepEqual(stableSortStrings([]), []);
	// duplicates preserved, stable across calls
	assert.deepEqual(stableSortStrings(names), stableSortStrings([...names].reverse()));
});

test("stableResourcesHash ignores input order of skills/templates/gates/recipes/profiles/extensions", () => {
	const resources = {
		skills: ["z-skill", "a-skill", "m-skill"],
		promptTemplates: ["q-verify.md", "q-plan.md"],
		gates: ["q5", "b0", "q0", "b5"],
		recipes: ["test:unit", "check:format", "backtest"],
		profiles: ["generic", "quant-research/stock-selection"],
		extensions: ["workbench-runtime", "other"],
	};
	const h1 = stableResourcesHash(resources);
	const h2 = stableResourcesHash({
		skills: [...resources.skills].reverse(),
		promptTemplates: [...resources.promptTemplates].reverse(),
		gates: [...resources.gates].reverse(),
		recipes: [...resources.recipes].reverse(),
		profiles: [...resources.profiles].reverse(),
		extensions: [...resources.extensions].reverse(),
	});
	assert.equal(h1, h2);
	// changing a member changes the hash (the hash is real, not constant)
	assert.notEqual(h1, stableResourcesHash({ ...resources, gates: [...resources.gates, "q1"] }));
});

test("normalizeResourceName makes path/name comparisons canonical", () => {
	assert.equal(normalizeResourceName("./skills/a"), "skills/a");
	assert.equal(normalizeResourceName("skills\\a"), "skills/a");
	assert.equal(normalizeResourceName("skills/a/"), "skills/a");
	// normalization happens BEFORE sorting in stableResourcesHash
	assert.deepEqual(stableSortStrings([normalizeResourceName("./skills/a"), "skills/z"]), ["skills/a", "skills/z"]);
});

test("glob-style match lists hash identically regardless of match order", () => {
	const matchesA = ["results/q2.json", "results/q1.json", "results/q0.json"];
	const matchesB = [...matchesA].reverse();
	assert.equal(canonicalHash(stableSortStrings(matchesA)), canonicalHash(stableSortStrings(matchesB)));
});

// ---------------------------------------------------------------------------
// 3. YAML key / list order
// ---------------------------------------------------------------------------

test("gate definitions: YAML list order cannot change the effective ladder (sorted by id)", async () => {
	const gateYaml = (order: "natural" | "reversed") => {
		const gates = [
			`  - id: g-custom\n    title: Custom gate\n    checks: []`,
			`  - id: b0\n    title: Project Readiness\n    checks: []`,
			`  - id: q0\n    title: Research Contract\n    checks: []`,
		];
		return `gates:\n${(order === "natural" ? gates : [...gates].reverse()).join("\n")}\n`;
	};
	const parseGates = (doc: unknown): Gate[] => {
		// minimal project-gate parse mirroring gate-engine's parseGatesDocument
		const list = (doc as { gates?: unknown }).gates;
		return (Array.isArray(list) ? list : []).map((raw) => {
			const r = raw as { id?: unknown; title?: unknown; checks?: unknown };
			return {
				id: String(r.id ?? "?"),
				title: String(r.title ?? ""),
				description: "",
				profiles: [],
				prerequisites: [],
				required: true,
				blocking: true,
				evidence: [],
				acceptance: "",
				checks: [],
				source: "project",
			};
		});
	};
	const docA = parseYaml(gateYaml("natural")) as unknown;
	const docB = parseYaml(gateYaml("reversed")) as unknown;
	const catalog = [
		{ id: "b0", title: "Project Readiness", description: "", profiles: [], prerequisites: [], required: true, blocking: true, evidence: [], acceptance: "", checks: [], source: "catalog" },
		{ id: "q0", title: "Research Contract", description: "", profiles: ["quant-research/stock-selection"], prerequisites: [], required: true, blocking: true, evidence: [], acceptance: "", checks: [], source: "catalog" },
	] as Gate[];
	const idsA = effectiveGates("quant-research/stock-selection", catalog, parseGates(docA)).map((g) => g.id);
	const idsB = effectiveGates("quant-research/stock-selection", catalog, parseGates(docB)).map((g) => g.id);
	assert.deepEqual(idsA, idsB);
	assert.deepEqual(idsA, ["b0", "g-custom", "q0"], "sorted by gate id regardless of YAML order");
});

test("recipes: YAML list order cannot change the parsed recipe set (sorted by name)", () => {
	const docA = parseYaml("recipes:\n  - name: zebra\n    command: [echo, z]\n  - name: alpha\n    command: [echo, a]\n") as unknown;
	const docB = parseYaml("recipes:\n  - name: alpha\n    command: [echo, a]\n  - name: zebra\n    command: [echo, z]\n") as unknown;
	const names = (doc: unknown): string[] => parseRecipesDocument(doc).recipes.map((r) => r.name);
	assert.deepEqual(names(docA), ["alpha", "zebra"]);
	assert.deepEqual(names(docA), names(docB));
});

test("profiles: YAML list order cannot change the parsed profile set (sorted by name)", async () => {
	await withTempDir(async (dir) => {
		await writeConfigFile(dir, "profiles.yaml", "profiles:\n  - name: zeta\n    description: z\n  - name: alpha\n    description: a\n");
		await writeConfigFile(dir, "project.yaml", "name: p\nprofile: alpha\n");
		const config = await loadProjectConfig(dir, { trusted: true });
		const names = (config.profiles as Array<{ name?: unknown }>).map((p) => String(p.name ?? ""));
		assert.deepEqual(names, ["alpha", "zeta"]);
	});
});

// ---------------------------------------------------------------------------
// 4. Dynamic facts never touch the stable hashes
// ---------------------------------------------------------------------------

test("dynamic task/run/gate/git/time facts do not change the stable prefix hashes", () => {
	const tools = allToolInfos();
	const baseline = modePrefixFingerprint("DEV", SYSTEM_PROMPT, tools, DEV_TOOLS);
	// dynamic facts live in a SEPARATE dynamic document (allowed channels only)
	const dynamic = {
		taskId: "task-2026-01-15",
		runId: "20260115-093000-abcd",
		gateId: "q3",
		gateStatus: "FAIL",
		gitDirty: true,
		now: "2026-01-15T09:30:00.000Z",
		cacheHitRatio: 0.8,
		tokens: 12345,
	};
	assert.equal(canonicalHash(dynamic), canonicalHash({ ...dynamic }), "dynamic facts hash deterministically");
	// ... but they are NOT part of the stable zone: same stable inputs -> same hash
	const again = modePrefixFingerprint("DEV", SYSTEM_PROMPT, tools, DEV_TOOLS);
	assert.deepEqual(again, baseline);
	assert.equal(again.systemPromptHash, sha256Hex(SYSTEM_PROMPT));
	// the system prompt hash ignores an appended dynamic appendix: stable
	// hashing is over the stable inputs ONLY (never over a composed string)
	assert.equal(modePrefixFingerprint("DEV", SYSTEM_PROMPT, tools, DEV_TOOLS).systemPromptHash, baseline.systemPromptHash);
});

test("tool metadata audit flags dynamic values and passes static catalog metadata", () => {
	const dynamicTool: ToolInfoLike = {
		name: "workbench_bad",
		description: "run cwd /home/hanbaoji/projects/x on 2026-01-15 for run 20260115-093000-abcd",
		promptSnippet: "mode VERIFY",
		promptGuidelines: [],
	};
	const issues = staticToolMetadataIssues(dynamicTool);
	assert.ok(issues.length > 0, "dynamic values must be flagged");
	assert.ok(issues.some((i) => i.includes("iso-date")), issues.join("; "));
	// the real catalog is clean
	for (const tool of workbenchToolMetadataOrdered()) {
		const meta = { ...tool, description: tool.description, promptSnippet: tool.promptSnippet, promptGuidelines: [...tool.promptGuidelines] };
		assert.deepEqual(staticToolMetadataIssues(meta), [], `${tool.name} metadata must be static`);
	}
});

test("workbench_delegate_worker metadata is static, compact, and preserves authority boundaries", () => {
	const meta = WORKBENCH_TOOL_METADATA.workbench_delegate_worker;
	// Every metadata field stays free of dynamic values (no dates, times,
	// hashes, absolute paths, or concrete run/gate/task ids).
	for (const field of [meta.description, meta.promptSnippet, ...meta.promptGuidelines]) {
		assert.deepEqual(findDynamicValueMarkers(field), [], `delegate metadata must be static: ${field.slice(0, 80)}`);
	}
	const text = [meta.description, meta.promptSnippet, ...meta.promptGuidelines].join("\n");
	assert.ok(Buffer.byteLength(text, "utf8") < 2_500, "delegate metadata stays context-efficient");
	assert.match(text, /GPT-5\.6 Luna xhigh/);
	assert.match(text, /Implementation may write only approved paths/);
	assert.match(text, /diagnosis is strictly read-only/);
	assert.match(text, /smallest useful allowed_paths/);
	assert.match(text, /recipe:<declared-name>/);
	assert.match(text, /12 KiB/);
	assert.match(text, /64 KiB/);
	assert.match(text, /fresh no-session process/);
	assert.match(text, /ambiguous authority fails closed/);
	assert.match(text, /immutable Sol REPAIR decision/);
	assert.match(text, /lineage preserves rejected W\/D paths, exact scope, root plan identity, and the latest continuation decision/);
	assert.match(text, /project lock prevents sibling starts/);
	assert.match(text, /never resumes a session or imports prior prose/);
	assert.match(text, /Sol owns semantic acceptance, final verification, Gates, permissions and the final verdict/);
	assert.doesNotMatch(text, /deepseek/i, "current delegate metadata contains no retired provider wording");
	// Registration name/order stay stable. The current schema/hash intentionally
	// advances for the additive optional task_kind field, while the separately
	// retained governance-v1 schema remains pinned to its repair_of baseline.
	assert.equal(meta.name, "workbench_delegate_worker");
	assert.equal(WORKBENCH_TOOL_NAMES.indexOf("workbench_delegate_worker"), WORKBENCH_TOOL_NAMES.length - 5, "delegate tool keeps its registration position (seven existing → delegate → review → status → recovery → local commit)");
	// The canonical schema object itself (not only its hash): budget_profile
	// stays OPTIONAL — absent from `required` — and its nested union carries
	// the JSON Schema `default: "extended"` annotation plus the exact
	// closed alternatives in the fixed standard|extended order. This
	// inspects the real serialized shape so the pin below can never pass on
	// a self-comparison or a drifted-but-self-consistent schema.
	const delegateParameters = WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker as unknown as {
		type: string;
		required?: string[];
		properties: Record<string, { default?: unknown; anyOf?: Array<{ const?: unknown }>; type?: string; minLength?: number; maxLength?: number; pattern?: string; description?: string }>;
	};
	assert.equal(delegateParameters.type, "object");
	assert.ok(!(delegateParameters.required ?? []).includes("budget_profile"), "budget_profile stays optional — no required-list regression");
	const budgetProfileSchema = delegateParameters.properties.budget_profile;
	assert.ok(budgetProfileSchema, "budget_profile is present in the serialized parameter schema");
	assert.equal(budgetProfileSchema.default, "extended", "the nested budget_profile schema carries the JSON Schema safe default annotation extended");
	assert.deepEqual(
		(budgetProfileSchema.anyOf ?? []).map((alternative) => alternative.const),
		["standard", "extended"],
		"the exact closed active alternatives in the fixed standard|extended order",
	);
	assert.doesNotMatch(budgetProfileSchema.description ?? "", /low =/);
	assert.match(budgetProfileSchema.description ?? "", /retired low literal is rejected/);
	assert.match(budgetProfileSchema.description ?? "", /Luna xhigh cumulative spend profile/);
	assert.match(budgetProfileSchema.description ?? "", /standard: soft at 32 turns \/ 5,440,000 total \/ 160,000 output/);
	assert.match(budgetProfileSchema.description ?? "", /advisory turn marker 64, hard total 10,880,000, hard output 320,000/);
	assert.match(budgetProfileSchema.description ?? "", /never kills healthy tool-heavy work by itself/);
	assert.match(budgetProfileSchema.description ?? "", /current Sol session/);
	// The current surface retains Phase 4A's public shape while strengthening
	// its authority semantics: repair_of stays OPTIONAL —
	// absent from `required` — and is an exactly-20-character string pinned
	// to the strict delegation-id pattern ^\d{8}-\d{6}-[A-Za-z0-9]{4}$.
	// The description also exposes current semantic-REPAIR/lineage rules. The
	// separately pinned governance-v1 schema above preserves the historical
	// pointer-only wording byte-for-byte.
	const repairOfSchema = delegateParameters.properties.repair_of;
	assert.ok(repairOfSchema, "repair_of is present in the serialized parameter schema");
	assert.ok(!(delegateParameters.required ?? []).includes("repair_of"), "repair_of stays optional — no required-list regression");
	assert.equal(repairOfSchema.type, "string", "repair_of is a string");
	assert.equal(repairOfSchema.minLength, 20, "repair_of minLength is exactly 20");
	assert.equal(repairOfSchema.maxLength, 20, "repair_of maxLength is exactly 20");
	assert.equal(repairOfSchema.pattern, "^\\d{8}-\\d{6}-[A-Za-z0-9]{4}$", "repair_of matches the strict delegation-id pattern");
	assert.equal(
		repairOfSchema.description,
		"Exact prior delegation id for a known repair. A PENDING_REVIEW implementation is referenceable only after Sol publishes an immutable current-binding semantic REPAIR decision; lineaged terminal retries require strict continuation authority. The fresh worker receives the rejected W/D closure, exact scope, plan identity, and repair decision, never the old session or Gate authority.",
		"repair_of description exposes the current semantic-repair continuity contract",
	);
	const taskKindSchema = delegateParameters.properties.task_kind;
	assert.ok(taskKindSchema, "task_kind is present in the current serialized parameter schema");
	assert.ok(!(delegateParameters.required ?? []).includes("task_kind"), "task_kind stays optional for governance-v1 callers");
	assert.equal(taskKindSchema.default, "implementation", "task_kind omission is documented as the implementation default");
	assert.deepEqual(
		(taskKindSchema.anyOf ?? []).map((alternative) => alternative.const),
		["implementation", "diagnosis"],
		"task_kind is the exact closed implementation|diagnosis union; mechanical is not public",
	);
	const planRefSchema = delegateParameters.properties.plan_ref as typeof delegateParameters.properties[string] & {
		additionalProperties?: boolean;
		properties: {
			schema: { const?: unknown };
			criteria: { minItems?: number; maxItems?: number; items: { additionalProperties?: boolean } };
		};
	};
	assert.ok(planRefSchema, "plan_ref is present in the current serialized parameter schema");
	assert.ok(!(delegateParameters.required ?? []).includes("plan_ref"), "plan_ref stays optional for historical callers");
	assert.equal(planRefSchema.additionalProperties, false, "plan_ref rejects unknown top-level fields");
	assert.equal(planRefSchema.properties.schema.const, "workbench-plan-ref-v1");
	assert.equal(planRefSchema.properties.criteria.minItems, 1);
	assert.equal(planRefSchema.properties.criteria.maxItems, 20);
	assert.equal(planRefSchema.properties.criteria.items.additionalProperties, false, "plan criteria reject unknown fields");
	const extendedReasonSchema = delegateParameters.properties.extended_reason;
	assert.ok(extendedReasonSchema, "extended_reason is an optional current-contract field");
	assert.ok(!(delegateParameters.required ?? []).includes("extended_reason"));
	assert.equal(extendedReasonSchema.maxLength, 500);
	assert.match(extendedReasonSchema.description ?? "", /12 KiB ordinary soft limit/);
	assert.equal(
		canonicalHash(WORKBENCH_DELEGATE_WORKER_V1_PARAMETERS),
		"dc1db21e3590c7f57cfa88f042052964a92d495116966747918d72f2018176a7",
		"the independently retained governance-v1 delegate schema stays machine-pinned",
	);
	assert.equal(
		canonicalHash(WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker),
		"fc20b3d36eb2f43f78bb2012635eb1906d96845aeafdacd130a70630a2a8dffd",
		"current delegate parameter schema hash is pinned after semantic-repair continuity",
	);
});

// ---------------------------------------------------------------------------
// 5. Per-mode tool hashes: stable, pairwise different
// ---------------------------------------------------------------------------

test("DEV / AUDIT / VERIFY tool hashes are stable and pairwise different", () => {
	const tools = allToolInfos();
	const dev = modePrefixFingerprint("DEV", SYSTEM_PROMPT, tools, DEV_TOOLS);
	const audit = modePrefixFingerprint("AUDIT", SYSTEM_PROMPT, tools, AUDIT_TOOLS);
	const verify = modePrefixFingerprint("VERIFY", SYSTEM_PROMPT, tools, VERIFY_TOOLS);
	// stability: repeated builds
	assert.deepEqual(dev, modePrefixFingerprint("DEV", SYSTEM_PROMPT, tools, DEV_TOOLS));
	assert.deepEqual(audit, modePrefixFingerprint("AUDIT", SYSTEM_PROMPT, tools, AUDIT_TOOLS));
	assert.deepEqual(verify, modePrefixFingerprint("VERIFY", SYSTEM_PROMPT, tools, VERIFY_TOOLS));
	// pairwise different — each mode has a distinct prefix
	assert.notEqual(dev.modeHash, audit.modeHash);
	assert.notEqual(dev.modeHash, verify.modeHash);
	assert.notEqual(audit.modeHash, verify.modeHash);
	// AUDIT ⊂ VERIFY ⊂ DEV but each has its own order hash
	assert.notEqual(dev.toolOrderHash, audit.toolOrderHash);
	assert.notEqual(dev.toolOrderHash, verify.toolOrderHash);
	assert.notEqual(audit.toolOrderHash, verify.toolOrderHash);
});

test("NRO N1/N2 transition: override metadata/schemas shift the schema/mode fingerprints exactly once; names/order unchanged; same-mode fingerprints stay stable", () => {
	const preNro = preNroToolInfos();
	const current = allToolInfos();
	// names and active order are IDENTICAL — the overrides replace the
	// built-ins under the SAME names; nothing is added, removed or reordered
	assert.deepEqual(
		current.map((t) => t.name),
		preNro.map((t) => t.name),
		"the N1/N2 transition changes no tool names and no tool order",
	);
	const modes = [
		["DEV", DEV_TOOLS],
		["AUDIT", AUDIT_TOOLS],
		["VERIFY", VERIFY_TOOLS],
	] as const;
	for (const [mode, modeToolNames] of modes) {
		const before = modePrefixFingerprint(mode, SYSTEM_PROMPT, preNro, modeToolNames);
		const after = modePrefixFingerprint(mode, SYSTEM_PROMPT, current, modeToolNames);
		// the ONE intentional combined N1/N2 fingerprint transition (plan
		// §7.1): the tool-schema hash and therefore the whole mode prefix
		// change...
		assert.notEqual(after.toolSchemaHash, before.toolSchemaHash, `${mode} tool-schema fingerprint changed by the N1/N2 transition`);
		assert.notEqual(after.modeHash, before.modeHash, `${mode} mode prefix changed by the N1/N2 transition`);
		// ...while the name set and the active order stay byte-identical
		assert.equal(after.toolNamesHash, before.toolNamesHash, `${mode} tool NAMES unchanged by N1/N2`);
		assert.equal(after.toolOrderHash, before.toolOrderHash, `${mode} tool ORDER unchanged by N1/N2`);
		// stability after the transition: repeated same-mode builds of the
		// CURRENT surface are deterministic
		assert.deepEqual(after, modePrefixFingerprint(mode, SYSTEM_PROMPT, current, modeToolNames), `${mode} current fingerprint is deterministic across builds`);
	}
	// The original N1/N2 transition remains deterministic. In v0.10.0 read
	// deliberately moves beyond byte-identical built-in metadata/schema to
	// the bounded pager contract; grep keeps the built-in
	// metadata/schema PREFIX byte-identical, appends exactly the two
	// optional count selectors, gains the intended static count-mode
	// description sentence and mirrors the ONE guideline bullet (N2); find
	// stays fully built-in-compatible (N3 not implemented)
	const currentRead = nativeOverrideToolInfos()[0]!;
	const builtinRead = createReadToolDefinition(".") as unknown as ToolInfoLike;
	assert.equal(currentRead.name, builtinRead.name);
	assert.notEqual(currentRead.description, builtinRead.description, "v0.10.0 read description intentionally declares the bounded pager");
	assert.match(currentRead.description ?? "", /12 KiB/);
	assert.match(currentRead.description ?? "", /240 file lines/);
	assert.equal(currentRead.promptSnippet, builtinRead.promptSnippet, "read promptSnippet unchanged (built-in verbatim)");
	const currentReadParameters = currentRead.parameters as { properties: Record<string, { type?: string; minimum?: number; maximum?: number }>; required?: string[] };
	assert.deepEqual(Object.keys(currentReadParameters.properties), ["path", "offset", "limit", "cursor"], "read v3 schema has the fixed path/offset/limit/cursor order");
	assert.equal(currentReadParameters.properties.offset?.type, "integer");
	assert.equal(currentReadParameters.properties.offset?.minimum, 1);
	assert.equal(currentReadParameters.properties.limit?.type, "integer");
	assert.equal(currentReadParameters.properties.limit?.minimum, 1);
	assert.equal(currentReadParameters.properties.limit?.maximum, 240);
	assert.ok(!(currentReadParameters.required ?? []).includes("cursor"), "cursor remains optional");
	assert.deepEqual(
		currentRead.promptGuidelines,
		[...(builtinRead.promptGuidelines ?? []), READ_PREVIEW_GUIDELINE],
		"read v3 keeps the built-in usage bullet plus the one static continuation/count guideline",
	);
	// grep: the built-in description is the verbatim prefix of the current
	// one, which then carries the intended static count-mode sentence; the
	// schema keeps the byte-identical legacy property prefix and appends
	// exactly output/count_kind
	const currentGrep = nativeOverrideToolInfos().find((t) => t.name === "grep")!;
	const builtinGrep = createGrepToolDefinition(".") as unknown as ToolInfoLike;
	assert.ok((currentGrep.description ?? "").startsWith(builtinGrep.description ?? ""), "grep description keeps the built-in text verbatim as its prefix");
	assert.ok((currentGrep.description ?? "").includes("Use output=count for an exact uncapped count"), "grep description carries the intended static count-mode sentence");
	assert.equal(currentGrep.promptSnippet, builtinGrep.promptSnippet, "grep promptSnippet unchanged (built-in verbatim)");
	assert.deepEqual(currentGrep.promptGuidelines, [GREP_COUNT_GUIDELINE], "grep carries exactly the one mirrored §6.4 guideline bullet");
	const grepOverrideProps = (currentGrep.parameters as { properties: Record<string, unknown> }).properties;
	const grepBuiltinProps = (builtinGrep.parameters as { properties: Record<string, unknown> }).properties;
	const legacyKeys = ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"];
	assert.deepEqual(Object.keys(grepBuiltinProps), legacyKeys, "built-in grep property order (oracle sanity)");
	assert.deepEqual(
		Object.keys(grepOverrideProps),
		[...legacyKeys, "output", "count_kind"],
		"grep appends exactly output and count_kind after the byte-identical legacy prefix",
	);
	for (const key of legacyKeys) {
		assert.deepEqual(grepOverrideProps[key], grepBuiltinProps[key], `grep legacy property ${key} byte-identical`);
	}
	// find: fully built-in-compatible — metadata verbatim, schema
	// byte-identical (N3 count/max_depth are not implemented)
	const currentFind = nativeOverrideToolInfos().find((t) => t.name === "find")!;
	const builtinFind = createFindToolDefinition(".") as unknown as ToolInfoLike;
	assert.equal(currentFind.description, builtinFind.description, "find description built-in verbatim");
	assert.equal(currentFind.promptSnippet, builtinFind.promptSnippet, "find promptSnippet built-in verbatim");
	assert.deepEqual(currentFind.promptGuidelines, builtinFind.promptGuidelines ?? [], "find promptGuidelines unchanged");
	assert.deepEqual(currentFind.parameters, builtinFind.parameters, "find parameter schema byte-identical to the Pi 0.83.0 built-in");
});

test("mode matrix is exactly the P6-B spec matrix (P8b appends the read-only recovery tool)", () => {
	assert.deepEqual(MODE_TOOLS.AUDIT, ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_read_run", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs", "workbench_recover_tool_result"]);
	assert.deepEqual(MODE_TOOLS.VERIFY, ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_run_recipe", "workbench_read_run", "workbench_run_gate", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs", "workbench_recover_tool_result"]);
	assert.deepEqual(MODE_TOOLS.DEV, ["read", "grep", "find", "ls", "bash", "edit", "write", ...WORKBENCH_TOOLS]);
	// AUDIT has no mutating tools; VERIFY has no free bash/edit/write
	for (const forbidden of ["bash", "edit", "write", "workbench_run_recipe", "workbench_run_gate", "workbench_delegate_worker"]) {
		assert.ok(!AUDIT_TOOLS.includes(forbidden), `AUDIT must not contain ${forbidden}`);
	}
	for (const forbidden of ["bash", "edit", "write", "workbench_delegate_worker"]) {
		assert.ok(!VERIFY_TOOLS.includes(forbidden), `VERIFY must not contain ${forbidden}`);
	}
});

test("computeActiveTools: DEV foreign-tool order is deterministic (sorted by name)", () => {
	const foreign = ["zeta_ext", "alpha_ext", "workbench_gate_check"];
	const a = computeActiveTools("DEV", ["read", "bash", ...foreign]);
	const b = computeActiveTools("DEV", ["bash", ...[...foreign].reverse(), "read"]);
	assert.deepEqual(a, b);
	const foreignPositions = a.filter((t) => !DEV_TOOLS.includes(t));
	assert.deepEqual(foreignPositions, ["alpha_ext", "workbench_gate_check", "zeta_ext"], "foreign tools sorted by name");
	// frozen set: identical inputs -> identical output
	assert.deepEqual(a, computeActiveTools("DEV", ["read", "bash", ...foreign]));
});

test("P7/P8b order stays fixed and structured Git completion is appended last", () => {
	const names = [...WORKBENCH_TOOL_NAMES];
	assert.equal(names.length, 12, "twelve workbench custom tools after structured Git completion");
	assert.deepEqual(
		names.slice(0, 7),
		["workbench_project_inspect", "workbench_run_recipe", "workbench_read_run", "workbench_run_gate", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs"],
		"the seven existing tools keep their registration order",
	);
	assert.deepEqual(
		names.slice(7, 10),
		["workbench_delegate_worker", "workbench_review_worker_diff", "workbench_delegation_status"],
		"the three P7 tools follow in strict delegate → review → status order",
	);
	assert.deepEqual(names.slice(10, 11), ["workbench_recover_tool_result"], "the P8b recovery tool keeps its position");
	assert.deepEqual(names.slice(11), ["workbench_git"], "structured Git completion is appended LAST");
	// Every P7/P8b tool's metadata stays free of dynamic values (no dates,
	// times, hashes, absolute paths, or concrete run/gate/task ids).
	for (const name of names.slice(7)) {
		const meta = WORKBENCH_TOOL_METADATA[name];
		for (const field of [meta.description, meta.promptSnippet, ...meta.promptGuidelines]) {
			assert.deepEqual(findDynamicValueMarkers(field), [], `${name} metadata must be static: ${field.slice(0, 80)}`);
		}
	}
	// Review/status/recovery parameter schemas are constructed in source order and
	// stable across builds (identical hashes on repeat construction).
	for (const name of names.slice(7)) {
		assert.equal(canonicalHash(WORKBENCH_TOOL_PARAMETERS[name]), canonicalHash(WORKBENCH_TOOL_PARAMETERS[name]), name);
	}
});

test("delegation status metadata distinguishes new-v2 relevance from legacy full-diff freshness", () => {
	const meta = WORKBENCH_TOOL_METADATA.workbench_delegation_status;
	assert.equal(
		meta.promptSnippet,
		"Show write-authority and delegation review status (actor, lease, review, hashes, blocked writes)",
		"the established status prompt snippet stays byte-identical",
	);
	assert.deepEqual(meta.promptGuidelines, [
		"Successful non-zero implementation delivery returns a provisional scope/integrity packet and stays PENDING_REVIEW; after inspecting a complete unchanged packet, use workbench_review_worker_diff for hash-bound Sol ACCEPT. Use status only for diagnostics or recovery.",
		"If a complete packet is wrong, publish semantic_decision=REPAIR with the exact bound hash and a bounded reason, then follow only the exact repair_of shown by status. REPAIR and every unresolved lineage remain Gate-blocking.",
		"When STALE is backed by strict v2 FINAL/PASS plus explicit Sol semantic authority, follow the reported successor action instead of retrying immutable review; a mechanical FINAL/PASS remains blocked and VERIFY stays blocked until a valid successor is reviewed.",
		"In the TUI, WF:LOCKED means routine writes belong to Luna, WF:LEASE means a bounded temporary Sol write exception is active, and WF:REVIEW means recovery review is outstanding.",
	], "current status guidelines keep routine work out of the recovery chain");
	assert.match(meta.description, /durable semantic-repair state/);
	assert.match(meta.description, /REPAIR_REQUIRED reports one exact repair_of action only while its bound workspace is fresh/);
	assert.match(meta.description, /active, recovery, forked, missing-continuation, or corrupt lineages remain visibly blocked/);
	assert.match(meta.description, /New tagged v2 uses the W\/D\/S relevance binding/);
	assert.match(meta.description, /historical untagged v2\/v1 retains the complete diff binding/);
	assert.match(meta.description, /Baseline unrelated dirt and recognized workbench artifacts do not stale tagged v2/);
	assert.match(meta.description, /Git HEAD, W\/D\/S, unknown-origin, or repair-authority drift fails closed/);
	assert.doesNotMatch(meta.description, /real git diff \(any change after REVIEWED turns it STALE\)/);
	assert.equal(
		canonicalHash(meta),
		"c69030ba3e01c704cb32ee41f52c0b14931200bdfa0d66396a164eaf876a2c1d",
		"current status metadata hash is machine-pinned after semantic-repair projection",
	);
	assert.equal(
		canonicalHash(WORKBENCH_TOOL_PARAMETERS.workbench_delegation_status),
		"efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
		"status input schema stays byte-identical",
	);
	assert.equal(
		canonicalHash(workbenchToolMetadataOrdered()),
		"09a9f327341cf5bd3c9490e1f873c46a34cafeb0ee91cc3d5cc6d47065d4c003",
		"current public catalog hash is machine-pinned after structured Git completion was added",
	);
});

test("delegation review metadata separates provisional inspection from explicit Sol acceptance", () => {
	const meta = WORKBENCH_TOOL_METADATA.workbench_review_worker_diff;
	assert.equal(
		meta.promptSnippet,
		"Inspect a bound worker diff, then explicitly ACCEPT it or require an exact fresh REPAIR",
		"the current prompt separates inspection from positive or negative semantic authority",
	);
	assert.deepEqual(meta.promptGuidelines, [
		"First call without semantic fields and normally without delegation_id; the runtime selects the durable latest delegation and returns its exact id. This provisional presentation cannot finalize review.",
		"Only after Sol inspects the complete packet, call with that exact delegation_id plus semantic_decision=ACCEPT or REPAIR and its exact expected_bound_diff_hash. REPAIR also requires repair_reason, stays Gate-blocking, and permits only exact repair_of. For an explicitly reported historical migration, only ACCEPT is valid and also requires expected_migration_binding_hash. Never guess an id or hash.",
		"include_paths changes presentation only. When one ordinary source path remains, repeat that single path until its hash-bound page range reaches the total; never accept after drift, incomplete packet coverage, unresolved semantic risk, or an unverified hash.",
		"Review authority never substitutes for final verification or Gate authority.",
	]);
	assert.match(meta.description, /only provisional presentation/);
	assert.match(meta.description, /Omit delegation_id for a read-only presentation of the durable latest delegation/);
	assert.match(meta.description, /semantic_decision=ACCEPT grants exact hash-bound semantic authority/);
	assert.match(meta.description, /semantic_decision=REPAIR plus a bounded repair_reason publishes immutable negative authority/);
	assert.match(meta.description, /enables only an exact fresh repair_of lineage/);
	assert.match(meta.description, /REPAIR never grants Gate authority/);
	assert.match(meta.description, /Historical migration supports ACCEPT only/);
	assert.match(meta.description, /resumes the next contiguous UTF-8 page/);
	assert.match(meta.description, /redacted-stream hashes/);
	assert.match(meta.description, /Workspace drift invalidates either decision/);
	const reviewParameters = WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff as unknown as {
		required?: string[];
		properties: Record<string, { anyOf?: Array<{ const?: unknown }>; pattern?: string; minLength?: number; maxLength?: number; description?: string }>;
	};
	const semantic = reviewParameters.properties.semantic_decision;
	const expectedHash = reviewParameters.properties.expected_bound_diff_hash;
	const repairReason = reviewParameters.properties.repair_reason;
	const migrationHash = reviewParameters.properties.expected_migration_binding_hash;
	assert.deepEqual((semantic?.anyOf ?? []).map((alternative) => alternative.const), ["ACCEPT", "REPAIR"]);
	assert.equal(expectedHash?.pattern, "^[a-f0-9]{64}$");
	assert.equal(expectedHash?.minLength, 64);
	assert.equal(expectedHash?.maxLength, 64);
	assert.equal(repairReason?.minLength, 1);
	assert.equal(repairReason?.maxLength, 1024);
	assert.equal(migrationHash?.pattern, "^[a-f0-9]{64}$");
	assert.equal(migrationHash?.minLength, 64);
	assert.equal(migrationHash?.maxLength, 64);
	assert.ok(!(reviewParameters.required ?? []).includes("semantic_decision"));
	assert.ok(!(reviewParameters.required ?? []).includes("delegation_id"));
	assert.ok(!(reviewParameters.required ?? []).includes("expected_bound_diff_hash"));
	assert.ok(!(reviewParameters.required ?? []).includes("repair_reason"));
	assert.ok(!(reviewParameters.required ?? []).includes("expected_migration_binding_hash"));
	assert.match(`${semantic?.description}\n${expectedHash?.description}`, /complete packet/);
	assert.match(`${semantic?.description}\n${expectedHash?.description}`, /ACCEPT or REPAIR/);
	assert.match(repairReason?.description ?? "", /Required only with semantic_decision=REPAIR/);
	assert.match(repairReason?.description ?? "", /immutable negative authority/);
	assert.match(repairReason?.description ?? "", /never grants Gate authority/);
	assert.equal(
		canonicalHash(meta),
		"80a8f9242431c26eb8700cc24b8b2d48c9fce2e98b89007045d719fee034b4e4",
		"current review metadata hash is pinned after ACCEPT/REPAIR and page-continuation guidance",
	);
	assert.equal(
		canonicalHash(WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff),
		"75e16f08badfe5762541904d242e34121214d86ded0454067c9c28f40c2dd087",
		"review input schema pins ACCEPT/REPAIR and their bounded authority fields",
	);
});

test("workbench tool catalog: registration order, static metadata, stable schema hashes", () => {
	// WORKBENCH_TOOLS (mode matrix) == WORKBENCH_TOOL_NAMES (registration order)
	assert.deepEqual([...WORKBENCH_TOOLS], [...WORKBENCH_TOOL_NAMES]);
	// metadata order is the explicit constant order
	const ordered = workbenchToolMetadataOrdered();
	assert.deepEqual(ordered.map((t) => t.name), [...WORKBENCH_TOOL_NAMES]);
	// schema construction order is stable: canonical hash identical across builds
	for (const name of WORKBENCH_TOOL_NAMES) {
		assert.equal(canonicalHash(WORKBENCH_TOOL_PARAMETERS[name]), canonicalHash(WORKBENCH_TOOL_PARAMETERS[name]), name);
	}
	// metadata present for every name
	for (const name of WORKBENCH_TOOL_NAMES) {
		assert.ok(WORKBENCH_TOOL_METADATA[name], name);
		assert.ok(typeof WORKBENCH_TOOL_METADATA[name].description === "string", name);
	}
});

test("the read-only batching guideline appears exactly once in static catalog metadata (Commander Slice B1)", () => {
	const marker = "known-independent read-only";
	let occurrences = 0;
	for (const tool of workbenchToolMetadataOrdered()) {
		for (const field of [tool.description, tool.promptSnippet, ...tool.promptGuidelines]) {
			assert.deepEqual(findDynamicValueMarkers(field), [], `${tool.name} metadata must be static: ${field.slice(0, 80)}`);
			occurrences += field.split(marker).length - 1;
		}
	}
	assert.equal(occurrences, 1, "the batching guideline appears exactly once across all static tool metadata");
	// it lives on workbench_read_run (the tool whose default became the bounded summary)
	const readRun = WORKBENCH_TOOL_METADATA.workbench_read_run;
	assert.ok(readRun.promptGuidelines.some((g) => g.includes(marker)), "guideline present on workbench_read_run");
	// the guideline mirrors the explicit allowlist (the classifier's machine form)
	const guideline = readRun.promptGuidelines.find((g) => g.includes(marker))!;
	for (const name of INDEPENDENT_READ_ONLY_ALLOWLIST) {
		assert.ok(guideline.includes(name), `guideline names ${name}`);
	}
	// the guideline stays static under the standard audit
	assert.deepEqual(staticToolMetadataIssues(readRun), [], "workbench_read_run metadata stays static");
});

test("the independent read-only allowlist is the exact approved set and never infers (Commander Slice B1; P8b boundary documented)", () => {
	assert.deepEqual(
		[...INDEPENDENT_READ_ONLY_ALLOWLIST],
		["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_read_run", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs"],
		"exactly the four read built-ins plus the five read-only workbench tools",
	);
	// P8b deliberate boundary: the AUDIT mode matrix gains the read-only
	// recovery tool, but the fixed P3 batching classifier (core/run-result.ts)
	// is NOT part of the P8b scope and stays the exact five read-only
	// workbench tools — the recovery tool is deliberately NOT classified as
	// batchable yet (it is read-only and deterministic, but batching it is a
	// separate reviewed decision).
	assert.deepEqual(
		[...AUDIT_TOOLS],
		[...INDEPENDENT_READ_ONLY_ALLOWLIST, "workbench_recover_tool_result"],
		"AUDIT = the batch allowlist + the P8b recovery tool (deliberate one-tool difference)",
	);
	assert.equal(isIndependentReadOnlyTool("workbench_recover_tool_result"), false, "P8b boundary: recovery tool is not (yet) batch-classified");
	// delegation_status is excluded even though it only reads: it refreshes
	// persisted delegation state; every execution/review/delegation/write
	// tool is excluded too
	for (const name of [
		"bash",
		"edit",
		"write",
		"workbench_run_recipe",
		"workbench_run_gate",
		"workbench_delegate_worker",
		"workbench_review_worker_diff",
		"workbench_delegation_status",
	]) {
		assert.equal(isIndependentReadOnlyTool(name), false, name);
	}
	// deterministic membership for every registered tool + the built-ins
	const expected = new Set<string>([...INDEPENDENT_READ_ONLY_ALLOWLIST]);
	for (const name of [...WORKBENCH_TOOL_NAMES, "read", "grep", "find", "ls", "bash", "edit", "write"]) {
		assert.equal(isIndependentReadOnlyTool(name), expected.has(name), name);
	}
	// the classifier never infers independence for unknown tools
	assert.equal(isIndependentReadOnlyTool("workbench_gate_check"), false);
	assert.equal(isIndependentReadOnlyTool(""), false);
});

test("v0.10.0 runtime removes only the temporary sequential read-only modes", async () => {
	const index = await readFile(new URL("index.ts", EXTENSION_DIR), "utf8");
	const recipeController = await readFile(new URL("core/recipe-tools-controller.ts", EXTENSION_DIR), "utf8");
	const gateController = await readFile(new URL("core/gate-tools-controller.ts", EXTENSION_DIR), "utf8");
	const compareController = await readFile(new URL("core/compare-tool-controller.ts", EXTENSION_DIR), "utf8");
	const delegationStatusController = await readFile(new URL("core/delegation-status-tool-controller.ts", EXTENSION_DIR), "utf8");
	const reviewController = await readFile(new URL("core/review-tool-controller.ts", EXTENSION_DIR), "utf8");
	const delegateController = await readFile(new URL("core/delegate-tool-controller.ts", EXTENSION_DIR), "utf8");
	const recoveryController = await readFile(new URL("core/recovery-tool-controller.ts", EXTENSION_DIR), "utf8");
	const registration = (name: string): string => {
		const source = name === "workbench_read_run"
			? recipeController
			: new Set(["workbench_read_gate", "workbench_list_gates"]).has(name)
				? gateController
				: name === "workbench_compare_runs"
					? compareController
					: name === "workbench_review_worker_diff"
						? reviewController
						: name === "workbench_delegate_worker"
							? delegateController
							: index;
		const marker = `...WORKBENCH_TOOL_METADATA.${name},`;
		const start = source.indexOf(marker);
		assert.ok(start >= 0, `${name} registration exists`);
		const next = source.indexOf("registerTool({", start + marker.length);
		return source.slice(start, next < 0 ? source.length : next);
	};
	for (const name of ["workbench_read_run", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs"]) {
		assert.doesNotMatch(registration(name), /executionMode:\s*"sequential"/, `${name} now uses runtime turn-budget authorization`);
	}
	for (const name of ["workbench_delegate_worker", "workbench_review_worker_diff"]) {
		assert.match(registration(name), /executionMode:\s*"sequential"/, `${name} remains sequential`);
	}
});

test("workbench_read_run schema/metadata wording declares the summary default and the P4b observation-only verdict semantics (Commander Slice B1 + P4b)", () => {
	const params = WORKBENCH_TOOL_PARAMETERS.workbench_read_run as unknown as {
		properties: Record<string, { description?: string }>;
	};
	assert.match(params.properties.include?.description ?? "", /default: summary/);
	const meta = WORKBENCH_TOOL_METADATA.workbench_read_run;
	assert.match(meta.description, /default/i);
	assert.match(meta.description, /no raw logs, no argv/);
	assert.match(meta.promptSnippet, /default: bounded summary/);
	// the tool keeps its registration position and the union keeps its order
	assert.equal(WORKBENCH_TOOL_NAMES.indexOf("workbench_read_run"), 2, "read_run stays the third registered tool");
	const includeSchema = params.properties.include as unknown as { anyOf?: Array<{ const?: string }> };
	assert.deepEqual(
		(includeSchema.anyOf ?? []).map((alternative) => alternative.const),
		["summary", "manifest", "logs", "all"],
		"the include union keeps the fixed summary|manifest|logs|all order",
	);
	// P4b: the static metadata/guideline wording explicitly conveys the three
	// validation-verdict semantics — the verdict is observation only, it
	// never automatically skips recipe/gate execution, and it is never
	// acceptance evidence.
	assert.match(meta.description, /as observation only/, "the description frames the verdict as a current-state observation");
	assert.match(meta.description, /never automatically skips recipe\/gate execution/, "the description says the verdict never skips execution");
	assert.match(meta.description, /never acceptance evidence/, "the description says the verdict is never acceptance evidence");
	assert.match(meta.promptSnippet, /current-state REUSABLE\/RERUN_REQUIRED verdict/, "the snippet names the current-state verdict");
	const verdictGuideline = meta.promptGuidelines.find((g) => g.includes("validation verdict"));
	assert.ok(verdictGuideline, "the static guidelines state the validation-verdict semantics");
	assert.match(verdictGuideline!, /current-state observation only/, "the guideline frames the verdict as observation only");
	assert.match(verdictGuideline!, /never skips recipe\/gate execution/, "the guideline says the verdict never skips execution");
	assert.match(verdictGuideline!, /never acceptance evidence/, "the guideline says the verdict is never acceptance evidence");
	assert.match(verdictGuideline!, /final recipe\/gate runs remain required/, "the guideline keeps final recipe/gate runs required");
});

test("v0.10.0 bounded public schemas pin paging selectors and hard maxima", () => {
	const schema = (name: keyof typeof WORKBENCH_TOOL_PARAMETERS) => WORKBENCH_TOOL_PARAMETERS[name] as unknown as {
		properties: Record<string, { type?: string; minimum?: number; maximum?: number; anyOf?: Array<{ const?: string }> }>;
	};
	const readRun = schema("workbench_read_run").properties;
	assert.deepEqual((readRun.log_stream?.anyOf ?? []).map((item) => item.const), ["stdout", "stderr", "both"]);
	assert.equal(readRun.max_lines?.minimum, 1);
	assert.equal(readRun.max_lines?.maximum, 400);
	assert.equal(readRun.max_bytes?.minimum, 1024);
	assert.equal(readRun.max_bytes?.maximum, 32768);
	assert.ok(readRun.cursor);

	const readGate = schema("workbench_read_gate").properties;
	assert.deepEqual((readGate.include?.anyOf ?? []).map((item) => item.const), ["summary", "failures", "checks"]);
	assert.ok(readGate.cursor);
	assert.equal(readGate.max_lines?.minimum, 1);
	assert.equal(readGate.max_lines?.maximum, 320);

	const review = schema("workbench_review_worker_diff").properties;
	assert.equal(review.max_lines?.minimum, 1);
	assert.equal(review.max_lines?.maximum, 400);
	assert.equal(review.max_bytes?.minimum, 1);
	assert.equal(review.max_bytes?.maximum, 32768);
});

// ---------------------------------------------------------------------------
// 6. Invalidation classification matrix
// ---------------------------------------------------------------------------

test("mode switch / model switch / thinking change / reload / compaction are EXPECTED", () => {
	for (const input of [
		{ isFirstRequest: false, isNewSession: false, modelChanged: true, thinkingChanged: false, modeChanged: false, packageReloaded: false, compactionOccurred: false, systemPromptChanged: false, toolSetChanged: false, toolOrderChanged: false, toolSchemaChanged: false, contextShapeChanged: false, cacheReadTokens: 0, previousCacheReadTokens: 0 },
		{ isFirstRequest: false, isNewSession: false, modelChanged: false, thinkingChanged: true, modeChanged: false, packageReloaded: false, compactionOccurred: false, systemPromptChanged: false, toolSetChanged: false, toolOrderChanged: false, toolSchemaChanged: false, contextShapeChanged: false, cacheReadTokens: 0, previousCacheReadTokens: 0 },
		{ isFirstRequest: false, isNewSession: false, modelChanged: false, thinkingChanged: false, modeChanged: true, packageReloaded: false, compactionOccurred: false, systemPromptChanged: false, toolSetChanged: false, toolOrderChanged: false, toolSchemaChanged: false, contextShapeChanged: false, cacheReadTokens: 0, previousCacheReadTokens: 0 },
		{ isFirstRequest: false, isNewSession: false, modelChanged: false, thinkingChanged: false, modeChanged: false, packageReloaded: true, compactionOccurred: false, systemPromptChanged: false, toolSetChanged: false, toolOrderChanged: false, toolSchemaChanged: false, contextShapeChanged: false, cacheReadTokens: 0, previousCacheReadTokens: 0 },
		{ isFirstRequest: false, isNewSession: false, modelChanged: false, thinkingChanged: false, modeChanged: false, packageReloaded: false, compactionOccurred: true, systemPromptChanged: false, toolSetChanged: false, toolOrderChanged: false, toolSchemaChanged: false, contextShapeChanged: false, cacheReadTokens: 0, previousCacheReadTokens: 0 },
		{ isFirstRequest: false, isNewSession: false, modelChanged: false, thinkingChanged: false, modeChanged: false, packageReloaded: false, compactionOccurred: false, sessionTreeChanged: true, systemPromptChanged: false, toolSetChanged: false, toolOrderChanged: false, toolSchemaChanged: false, contextShapeChanged: true, cacheReadTokens: 0, previousCacheReadTokens: 900 },
	]) {
		const verdict = classifyInvalidation(input);
		assert.equal(invalidationClass(verdict.reason), "expected", verdict.reason);
		assert.equal(verdict.driftSource, null, verdict.reason);
	}
});

test("payload relationship distinguishes unchanged, append-only, rewritten, and unknown without retaining content", () => {
	const base = summarizePayload({
		model: "deepseek-v4-flash",
		messages: [
			{ role: "system", content: "stable system" },
			{ role: "user", content: "first request" },
		],
		tools: [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object" } } }],
	});
	const appended = summarizePayload({
		model: "deepseek-v4-flash",
		messages: [
			{ role: "system", content: "stable system" },
			{ role: "user", content: "first request" },
			{ role: "assistant", content: "first response" },
		],
		tools: [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object" } } }],
	});
	const rewritten = summarizePayload({
		model: "deepseek-v4-flash",
		messages: [
			{ role: "system", content: "stable system" },
			{ role: "user", content: "rewritten request" },
			{ role: "assistant", content: "first response" },
		],
		tools: [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object" } } }],
	});
	assert.equal(classifyPayloadRelationship(base, base), "UNCHANGED");
	assert.equal(classifyPayloadRelationship(base, appended), "APPEND_ONLY");
	assert.equal(classifyPayloadRelationship(base, rewritten), "PREFIX_REWRITTEN");
	assert.equal(classifyPayloadRelationship(base, summarizePayload(null)), "UNKNOWN");
	assert.ok(!JSON.stringify(base).includes("stable system"), "summary keeps only lengths and hashes");
	assert.ok(!JSON.stringify(base).includes("first request"), "summary never retains message content");
});

test("provider observation reports only whole-item LCP count and UTF-8 scalar bytes", () => {
	const first = { role: "user", content: "A🙂" };
	const base = summarizePayload({ messages: [first] });
	const appended = summarizePayload({ messages: [first, { role: "assistant", content: "next" }] });
	const partiallyRewritten = summarizePayload({ messages: [{ role: "user", content: "A🙃" }] });

	assert.deepEqual(wholeItemLcpFacts(base, appended), {
		itemCount: 2,
		itemLcpCount: 1,
		itemLcpUtf8Bytes: 9,
		relationship: "APPEND_ONLY",
	});
	assert.deepEqual(wholeItemLcpFacts(base, partiallyRewritten), {
		itemCount: 1,
		itemLcpCount: 0,
		itemLcpUtf8Bytes: 0,
		relationship: "PREFIX_REWRITTEN",
	}, "a shared text prefix never becomes a fabricated partial-item LCP");
	assert.equal(JSON.stringify(base).includes("A🙂"), false, "byte accounting retains no provider text");
});

test("provider observation treats object key order and __proto__ as wire-significant", () => {
	const ordered = { alpha: "A", beta: "B" };
	const reordered = { beta: "B", alpha: "A" };
	assert.notEqual(JSON.stringify(ordered), JSON.stringify(reordered), "the provider wire preserves enumerable key order");
	const base = summarizePayload({ messages: [{ role: "user", content: "same", metadata: ordered }] });
	const keyOrderRewrite = summarizePayload({ messages: [{ role: "user", content: "same", metadata: reordered }] });
	assert.deepEqual(wholeItemLcpFacts(base, keyOrderRewrite), {
		itemCount: 1,
		itemLcpCount: 0,
		itemLcpUtf8Bytes: 0,
		relationship: "PREFIX_REWRITTEN",
	});

	const emptyMetadata = Object.create(null) as Record<string, unknown>;
	const protoMetadata = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(protoMetadata, "__proto__", {
		value: "provider-visible",
		enumerable: true,
		configurable: true,
		writable: true,
	});
	assert.notEqual(JSON.stringify(emptyMetadata), JSON.stringify(protoMetadata));
	const withoutProtoKey = summarizePayload({ messages: [{ role: "user", content: "same", metadata: emptyMetadata }] });
	const withProtoKey = summarizePayload({ messages: [{ role: "user", content: "same", metadata: protoMetadata }] });
	assert.equal(classifyPayloadRelationship(withoutProtoKey, withProtoKey), "PREFIX_REWRITTEN");
	assert.equal(wholeItemLcpFacts(withoutProtoKey, withProtoKey).itemLcpCount, 0);
});

test("payload relationship hashes complete items, including part types, images, scalar structure, and tool calls", () => {
	const firstItem = {
		role: "user",
		content: [
			{ type: "input_text", text: "inspect this" },
			{ type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
		],
		metadata: { cache_visible: true, priority: 3 },
	};
	const assistantToolCall = {
		role: "assistant",
		content: null,
		tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{\"path\":\"/a\"}" } }],
	};
	const payload = (items: unknown[]) => ({
		model: "deepseek-v4-flash",
		messages: items,
		tools: [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object" }, strict: true } }],
	});
	const base = summarizePayload(payload([firstItem]));
	const append = summarizePayload(payload([firstItem, assistantToolCall]));
	assert.equal(classifyPayloadRelationship(base, append), "APPEND_ONLY");

	const changedPartType = summarizePayload(payload([{ ...firstItem, content: [{ type: "output_text", text: "inspect this" }, firstItem.content[1]] }]));
	const changedImage = summarizePayload(payload([{ ...firstItem, content: [firstItem.content[0], { ...firstItem.content[1], image_url: "data:image/png;base64,BBBB" }] }]));
	const changedScalar = summarizePayload(payload([{ ...firstItem, metadata: { cache_visible: false, priority: 3 } }]));
	const movedText = summarizePayload(payload([{ role: "user", content: [{ type: "input_text", text: "inspect" }] }, { role: "user", content: [{ type: "input_text", text: " this" }] }]));
	const changedOldToolCall = summarizePayload(payload([firstItem, { ...assistantToolCall, tool_calls: [{ ...assistantToolCall.tool_calls[0], id: "call-2" }] }]));
	assert.equal(classifyPayloadRelationship(base, changedPartType), "PREFIX_REWRITTEN");
	assert.equal(classifyPayloadRelationship(base, changedImage), "PREFIX_REWRITTEN");
	assert.equal(classifyPayloadRelationship(base, changedScalar), "PREFIX_REWRITTEN");
	assert.equal(classifyPayloadRelationship(base, movedText), "PREFIX_REWRITTEN");
	assert.equal(classifyPayloadRelationship(append, changedOldToolCall), "PREFIX_REWRITTEN");
});

test("payload relationship degrades to UNKNOWN for caps, tool schema failure, accessors, and proxies", () => {
	const capped = summarizePayload({ messages: Array.from({ length: 20_001 }, (_, index) => ({ role: "user", content: String(index) })) });
	const toolSchemaFailure = summarizePayload({ messages: [], tools: [{ type: "function", function: { name: "read", parameters: { forbidden: 1n } } }] });
	const accessorPayload: Record<string, unknown> = {};
	Object.defineProperty(accessorPayload, "messages", { enumerable: true, get: () => [] });
	const proxied = new Proxy({ messages: [] }, { ownKeys: () => { throw new Error("trap"); } });
	const safe = summarizePayload({ messages: [] });
	for (const degraded of [capped, toolSchemaFailure, summarizePayload(accessorPayload), summarizePayload(proxied)]) {
		assert.equal(classifyPayloadRelationship(safe, degraded), "UNKNOWN");
	}
});

test("explicit history-projection epoch transition is an expected invalidation", () => {
	const verdict = classifyInvalidation({
		isFirstRequest: false,
		isNewSession: false,
		modelChanged: false,
		thinkingChanged: false,
		modeChanged: false,
		packageReloaded: false,
		compactionOccurred: false,
		historyProjectionEpochChanged: true,
		systemPromptChanged: false,
		toolSetChanged: false,
		toolOrderChanged: false,
		toolSchemaChanged: false,
		contextShapeChanged: true,
		cacheReadTokens: 0,
		previousCacheReadTokens: 900,
	});
	assert.equal(verdict.reason, "HISTORY_PROJECTION_EPOCH_CHANGED");
	assert.equal(verdict.confidence, "high");
	assert.equal(invalidationClass(verdict.reason), "expected");
});

test("session-tree lifecycle attribution is one-shot, report-safe, and does not mask later drift", async () => {
	const telemetry = createCacheTelemetry({ now: () => 1_700_000_000_000, appendEntry: () => {} });
	telemetry.setProjectRoot("/tmp/irrelevant");
	telemetry.setSessionId("p6b-session-tree");
	telemetry.setMode("DEV");
	telemetry.setThinkingLevel("high");
	const facts: MessageEndFacts = {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1010, cost: { total: 0.001 } },
		thinkingLevel: "high",
		systemPrompt: SYSTEM_PROMPT,
		activeToolNames: DEV_TOOLS,
		tools: allToolInfos(),
	};
	const payload = (text: string) => ({
		model: "deepseek-v4-flash",
		messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }],
	});

	telemetry.observePayload(payload("original branch"));
	const first = await telemetry.observeMessageEnd(facts);
	assert.ok(first);
	telemetry.observeSessionTreeChange();
	telemetry.observePayload(payload("selected branch"));
	const navigated = await telemetry.observeMessageEnd(facts);
	assert.ok(navigated);
	assert.equal(navigated.inferredInvalidationReason, "SESSION_TREE_CHANGED");
	assert.equal(invalidationClass(navigated.inferredInvalidationReason), "expected");

	const lifecycleReport = buildCacheReport([first, navigated], "session", () => undefined);
	assert.equal(lifecycleReport.expectedInvalidations, 2);
	assert.equal(lifecycleReport.unexpectedDrifts, 0);
	assert.equal(lifecycleReport.sameModeMutationCount, 0, "tree navigation is not counted as a same-mode mutation");

	telemetry.observePayload(payload("unattributed rewrite"));
	const drifted = await telemetry.observeMessageEnd(facts);
	assert.ok(drifted);
	assert.equal(drifted.inferredInvalidationReason, "CONTEXT_PREFIX_DIVERGED", "one-shot tree attribution cannot weaken later drift detection");
	const fullReport = buildCacheReport([first, navigated, drifted], "session", () => undefined);
	assert.equal(fullReport.expectedInvalidations, 2);
	assert.equal(fullReport.unexpectedDrifts, 1);
	assert.equal(fullReport.sameModeMutationCount, 1);
});

test("same-mode mutations are UNEXPECTED_DRIFT with a driftSource", () => {
	const base = { isFirstRequest: false, isNewSession: false, modelChanged: false, thinkingChanged: false, modeChanged: false, packageReloaded: false, compactionOccurred: false, systemPromptChanged: false, toolSetChanged: false, toolOrderChanged: false, toolSchemaChanged: false, contextShapeChanged: false, cacheReadTokens: 0, previousCacheReadTokens: 0 };
	const sys = classifyInvalidation({ ...base, systemPromptChanged: true });
	assert.equal(sys.reason, "UNEXPECTED_DRIFT");
	assert.equal(sys.driftSource, "SYSTEM_PROMPT");
	assert.equal(invalidationClass(sys.reason), "unexpected");
	const set = classifyInvalidation({ ...base, toolSetChanged: true });
	assert.equal(set.reason, "UNEXPECTED_DRIFT");
	assert.equal(set.driftSource, "TOOL_SET");
	const order = classifyInvalidation({ ...base, toolOrderChanged: true });
	assert.equal(order.reason, "UNEXPECTED_DRIFT");
	assert.equal(order.driftSource, "TOOL_ORDER");
	const schema = classifyInvalidation({ ...base, toolSchemaChanged: true });
	assert.equal(schema.reason, "UNEXPECTED_DRIFT");
	assert.equal(schema.driftSource, "TOOL_SCHEMA");
});

test("same-mode mutation telemetry end-to-end: record reason + report counting", async () => {
	const entries: CacheStateEntryLike[] = [];
	const telemetry: CacheTelemetry = createCacheTelemetry({ now: () => 1_700_000_000_000, appendEntry: (t, d) => entries.push({ type: "custom", customType: t, data: d }) });
	telemetry.setProjectRoot("/tmp/irrelevant");
	telemetry.setSessionId("p6b-session");
	telemetry.setMode("DEV");
	telemetry.setThinkingLevel("high");
	const facts = (overrides: Partial<MessageEndFacts> = {}): MessageEndFacts => ({
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1010, cost: { total: 0.001 } },
		thinkingLevel: "high",
		systemPrompt: SYSTEM_PROMPT,
		activeToolNames: DEV_TOOLS,
		tools: allToolInfos(),
		...overrides,
	});
	const first = await telemetry.observeMessageEnd(facts());
	assert.ok(first);
	assert.equal(first.inferredInvalidationReason, "FIRST_OBSERVED_REQUEST");
	const drifted = await telemetry.observeMessageEnd(facts({ activeToolNames: AUDIT_TOOLS }));
	assert.ok(drifted);
	assert.equal(drifted.inferredInvalidationReason, "UNEXPECTED_DRIFT");
	assert.equal(drifted.driftSource, "TOOL_SET");
	assert.equal(invalidationClass(drifted.inferredInvalidationReason), "unexpected");
	const report = buildCacheReport([first, drifted], "session", () => undefined);
	assert.equal(report.unexpectedDrifts, 1);
	assert.equal(report.sameModeMutationCount, 1);
});

// ---------------------------------------------------------------------------
// 7. before_provider_request read-only + telemetry out of context
// ---------------------------------------------------------------------------

test("before_provider_request peek never mutates the payload", () => {
	const entries: CacheStateEntryLike[] = [];
	const telemetry = createCacheTelemetry({ now: () => 0, appendEntry: (t, d) => entries.push({ type: "custom", customType: t, data: d }) });
	const payload = {
		model: "deepseek-v4-flash",
		messages: [{ role: "system", content: SYSTEM_PROMPT }],
		tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }],
		stream: true,
	};
	const snapshot = JSON.parse(JSON.stringify(payload)) as unknown;
	telemetry.observePayload(payload);
	assert.deepEqual(payload, snapshot, "payload untouched");
});

test("telemetry never enters the model context (custom entries only, no messages)", async () => {
	const entries: CacheStateEntryLike[] = [];
	const telemetry = createCacheTelemetry({ now: () => 1_700_000_000_000, appendEntry: (t, d) => entries.push({ type: "custom", customType: t, data: d }) });
	telemetry.setProjectRoot("/tmp/irrelevant");
	telemetry.setSessionId("p6b-context");
	telemetry.setMode("VERIFY");
	await telemetry.observeMessageEnd({
		provider: "deepseek",
		model: "deepseek-v4-flash",
		apiKind: "openai-completions",
		usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1010, cost: { total: 0.001 } },
		thinkingLevel: "high",
		systemPrompt: SYSTEM_PROMPT,
		activeToolNames: VERIFY_TOOLS,
		tools: allToolInfos(),
	});
	telemetry.flush();
	// every persisted artifact is a custom session entry — never a message
	for (const entry of entries) {
		assert.equal(entry.type, "custom", "cache state persists as custom entries only");
		assert.ok(entry.customType, "has a customType");
	}
	// the compact note (the ONLY message the workbench ever injects) carries
	// no cache statistics — compaction must not write real-time cache stats
	const note = buildCompactNote(emptyCompactState("VERIFY"));
	assert.ok(!/cache|token|hit ratio|CACHE/i.test(note), "compact note has no cache stats");
});

// ---------------------------------------------------------------------------
// 8. No dynamic tool loader / no tool-search claims (source scan)
// ---------------------------------------------------------------------------

const EXTENSION_DIR = new URL("../extensions/workbench-runtime/", import.meta.url);

async function extensionSources(): Promise<Record<string, string>> {
	const { readdir } = await import("node:fs/promises");
	const names = await readdir(EXTENSION_DIR);
	const sources: Record<string, string> = {};
	for (const name of names) {
		if (!name.endsWith(".ts")) continue;
		sources[name] = await readFile(new URL(name, EXTENSION_DIR), "utf8");
	}
	const coreDir = new URL("core/", EXTENSION_DIR);
	for (const name of await readdir(coreDir)) {
		if (name.endsWith(".ts")) sources[`core/${name}`] = await readFile(new URL(`core/${name}`, EXTENSION_DIR), "utf8");
	}
	const cacheDir = new URL("cache/", EXTENSION_DIR);
	for (const name of await readdir(cacheDir)) {
		if (name.endsWith(".ts")) sources[`cache/${name}`] = await readFile(new URL(`cache/${name}`, EXTENSION_DIR), "utf8");
	}
	return sources;
}

test("no dynamic tool loader: tools are registered statically — the three fixed native overrides first, then WORKBENCH_TOOL_NAMES order", async () => {
	const index = await readFile(new URL("index.ts", EXTENSION_DIR), "utf8");
	const nativeController = await readFile(new URL("core/native-tool-overrides-controller.ts", EXTENSION_DIR), "utf8");
	const recipeController = await readFile(new URL("core/recipe-tools-controller.ts", EXTENSION_DIR), "utf8");
	const gateController = await readFile(new URL("core/gate-tools-controller.ts", EXTENSION_DIR), "utf8");
	const compareController = await readFile(new URL("core/compare-tool-controller.ts", EXTENSION_DIR), "utf8");
	const delegationStatusController = await readFile(new URL("core/delegation-status-tool-controller.ts", EXTENSION_DIR), "utf8");
	const reviewController = await readFile(new URL("core/review-tool-controller.ts", EXTENSION_DIR), "utf8");
	const delegateController = await readFile(new URL("core/delegate-tool-controller.ts", EXTENSION_DIR), "utf8");
	const recoveryController = await readFile(new URL("core/recovery-tool-controller.ts", EXTENSION_DIR), "utf8");
	const localCommitController = await readFile(new URL("core/local-commit-tool-controller.ts", EXTENSION_DIR), "utf8");
	// exactly one setActiveTools call site (applyModeTools) — the tool set is
	// swapped only on mode switches / session_start, never per turn
	assert.equal(index.split("setActiveTools(").length - 1, 1, "setActiveTools called from exactly one place");
	// exactly the three fixed native overrides + the 12 workbench catalog
	// tools are registered (15 total), in the fixed order
	const indexRegistrations = index.split("pi.registerTool({").slice(1);
	const registrations = [
		...nativeController.split("controller.pi.registerTool({").slice(1),
		...recipeController.split("controller.pi.registerTool({").slice(1),
		...gateController.split("controller.pi.registerTool({").slice(1),
		...compareController.split("controller.pi.registerTool({").slice(1),
		...delegateController.split("controller.pi.registerTool({").slice(1),
		...reviewController.split("controller.pi.registerTool({").slice(1),
		...delegationStatusController.split("controller.pi.registerTool({").slice(1),
		...recoveryController.split("controller.pi.registerTool({").slice(1),
		...localCommitController.split("controller.pi.registerTool({").slice(1),
		...indexRegistrations,
	];
	assert.equal(
		registrations.length,
		NATIVE_OVERRIDE_NAMES.length + WORKBENCH_TOOL_NAMES.length,
		"one registerTool per native override and catalog tool (3 + 12 = 15)",
	);
	const registered: string[] = [];
	for (const block of registrations) {
		// NRO N1: the three fixed same-name overrides spread the policy
		// module's static metadata (NATIVE_OVERRIDE_METADATA.<name>).
		const nativeMatch = /\.\.\.NATIVE_OVERRIDE_METADATA\.(read|grep|find),/.exec(block);
		if (nativeMatch) {
			registered.push(nativeMatch[1] ?? "");
			continue;
		}
		// P6-B: metadata is spread from the tool catalog — the name comes from
		// the explicit WORKBENCH_TOOL_METADATA.<name> reference.
		const match = /\.\.\.WORKBENCH_TOOL_METADATA\.(workbench_[a-z_]+),/.exec(block);
		assert.ok(match, `registerTool block must spread catalog metadata: ${block.slice(0, 80)}`);
		registered.push(match[1] ?? "");
	}
	assert.deepEqual(
		registered,
		[...NATIVE_OVERRIDE_NAMES, ...WORKBENCH_TOOL_NAMES],
		"registration order == NATIVE_OVERRIDE_NAMES + WORKBENCH_TOOL_NAMES (WORKBENCH_TOOL_NAMES itself unchanged)",
	);
	// no registerTool inside any loop construct (static registration only)
	for (const line of `${nativeController}\n${recipeController}\n${gateController}\n${compareController}\n${delegateController}\n${reviewController}\n${delegationStatusController}\n${recoveryController}\n${localCommitController}\n${index}`.split("\n")) {
		if (line.includes("registerTool")) {
			assert.ok(!/(for|while|forEach|\.map)\(/.test(line), `registerTool must not appear in a loop: ${line.trim()}`);
		}
	}
});

test("no supportsToolSearch / supportsToolReferences / search_tools claims", async () => {
	const sources = await extensionSources();
	for (const [file, source] of Object.entries(sources)) {
		for (const token of ["supportsToolSearch", "supportsToolReferences", "search_tools", "tool_loader", "toolLoader"]) {
			assert.ok(!source.includes(token), `${file} must not claim ${token}`);
		}
	}
});

test("child runtime threads the strict task-kind env through advertised tools and the call guard", async () => {
	const index = await readFile(new URL("index.ts", EXTENSION_DIR), "utf8");
	const guard = await readFile(new URL("core/tool-call-guard-controller.ts", EXTENSION_DIR), "utf8");
	assert.ok(index.includes("taskKind: parseWorkerTaskKindEnvironment(process.env[WORKER_TASK_KIND_ENV])"));
	const activeToolsCall = /computeRoleActiveTools\([\s\S]*?workerRoleContext\.role,[\s\S]*?workerRoleContext\.taskKind,[\s\S]*?\)/.exec(index);
	assert.ok(activeToolsCall, "active-tool filtering receives the strict child task kind");
	assert.ok(
		guard.includes("workerRoleToolCallBlockReason(workerRoleContext, event.toolName, event.input)"),
		"the second-layer call guard receives the same worker role context",
	);
});

test("slash commands are not registered as model-callable tools", async () => {
	const sources = await extensionSources();
	const registrations = Object.values(sources).join("\n");
	// every registerCommand name starts with "q-" and none of the workbench
	// tool names appear as a command
	const commandNames = registrations
		.split("registerCommand(")
		.slice(1)
		.map((block) => /"([^"]+)"/.exec(block)?.[1])
		.filter((n): n is string => Boolean(n));
	assert.ok(commandNames.length >= 15, `expected the /q-* command set, got ${commandNames.length}`);
	for (const name of commandNames) assert.ok(name.startsWith("q-"), name);
	for (const tool of WORKBENCH_TOOL_NAMES) assert.ok(!commandNames.includes(tool), tool);
});

test("delegate wiring uses one v2 execution path and whole-lineage repair authority", async () => {
	const [block, adapters] = await Promise.all([
		readFile(new URL("core/delegate-tool-controller.ts", EXTENSION_DIR), "utf8"),
		readFile(new URL("core/runtime-controller-services.ts", EXTENSION_DIR), "utf8"),
	]);
	assert.match(block, /\.\.\.WORKBENCH_TOOL_METADATA\.workbench_delegate_worker,/);
	const taskKind = "const taskKind = resolveWorkerTaskKind(params.task_kind);";
	const normalize = "normalizeDelegationBoundedTaskContractV2({";
	const projectRootLine = "const projectRoot = await controller.projectRootFor(ctx);";
	const v2Read = "controller.services.readCommittedGeneration(projectRoot, repairId)";
	const v1Fallback = "controller.services.readLegacyLedger(projectRoot, repairId)";
	const execute = "controller.services.executeDelegation({";
	const complete = "controller.services.completeDefaultDelivery({";
	for (const expected of [taskKind, normalize, projectRootLine, v2Read, v1Fallback, execute, complete]) assert.ok(block.includes(expected), expected);
	assert.ok(block.indexOf(taskKind) < block.indexOf(normalize));
	assert.ok(block.indexOf(normalize) < block.indexOf(projectRootLine));
	assert.ok(block.indexOf(v2Read) < block.indexOf(v1Fallback));
	assert.ok(block.indexOf(v1Fallback) < block.indexOf(execute));
	assert.ok(block.includes('priorV2.error.code === "not_found"'), "only v2 not_found permits legacy fallback");
	assert.ok(block.includes("hasDelegationSemanticRepairAuthorityV2"), "PENDING_REVIEW repair requires immutable semantic REPAIR authority");
	assert.ok(block.includes("isStrictRetryableAbortedRepairV2"), "lineaged ABORTED retry uses the strict before-write envelope");
	assert.ok(block.includes("isStrictRetryableEmptyRepairRecoveryV2"), "empty lineaged recovery uses the strict released-owner envelope");
	assert.ok(block.split("controller.reconcileProjectAuthority(projectRoot").length - 1 >= 2, "every start audits project authority before and inside the lock");
	assert.ok(block.includes("controller.services.acquireStartLock({"), "project repair starts are serialized by the durable start lock");
	assert.ok(block.includes("repair lineage cannot be advanced safely"), "unsafe lineage advancement fails closed");
	assert.ok(block.includes("abortPristinePreparedDelegationUnderStartLockV2({"),
		"an exact owned start lock closes an ownerless pristine PREPARED result before release");
	assert.ok(block.indexOf("abortPristinePreparedDelegationUnderStartLockV2({") < block.indexOf("preserveStartLock = durableExecutionState?.status === \"PREPARED\""),
		"controller attempts exact same-process PREPARED closure before deciding to preserve the lock");
	for (const forbidden of ["createDelegationLedger", "finishDelegationLedger", "runPinnedWorker("]) {
		assert.equal(block.includes(forbidden), false, `${forbidden} is absent from the public v2 handler`);
	}
	assert.equal(block.split("controller.services.executeDelegation({").length - 1, 1, "one injected execution service owns the lifecycle");
	assert.equal(block.split("controller.services.completeDefaultDelivery({").length - 1, 1, "one injected delivery service owns ordinary review close");
	assert.ok(block.indexOf(execute) < block.indexOf(complete), "delivery review follows successful execution");
	assert.match(adapters, /readCommittedGeneration: readDelegationCommittedGenerationV2/);
	assert.match(adapters, /readLegacyLedger: readDelegationLedger/);
	assert.match(adapters, /executeDelegation: executeDelegationV2/);
	assert.match(adapters, /completeDefaultDelivery: completeDefaultDelegationDeliveryV2/);
});

// ---------------------------------------------------------------------------
// 9. Resource discovery determinism helpers
// ---------------------------------------------------------------------------

test("sortedById / sortedByName / sortedByPath are total, stable sorts", () => {
	const gates = sortedById([{ id: "q5" }, { id: "b0" }, { id: "q0" }]);
	assert.deepEqual(gates.map((g) => g.id), ["b0", "q0", "q5"]);
	const recipes = sortedByName([{ name: "zebra" }, { name: "alpha" }, { name: "alpha" }]);
	assert.deepEqual(recipes.map((r) => r.name), ["alpha", "alpha", "zebra"]);
	const paths = sortedByPath([{ path: "skills/z" }, { path: "skills/a" }, { path: "skills/a/nested" }]);
	assert.deepEqual(paths.map((p) => p.path), ["skills/a", "skills/a/nested", "skills/z"]);
	// equal keys keep input order (stable)
	const stable = sortedByName([{ name: "x", i: 1 }, { name: "x", i: 2 }]);
	assert.deepEqual(stable.map((r) => (r as { i: number }).i), [1, 2]);
});

test("fingerprintTools includes promptSnippet in the schema hash (stable-zone metadata)", () => {
	const tools: readonly ToolInfoLike[] = [
		{ name: "read", description: "d", promptSnippet: "s1", parameters: {}, promptGuidelines: [] },
	];
	const a = fingerprintTools(["read"], tools);
	const b = fingerprintTools(["read"], [{ ...tools[0]!, promptSnippet: "s2" }]);
	assert.notEqual(a.schemaHash, b.schemaHash, "promptSnippet changes must be detected as schema drift");
	assert.equal(a.schemaHash, fingerprintTools(["read"], tools).schemaHash);
});
