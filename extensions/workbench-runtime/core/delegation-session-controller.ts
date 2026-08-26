/** Runtime-scoped delegation session mirror and project-authority reconciliation. */

import type { ExecFn } from "./config.ts";
import type {
	collectCurrentDelegationBindingV2,
	ProjectDelegationAuthorityIssueV2,
	reconcileProjectDelegationAuthorityV2,
} from "./delegation-project-authority.ts";
import {
	DELEGATION_STATE_ENTRY_TYPE,
	emptyDelegationState,
	loadDelegationStateFromEntries,
	markReviewed,
	observeDiffChange,
	serializeDelegationState,
	type DelegationState,
	type DelegationStateEntry,
} from "./delegation-state.ts";

export interface DelegationSessionServices {
	collectCurrentBinding: typeof collectCurrentDelegationBindingV2;
	reconcileProjectAuthority: typeof reconcileProjectDelegationAuthorityV2;
}

export interface DelegationSessionControllerOptions {
	exec: ExecFn;
	appendEntry(customType: string, data: unknown): void;
	onStateChanged(state: DelegationState): void;
}

export interface DelegationSessionController {
	getState(): DelegationState;
	setState(nextState: DelegationState): void;
	restore(entries: readonly DelegationStateEntry[]): DelegationState;
	persistBestEffort(): void;
	persistStrict(nextState?: DelegationState): void;
	isStrictMirrorDirty(): boolean;
	setStrictMirrorDirty(dirty: boolean): void;
	markTerminalMirrorBlocked(): void;
	getProjectAuthorityIssue(): ProjectDelegationAuthorityIssueV2 | undefined;
	clearProjectAuthorityIssue(): void;
	projectAuthorityBlockReason(target: "delegation" | "verify" | "review"): string | undefined;
	collectCurrentBinding(projectRoot: string, delegationId?: string): ReturnType<DelegationSessionServices["collectCurrentBinding"]>;
	collectCurrentDiffHash(projectRoot: string): Promise<string | null>;
	projectTerminalReviewedBinding(projectRoot: string, delegationId: string, now: string): Promise<DelegationState | null>;
	reconcileProjectAuthority(projectRoot: string, now: string, options?: { deferReviewedFreshness?: boolean }): Promise<boolean>;
}

/** Create one isolated delegation mirror; no state is shared across runtimes. */
export function createDelegationSessionController(
	options: DelegationSessionControllerOptions,
	services: DelegationSessionServices,
): DelegationSessionController {
	let state = emptyDelegationState();
	let strictMirrorDirty = false;
	let terminalMirrorBlocked = false;
	let projectAuthorityIssue: ProjectDelegationAuthorityIssueV2 | undefined;

	function changed(): void {
		options.onStateChanged(state);
	}

	function persistStrict(nextState: DelegationState = state): void {
		options.appendEntry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(nextState));
		state = nextState;
		strictMirrorDirty = false;
		terminalMirrorBlocked = false;
		changed();
	}

	const controller: DelegationSessionController = {
		getState: () => state,
		setState(nextState) {
			state = nextState;
		},
		restore(entries) {
			state = loadDelegationStateFromEntries(entries);
			strictMirrorDirty = false;
			terminalMirrorBlocked = false;
			projectAuthorityIssue = undefined;
			changed();
			return state;
		},
		persistBestEffort() {
			changed();
			try {
				options.appendEntry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(state));
			} catch {
				// The in-memory state remains authoritative for this runtime.
			}
		},
		persistStrict,
		isStrictMirrorDirty: () => strictMirrorDirty,
		setStrictMirrorDirty(dirty) {
			strictMirrorDirty = dirty;
		},
		markTerminalMirrorBlocked() {
			terminalMirrorBlocked = true;
		},
		getProjectAuthorityIssue: () => projectAuthorityIssue,
		clearProjectAuthorityIssue() {
			projectAuthorityIssue = undefined;
		},
		projectAuthorityBlockReason(target) {
			if (projectAuthorityIssue === undefined) return undefined;
			const id = projectAuthorityIssue.delegationId ?? "latest";
			return `Project delegation authority ${id} is ${projectAuthorityIssue.code}; ${target} fails closed`;
		},
		collectCurrentBinding(projectRoot, delegationId = state.latestId) {
			return services.collectCurrentBinding(projectRoot, delegationId, options.exec);
		},
		async collectCurrentDiffHash(projectRoot) {
			const binding = await controller.collectCurrentBinding(projectRoot);
			return binding.status === "unavailable" ? null : binding.hash;
		},
		async projectTerminalReviewedBinding(projectRoot, delegationId, now) {
			const binding = await controller.collectCurrentBinding(projectRoot, delegationId);
			if (binding.status !== "fresh") return null;
			const projected = observeDiffChange(state, binding.hash, now);
			const reviewed = markReviewed(projected, now);
			return reviewed.ok ? reviewed.state : null;
		},
		async reconcileProjectAuthority(projectRoot, now, reconcileOptions = {}) {
			const reconciled = await services.reconcileProjectAuthority({
				project_root: projectRoot,
				current_state: state,
				now,
				exec: options.exec,
				terminal_mirror_blocked: terminalMirrorBlocked,
				defer_reviewed_freshness: reconcileOptions.deferReviewedFreshness,
			});
			if (!reconciled.ok) {
				projectAuthorityIssue = reconciled.issue;
				changed();
				return false;
			}
			projectAuthorityIssue = undefined;
			if (reconciled.state === null) {
				if (state.latestId === undefined && !strictMirrorDirty) return true;
				const cleared = emptyDelegationState();
				try {
					persistStrict(cleared);
				} catch {
					state = cleared;
					strictMirrorDirty = true;
					changed();
				}
				return true;
			}
			if (reconciled.state === state && !strictMirrorDirty) return true;
			try {
				persistStrict(reconciled.state);
			} catch {
				state = reconciled.state;
				strictMirrorDirty = true;
				changed();
			}
			return true;
		},
	};
	return Object.freeze(controller);
}
