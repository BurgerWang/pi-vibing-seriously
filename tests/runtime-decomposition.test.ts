/** Architecture checks for the decomposed runtime composition root. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const RUNTIME_ROOT = join(ROOT, "extensions", "workbench-runtime");
const INDEX_PATH = join(RUNTIME_ROOT, "index.ts");
const RUNTIME_MODULES = [
	"core/compare-tool-controller.ts",
	"core/delegate-tool-controller.ts",
	"core/delegation-session-controller.ts",
	"core/delegation-status-tool-controller.ts",
	"core/gate-tools-controller.ts",
	"core/message-end-controller.ts",
	"core/milestone-handoff-controller.ts",
	"core/native-tool-overrides-controller.ts",
	"core/recipe-tools-controller.ts",
	"core/recovery-tool-controller.ts",
	"core/review-tool-controller.ts",
	"core/runtime-controller-services.ts",
	"core/runtime-output-controller.ts",
	"core/runtime-transient-state.ts",
	"core/runtime-workbench-tools-controller.ts",
	"core/tool-call-guard-controller.ts",
	"core/tool-result-middleware-controller.ts",
	"index.ts",
] as const;

function relativeImports(source: string): string[] {
	return [...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)]
		.map((match) => match[1])
		.filter((specifier): specifier is string => typeof specifier === "string");
}

test("index is a bounded composition root and public tool behavior lives in controllers", async () => {
	const [source, toolsController] = await Promise.all([
		readFile(INDEX_PATH, "utf8"),
		readFile(join(RUNTIME_ROOT, "core", "runtime-workbench-tools-controller.ts"), "utf8"),
	]);
	const lines = source.split("\n").length - 1;
	assert.ok(lines <= 2_000, `index.ts must stay at or below 2,000 lines; got ${lines}`);
	assert.doesNotMatch(source, /\bpi\.registerTool\(/, "composition root delegates every public tool registration");
	for (const directDomainCall of [
		"executeDelegationV2(",
		"reviewDelegationV2(",
		"compareRuns(",
		"recoverReceipt(",
		"runRecipe(",
		"runGate(",
	]) {
		assert.equal(source.includes(directDomainCall), false, directDomainCall);
	}
	assert.match(source, /createRuntimeTransientState\(\)/);
	assert.match(source, /registerRuntimeWorkbenchToolsV1\(\{/);
	assert.match(toolsController, /services: RUNTIME_CONTROLLER_SERVICES\.(compare|delegate|review|recovery)/);
});

test("runtime controller layer has no relative import cycle or import back to index", async () => {
	const files = new Set(RUNTIME_MODULES.map((path) => normalize(join(RUNTIME_ROOT, path))));
	const graph = new Map<string, string[]>();
	for (const file of files) {
		const source = await readFile(file, "utf8");
		if (file !== INDEX_PATH) {
			assert.equal(relativeImports(source).some((specifier) => normalize(resolve(dirname(file), specifier)) === INDEX_PATH), false, relative(RUNTIME_ROOT, file));
		}
		graph.set(file, relativeImports(source)
			.map((specifier) => normalize(resolve(dirname(file), specifier)))
			.filter((dependency) => files.has(dependency)));
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	function visit(file: string, path: string[]): void {
		if (visiting.has(file)) {
			const cycleStart = path.indexOf(file);
			assert.fail(`runtime import cycle: ${path.slice(cycleStart).concat(file).map((item) => relative(RUNTIME_ROOT, item)).join(" -> ")}`);
		}
		if (visited.has(file)) return;
		visiting.add(file);
		for (const dependency of graph.get(file) ?? []) visit(dependency, [...path, file]);
		visiting.delete(file);
		visited.add(file);
	}
	for (const file of files) visit(file, []);
});

test("mutable streaming identity and FIFO state are runtime-scoped, not module globals", async () => {
	const [output, transient] = await Promise.all([
		readFile(join(RUNTIME_ROOT, "core", "runtime-output-controller.ts"), "utf8"),
		readFile(join(RUNTIME_ROOT, "core", "runtime-transient-state.ts"), "utf8"),
	]);
	assert.doesNotMatch(output, /^const locallyBoundedStreamingUpdates/m);
	assert.match(output, /export function streamingControlledApi[\s\S]*const locallyBoundedStreamingUpdates = new WeakSet<object>\(\);/);
	for (const registry of ["outputAuthorizations", "readContinuations", "runLogContinuations", "gateContinuations", "ingressAuthorities", "processedNormalResults"]) {
		assert.match(transient, new RegExp(`function createRuntimeTransientState\\(\\)[\\s\\S]*const ${registry} = new Map`));
	}
});
