/** Mode, status, observability and widget command controller. */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	evaluateAdvisory,
	renderAdvisoryFacts,
	type AdvisoryConfig,
} from "./commander-advisory.ts";
import { buildCostBreakdown, renderCostBreakdown } from "./cost-breakdown.ts";
import {
	delegationCompactSummary,
	reviewBlockReason,
	type DelegationState,
} from "./delegation-state.ts";
import { loadProjectConfig } from "./config.ts";
import { MODE_TOOLS, type WorkbenchMode } from "./mode-policy.ts";
import {
	renderOutputControlStatus,
	type OutputControlTelemetryAccumulator,
} from "./output-control-telemetry.ts";
import { describeMode } from "./state.ts";
import {
	defaultWritePolicy,
	detectActorRole,
	leaseCompactSummary,
	type ActorFacts,
	type WriteLease,
} from "./write-authority.ts";
import { delegationContextRiskLine } from "../worker/context-diagnostics.ts";

export interface StatusCommandController {
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "registerCommand">;
	getMode(): WorkbenchMode;
	setMode(mode: WorkbenchMode, ctx: ExtensionContext, label: string): void;
	getIdentity(): ActorFacts;
	getLease(): WriteLease | undefined;
	getDelegationState(): DelegationState;
	syncLease(): void;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<unknown>;
	getProjectAuthorityBlockReason(action: "verify"): string | undefined;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	delegationStatusLines(projectRoot: string): Promise<{ lines: string[] }>;
	getOutputTelemetry(): OutputControlTelemetryAccumulator;
	getWidgetForced(): boolean;
	setWidgetForced(forced: boolean): void;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
	refreshStatus(ctx: ExtensionCommandContext): void | Promise<void>;
	refreshWidget(ctx: ExtensionCommandContext): void | Promise<void>;
	now?(): string;
}

