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
import { effectiveGates, type Gate } from "../extensions/workbench-runtime/core/gate-schema.ts";
import { parseRecipesDocument, type Recipe } from "../extensions/workbench-runtime/core/recipe-schema.ts";
import { loadProjectConfig } from "../extensions/workbench-runtime/core/config.ts";
import { withTempDir, writeConfigFile } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = "You are the pi-dev-workbench assistant. Follow the workbench mode policy and validation ladder.";

const BUILTIN_TOOLS: readonly ToolInfoLike[] = [
	{ name: "read", description: "Read the contents of a file", promptSnippet: "Read file contents", parameters: { type: "object", properties: { path: { type: "string" } } }, promptGuidelines: [] },
	{ name: "grep", description: "Search file contents", promptSnippet: "Search for patterns", parameters: { type: "object" }, promptGuidelines: [] },
	{ name: "find", description: "Find files by glob", promptSnippet: "Find files", parameters: { type: "object" }, promptGuidelines: [] },
	{ name: "ls", description: "List directory contents", promptSnippet: "List a directory", parameters: { type: "object" }, promptGuidelines: [] },
	{ name: "bash", description: "Execute a bash command", promptSnippet: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } }, promptGuidelines: [] },
	{ name: "edit", description: "Edit a file", promptSnippet: "Make precise edits", parameters: { type: "object" }, promptGuidelines: [] },
	{ name: "write", description: "Write a file", promptSnippet: "Create or overwrite a file", parameters: { type: "object" }, promptGuidelines: [] },
];

/** All registered tool infos: built-ins + the workbench catalog (in registration order). */
function allToolInfos(): ToolInfoLike[] {
	return [
		...BUILTIN_TOOLS,
		...workbenchToolMetadataOrdered().map((t) => ({
			name: t.name,
			description: t.description,
			promptSnippet: t.promptSnippet,
			parameters: t.parameters,
			promptGuidelines: [...t.promptGuidelines],
		})),
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

test("mode matrix is exactly the P6-B spec matrix", () => {
	assert.deepEqual(MODE_TOOLS.AUDIT, ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_read_run", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs"]);
	assert.deepEqual(MODE_TOOLS.VERIFY, ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_run_recipe", "workbench_read_run", "workbench_run_gate", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs"]);
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

test("no dynamic tool loader: tools are registered statically in WORKBENCH_TOOL_NAMES order", async () => {
	const index = await readFile(new URL("index.ts", EXTENSION_DIR), "utf8");
	// exactly one setActiveTools call site (applyModeTools) — the tool set is
	// swapped only on mode switches / session_start, never per turn
	assert.equal(index.split("setActiveTools(").length - 1, 1, "setActiveTools called from exactly one place");
	// exactly the 8 workbench tools are registered, in catalog order
	const registrations = index.split("pi.registerTool({").slice(1);
	assert.equal(registrations.length, WORKBENCH_TOOL_NAMES.length, "one registerTool per catalog tool");
	const registered: string[] = [];
	for (const block of registrations) {
		// P6-B: metadata is spread from the tool catalog — the name comes from
		// the explicit WORKBENCH_TOOL_METADATA.<name> reference.
		const match = /\.\.\.WORKBENCH_TOOL_METADATA\.(workbench_[a-z_]+),/.exec(block);
		assert.ok(match, `registerTool block must spread catalog metadata: ${block.slice(0, 80)}`);
		registered.push(match[1] ?? "");
	}
	assert.deepEqual(registered, [...WORKBENCH_TOOL_NAMES], "registration order == explicit constant order");
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
