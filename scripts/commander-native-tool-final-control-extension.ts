/**
 * FINAL-ARM control extension — FINAL COLLECTION ONLY (never a DEV
 * approximation; not adoption evidence by itself).
 *
 * This module is the FINAL control adapter for the Commander Native Tool
 * Optimization (NRO) plan (`docs/plans/commander-native-tool-optimization.md`)
 * and its frozen protocol (`docs/baselines/commander-native-tool-benchmark-
 * protocol.md`, §3.5/§4.1): it runs the CURRENT normal workbench runtime
 * extension (`extensions/workbench-runtime/index.ts` default export) behind
 * a Proxy that suppresses exactly the three NRO native same-name overrides
 * (`read`, `grep`, `find` — the canonical `NATIVE_OVERRIDE_NAMES`), so the
 * Pi built-in tools stay in effect for those three names while every other
 * current workbench behavior (the 11 catalog tools, commands, events,
 * state, gates, cache, worker delegation, …) is delegated unchanged.
 *
 * FINAL-ARM SEMANTICS (protocol §3.5):
 *   - control and treatment load the SAME current runtime source; only the
 *     control arm runs it through this adapter;
 *   - a literal pre-N1 checkout (`aa2301763d95`) is NOT the control arm —
 *     that committed revision is itself a reproducible pre-N1 tree, but the
 *     CURRENT working tree contains other uncommitted runtime changes made
 *     after that commit, so running the old committed runtime would differ
 *     from treatment beyond the three overrides and confound the
 *     only-permitted-difference rule;
 *   - this module is FINAL-COLLECTION ONLY and is NOT the DEV-pilot
 *     approximation (`scripts/commander-native-tool-control-extension.ts`,
 *     label `dev-pilot-control-approximation`), which is never used as
 *     final evidence; the two modules are independently named and labeled.
 *
 * The proxy intercepts ONLY `registerTool` (exact-name suppression of the
 * canonical three names). Every other property read, write and method call
 * delegates to the ORIGINAL target object: callable values are bound to the
 * target so `this`/receiver and private-state semantics are preserved, and
 * the proxy itself never accumulates own state. Return values and thrown
 * errors propagate untouched.
 *
 * The default export is a pi-extension factory (async-runtime compatible:
 * it awaits the normal runtime invocation) and must only ever be loaded by
 * the FINAL collection harness — never by the production extension loader.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { NATIVE_OVERRIDE_NAMES } from "../extensions/workbench-runtime/core/native-tool-policy.ts";

/**
 * Fixed FINAL-ARM marker: this module is the FINAL control adapter (final
 * collection only) — deliberately distinct from the DEV-pilot approximation
 * label (`dev-pilot-control-approximation`). The DEV-only wrapper is never
 * used as final evidence.
 */
export const FINAL_CONTROL_LABEL = "final-arm-control" as const;

/**
 * The exact tool-registration names this FINAL control proxy suppresses:
 * the canonical three NRO native override names, REUSED (not duplicated)
 * by identity from the runtime policy module (`NATIVE_OVERRIDE_NAMES`), in
 * canonical order. Static — never derived from dynamic state.
 */
export const FINAL_SUPPRESSED_TOOL_NAMES: readonly string[] = NATIVE_OVERRIDE_NAMES;

/** Exact-name suppression set built once from the canonical names. */
const SUPPRESSED_REGISTRATION_NAMES = new Set<string>(NATIVE_OVERRIDE_NAMES);

/**
 * Exact-name predicate: `true` only for the canonical three NRO native
 * override names (`read`, `grep`, `find`). Case-sensitive; substrings and
 * near-misses (e.g. `Read`, `workbench_read_run`) are never suppressed.
 */
export function isFinalControlSuppressedToolName(name: string): boolean {
	return SUPPRESSED_REGISTRATION_NAMES.has(name);
}

/**
 * Wrap an `ExtensionAPI` in the FINAL control proxy.
 *
 * Intercepts ONLY `registerTool`:
 *   - a registration whose `definition.name` is exactly one of
 *     `FINAL_SUPPRESSED_TOOL_NAMES` is suppressed (dropped, returns
 *     `undefined`, the target is never called);
 *   - every other registration delegates to the original API unchanged
 *     (same definition object, same call order), with the target's return
 *     value and thrown errors propagated.
 *
 * All other API surface delegates safely to the original target: callable
 * values are bound to the target (so `this`/receiver and private-state
 * semantics are preserved for direct, destructured and callback-style
 * calls), property reads resolve against the target, and property writes
 * land on the target — the proxy never accumulates own state.
 */
export function createFinalControlApi(api: ExtensionAPI): ExtensionAPI {
	const handler: ProxyHandler<ExtensionAPI> = {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (tool: ToolDefinition<any, any, any>): void => {
					if (typeof tool?.name === "string" && isFinalControlSuppressedToolName(tool.name)) {
						return;
					}
					return target.registerTool(tool);
				};
			}
			const value = Reflect.get(target, prop, target);
			if (typeof value === "function") {
				return value.bind(target);
			}
			return value;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	};
	return new Proxy(api, handler);
}

/**
 * FINAL control extension factory: invokes (and awaits) the NORMAL current
 * workbench runtime through the control proxy, i.e. the full current
 * workbench behavior minus the three NRO native overrides.
 *
 * FINAL COLLECTION ONLY — never the production extension entry point; never
 * a DEV approximation. For final-harness use only.
 */
export default async function finalControlExtension(pi: ExtensionAPI): Promise<void> {
	const controlled = createFinalControlApi(pi);
	await workbenchRuntime(controlled);
}
