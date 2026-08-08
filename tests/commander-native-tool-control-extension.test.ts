/**
 * Hermetic unit tests for the DEV-PILOT control extension
 * (`scripts/commander-native-tool-control-extension.ts`).
 *
 * The control proxy is exercised ONLY against a stub `ExtensionAPI`: the
 * full workbench runtime (`extensions/workbench-runtime/index.ts`) is
 * imported transitively for typecheck wiring but its factory is NEVER
 * invoked, and the script's default export (the only path that would run
 * the runtime) is only asserted to be a function. No provider, model or
 * network call can occur.
 *
 * Covered contract:
 *   - suppression names are EXACTLY the canonical three (read/grep/find),
 *     reused via `NATIVE_OVERRIDE_NAMES` — never duplicated;
 *   - `registerTool` calls whose `definition.name` is exactly one of the
 *     canonical three are dropped (target never called, returns undefined);
 *   - every other registration delegates unchanged — same definition object,
 *     same order, return values and thrown errors propagated; only exact
 *     names are suppressed (case/substring near-misses and nameless
 *     definitions delegate);
 *   - non-register methods are bound to the ORIGINAL target (receiver
 *     preserved for direct, destructured and async calls) with return
 *     values and errors propagated;
 *   - property reads/writes behave as intended and land on the original
 *     target (the proxy accumulates no own state);
 *   - only `registerTool` is intercepted — other API methods delegate with
 *     arguments preserved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import devPilotControlExtension, {
	createDevPilotControlApi,
	DEV_PILOT_CONTROL_LABEL,
	DEV_PILOT_SUPPRESSED_TOOL_NAMES,
	isSuppressedToolName,
} from "../scripts/commander-native-tool-control-extension.ts";
import { NATIVE_OVERRIDE_NAMES } from "../extensions/workbench-runtime/core/native-tool-policy.ts";

// ------------------------------------------------------------------ stubs

/** Errors thrown by the stub so tests can assert identity propagation. */
const EXPLODE_ERROR = new Error("explode-error");
const BOOM_ERROR = new Error("boom-error");

interface StubAPI {
	registered: Array<{ name: string; def: unknown }>;
	property: string;
	receiverSeen: unknown[];
	registerCalls: number;
	commandCalls: string[];
	eventCalls: string[];
}

/** Minimal structurally-valid tool definition for the stub surface. */
function toolDef(name: string): ToolDefinition<any, any, any> {
	return {
		name,
		label: `Label: ${name}`,
		description: `Description: ${name}`,
		parameters: {} as never,
		async execute() {
			return { content: [], details: undefined };
		},
	} as ToolDefinition<any, any, any>;
}

/**
 * Stub ExtensionAPI recording every registration (name + exact definition
 * reference, in call order), a receiver-probe method pair, an error method,
 * and a writable property. `registerTool` throws `EXPLODE_ERROR` for the
 * `explode` name so tests can prove suppressed names never reach the target.
 */