/** Register all human-facing mode/status commands behind one state adapter. */
export function registerStatusCommands(controller: StatusCommandController): void {
	const now = controller.now ?? (() => new Date().toISOString());

	controller.pi.registerCommand("q-mode-audit", {
		description: "Switch workbench to AUDIT mode (read-only: read, grep, find, ls, workbench_project_inspect, workbench_read_run)",
		handler: async (_args, ctx) => controller.setMode("AUDIT", ctx, "AUDIT mode"),
	});

	controller.pi.registerCommand("q-mode-dev", {
		description: "Switch workbench to DEV mode (full local development tools)",
		handler: async (_args, ctx) => controller.setMode("DEV", ctx, "DEV mode"),
	});

	controller.pi.registerCommand("q-mode-verify", {
		description:
			"Switch workbench to VERIFY mode (read, grep, find, ls, workbench tools; no free bash/edit/write — declared recipes only)",
		handler: async (_args, ctx) => {
			const projectRoot = await controller.projectRootFor(ctx);
			await controller.reconcileProjectAuthority(projectRoot, now());
			const block = controller.getProjectAuthorityBlockReason("verify")
				?? reviewBlockReason(controller.getDelegationState(), "verify");
			if (block) {
				controller.output(ctx, [`/q-mode-verify: ${block}`]);
				return;
			}
			controller.setMode("VERIFY", ctx, "VERIFY mode");
		},
	});

	controller.pi.registerCommand("q-status", {
		description: "Show workbench mode, cwd, project trust, active tools, and workbench tools",
		handler: async (_args, ctx) => {
			controller.syncLease();
			const mode = controller.getMode();
			const identity = controller.getIdentity();
			let projectAuthorityBlock: string | undefined;
			if (ctx.isProjectTrusted()) {
				try {
					const projectRoot = await controller.projectRootFor(ctx);
					await controller.reconcileProjectAuthority(projectRoot, now());
					projectAuthorityBlock = controller.getProjectAuthorityBlockReason("verify");
				} catch {
					projectAuthorityBlock = "project delegation authority status is unavailable; delegation and VERIFY fail closed";
				}
			}
			const delegationState = controller.getDelegationState();
			const workbenchTools = controller.pi.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => name.startsWith("workbench_"));
			const lines = [
				`workbench mode : ${mode} — ${describeMode(mode)}`,
				`cwd            : ${ctx.cwd}`,
				`project trust  : ${ctx.isProjectTrusted() ? "trusted" : "not trusted"}`,
				`active tools   : ${controller.pi.getActiveTools().join(", ") || "(none)"}`,
				`mode tool set  : ${MODE_TOOLS[mode].join(", ")}`,
				`workbench tools: ${workbenchTools.length > 0 ? workbenchTools.join(", ") : "(none registered)"}`,
				`agent role     : ${identity.roleEnv ?? "commander"}`,
				`actor identity : ${detectActorRole(identity)} (${identity.provider ?? "(none)"}/${identity.model ?? "(none)"})`,
				`write policy   : ${defaultWritePolicy(identity.provider, identity.model) ?? "not-applicable"}`,
				`write lease    : ${leaseCompactSummary(controller.getLease(), now())}`,
				`delegation     : ${delegationCompactSummary(delegationState)}`,
				`project auth   : ${projectAuthorityBlock ?? "available"}`,
				"path policy    : write .env/.pem/.key/credentials.*/secrets.*/auth.json blocked in all modes; read blocked in AUDIT/VERIFY, allowed in DEV",
				"command guard  : rm -rf / or ~, git reset --hard, git clean -fd, git push --force, git checkout -- ., git restore ., git remote changes, rm .git, git config --global writes, sudo, npm/yarn/pnpm/bun publish",
			];
			const contextRisk = delegationContextRiskLine(ctx.sessionManager.getEntries());
			if (contextRisk) lines.push(contextRisk);
			controller.output(ctx, lines);
		},
	});

	controller.pi.registerCommand("q-cost-status", {
		description:
			"Show the split session cost breakdown from session entries: commander (assistant usage), worker (workbench_delegate_worker tool results), other (tools/summaries), total, per-model commander costs, and the P7 commander advisory facts (observation-only — never a hard stop)",
		handler: async (_args, ctx) => {
			const breakdown = buildCostBreakdown(ctx.sessionManager.getEntries());
			let advisoryConfig: AdvisoryConfig | undefined;
			try {
				if (ctx.isProjectTrusted()) {
					const projectRoot = await controller.projectRootFor(ctx);
					advisoryConfig = (await loadProjectConfig(projectRoot, { trusted: true })).commanderAdvisory;
				}
			} catch {
				// Observation stays available with default advisory thresholds.
			}
			const facts = evaluateAdvisory(breakdown, advisoryConfig);
			controller.output(ctx, [...renderCostBreakdown(breakdown), "", ...renderAdvisoryFacts(facts)]);
		},
	});

	controller.pi.registerCommand("q-context-output-status", {
		description:
			"Show numeric-only context-output observations; optional exact subcommand: json (observation-only, never enforcement)",
		handler: async (args, ctx) => {
			const format = typeof args === "string" ? args.trim() : "";
			if (format !== "" && format !== "json") {
				controller.output(ctx, ["usage: /q-context-output-status [json]"]);
				return;
			}
			const snapshot = controller.getOutputTelemetry().snapshot();
			controller.output(ctx, renderOutputControlStatus(snapshot, format === "json" ? "json" : "text").split("\n"));
		},
	});

	controller.pi.registerCommand("q-delegation-status", {
		description:
			"Show write-authority and delegation review status: actor, write policy, lease, latest delegation, review status, current/reviewed binding hashes, blocked write attempts, latest review verdict (new v2 refreshes worker/dependency/control relevance and rejects unknown-origin drift; historical v2/v1 retain full-diff freshness)",
		handler: async (_args, ctx) => {
			controller.syncLease();
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-delegation-status: ${trustError}`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const status = await controller.delegationStatusLines(projectRoot);
			const contextRisk = delegationContextRiskLine(ctx.sessionManager.getEntries());
			controller.output(ctx, contextRisk ? [...status.lines, contextRisk] : status.lines);
			void controller.refreshStatus(ctx);
		},
	});

}

/** Register widget at its historical command-order position. */
export function registerWidgetCommand(controller: StatusCommandController): void {
	controller.pi.registerCommand("q-widget", {
		description: "Toggle the workbench widget: /q-widget on | /q-widget off (widget also shows during tasks and gate failures)",
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument === "on") {
				controller.setWidgetForced(true);
				controller.output(ctx, ["workbench widget: on (shown while a task is active, a gate is failing, or forced)"]);
			} else if (argument === "off") {
				controller.setWidgetForced(false);
				controller.output(ctx, ["workbench widget: off (auto-hides; still shows during tasks and gate failures)"]);
			} else {
				controller.output(ctx, ["/q-widget: usage: /q-widget on | /q-widget off"]);
				return;
			}
			await controller.refreshWidget(ctx);
		},
	});
}
