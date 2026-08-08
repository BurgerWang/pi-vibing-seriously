/**
 * DEV-PILOT control extension — APPROXIMATION ONLY, NEVER FINAL EVIDENCE.
 *
 * This module is a DEV-pilot control approximation for the Commander Native
 * Tool Optimization (NRO) plan (`docs/plans/commander-native-tool-
 * optimization.md`): it runs the CURRENT normal workbench runtime extension
 * (`extensions/workbench-runtime/index.ts` default export) behind a Proxy
 * that suppresses exactly the three NRO native same-name overrides
 * (`read`, `grep`, `find` — the canonical `NATIVE_OVERRIDE_NAMES`), so the
 * Pi built-in tools stay in effect for those three names while every other
 * current workbench behavior (the 11 catalog tools, commands, events, state,
 * gates, cache, worker delegation, …) is delegated unchanged.
 *
 * It is a CONTROL/APPROXIMATION artifact for a DEV pilot only:
 *   - it removes the current NRO native overrides for measurement purposes;
 *   - it keeps all other current workbench behavior byte-for-byte;
 *   - it is NEVER final-arm or adoption evidence: no conclusion about the
 *     NRO treatment vs. control may be drawn from this module alone, and it
 *     must not be wired into any production/acceptance configuration.
 *
 * The proxy intercepts ONLY `registerTool` (exact-name suppression of the
 * canonical three names). Every other property read, write and method call
 * delegates to the ORIGINAL target object: callable values are bound to the
 * target so `this`/receiver and private-state semantics are preserved, and
 * the proxy itself never accumulates own state. Return values and thrown
 * errors propagate untouched.
 *
 * The default export is a pi-extension factory (sync-runtime compatible:
 * it awaits the normal runtime invocation) and must only ever be loaded by
 * the DEV-pilot harness — never by the production extension loader.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { NATIVE_OVERRIDE_NAMES } from "../extensions/workbench-runtime/core/native-tool-policy.ts";

/**
 * Fixed DEV-PILOT marker: this module is a control APPROXIMATION, never
 * final-arm or adoption evidence.
 */
export const DEV_PILOT_CONTROL_LABEL = "dev-pilot-control-approximation" as const;

/**
 * The exact tool-registration names this DEV-PILOT control proxy suppresses:
 * the canonical three NRO native override names, REUSED (not duplicated)
 * from the runtime policy module (`NATIVE_OVERRIDE_NAMES`), in canonical
 * order. Static — never derived from dynamic state.
 */
export const DEV_PILOT_SUPPRESSED_TOOL_NAMES: readonly string[] = NATIVE_OVERRIDE_NAMES;

/** Exact-name suppression set built once from the canonical names. */
const SUPPRESSED_REGISTRATION_NAMES = new Set<string>(NATIVE_OVERRIDE_NAMES);

/**
 * Exact-name predicate: `true` only for the canonical three NRO native
 * override names (`read`, `grep`, `find`). Case-sensitive; substrings and
 * near-misses (e.g. `Read`, `workbench_read_run`) are never suppressed.
 */
export function isSuppressedToolName(name: string): boolean {
	return SUPPRESSED_REGISTRATION_NAMES.has(name);
}

/**
 * Wrap an `ExtensionAPI` in the DEV-PILOT control proxy.
 *
 * Intercepts ONLY `registerTool`:
 *   - a registration whose `definition.name` is exactly one of
 *     `DEV_PILOT_SUPPRESSED_TOOL_NAMES` is suppressed (dropped, returns
 *     `undefined`, the target is never called);
 *   - every other registration delegates to the original API unchanged (same
 *     definition object, same call order), with the target's return value
 *     and thrown errors propagated.
 *
 * All other API surface delegates safely to the original target: callable
 * values are bound to the target (so `this`/receiver and private-state
 * semantics are preserved for direct, destructured and callback-style
 * calls), property reads resolve against the target, and property writes
 * land on the target — the proxy never accumulates own state.
 */
export function createDevPilotControlApi(api: ExtensionAPI): ExtensionAPI {
	const handler: ProxyHandler<ExtensionAPI> = {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (tool: ToolDefinition<any, any, any>): void => {
					if (typeof tool?.name === "string" && isSuppressedToolName(tool.name)) {
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
 * DEV-PILOT control extension factory: invokes (and awaits) the NORMAL
 * current workbench runtime through the control proxy, i.e. the full
 * current workbench behavior minus the three NRO native overrides.
 *
 * APPROXIMATION ONLY — never final-arm or adoption evidence. For DEV-pilot
 * harness use only; never the production extension entry point.
 */
export default async function devPilotControlExtension(pi: ExtensionAPI): Promise<void> {
	const controlled = createDevPilotControlApi(pi);
	await workbenchRuntime(controlled);
}