function makeStub(): StubAPI & ExtensionAPI {
	const stub: StubAPI & ExtensionAPI = {
		registered: [],
		property: "initial-value",
		receiverSeen: [],
		registerCalls: 0,
		commandCalls: [],
		eventCalls: [],
		registerTool: (def: { name: string }) => {
			stub.registerCalls += 1;
			stub.registered.push({ name: def.name, def });
			if (def.name === "explode") {
				throw EXPLODE_ERROR;
			}
			return "registered-ok";
		},
		probeReceiver: function (this: unknown, tag: string) {
			stub.receiverSeen.push(this);
			return `probe-${tag}`;
		},
		asyncProbe: async function (this: unknown, tag: string) {
			stub.receiverSeen.push(this);
			return `async-${tag}`;
		},
		boom: function () {
			throw BOOM_ERROR;
		},
		registerCommand: (name: string) => {
			stub.commandCalls.push(name);
			return "command-ok";
		},
		on: () => {
			stub.eventCalls.push("on");
			return "on-ok";
		},
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

/** Loose surface view of the control proxy for non-API stub methods. */
interface ControlSurface {
	probeReceiver: (tag: string) => string;
	asyncProbe: (tag: string) => Promise<string>;
	boom: () => never;
	property: string;
	missing?: unknown;
	added?: number;
	registerCommand: (name: string) => string;
	on: () => string;
}

// ------------------------------------------------------------------ tests

test("suppression names are exactly the canonical three, reused not duplicated", () => {
	assert.deepEqual([...NATIVE_OVERRIDE_NAMES], ["read", "grep", "find"]);
	assert.deepEqual([...DEV_PILOT_SUPPRESSED_TOOL_NAMES], ["read", "grep", "find"]);
	// identity: the control list IS the canonical list — never a copy
	assert.equal(DEV_PILOT_SUPPRESSED_TOOL_NAMES, NATIVE_OVERRIDE_NAMES);
	for (const name of NATIVE_OVERRIDE_NAMES) {
		assert.equal(isSuppressedToolName(name), true);
	}
	// exact-name matching only: case variants, substrings and near-misses are not suppressed
	for (const name of ["Read", "reader", "find_all", "grep_count", "workbench_read_run", "read2"]) {
		assert.equal(isSuppressedToolName(name), false);
	}
});

test("read/grep/find registrations are suppressed; all others delegate unchanged in order", () => {
	const stub = makeStub();
	const controlled = createDevPilotControlApi(stub);

	const readDef = toolDef("read");
	const grepDef = toolDef("grep");
	const readCaseDef = toolDef("Read"); // near-miss: must NOT be suppressed
	const aDef = toolDef("workbench_project_inspect");
	const findDef = toolDef("find");
	const bDef = toolDef("workbench_run_recipe");
	const cDef = toolDef("workbench_read_run"); // substring near-miss: must NOT be suppressed

	controlled.registerTool(readDef);
	controlled.registerTool(grepDef);
	controlled.registerTool(readCaseDef);
	controlled.registerTool(aDef);
	controlled.registerTool(findDef);
	controlled.registerTool(bDef);
	controlled.registerTool(cDef);

	// only the four non-suppressed registrations reached the target
	assert.equal(stub.registerCalls, 4);
	assert.deepEqual(
		stub.registered.map((r) => r.name),
		["Read", "workbench_project_inspect", "workbench_run_recipe", "workbench_read_run"],
	);
	// the exact definition objects are preserved (reference equality), in order
	assert.equal(stub.registered[0]?.def, readCaseDef);
	assert.equal(stub.registered[1]?.def, aDef);
	assert.equal(stub.registered[2]?.def, bDef);
	assert.equal(stub.registered[3]?.def, cDef);
});

test("suppressed registrations return undefined and never reach the target, even when it would throw", () => {
	const stub = makeStub();
	const controlled = createDevPilotControlApi(stub);
	const register = controlled.registerTool as unknown as (def: { name: string }) => string;

	assert.equal(register(toolDef("read")), undefined);
	assert.equal(register(toolDef("grep")), undefined);
	assert.equal(register(toolDef("find")), undefined);
	// the stub would throw for "explode" — suppressed names never get there
	assert.equal(stub.registerCalls, 0);
	assert.deepEqual(stub.registered, []);
});

test("non-suppressed registrations propagate return values and errors", () => {
	const stub = makeStub();
	const controlled = createDevPilotControlApi(stub);
	const register = controlled.registerTool as unknown as (def: { name: string }) => string;

	// the target's return value is propagated
	assert.equal(register(toolDef("workbench_run_recipe")), "registered-ok");
	// the target's thrown error is propagated (same instance)
	assert.throws(() => register(toolDef("explode")), (err: unknown) => err === EXPLODE_ERROR);
	// a nameless definition is not suppressed — it delegates to the target
	assert.equal(register({} as never), "registered-ok");
	assert.equal(stub.registerCalls, 3);
});

test("non-register methods are bound to the original target (receiver preserved)", async () => {
	const stub = makeStub();
	const controlled = createDevPilotControlApi(stub);
	const surface = controlled as unknown as ControlSurface;

	// direct call through the proxy
	assert.equal(surface.probeReceiver("direct"), "probe-direct");
	// destructured call (the pattern the runtime may use)
	const { probeReceiver } = surface;
	assert.equal(probeReceiver("destructured"), "probe-destructured");
	// async method call
	assert.equal(await surface.asyncProbe("async"), "async-async");

	// every call saw the ORIGINAL target as `this`, never the proxy
	assert.equal(stub.receiverSeen.length, 3);
	for (const receiver of stub.receiverSeen) {
		assert.equal(receiver, stub);
	}
});

test("non-register method return values and errors propagate", () => {
	const stub = makeStub();
	const controlled = createDevPilotControlApi(stub);
	const surface = controlled as unknown as ControlSurface;

	assert.equal(surface.probeReceiver("value"), "probe-value");
	assert.throws(() => surface.boom(), (err: unknown) => err === BOOM_ERROR);
});

test("property reads and writes behave as intended and land on the original target", () => {
	const stub = makeStub();
	const controlled = createDevPilotControlApi(stub);
	const surface = controlled as unknown as ControlSurface;

	// reads resolve against the target; missing properties read as undefined
	assert.equal(surface.property, "initial-value");
	assert.equal(surface.missing, undefined);

	// writes to existing properties land on the target and read back
	surface.property = "updated-value";
	assert.equal(stub.property, "updated-value");
	assert.equal(surface.property, "updated-value");

	// writes of NEW properties also land on the target (the proxy accumulates
	// no own state), and read back through the proxy
	surface.added = 42;
	assert.equal((stub as unknown as { added?: number }).added, 42);
	assert.equal(surface.added, 42);
});

test("only registerTool is intercepted; other API methods delegate with arguments preserved", () => {
	const stub = makeStub();
	const controlled = createDevPilotControlApi(stub);
	const surface = controlled as unknown as ControlSurface;

	assert.equal(surface.registerCommand("my-command"), "command-ok");
	assert.equal(surface.on(), "on-ok");
	assert.deepEqual(stub.commandCalls, ["my-command"]);
	assert.deepEqual(stub.eventCalls, ["on"]);
});

test("default export is the DEV-PILOT control factory and is never invoked by tests", () => {
	assert.equal(typeof devPilotControlExtension, "function");
	assert.equal(DEV_PILOT_CONTROL_LABEL, "dev-pilot-control-approximation");
	assert.ok(DEV_PILOT_CONTROL_LABEL.length > 0);
});
