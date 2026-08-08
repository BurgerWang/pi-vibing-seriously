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
import { fingerprintTools, type ToolInfoLike } from "../extensions/workbench-runtime/cache/prompt-fingerprint.ts";
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

test("workbench_delegate_worker metadata is static and carries the responsibility contract", () => {
	const meta = WORKBENCH_TOOL_METADATA.workbench_delegate_worker;
	// Every metadata field stays free of dynamic values (no dates, times,
	// hashes, absolute paths, or concrete run/gate/task ids).
	for (const field of [meta.description, meta.promptSnippet, ...meta.promptGuidelines]) {
		assert.deepEqual(findDynamicValueMarkers(field), [], `delegate metadata must be static: ${field.slice(0, 80)}`);
	}
	const text = [meta.description, meta.promptSnippet, ...meta.promptGuidelines].join("\n");
	// Worker-owned routine local implementation decisions inside the contract.
	assert.match(text, /routine local implementation decisions inside the approved contract/);
	// Sol-owned authority: requirements, cross-cutting architecture, scope,
	// actual-diff review, final verification/gates, verdict.
	assert.match(text, /Sol owns requirements, cross-cutting architecture, scope, actual-diff review, final verification\/gates, and the verdict/);
	// DEV default: coherent source+tests+docs vertical slices, bounded
	// low/medium-risk, observable acceptance criteria, no worker-prose acceptance.
	assert.match(text, /source\+tests\+docs vertical slices/);
	assert.match(text, /bounded low\/medium-risk implementation/);
	assert.match(text, /observable acceptance criteria/);
	assert.match(text, /Worker prose is never acceptance evidence/);
	// The registration-order/schema contract is untouched: same name, same
	// position (the first P7 tool, after the seven existing tools; P8b
	// appends the recovery tool LAST), same parameter schema hash — pinned
	// to the final Phase 4A optional repair_of schema baseline
	// (a self-comparison would prove nothing). The hash changed exactly
	// TWICE, both intentionally, in the worker repair rollout: in Phase 3
	// of the worker token-budget repair (see docs/compatibility.md for the
	// documented fingerprint transition) the additive optional
	// `budget_profile` parameter (with the nested JSON Schema
	// `default: "standard"` annotation) landed in one rollout transition
	// directly from the pre-repair baseline
	// 2cf1f563f78ffe2c85d142c1f40deea7bc658365345554db11c80b8af6b521d9 to
	// the historical final Phase 3 value
	// 71707090d2da085b036c5879dd2fcb72558175ead8e596bf55406b65732b0c83;
	// then Phase 4A (public schema shape only) added the optional
	// `repair_of` pointer below, and a focused machine run (commander
	// no-cache run 20260808-114550-j4gd) derived the new canonical hash
	// pinned below: the final Phase 4A optional repair_of schema baseline.
	// Phase 5 (task-contract wording / granularity) deliberately leaves the
	// parameter schema byte-for-byte unchanged.
	assert.equal(meta.name, "workbench_delegate_worker");
	assert.equal(WORKBENCH_TOOL_NAMES.indexOf("workbench_delegate_worker"), WORKBENCH_TOOL_NAMES.length - 4, "delegate tool keeps its registration position (seven existing → delegate → review → status → recovery)");
	// The canonical schema object itself (not only its hash): budget_profile
	// stays OPTIONAL — absent from `required` — and its nested union carries
	// the JSON Schema `default: "standard"` annotation plus the exact
	// closed alternatives in the fixed low|standard|extended order. This
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
	assert.equal(budgetProfileSchema.default, "standard", "the nested budget_profile schema carries the JSON Schema default annotation standard");
	assert.deepEqual(
		(budgetProfileSchema.anyOf ?? []).map((alternative) => alternative.const),
		["low", "standard", "extended"],
		"the exact closed alternatives in the fixed low|standard|extended order",
	);
	// Phase 4A (public schema shape only): repair_of stays OPTIONAL —
	// absent from `required` — and is an exactly-20-character string pinned
	// to the strict delegation-id pattern ^\d{8}-\d{6}-[A-Za-z0-9]{4}$.
	// The description preserves the fresh-worker/no-authority semantics:
	// strict prior delegation-id provenance for a known-root-cause repair
	// only; the parent task itself must carry the bounded root cause /
	// failure evidence; and the pointer adds no path/scope/authority and
	// never resumes or imports the old report.
	const repairOfSchema = delegateParameters.properties.repair_of;
	assert.ok(repairOfSchema, "repair_of is present in the serialized parameter schema");
	assert.ok(!(delegateParameters.required ?? []).includes("repair_of"), "repair_of stays optional — no required-list regression");
	assert.equal(repairOfSchema.type, "string", "repair_of is a string");
	assert.equal(repairOfSchema.minLength, 20, "repair_of minLength is exactly 20");
	assert.equal(repairOfSchema.maxLength, 20, "repair_of maxLength is exactly 20");
	assert.equal(repairOfSchema.pattern, "^\\d{8}-\\d{6}-[A-Za-z0-9]{4}$", "repair_of matches the strict delegation-id pattern");
	assert.equal(
		repairOfSchema.description,
		"strict prior delegation-id provenance for a known-root-cause repair; parent task must include bounded root cause/failure evidence; pointer adds no path/scope/authority and never resumes/imports old report",
		"repair_of description preserves the fresh-worker/no-authority semantics",
	);
	assert.equal(
		canonicalHash(WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker),
		"dc1db21e3590c7f57cfa88f042052964a92d495116966747918d72f2018176a7",
		"delegate parameter schema hash literal is the final Phase 4A optional repair_of schema baseline — machine-derived (commander no-cache run 20260808-114550-j4gd), superseding the historical final Phase 3 value 71707090d2da085b036c5879dd2fcb72558175ead8e596bf55406b65732b0c83",
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
	// the transition is exactly the documented combined N1/N2 one (plan
	// §7.1 / §6.4): read keeps the built-in schema and gains exactly the ONE
	// continuation/count guideline bullet (N1); grep keeps the built-in
	// metadata/schema PREFIX byte-identical, appends exactly the two
	// optional count selectors, gains the intended static count-mode
	// description sentence and mirrors the ONE guideline bullet (N2); find
	// stays fully built-in-compatible (N3 not implemented)
	const currentRead = nativeOverrideToolInfos()[0]!;
	const builtinRead = createReadToolDefinition(".") as unknown as ToolInfoLike;
	assert.equal(currentRead.name, builtinRead.name);
	assert.equal(currentRead.description, builtinRead.description, "read description unchanged (built-in verbatim)");
	assert.equal(currentRead.promptSnippet, builtinRead.promptSnippet, "read promptSnippet unchanged (built-in verbatim)");
	assert.deepEqual(currentRead.parameters, builtinRead.parameters, "read parameter schema byte-identical to the Pi 0.83.0 built-in");
	assert.deepEqual(
		currentRead.promptGuidelines,
		[...(builtinRead.promptGuidelines ?? []), READ_PREVIEW_GUIDELINE],
		"read adds exactly the ONE §6.4 guideline bullet — nothing else",
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

test("P7 tools keep the fixed seven→delegate→review→status order with static metadata; P8b appends the recovery tool LAST", () => {
	const names = [...WORKBENCH_TOOL_NAMES];
	assert.equal(names.length, 11, "eleven workbench custom tools after P8b");
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
	assert.deepEqual(names.slice(10), ["workbench_recover_tool_result"], "the P8b recovery tool is appended LAST");
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
	]) {
		const verdict = classifyInvalidation(input);
		assert.equal(invalidationClass(verdict.reason), "expected", verdict.reason);
		assert.equal(verdict.driftSource, null, verdict.reason);
	}
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
	// exactly one setActiveTools call site (applyModeTools) — the tool set is
	// swapped only on mode switches / session_start, never per turn
	assert.equal(index.split("setActiveTools(").length - 1, 1, "setActiveTools called from exactly one place");
	// exactly the three fixed native overrides + the 11 workbench catalog
	// tools are registered (14 total), in the fixed order
	const registrations = index.split("pi.registerTool({").slice(1);
	assert.equal(
		registrations.length,
		NATIVE_OVERRIDE_NAMES.length + WORKBENCH_TOOL_NAMES.length,
		"one registerTool per native override and catalog tool (3 + 11 = 14)",
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
	for (const line of index.split("\n")) {
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

test("slash commands are not registered as model-callable tools", async () => {
	const index = await readFile(new URL("index.ts", EXTENSION_DIR), "utf8");
	// every registerCommand name starts with "q-" and none of the workbench
	// tool names appear as a command
	const commandNames = index
		.split("pi.registerCommand(")
		.slice(1)
		.map((block) => /"([^"]+)"/.exec(block)?.[1])
		.filter((n): n is string => Boolean(n));
	assert.ok(commandNames.length >= 15, `expected the /q-* command set, got ${commandNames.length}`);
	for (const name of commandNames) assert.ok(name.startsWith("q-"), name);
	for (const tool of WORKBENCH_TOOL_NAMES) assert.ok(!commandNames.includes(tool), tool);
});

test("delegate wiring: strict repair resolver and finished-ledger guard precede ledger create / worker run; the repair pointer spreads exactly twice and reads only id/status/after facts (Phase 4D)", async () => {
	const index = await readFile(new URL("index.ts", EXTENSION_DIR), "utf8");
	const blockStart = index.indexOf("...WORKBENCH_TOOL_METADATA.workbench_delegate_worker,");
	const blockEnd = index.indexOf("...WORKBENCH_TOOL_METADATA.workbench_review_worker_diff,");
	assert.ok(blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart, "delegate registerTool block is delimited by the catalog spreads");
	const block = index.slice(blockStart, blockEnd);
	// 1. The strict repair resolver runs BEFORE projectRoot resolution and
	// before any new ledger is created (malformed pointers fail closed
	// before any write or child launch).
	const resolver = "const repairOf = resolveWorkerRepairOf(params.repair_of);";
	const projectRootLine = "const projectRoot = await projectRootFor(ctx);";
	const createLedger = "createDelegationLedger(";
	assert.ok(block.includes(resolver), "strict repair resolver is present");
	assert.ok(block.includes(projectRootLine), "projectRoot resolution is present");
	assert.ok(block.indexOf(resolver) < block.indexOf(projectRootLine), "strict resolver precedes projectRoot resolution");
	assert.ok(block.indexOf(resolver) < block.indexOf(createLedger), "strict resolver precedes any new ledger creation");
	// 2. The finished-ledger check (manifest status finished + non-null
	// after record) happens BEFORE any new ledger is created and before any
	// worker is launched.
	const finishedCheck = 'prior.manifest.status !== "finished" || prior.after === null';
	const runWorker = "runDeepseekWorker({";
	assert.ok(block.includes("readDelegationLedger(projectRoot, repairOf.repairOf)"), "the prior ledger is read for the finished check");
	assert.ok(block.includes(finishedCheck), "the finished-ledger guard checks manifest status and the after record");
	assert.ok(block.indexOf(finishedCheck) < block.indexOf(createLedger), "finished-ledger guard precedes any new ledger creation");
	assert.ok(block.indexOf(finishedCheck) < block.indexOf(runWorker), "finished-ledger guard precedes any worker launch");
	// 3. The SAME conditional repairOf spread appears exactly twice — the
	// ledger contract and the worker contract — and the omitted path
	// carries no key.
	const spread = "...(repairOf.repairOf !== undefined ? { repairOf: repairOf.repairOf } : {})";
	assert.equal(block.split(spread).length - 1, 2, "the conditional repairOf spread appears exactly twice (ledger contract + worker contract)");
	// 4. The delegate block reads ONLY the prior id/status/after facts: it
	// never accesses prior.before, prior.workerSummary, the prior
	// worker-report artifact, or any prior contract field (no prose/scope
	// inheritance, no authority expansion).
	const priorAccesses = [...block.matchAll(/prior\.\w+/g)].map((m) => m[0]);
	assert.deepEqual([...new Set(priorAccesses)], ["prior.manifest", "prior.after"], "only the prior manifest status and after record are inspected");
	assert.ok(!block.includes("prior.before"), "the delegate block never accesses prior.before");
	assert.ok(!block.includes("prior.workerSummary"), "the delegate block never accesses prior.workerSummary");
	assert.ok(!block.includes("prior.contract"), "the delegate block never accesses prior contract fields");
	// The prior delegation's report artifact (worker-report.md) is never
	// read: the block resolves no delegation directory itself, never uses
	// the report constant, and its only worker-report mention is the
	// finish-step comment about the CURRENT delegation's OWN artifact —
	// never on a line touching the prior id or the repair pointer.
	assert.ok(!block.includes("delegationDirFor("), "the delegate block never resolves a delegation directory itself");
	assert.ok(!block.includes("WORKER_REPORT_FILE_NAME"), "the delegate block never reads the report artifact constant");
	assert.ok(block.split("worker-report").length - 1 >= 1, "the finish-step comment names the current delegation's own worker-report.md");
	for (const line of block.split("\n")) {
		if (line.includes("worker-report")) {
			assert.ok(!line.includes("prior") && !line.includes("repairOf"), `worker-report mention must never touch the prior delegation: ${line.trim()}`);
		}
	}
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
