/** Session-local FIFO registries shared by runtime controllers. */

import { exactCallKey } from "./runtime-output-controller.ts";
import { toolResultTextContentDigest } from "./trusted-recovery-authority.ts";
import type { TrustedRecoveryAuthority } from "./tool-result-ingress-projection.ts";
import type { TurnOutputAuthorization } from "./turn-output-budget.ts";

export const MAX_PENDING_TRUSTED_INGRESS_SLOTS = 64;

export interface BoundTrustedIngressAuthority {
	readonly authority: TrustedRecoveryAuthority;
	readonly contentDigest: string;
}

interface TrustedIngressAuthoritySlot {
	readonly bound?: BoundTrustedIngressAuthority;
}

export interface RuntimeTransientState {
	rememberOutputAuthorization(authorization: TurnOutputAuthorization): void;
	takeOutputAuthorization(toolCallId: unknown, toolName: unknown): TurnOutputAuthorization | undefined;
	peekOutputAuthorization(toolCallId: unknown, toolName: unknown): TurnOutputAuthorization | undefined;
	rememberTrustedReadContinuation(toolCallId: unknown, cursor: unknown): void;
	takeTrustedReadContinuation(toolCallId: unknown, toolName: unknown): { kind: "read"; value: string } | undefined;
	rememberTrustedRunLogContinuation(toolCallId: unknown, cursor: unknown): void;
	takeTrustedRunLogContinuation(toolCallId: unknown, toolName: unknown): { kind: "run-log"; value: string } | undefined;
	rememberTrustedGateContinuation(toolCallId: unknown, cursor: unknown): void;
	takeTrustedGateContinuation(toolCallId: unknown, toolName: unknown): { kind: "gate-read"; value: string } | undefined;
	bindTrustedIngressAuthority(authority: TrustedRecoveryAuthority | undefined, content: unknown): BoundTrustedIngressAuthority | undefined;
	rememberTrustedIngressAuthority(toolCallId: unknown, toolName: unknown, bound: BoundTrustedIngressAuthority | undefined): void;
	takeTrustedIngressAuthority(toolCallId: unknown, toolName: unknown): BoundTrustedIngressAuthority | undefined;
	resetTrustedIngressAuthorities(): void;
	rememberProcessedNormalResult(toolCallId: unknown, toolName: unknown): void;
	takeProcessedNormalResult(toolCallId: unknown, toolName: unknown): boolean;
	clearOutputAuthorizations(): void;
	resetTurn(): void;
}

