/** Explicit user-only WP5 Candidate promotion command. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { boundedInlineDetail } from "./command-output.ts";
import type { ExecFn } from "./config.ts";
import { reviewBlockReason, type DelegationState } from "./delegation-state.ts";
import type { WorkerFirstGateFacts } from "./gate-schema.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { promoteCandidateV1, type PromotionTargetV1 } from "./promotion.ts";
import { runProjectCheckoutOperationV1 } from "./project-checkout-operation.ts";
import { isValidRunId } from "./runs.ts";
import type { RecipeMutationFacts } from "./worker-policy.ts";

const HASH_RE = /^[0-9a-f]{64}$/u;
export const PROMOTION_USAGE = "/q-promote research <candidate-id> <source-run-id> [manual:<check-id>=<evidence> ...] | /q-promote release <candidate-id> <source-run-id> --artifact-run <run-id> --authorize-release [manual:<check-id>=<evidence> ...]";

export type ParsedPromotionArgsV1 =
	| {
		ok: true;
		target: PromotionTargetV1;
		candidateIdentity: string;
		sourceRunId: string;
		artifactRunId?: string;
		releaseAuthorized: boolean;
		manualEvidence: Record<string, string>;
	}
	| { ok: false; error: string };

export function parsePromotionCommandArgsV1(args: string): ParsedPromotionArgsV1 {
	const tokens = args.trim().split(/\s+/u).filter(Boolean);
	const targetToken = tokens.shift();
	const candidateIdentity = tokens.shift() ?? "";
	const sourceRunId = tokens.shift() ?? "";
	if (targetToken !== "research" && targetToken !== "release") return { ok: false, error: "target must be research or release" };
	if (!HASH_RE.test(candidateIdentity)) return { ok: false, error: "candidate id must be 64 lowercase hex characters" };
	if (!isValidRunId(sourceRunId)) return { ok: false, error: "source run id is invalid" };
	let artifactRunId: string | undefined;
	let releaseAuthorized = false;
	const manualEvidence: Record<string, string> = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--authorize-release") {
			releaseAuthorized = true;
			continue;
		}
		if (token === "--artifact-run") {
			artifactRunId = tokens[index + 1];
			index += 1;
			continue;
		}
		if (token.startsWith("--artifact-run=")) {
			artifactRunId = token.slice("--artifact-run=".length);
			continue;
		}
		const separator = token.indexOf("=");
		if (separator > "manual:".length && token.startsWith("manual:")) {
			const checkId = token.slice("manual:".length, separator);
			const evidence = token.slice(separator + 1).trim();
			if (!checkId || !evidence) return { ok: false, error: "manual evidence needs a check id and non-empty value" };
			manualEvidence[checkId] = evidence;
			continue;
		}
		return { ok: false, error: `unknown argument ${boundedInlineDetail(token, 128)}` };
	}
	if (targetToken === "research" && (artifactRunId !== undefined || releaseAuthorized)) {
		return { ok: false, error: "release flags are not valid for research promotion" };
	}
	if (targetToken === "release" && (!artifactRunId || !isValidRunId(artifactRunId))) {
		return { ok: false, error: "release promotion requires a valid --artifact-run" };
	}
	if (targetToken === "release" && !releaseAuthorized) {
		return { ok: false, error: "release promotion requires the explicit --authorize-release flag" };
	}
	return {
		ok: true,
		target: targetToken === "release" ? "RELEASE_AUTHORIZED" : "RESEARCH_ACCEPTED",
		candidateIdentity,
		sourceRunId,
		artifactRunId,
		releaseAuthorized,
		manualEvidence,
	};
}

export interface PromotionCommandController {
	pi: Pick<ExtensionAPI, "registerCommand">;
	getMode(): WorkbenchMode;
	getDelegationState(): DelegationState;
	getActorFacts(): RecipeMutationFacts;
	getProjectAuthorityBlockReason(action: "verify"): string | undefined;
	reconcileProjectAuthority(projectRoot: string, now: string): Promise<boolean>;
	buildWorkerFirstFacts(projectRoot: string, now: string): Promise<WorkerFirstGateFacts>;
	exec: ExecFn;
	trustedOrError(ctx: ExtensionCommandContext): string | undefined;
	projectRootFor(ctx: ExtensionCommandContext): Promise<string>;
	output(ctx: ExtensionCommandContext, lines: string[]): void;
	refreshStatus(ctx: ExtensionCommandContext): void | Promise<void>;
	refreshWidget(ctx: ExtensionCommandContext): void | Promise<void>;
	now?(): string;
}

export function registerPromotionCommandV1(controller: PromotionCommandController): void {
	const now = controller.now ?? (() => new Date().toISOString());
	controller.pi.registerCommand("q-promote", {
		description: `Promote one frozen Candidate after a complete VERIFY Gate run: ${PROMOTION_USAGE}`,
		handler: async (args, ctx) => {
			const parsed = parsePromotionCommandArgsV1(args);
			if (!parsed.ok) {
				controller.output(ctx, [`/q-promote: ${parsed.error}`, `usage: ${PROMOTION_USAGE}`]);
				return;
			}
			const trustError = controller.trustedOrError(ctx);
			if (trustError) {
				controller.output(ctx, [`/q-promote: ${trustError}`]);
				return;
			}
			if (controller.getMode() !== "VERIFY") {
				controller.output(ctx, [`/q-promote: refused — Candidate promotion requires VERIFY mode (current mode: ${controller.getMode()})`]);
				return;
			}
			const projectRoot = await controller.projectRootFor(ctx);
			const timestamp = now();
			if (!await controller.reconcileProjectAuthority(projectRoot, timestamp)) {
				controller.output(ctx, ["/q-promote: checkout authority recovery is unavailable"]);
				return;
			}
			const block = controller.getProjectAuthorityBlockReason("verify") ?? reviewBlockReason(controller.getDelegationState(), "verify");
			if (block) {
				controller.output(ctx, [`/q-promote: ${block}`]);
				return;
			}
			try {
				const operation = await runProjectCheckoutOperationV1({
					project_root: projectRoot,
					operation_kind: "command",
					operation_id: `command:q-promote:${parsed.target}:${parsed.candidateIdentity}`.slice(0, 256),
					now: timestamp,
				}, async () => promoteCandidateV1({
					projectRoot,
					target: parsed.target,
					expectedCandidateIdentity: parsed.candidateIdentity,
					sourceRunId: parsed.sourceRunId,
					artifactRunId: parsed.artifactRunId,
					releaseAuthorized: parsed.releaseAuthorized,
					authorizationProvenance: "user-command",
					manualEvidence: parsed.manualEvidence,
					workerFirstFacts: await controller.buildWorkerFirstFacts(projectRoot, now()),
					actorFacts: controller.getActorFacts(),
					exec: controller.exec,
					signal: ctx.signal,
				}));
				if (!operation.ok) {
					controller.output(ctx, [`/q-promote: checkout writer lane ${operation.error.code}`]);
					return;
				}
				const result = operation.value;
				if (!result.ok) {
					controller.output(ctx, [
						`/q-promote: BLOCKED (${result.code})`,
						`candidate  : ${result.candidateIdentity ?? parsed.candidateIdentity}`,
						...(result.gateRunId ? [`gate run   : ${result.gateRunId} (${result.gateStatus ?? "authority unavailable"})`] : []),
						"DEV remains available for producing a new Candidate; no release, push, or publish was performed.",
					]);
					return;
				}
				controller.output(ctx, [
					`/q-promote: ${result.record.target}`,
					`candidate  : ${result.record.candidate_binding.candidate_identity}`,
					`gate run   : ${result.gateRunId} (PASS)`,
					`promotion  : ${result.record.promotion_identity}`,
					`alias      : ${result.record.target === "RELEASE_AUTHORIZED" ? "release-candidate" : "champion"}`,
					"profitability/better-strategy authority: NOT_GRANTED",
					"No push or publish was performed.",
					...(operation.release === "recovery_required" ? ["warning: promotion completed but checkout lock cleanup requires recovery"] : []),
				]);
				void controller.refreshStatus(ctx);
				void controller.refreshWidget(ctx);
			} catch (error) {
				controller.output(ctx, [`/q-promote: failed — ${boundedInlineDetail((error as Error).message, 1_024)}`]);
			}
		},
	});
}
