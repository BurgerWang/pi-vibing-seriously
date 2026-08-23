import assert from "node:assert/strict";
import { test } from "node:test";

import {
	canonicalWorkerContractBytes,
	normalizeWorkerContractReason,
	normalizeWorkerContractText,
	parseWorkerVerificationRecipeReference,
	stableUniqueStrings,
	workerContractComparisonKey,
	workerVerificationRecipeNames,
} from "../extensions/workbench-runtime/core/worker-contract.ts";

test("worker contract text retains internal layout while comparison keys only drive stable de-duplication", () => {
	const retained = normalizeWorkerContractText("  keep\n  yaml:\n    key: value  ");
	assert.equal(retained, "keep\n  yaml:\n    key: value");
	assert.equal(workerContractComparisonKey(retained), "keep yaml: key: value");
	assert.deepEqual(
		stableUniqueStrings(["Keep  exact\n spacing", " Keep exact spacing ".trim(), "Second"], workerContractComparisonKey),
		["Keep  exact\n spacing", "Second"],
	);
	assert.equal(normalizeWorkerContractReason("  bounded\n cross-module   detail "), "bounded cross-module detail");
});

test("verification references are exact parseable recipe catalog keys", () => {
	assert.deepEqual(parseWorkerVerificationRecipeReference("recipe:test:unit"), {
		reference: "recipe:test:unit",
		recipe: "test:unit",
	});
	for (const invalid of ["test:unit", " recipe:test", "recipe:test ", "recipe:", "recipe:test\nmore", 7]) {
		assert.equal(parseWorkerVerificationRecipeReference(invalid), undefined);
	}
	assert.deepEqual(workerVerificationRecipeNames(["recipe:test", "recipe:typecheck"]), ["test", "typecheck"]);
	assert.equal(workerVerificationRecipeNames(["recipe:test", "free prose"]), undefined);
});

test("canonical byte measurement is deterministic and fails closed for non-JSON values", () => {
	assert.equal(canonicalWorkerContractBytes({ b: "é" }), Buffer.byteLength(JSON.stringify({ b: "é" }), "utf8"));
	assert.equal(canonicalWorkerContractBytes({ bad: 1n }), undefined);
});
