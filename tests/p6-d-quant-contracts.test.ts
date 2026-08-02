/**
 * P6-D quant contract tests — the three versioned manifest schemas
 * (DATA_SNAPSHOT, FEATURE_SET, BACKTEST_RESULT), immutable reference
 * resolution, the key/invalidation matrix, fixtures and the no-HFT
 * boundary.
 *
 * Coverage (P6-D spec §10): immutable snapshot valid, latest rejected,
 * logical latest resolves, unresolved latest not cacheable, provider
 * revision / symbols / universe / timezone / calendar / feature code /
 * normalization / industry version / financial publication policy /
 * signal timestamp / resampling / fee-slippage / benchmark / rebalance /
 * split / walk-forward / seed / engine version key changes, point-in-time
 * missing, corporate-action policy missing, delisting policy missing,
 * failed fold retained, missing fold rejected, artifact corruption,
 * upstream lineage, stock-selection + market-timing fixtures, no
 * HFT/LOB/market-making schema or module.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	computeQuantManifestHash,
	isMutableId,
	parseQuantReferenceKey,
	quantImmutableKey,
	QUANT_CONTRACT_TYPES,
	QUANT_CONTRACT_SCHEMA_VERSION,
	resolveLogicalManifest,
	validateQuantContract,
	type QuantContractType,
} from "../extensions/workbench-runtime/cache/quant-contracts.ts";
import {
	discoverCandidateManifests,
	readQuantManifestFile,
	resolveQuantContract,
	verifyBacktestResultArtifact,
	verifyDeclaredHash,
} from "../extensions/workbench-runtime/cache/quant-files.ts";
import { withTempDir } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "quant");

async function loadFixture(name: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function v(manifest: Record<string, unknown>, profile?: string) {
	return validateQuantContract(manifest, profile ? { profile } : {});
}

const SELECTION = "quant-research/stock-selection";
const TIMING = "quant-research/market-timing";

// ---------------------------------------------------------------------------
// Data snapshot contract
// ---------------------------------------------------------------------------

test("data-snapshot: immutable valid snapshot validates and is cache-eligible", async () => {
	const manifest = await loadFixture("valid-data-snapshot");
	const r = v(manifest);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "validated");
	assert.equal(r.cacheEligible, true);
	assert.equal(r.mutableId, false);
	assert.equal(r.missingFields.length, 0);
	const key = quantImmutableKey(manifest);
	assert.ok(key, "immutable key present");
	assert.match(key ?? "", /^quant:data-snapshot:2026-08-01-eod-v3:r3:[0-9a-f]{16}$/);
	assert.deepEqual(
		r.qGateImplications.map((g) => g.gate),
		["q1"],
	);
});

test("data-snapshot: latest is rejected as a final id and never cacheable", async () => {
	const manifest = await loadFixture("invalid-latest-snapshot");
	const r = v(manifest);
	assert.equal(r.mutableId, true);
	assert.equal(r.valid, false);
	assert.equal(r.cacheEligible, false);
	assert.equal(quantImmutableKey(manifest), null);
	// isMutableId covers the bare tokens and prefixed forms.
	assert.equal(isMutableId("latest"), true);
	assert.equal(isMutableId("current"), true);
	assert.equal(isMutableId("now"), true);
	assert.equal(isMutableId("today"), true);
	assert.equal(isMutableId("LATEST"), true);
	assert.equal(isMutableId("latest@2026-08-01"), true);
	assert.equal(isMutableId("2026-08-01-eod-v3"), false);
	assert.equal(isMutableId("latest-data-v1"), true);
});

test("data-snapshot: logical latest resolves to the newest immutable revision", async () => {
	const base = await loadFixture("valid-data-snapshot");
	const older = { ...base, snapshotId: "2026-07-01-eod-v2", providerRevision: "r2", acquiredAt: "2026-07-02T01:00:00Z" };
	const newest = { ...base, snapshotId: "2026-08-01-eod-v3", providerRevision: "r3", acquiredAt: "2026-08-02T01:00:00Z" };
	const outcome = resolveLogicalManifest({ id: "latest", kind: "data-snapshot", provider: "example-data-vendor", dataset: "us-equities-daily" }, [older, newest]);
	assert.ok(outcome.resolved);
	if (outcome.resolved) {
		assert.equal(outcome.result.manifest.snapshotId, "2026-08-01-eod-v3");
		assert.equal(outcome.result.logicalReference, "latest");
		assert.match(outcome.result.resolvedReference, /^quant:data-snapshot:2026-08-01-eod-v3:r3:/);
	}
});

test("data-snapshot: unresolved latest is not cacheable", async () => {
	const outcome = resolveLogicalManifest({ id: "latest", kind: "data-snapshot" }, []);
	assert.ok(!outcome.resolved);
	if (!outcome.resolved) assert.match(outcome.reason, /no immutable/);
});

test("data-snapshot: unresolved latest refuses the recipe quant cache on disk", async () => {
	await withTempDir(async (dir) => {
		const manifest = await loadFixture("invalid-latest-snapshot");
		await mkdir(join(dir, "artifacts"), { recursive: true });
		await writeFile(join(dir, "artifacts", "data-snapshot.json"), JSON.stringify(manifest, null, 2), "utf8");
		const result = await resolveQuantContract(dir, { type: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		assert.ok(!result.ok);
		if (!result.ok) assert.match(result.reason, /could not be resolved/);
	});
});

test("data-snapshot: resolution picks immutable registry candidates, never itself", async () => {
	await withTempDir(async (dir) => {
		const latest = await loadFixture("invalid-latest-snapshot");
		const valid = await loadFixture("valid-data-snapshot");
		const older = { ...valid, snapshotId: "2026-07-01-eod-v2", providerRevision: "r2", acquiredAt: "2026-07-02T01:00:00Z" };
		await mkdir(join(dir, "artifacts"), { recursive: true });
		await writeFile(join(dir, "artifacts", "data-snapshot.json"), JSON.stringify(latest, null, 2), "utf8");
		await writeFile(join(dir, "artifacts", "data-snapshot-2026-07-01.json"), JSON.stringify(older, null, 2), "utf8");
		await writeFile(join(dir, "artifacts", "data-snapshot-2026-08-01.json"), JSON.stringify(valid, null, 2), "utf8");

		const candidates = await discoverCandidateManifests(dir, "data-snapshot", "artifacts/data-snapshot.json");
		assert.equal(candidates.length, 2, "only the immutable siblings are candidates");
		const resolved = await resolveQuantContract(dir, { type: "data-snapshot", manifest: "artifacts/data-snapshot.json" });
		assert.ok(resolved.ok);
		if (resolved.ok) {
			assert.equal(resolved.resolved.manifest.snapshotId, "2026-08-01-eod-v3", "newest immutable revision wins");
			assert.equal(resolved.resolved.logicalReference, "latest");
			assert.ok(resolved.resolved.resolvedReference, "resolvedReference recorded");
		}
	});
});

test("data-snapshot: point-in-time missing blocks validation for stock-selection", async () => {
	const manifest = await loadFixture("missing-point-in-time");
	const generic = v(manifest);
	assert.equal(generic.valid, true);
	assert.equal(generic.validationStatus, "validated", "valid for generic usage");
	const selection = v(manifest, SELECTION);
	assert.equal(selection.valid, true, "still parses");
	assert.equal(selection.validationStatus, "unresolved", "never validated without point-in-time universe");
	assert.equal(selection.cacheEligible, false);
	assert.ok(selection.warnings.some((w) => w.includes("pointInTimeUniverseId")));
});

test("data-snapshot: corporate action policy missing -> parses but never validated", async () => {
	const manifest = await loadFixture("missing-corporate-action-policy");
	const r = v(manifest);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "unresolved");
	assert.equal(r.cacheEligible, false);
});

test("data-snapshot: delisting policy missing -> parses but never validated", async () => {
	const manifest = await loadFixture("valid-data-snapshot");
	delete manifest.delistingPolicy;
	const r = v(manifest);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "unresolved");
	assert.ok(r.warnings.some((w) => w.includes("delistingPolicy")));
});

test("data-snapshot: missing required fields are reported structurally", async () => {
	const manifest = await loadFixture("valid-data-snapshot");
	delete manifest.effectiveAsOf;
	delete manifest.tradingCalendar;
	const r = v(manifest);
	assert.equal(r.valid, false);
	assert.ok(r.missingFields.includes("effectiveAsOf"));
	assert.ok(r.missingFields.includes("tradingCalendar"));
	assert.equal(r.cacheEligible, false);
});

test("data-snapshot: source artifacts must be project-root restricted", async () => {
	const manifest = await loadFixture("valid-data-snapshot");
	const escape = { ...manifest, sourceArtifacts: ["../outside/data.parquet"] };
	assert.equal(v(escape).valid, false);
	const absolute = { ...manifest, sourceArtifacts: ["/etc/passwd"] };
	assert.equal(v(absolute).valid, false);
});

test("data-snapshot: manifest warnings are preserved verbatim", async () => {
	const manifest = await loadFixture("valid-data-snapshot");
	manifest.warnings = ["custom warning A", "custom warning B"];
	const r = v(manifest);
	assert.deepEqual(r.warnings, ["custom warning A", "custom warning B"]);
});

// ---------------------------------------------------------------------------
// Key / invalidation matrix
// ---------------------------------------------------------------------------

test("key matrix: content changes produce new immutable keys (and new action keys)", async () => {
	const snapshot = await loadFixture("valid-data-snapshot");
	const feature = await loadFixture("valid-stock-selection-feature-set");
	const backtest = await loadFixture("valid-stock-selection-backtest");

	const cases: { label: string; manifest: Record<string, unknown>; mutate: (m: Record<string, unknown>) => void }[] = [
		{ label: "provider revision", manifest: { ...snapshot }, mutate: (m) => (m.providerRevision = "r4") },
		{ label: "symbols", manifest: { ...snapshot }, mutate: (m) => (m.symbols = ["AAPL", "MSFT", "NVDA", "GOOG"]) },
		{ label: "universe", manifest: { ...snapshot }, mutate: (m) => (m.pointInTimeUniverseId = "universe:sp500-pit:2026-09-01:v3") },
		{ label: "timezone", manifest: { ...snapshot }, mutate: (m) => (m.timezone = "UTC") },
		{ label: "trading calendar", manifest: { ...snapshot }, mutate: (m) => (m.tradingCalendar = "NASDAQ") },
		{ label: "feature code", manifest: { ...feature }, mutate: (m) => (m.featureCodeHash = "c".repeat(64)) },
		{ label: "normalization", manifest: { ...feature }, mutate: (m) => (m.normalizationPolicy = "cross-sectional-rank") },
		{ label: "industry version", manifest: { ...feature }, mutate: (m) => (m.industryClassificationVersion = "gic-v2026-09") },
		{ label: "financial publication policy", manifest: { ...feature }, mutate: (m) => (m.financialReleaseAlignmentPolicy = "as-reported") },
		{ label: "signal timestamp", manifest: { ...feature }, mutate: (m) => (m.signalTimestampPolicy = "bar-close") },
		{ label: "resampling", manifest: { ...feature }, mutate: (m) => (m.resamplingPolicy = "weekly") },
		{ label: "fee model", manifest: { ...backtest }, mutate: (m) => (m.feeModelHash = "b".repeat(64)) },
		{ label: "slippage model", manifest: { ...backtest }, mutate: (m) => (m.slippageModelHash = "c".repeat(64)) },
		{ label: "benchmark", manifest: { ...backtest }, mutate: (m) => (m.benchmarkDefinitionHash = "d".repeat(64)) },
		{ label: "rebalance semantics", manifest: { ...backtest }, mutate: (m) => (m.rebalanceSemanticsHash = "e".repeat(64)) },
		{ label: "split", manifest: { ...backtest }, mutate: (m) => (m.splitDefinitionHash = "f".repeat(64)) },
		{ label: "walk-forward", manifest: { ...backtest }, mutate: (m) => (m.walkForwardDefinitionHash = "1".repeat(64)) },
		{ label: "seed", manifest: { ...backtest }, mutate: (m) => (m.seed = 43) },
		{ label: "engine version", manifest: { ...backtest }, mutate: (m) => (m.engineVersion = "example-backtest-engine-3.0.0") },
	];
	for (const c of cases) {
		const before = computeQuantManifestHash(c.manifest);
		const mutated = { ...c.manifest };
		c.mutate(mutated);
		const after = computeQuantManifestHash(mutated);
		assert.notEqual(after, before, `${c.label} must change the content hash`);
		const k1 = quantImmutableKey(c.manifest);
		const k2 = quantImmutableKey(mutated);
		assert.ok(k1 && k2, `${c.label}: both keys present`);
		assert.notEqual(k1, k2, `${c.label} must change the immutable key`);
	}
});

test("key matrix: symbols order never changes the hash (stable sort)", async () => {
	const snapshot = await loadFixture("valid-data-snapshot");
	const a = { ...snapshot, symbols: ["AAPL", "MSFT", "NVDA"] };
	const b = { ...snapshot, symbols: ["NVDA", "AAPL", "MSFT"] };
	assert.equal(computeQuantManifestHash(a), computeQuantManifestHash(b));
	assert.equal(quantImmutableKey(a), quantImmutableKey(b));
});

test("key matrix: manifest hash excludes logical/resolved reference bookkeeping", async () => {
	const snapshot = await loadFixture("valid-data-snapshot");
	const withMeta = { ...snapshot, logicalReference: "latest", resolvedReference: "quant:data-snapshot:2026-08-01-eod-v3:r3:abc" };
	assert.equal(computeQuantManifestHash(snapshot), computeQuantManifestHash(withMeta));
});

test("key matrix: every hash field is non-empty; non-hex hashes are flagged as warnings", async () => {
	const manifest = await loadFixture("valid-data-snapshot");
	manifest.schemaHash = "not-a-hex-hash";
	const r = v(manifest);
	assert.equal(r.valid, true);
	assert.ok(r.warnings.some((w) => w.includes("schemaHash") && w.includes("hex")));
});

test("reference keys: parseQuantReferenceKey round-trips", () => {
	const parsed = parseQuantReferenceKey("quant:feature-set:momentum-quality-v12:r0:dddddddddddddddd");
	assert.ok(parsed);
	assert.equal(parsed?.type, "feature-set");
	assert.equal(parsed?.id, "momentum-quality-v12");
	assert.equal(parsed?.revision, "r0");
	assert.equal(parseQuantReferenceKey("nonsense"), null);
	assert.equal(parseQuantReferenceKey("quant:hft:foo:r1:abc"), null, "unknown contract type is not a valid reference key");
});

// ---------------------------------------------------------------------------
// Feature set contract (per-profile requirements)
// ---------------------------------------------------------------------------

test("feature-set: stock-selection fixture validates with all required semantics", async () => {
	const manifest = await loadFixture("valid-stock-selection-feature-set");
	const r = v(manifest, SELECTION);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "validated");
	assert.equal(r.cacheEligible, true);
	assert.deepEqual(
		r.qGateImplications.map((g) => g.gate),
		["q1", "q2"],
	);
	// Missing ANY stock-selection semantic -> unresolved.
	for (const field of ["universeSnapshotKey", "industryClassificationVersion", "marketCapSourceVersion", "financialReleaseAlignmentPolicy", "winsorizationPolicy", "normalizationPolicy"]) {
		const mutated = { ...manifest };
		delete mutated[field];
		const m = v(mutated, SELECTION);
		assert.equal(m.validationStatus, "unresolved", `missing ${field} must block validation`);
		assert.equal(m.cacheEligible, false);
	}
});

test("feature-set: market-timing fixture validates with all required semantics", async () => {
	const manifest = await loadFixture("valid-market-timing-feature-set");
	const r = v(manifest, TIMING);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "validated");
	for (const field of ["signalTimestampPolicy", "barOpenCloseSemantics", "resamplingPolicy", "timezone", "tradingCalendar"]) {
		const mutated = { ...manifest };
		delete mutated[field];
		const m = v(mutated, TIMING);
		assert.equal(m.validationStatus, "unresolved", `missing ${field} must block validation`);
	}
	// warmupPeriod is a REQUIRED field for every profile — its absence is
	// a structural error (invalid), never a valid-but-unresolved state.
	const noWarmup = { ...manifest };
	delete noWarmup.warmupPeriod;
	assert.equal(v(noWarmup, TIMING).valid, false);
});

// ---------------------------------------------------------------------------
// Backtest result contract
// ---------------------------------------------------------------------------

test("backtest-result: valid fixture validates; failed folds are retained, never filtered", async () => {
	const manifest = await loadFixture("failed-fold-retained");
	const r = v(manifest, SELECTION);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "validated");
	assert.equal(r.cacheEligible, true);
	assert.equal(r.checked.includes("failedFolds"), true);
	// The failed fold is still IN foldArtifacts (nothing filtered).
	assert.equal((manifest.foldArtifacts as { id: string; status?: string }[]).some((f) => f.id === "f2" && f.status === "failed"), true);
});

test("backtest-result: a failed fold missing from foldArtifacts is rejected", async () => {
	const manifest = await loadFixture("failed-fold-retained");
	const mutated = {
		...manifest,
		foldArtifacts: (manifest.foldArtifacts as { id: string }[]).filter((f) => f.id !== "f2"),
	};
	const r = v(mutated, SELECTION);
	assert.equal(r.valid, false);
	assert.ok(r.errors.some((e) => e.includes("failed fold") && e.includes("never be filtered")));
});

test("backtest-result: walk-forward declared with empty folds is never validated", async () => {
	const manifest = await loadFixture("valid-stock-selection-backtest");
	const mutated = { ...manifest, foldArtifacts: [] };
	const r = v(mutated, SELECTION);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "unresolved");
	assert.ok(r.warnings.some((w) => w.includes("walk-forward") && w.includes("foldArtifacts")));
	// Without walk-forward, empty folds are acceptable.
	const noWf = { ...manifest, walkForwardDefinitionHash: undefined, foldArtifacts: [] };
	assert.equal(v(noWf, SELECTION).validationStatus, "validated");
});

test("backtest-result: best-trial-only caching is never valid", async () => {
	const manifest = await loadFixture("valid-stock-selection-backtest");
	const mutated = { ...manifest, bestTrialOnly: true };
	const r = v(mutated, SELECTION);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "unresolved");
	assert.ok(r.warnings.some((w) => w.includes("bestTrialOnly")));
});

test("backtest-result: parameter search must keep trial lineage or its digest", async () => {
	const manifest = await loadFixture("valid-stock-selection-backtest");
	const search = { ...manifest, parameterSearch: true, trialLineage: undefined };
	const r = v(search, SELECTION);
	assert.equal(r.validationStatus, "unresolved");
	assert.ok(r.warnings.some((w) => w.includes("trialLineage")));
	const withLineage = { ...manifest, parameterSearch: true, trialLineage: { retained: true } };
	assert.equal(v(withLineage, SELECTION).validationStatus, "validated");
	const withDigest = { ...manifest, parameterSearch: true, trialLineage: { digest: "a".repeat(64) } };
	assert.equal(v(withDigest, SELECTION).validationStatus, "validated");
});

test("backtest-result: market-timing fixture validates", async () => {
	const manifest = await loadFixture("valid-market-timing-backtest");
	const r = v(manifest, TIMING);
	assert.equal(r.valid, true);
	assert.equal(r.validationStatus, "validated");
	assert.equal(r.cacheEligible, true);
	assert.deepEqual(
		r.qGateImplications.map((g) => g.gate),
		["q2", "q3", "q4", "q5"],
	);
});

// ---------------------------------------------------------------------------
// Artifact hashes (file-level)
// ---------------------------------------------------------------------------

test("artifact corruption: declared resultArtifactHash mismatch is corruption", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "results"), { recursive: true });
		await writeFile(join(dir, "results", "quant-result.json"), '{"schema_version":"1.0"}\n', "utf8");
		const manifest = await loadFixture("corrupted-artifact");
		// The fixture declares an impossible hash -> verification must call it corruption.
		const result = await verifyBacktestResultArtifact(dir, manifest);
		assert.equal(result.ok, false);
		assert.equal(result.corrupt, true);
		// The matching hash verifies cleanly.
		const { sha256HexBytes } = await import("../extensions/workbench-runtime/cache/canonical-hash.ts");
		const good = { ...manifest, resultArtifactHash: sha256HexBytes(Buffer.from('{"schema_version":"1.0"}\n', "utf8")) };
		const okResult = await verifyBacktestResultArtifact(dir, good);
		assert.equal(okResult.ok, true);
		assert.equal(okResult.corrupt, false);
		// Missing file is unverifiable, NOT corruption.
		const missing = await verifyDeclaredHash(dir, "results/never.json", "a".repeat(64));
		assert.equal(missing.ok, false);
		assert.equal(missing.corrupt, false);
	});
});

// ---------------------------------------------------------------------------
// Fixtures + no-HFT boundary
// ---------------------------------------------------------------------------

test("fixtures: all 10 fixtures load, and the valid ones validate as expected", async () => {
	const names = [
		"valid-data-snapshot",
		"invalid-latest-snapshot",
		"valid-stock-selection-feature-set",
		"valid-market-timing-feature-set",
		"valid-stock-selection-backtest",
		"valid-market-timing-backtest",
		"missing-point-in-time",
		"missing-corporate-action-policy",
		"failed-fold-retained",
		"corrupted-artifact",
	];
	for (const name of names) {
		const manifest = await loadFixture(name);
		const r = v(manifest, SELECTION);
		assert.equal(typeof manifest.schemaVersion, "number", `${name}: schemaVersion present`);
		assert.ok(QUANT_CONTRACT_TYPES.includes(manifest.contractType as QuantContractType), `${name}: known contract type`);
	}
	assert.equal((await v(await loadFixture("valid-data-snapshot"), SELECTION)).validationStatus, "validated");
	assert.equal((await v(await loadFixture("invalid-latest-snapshot"), SELECTION)).mutableId, true);
	assert.equal((await v(await loadFixture("valid-stock-selection-feature-set"), SELECTION)).validationStatus, "validated");
	assert.equal((await v(await loadFixture("valid-market-timing-feature-set"), TIMING)).validationStatus, "validated");
	assert.equal((await v(await loadFixture("valid-stock-selection-backtest"), SELECTION)).validationStatus, "validated");
	assert.equal((await v(await loadFixture("valid-market-timing-backtest"), TIMING)).validationStatus, "validated");
	assert.equal((await v(await loadFixture("missing-point-in-time"), SELECTION)).validationStatus, "unresolved");
	assert.equal((await v(await loadFixture("missing-corporate-action-policy"), SELECTION)).validationStatus, "unresolved");
	assert.equal((await v(await loadFixture("failed-fold-retained"), SELECTION)).validationStatus, "validated");
	assert.equal((await v(await loadFixture("corrupted-artifact"), SELECTION)).validationStatus, "validated");
});

test("fixtures: manifests carry no fictitious investment conclusions", async () => {
	for (const name of [
		"valid-data-snapshot",
		"invalid-latest-snapshot",
		"valid-stock-selection-feature-set",
		"valid-market-timing-feature-set",
		"valid-stock-selection-backtest",
		"valid-market-timing-backtest",
		"missing-point-in-time",
		"missing-corporate-action-policy",
		"failed-fold-retained",
		"corrupted-artifact",
	]) {
		const text = JSON.stringify(await loadFixture(name)).toLowerCase();
		// No strategy performance claims, no tick data, no HFT artifacts.
		assert.ok(!text.includes('"return":'), `${name}: no return metrics`);
		assert.ok(!text.includes("sharpe"), `${name}: no sharpe`);
		assert.ok(!text.includes("pnl"), `${name}: no pnl`);
		assert.ok(!text.includes("tick"), `${name}: no tick data`);
	}
});

test("no HFT/LOB/market-making schema or module exists", async () => {
	// The only contract types are the three documented ones.
	assert.deepEqual(QUANT_CONTRACT_TYPES, ["data-snapshot", "feature-set", "backtest-result"]);
	assert.equal(QUANT_CONTRACT_SCHEMA_VERSION, 1);
	// No schema name for HFT/LOB/tick/queue/market-making exists anywhere.
	const source = await readFile(join(import.meta.dirname, "..", "extensions", "workbench-runtime", "cache", "quant-contracts.ts"), "utf8");
	for (const forbidden of ["hft", "lob", "tick-replay", "queue-model", "market-making", "colocation", "execution-engine"]) {
		assert.ok(!source.toLowerCase().includes(forbidden), `quant-contracts.ts must not mention ${forbidden}`);
	}
	const dir = join(import.meta.dirname, "..", "extensions", "workbench-runtime", "cache");
	const { readdir } = await import("node:fs/promises");
	const files = await readdir(dir);
	const forbiddenWord = ["hft", "lob", "tick", "queue-model", "market-making", "colocation"];
	for (const file of files) {
		if (!file.endsWith(".ts")) continue;
		const content = await readFile(join(dir, file), "utf8");
		for (const forbidden of forbiddenWord) {
			// Word-boundary match: "glob" must never trip the "lob" check.
			assert.ok(!new RegExp(`\\b${forbidden}\\b`, "i").test(content), `${file} must not mention ${forbidden}`);
		}
	}
});

test("upstream lineage: backtest keys link to snapshot and feature-set keys", async () => {
	const snapshot = await loadFixture("valid-data-snapshot");
	const feature = await loadFixture("valid-stock-selection-feature-set");
	const backtest = await loadFixture("valid-stock-selection-backtest");
	// The backtest manifest's DECLARED keys are references: lineage matches
	// them by type + id + revision, never by recomputing hashes.
	const declaredSnapshot = parseQuantReferenceKey(String(backtest.dataSnapshotKey));
	assert.ok(declaredSnapshot);
	assert.equal(declaredSnapshot?.type, "data-snapshot");
	assert.equal(declaredSnapshot?.id, String(snapshot.snapshotId));
	assert.equal(declaredSnapshot?.revision, String(snapshot.providerRevision));
	const declaredFeature = parseQuantReferenceKey(String(backtest.featureSetKey));
	assert.ok(declaredFeature);
	assert.equal(declaredFeature?.type, "feature-set");
	assert.equal(declaredFeature?.id, String(feature.featureSetId));
	// The snapshot's own immutable key is a quant reference key of the same shape.
	const snapshotKey = parseQuantReferenceKey(quantImmutableKey(snapshot) ?? "");
	assert.ok(snapshotKey);
	assert.equal(snapshotKey?.type, "data-snapshot");
});

test("contract parsing: unknown contractType / wrong schemaVersion rejected", async () => {
	assert.equal(v({ schemaVersion: 1, contractType: "tick-replay" }).valid, false);
	assert.equal(v({ schemaVersion: 2, contractType: "data-snapshot" }).valid, false);
	assert.equal(v({ contractType: "data-snapshot" }).valid, false);
});

test("readQuantManifestFile: paths outside the project root are refused", async () => {
	await withTempDir(async (dir) => {
		const outside = await readQuantManifestFile(dir, "../outside.json");
		assert.ok(!outside.ok);
		if (!outside.ok) assert.match(outside.reason ?? "", /escapes the project root/);
	});
});