/** Create one isolated set of runtime-scoped transient registries. */
export function createRuntimeTransientState(): RuntimeTransientState {
	const outputAuthorizations = new Map<string, TurnOutputAuthorization[]>();
	const readContinuations = new Map<string, Array<{ kind: "read"; value: string }>>();
	const runLogContinuations = new Map<string, Array<{ kind: "run-log"; value: string }>>();
	const gateContinuations = new Map<string, Array<{ kind: "gate-read"; value: string }>>();
	const ingressAuthorities = new Map<string, TrustedIngressAuthoritySlot[]>();
	const processedNormalResults = new Map<string, number>();
	let ingressSlotCount = 0;
	let ingressSaturated = false;

	function takeFrom<T>(store: Map<string, T[]>, toolCallId: unknown, toolName: unknown): T | undefined {
		const key = exactCallKey(toolCallId, toolName);
		if (!key) return undefined;
		const queue = store.get(key);
		const value = queue?.shift();
		if (queue?.length === 0) store.delete(key);
		return value;
	}

	function rememberContinuation<T extends { kind: string; value: string }>(
		store: Map<string, T[]>,
		toolCallId: unknown,
		toolName: string,
		kind: T["kind"],
		cursor: unknown,
	): void {
		if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1_024) return;
		const key = exactCallKey(toolCallId, toolName);
		if (!key) return;
		const queue = store.get(key) ?? [];
		queue.push({ kind, value: cursor } as T);
		store.set(key, queue);
	}

	function resetTrustedIngressAuthorities(): void {
		ingressAuthorities.clear();
		ingressSlotCount = 0;
		ingressSaturated = false;
	}

	const state: RuntimeTransientState = {
		rememberOutputAuthorization(authorization) {
			if (!authorization.authorizationId) return;
			const key = exactCallKey(authorization.toolCallId, authorization.toolName);
			if (!key) return;
			const queue = outputAuthorizations.get(key) ?? [];
			queue.push(authorization);
			outputAuthorizations.set(key, queue);
		},
		takeOutputAuthorization: (toolCallId, toolName) => takeFrom(outputAuthorizations, toolCallId, toolName),
		peekOutputAuthorization(toolCallId, toolName) {
			const key = exactCallKey(toolCallId, toolName);
			return key ? outputAuthorizations.get(key)?.[0] : undefined;
		},
		rememberTrustedReadContinuation: (toolCallId, cursor) =>
			rememberContinuation(readContinuations, toolCallId, "read", "read", cursor),
		takeTrustedReadContinuation(toolCallId, toolName) {
			return toolName === "read" ? takeFrom(readContinuations, toolCallId, toolName) : undefined;
		},
		rememberTrustedRunLogContinuation: (toolCallId, cursor) =>
			rememberContinuation(runLogContinuations, toolCallId, "workbench_read_run", "run-log", cursor),
		takeTrustedRunLogContinuation(toolCallId, toolName) {
			return toolName === "workbench_read_run" ? takeFrom(runLogContinuations, toolCallId, toolName) : undefined;
		},
		rememberTrustedGateContinuation: (toolCallId, cursor) =>
			rememberContinuation(gateContinuations, toolCallId, "workbench_read_gate", "gate-read", cursor),
		takeTrustedGateContinuation(toolCallId, toolName) {
			return toolName === "workbench_read_gate" ? takeFrom(gateContinuations, toolCallId, toolName) : undefined;
		},
		bindTrustedIngressAuthority(authority, content) {
			if (!authority) return undefined;
			const contentDigest = toolResultTextContentDigest(content);
			return contentDigest ? Object.freeze({ authority, contentDigest }) : undefined;
		},
		rememberTrustedIngressAuthority(toolCallId, toolName, bound) {
			if (ingressSaturated) return;
			const key = exactCallKey(toolCallId, toolName);
			if (!key) return;
			if (ingressSlotCount >= MAX_PENDING_TRUSTED_INGRESS_SLOTS) {
				ingressAuthorities.clear();
				ingressSlotCount = 0;
				ingressSaturated = true;
				return;
			}
			const queue = ingressAuthorities.get(key) ?? [];
			queue.push(Object.freeze({ ...(bound ? { bound } : {}) }));
			ingressAuthorities.set(key, queue);
			ingressSlotCount += 1;
		},
		takeTrustedIngressAuthority(toolCallId, toolName) {
			if (ingressSaturated) return undefined;
			const value = takeFrom(ingressAuthorities, toolCallId, toolName);
			if (value) ingressSlotCount = Math.max(0, ingressSlotCount - 1);
			return value?.bound;
		},
		resetTrustedIngressAuthorities,
		rememberProcessedNormalResult(toolCallId, toolName) {
			const key = exactCallKey(toolCallId, toolName);
			if (key) processedNormalResults.set(key, (processedNormalResults.get(key) ?? 0) + 1);
		},
		takeProcessedNormalResult(toolCallId, toolName) {
			const key = exactCallKey(toolCallId, toolName);
			if (!key) return false;
			const count = processedNormalResults.get(key) ?? 0;
			if (count <= 0) return false;
			if (count === 1) processedNormalResults.delete(key);
			else processedNormalResults.set(key, count - 1);
			return true;
		},
		clearOutputAuthorizations: () => outputAuthorizations.clear(),
		resetTurn() {
			outputAuthorizations.clear();
			readContinuations.clear();
			runLogContinuations.clear();
			gateContinuations.clear();
			processedNormalResults.clear();
			resetTrustedIngressAuthorities();
		},
	};
	return Object.freeze(state);
}
