/** User-only milestone/session handoff command controller. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { COMPACT_STATE_ENTRY_TYPE, type CompactState } from "./compact.ts";
import {
	DELEGATION_STATE_ENTRY_TYPE,
	delegationCompactSummary,
	serializeDelegationState,
	type DelegationState,
} from "./delegation-state.ts";
import {
	buildMilestoneHandoffNote,
	makeMilestoneId,
	MILESTONE_HANDOFF_ENTRY_TYPE,
	MILESTONE_HANDOFF_NOTE_ENTRY_TYPE,
	milestoneHandoffUsage,
	parseNextStepArg,
	prepareMilestoneHandoff,
	toCancelledRecord,
	toResumedRecord,
} from "./milestone-handoff.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { MODE_ENTRY_TYPE } from "./state.ts";

export interface MilestoneHandoffCommandController {
	pi: Pick<ExtensionAPI, "appendEntry" | "registerCommand">;
	getRole(): string | undefined;
	getMode(): WorkbenchMode;
	getCompactState(): CompactState;
	getDelegationState(): DelegationState;
	getSecrets(): readonly string[];
	refreshCompactFacts(): void;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
	now?(): Date;
}

/**
 * Register the complete milestone handoff lifecycle behind one thin runtime
 * adapter. The controller deliberately carries no write lease into the new
 * session: ordinary development writes remain direct, while high-risk writes
 * require fresh user authorization.
 */
export function registerMilestoneHandoffCommand(controller: MilestoneHandoffCommandController): void {
	const now = controller.now ?? (() => new Date());

	controller.pi.registerCommand("q-milestone-handoff", {
		description:
			"USER-ONLY milestone handoff: /q-milestone-handoff <next step> — starts a fresh parent-linked session; high-risk leases are not carried, while ordinary direct edit/write remains available",
		handler: async (args, ctx) => {
			// Refuse worker invocation before parsing or mutating session state.
			if (controller.getRole() === "worker") {
				controller.output(ctx, [
					"/q-milestone-handoff: refused — this command is user-only; a delegated worker cannot start a milestone handoff",
				]);
				return;
			}

			const parsed = parseNextStepArg(args);
			if (!parsed.ok) {
				controller.output(ctx, [`/q-milestone-handoff: ${parsed.error}`, milestoneHandoffUsage()]);
				return;
			}

			await ctx.waitForIdle();
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				controller.output(ctx, [
					"/q-milestone-handoff: refused — the current session is not persisted yet (wait for the first assistant response before handing off)",
				]);
				return;
			}

			// Capture source facts before newSession fires session_start("new") and
			// resets in-memory state to the target session defaults.
			controller.refreshCompactFacts();
			const preparedAt = now();
			const record = prepareMilestoneHandoff({
				milestoneId: makeMilestoneId(preparedAt),
				nextStep: parsed.nextStep,
				session: sessionFile,
				state: controller.getCompactState(),
				secrets: controller.getSecrets(),
				now: preparedAt.toISOString(),
			});
			const sourceMode = controller.getMode();
			const sourceDelegationState = controller.getDelegationState();
			const sourceDelegation = serializeDelegationState(sourceDelegationState);
			const sourceDelegationSummary = delegationCompactSummary(sourceDelegationState);

			// Persist the source record before attempting session replacement.
			controller.pi.appendEntry(MILESTONE_HANDOFF_ENTRY_TYPE, record);
			const outcome = await ctx.newSession({
				parentSession: sessionFile,
				setup: async (sessionManager) => {
					const resumed = toResumedRecord(record, now().toISOString());
					sessionManager.appendCustomEntry(MILESTONE_HANDOFF_ENTRY_TYPE, resumed);
					sessionManager.appendCustomMessageEntry(
						MILESTONE_HANDOFF_NOTE_ENTRY_TYPE,
						buildMilestoneHandoffNote(resumed),
						false,
						{ milestone_id: resumed.milestone_id, lifecycle: "resumed", updated_at: resumed.updated_at },
					);
					sessionManager.appendCustomEntry(MODE_ENTRY_TYPE, { mode: sourceMode });
					sessionManager.appendCustomEntry(COMPACT_STATE_ENTRY_TYPE, record.state);
					sessionManager.appendCustomEntry(DELEGATION_STATE_ENTRY_TYPE, sourceDelegation);
				},
				withSession: async (replacementCtx) => {
					controller.output(replacementCtx, [
						`/q-milestone-handoff: milestone ${record.milestone_id} handed off to a fresh parent-linked session`,
						`next step   : ${record.next_step}`,
						`source      : ${record.session}`,
						`mode        : ${record.state?.mode ?? sourceMode}`,
						`delegation  : ${sourceDelegationSummary}`,
						"write lease : NOT carried — high-risk paths require fresh authorization; ordinary direct edits remain available",
						"hidden milestone note injected (pointers/status only); reloading to restore copied state…",
					]);
					await replacementCtx.reload();
				},
			});

			if (outcome.cancelled) {
				controller.pi.appendEntry(
					MILESTONE_HANDOFF_ENTRY_TYPE,
					toCancelledRecord(record, now().toISOString()),
				);
				controller.output(ctx, [
					`/q-milestone-handoff: cancelled — no new session was started; the current session is unchanged (cancellation recorded for milestone ${record.milestone_id})`,
				]);
			}
		},
	});
}
