/** Development-first commander write command controller. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	makeLeaseId,
	newConfirmationParts,
	parseUnlockArgs,
	parseWritePolicyArgs,
	renderLeaseConfirmed,
	renderLeaseIssued,
	renderUnlockPreview,
	renderWritePolicyStatus,
	UNLOCK_USAGE,
} from "./lease-command.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import {
	confirmLease,
	defaultWritePolicy,
	detectActorRole,
	issueLease,
	leaseCompactSummary,
	leaseStatus,
	revokeLease,
	type ActorFacts,
	type WriteLease,
} from "./write-authority.ts";

export interface CommanderWriteCommandController {
	pi: Pick<ExtensionAPI, "registerCommand">;
	getMode(): WorkbenchMode;
	getIdentity(): ActorFacts;
	getLease(): WriteLease | undefined;
	setLease(lease: WriteLease | undefined): void;
	syncLease(now?: string): void;
	persistLease(): boolean | void;
	applyModeTools(): void;
	refreshStatus(ctx: ExtensionCommandContext): void | Promise<void>;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
	now?(): string;
}

/** Register the three user-only high-risk lease commands as one owned domain. */
export function registerCommanderWriteCommands(controller: CommanderWriteCommandController): void {
	const now = controller.now ?? (() => new Date().toISOString());
	const persistLease = (): boolean => {
		try {
			return controller.persistLease() !== false;
		} catch {
			return false;
		}
	};
	const persistOrLock = (lease: WriteLease, timestamp: string): boolean => {
		controller.setLease(lease);
		if (persistLease()) return true;
		controller.setLease(revokeLease(lease, "lease persistence unavailable", timestamp));
		persistLease();
		controller.applyModeTools();
		return false;
	};
	const persistenceFailure = (ctx: ExtensionCommandContext): void => {
		controller.output(ctx, ["High-risk write lease storage unavailable; ordinary direct writes remain available and high-risk paths stay locked"]);
	};

	controller.pi.registerCommand("q-write-policy", {
		description:
			"Show development write status: ordinary edit/write are direct; high-risk paths use a bounded optional lease (never displays confirmation tokens)",
		handler: async (args, ctx) => {
			const parsed = parseWritePolicyArgs(args);
			if (!parsed.ok) {
				controller.output(ctx, [`/q-write-policy: ${parsed.error}`]);
				return;
			}
			controller.syncLease();
			const timestamp = now();
			const identity = controller.getIdentity();
			controller.output(ctx, renderWritePolicyStatus({
				actor: detectActorRole(identity),
				provider: identity.provider,
				model: identity.model,
				policy: defaultWritePolicy(identity.provider, identity.model),
				lease: controller.getLease(),
				now: timestamp,
			}));
		},
	});

	controller.pi.registerCommand("q-commander-write-unlock", {
		description:
			"Temporary high-risk write lease for Sol in DEV: /q-commander-write-unlock <reason> --paths <comma-list> --calls <N> --minutes <N> (ordinary edit/write does not need this command)",
		handler: async (args, ctx) => {
			const timestamp = now();
			controller.syncLease(timestamp);
			const identity = controller.getIdentity();
			const actor = detectActorRole(identity);
			const policy = defaultWritePolicy(identity.provider, identity.model);
			if (actor !== "sol-commander" || policy !== "worker-first-strict") {
				controller.output(ctx, [
					`/q-commander-write-unlock: refused — only GPT-5.6 Sol on an approved provider may authorize high-risk paths (current actor: ${actor}, policy: ${policy ?? "not-applicable"})`,
				]);
				return;
			}
			if (controller.getMode() !== "DEV") {
				controller.output(ctx, [
					`/q-commander-write-unlock: refused — high-risk write leases exist only in DEV mode (current mode: ${controller.getMode()})`,
				]);
				return;
			}
			const parsed = parseUnlockArgs(args);
			if (!parsed.ok) {
				controller.output(ctx, [`/q-commander-write-unlock: ${parsed.error}`, UNLOCK_USAGE]);
				return;
			}
			if (parsed.kind === "confirm") {
				const lease = controller.getLease();
				if (!lease) {
					controller.output(ctx, [`/q-commander-write-unlock: no pending lease to confirm — issue one first (${UNLOCK_USAGE})`]);
					return;
				}
				if (parsed.leaseId !== undefined && parsed.leaseId !== lease.id) {
					controller.output(ctx, [`/q-commander-write-unlock: lease id mismatch — the pending lease is "${lease.id}"`]);
					return;
				}
				const status = leaseStatus(lease, timestamp);
				if (status !== "pending") {
					controller.output(ctx, [`/q-commander-write-unlock: lease ${lease.id} is ${status}, not pending — it cannot be confirmed now`]);
					return;
				}
				const confirmed = confirmLease(lease, parsed.partA, parsed.partB, timestamp);
				if (!confirmed.ok) {
					controller.output(ctx, [`/q-commander-write-unlock: ${confirmed.error} — the high-risk lease remains inactive`]);
					return;
				}
				if (!persistOrLock(confirmed.lease, timestamp)) {
					persistenceFailure(ctx);
					void controller.refreshStatus(ctx);
					return;
				}
				controller.applyModeTools();
				controller.output(ctx, renderLeaseConfirmed(confirmed.lease, timestamp));
				void controller.refreshStatus(ctx);
				return;
			}

			const existing = controller.getLease();
			const existingStatus = existing ? leaseStatus(existing, timestamp) : "locked";
			if (existingStatus === "pending") {
				controller.output(ctx, [`/q-commander-write-unlock: lease ${existing!.id} is already pending confirmation — confirm it or run /q-commander-write-lock first`]);
				return;
			}
			if (existingStatus === "active") {
				controller.output(ctx, [`/q-commander-write-unlock: lease ${existing!.id} is already active — run /q-commander-write-lock first to replace it`]);
				return;
			}

			const leaseId = makeLeaseId(timestamp);
			const tokens = newConfirmationParts();
			const issued = issueLease({
				id: leaseId,
				reason: parsed.reason,
				paths: parsed.paths,
				maxCalls: parsed.calls,
				durationMs: parsed.minutes * 60_000,
				confirmationTokenA: tokens.partA,
				confirmationTokenB: tokens.partB,
				now: timestamp,
			});
			if (!issued.ok) {
				controller.output(ctx, [`/q-commander-write-unlock: ${issued.error}`]);
				return;
			}
			if (ctx.mode === "tui") {
				const preview = renderUnlockPreview({
					leaseId,
					reason: parsed.reason,
					paths: parsed.paths,
					calls: parsed.calls,
					minutes: parsed.minutes,
					now: timestamp,
				});
				const accepted = await ctx.ui.confirm("Grant temporary high-risk write lease?", preview.join("\n"));
				if (!accepted) {
					controller.output(ctx, ["/q-commander-write-unlock: canceled — no high-risk lease issued; ordinary direct edits remain available"]);
					return;
				}
				const confirmed = confirmLease(issued.lease, tokens.partA, tokens.partB, timestamp);
				if (!confirmed.ok) {
					controller.output(ctx, [`/q-commander-write-unlock: ${confirmed.error}`]);
					return;
				}
				if (!persistOrLock(confirmed.lease, timestamp)) {
					persistenceFailure(ctx);
					void controller.refreshStatus(ctx);
					return;
				}
				controller.applyModeTools();
				controller.output(ctx, renderLeaseConfirmed(confirmed.lease, timestamp));
			} else {
				if (!persistOrLock(issued.lease, timestamp)) {
					persistenceFailure(ctx);
					void controller.refreshStatus(ctx);
					return;
				}
				controller.applyModeTools();
				controller.output(ctx, renderLeaseIssued(issued.lease, timestamp));
			}
			void controller.refreshStatus(ctx);
		},
	});

	controller.pi.registerCommand("q-commander-write-lock", {
		description: "Revoke the temporary high-risk write lease; ordinary direct edit/write remains available",
		handler: async (_args, ctx) => {
			const timestamp = now();
			controller.syncLease(timestamp);
			let lease = controller.getLease();
			if (lease) {
				lease = revokeLease(lease, "user-directed lock via /q-commander-write-lock", timestamp);
				if (!persistOrLock(lease, timestamp)) persistenceFailure(ctx);
			}
			controller.applyModeTools();
			controller.output(ctx, [
				lease
					? `/q-commander-write-lock: high-risk lease ${lease.id} revoked (${lease.revokedReason}); ordinary direct edits remain available`
					: "/q-commander-write-lock: no high-risk lease is active; ordinary direct edits remain available",
				leaseCompactSummary(lease, timestamp),
			]);
			void controller.refreshStatus(ctx);
		},
	});
}
