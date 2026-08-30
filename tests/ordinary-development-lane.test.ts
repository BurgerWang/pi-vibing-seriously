/**
 * WP4 ordinary DEV-lane verification reuse.
 *
 * The final check is reusable only for the exact unchanged Candidate and
 * invocation. Focused checks, changed params/state, VERIFY mode and explicit
 * no-cache/refresh requests execute normally. Reuse creates no duplicate run
 * transaction and is deliberately separate from the action cache.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { type ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import { registerRecipeTools } from "../extensions/workbench-runtime/core/recipe-tools-controller.ts";
import { runRecipe } from "../extensions/workbench-runtime/core/recipe-runner.ts";
import type { RecipeMutationFacts } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { initializeGitFixture, spawnExec, withTempDir, writeConfigFile } from "./helpers.ts";

const SOL_FACTS: RecipeMutationFacts = {
	provider: "openai-codex",
	model: "gpt-5.6-sol",
};

const RECIPES_YAML = `
recipes:
  - name: check
    description: complete final verification
    command: [node, -e, "process.exit(0)", "{{variant}}"]
    params:
      - { name: variant, type: string, required: true }
    mutation: none
    writes: []
    validation_components: [typecheck, unit-test, whitespace]
  - name: focused
    description: focused unit check
    command: [node, -e, "process.exit(0)"]
    mutation: none
    writes: []
    validation_components: [unit-test]
`;

function monotonicClock(): () => Date {
	let tick = Date.parse("2026-08-28T00:00:00.000Z");
	return () => new Date(tick += 1_000);
}

async function runIds(root: string): Promise<string[]> {
	return (await readdir(join(root, CONFIG_DIR_NAME, "workbench", "runs"), { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

test("ordinary DEV final verification reuses only the exact unchanged Candidate", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "candidate.ts"), "export const candidate = 1;\n", "utf8");
		await writeConfigFile(root, "recipes.yaml", RECIPES_YAML);
		await initializeGitFixture(root);

		let recipeExecutions = 0;
		const exec: ExecFn = async (command, args, options) => {
			if (command === "env") recipeExecutions += 1;
			return spawnExec(command, args, options);
		};
		const now = monotonicClock();
		const invoke = (overrides: Partial<Parameters<typeof runRecipe>[0]> = {}) => runRecipe({
			projectRoot: root,
			recipeName: "check",
			params: { variant: "stable" },
			mode: "DEV",
			exec,
			actorFacts: SOL_FACTS,
			now,
			...overrides,
		});

		const first = await invoke();
		assert.equal(first.ok, true);
		assert.equal(first.validationReuse, undefined);
		assert.equal(first.ordinaryCandidate?.status, "VERIFIED");
		assert.equal(first.ordinaryCandidate?.authorityScope, "DEVELOPMENT_ONLY");
		assert.match(first.ordinaryCandidate?.candidateIdentity ?? "", /^[0-9a-f]{64}$/);
		assert.deepEqual(first.record?.runtime_identity, {
			schema_version: 1,
			kind: "workbench-run-runtime-v1",
			workbench_version: first.record?.runtime_identity?.workbench_version,
			workbench_build: first.record?.runtime_identity?.workbench_build,
			workbench_source_hash: first.record?.runtime_identity?.workbench_source_hash,
			node_version: process.version,
			platform: process.platform,
			architecture: process.arch,
		});
		assert.match(first.record?.runtime_identity?.workbench_source_hash ?? "", /^sha256:[0-9a-f]{64}$/);
		assert.equal(recipeExecutions, 1);
		assert.equal((await runIds(root)).length, 1);

		const unchanged = await invoke();
		assert.deepEqual(unchanged.validationReuse, {
			status: "REUSED_CURRENT_CANDIDATE",
			sourceRunId: first.record?.run_id,
			validationIdentity: unchanged.validationReuse?.validationIdentity,
			executionSkipped: true,
		});
		assert.match(unchanged.validationReuse?.validationIdentity ?? "", /^[0-9a-f]{64}$/);
		assert.equal(unchanged.record?.run_id, first.record?.run_id);
		assert.equal(unchanged.ordinaryCandidate?.candidateIdentity, first.ordinaryCandidate?.candidateIdentity);
		assert.equal(recipeExecutions, 1, "unchanged Candidate must not spawn a duplicate final check");
		assert.equal((await runIds(root)).length, 1, "reuse must not create a duplicate run transaction");

		const changedInvocation = await invoke({ params: { variant: "other" } });
		assert.equal(changedInvocation.validationReuse, undefined);
		assert.notEqual(changedInvocation.ordinaryCandidate?.candidateIdentity, first.ordinaryCandidate?.candidateIdentity);
		assert.equal(recipeExecutions, 2, "changed argv identity must execute");

		const repeatedChangedInvocation = await invoke({ params: { variant: "other" } });
		assert.equal(repeatedChangedInvocation.validationReuse?.sourceRunId, changedInvocation.record?.run_id);
		assert.equal(recipeExecutions, 2);

		await writeFile(join(root, "candidate.ts"), "export const candidate = 2;\n", "utf8");
		const changedCandidate = await invoke({ params: { variant: "other" } });
		assert.equal(changedCandidate.validationReuse, undefined);
		assert.notEqual(changedCandidate.ordinaryCandidate?.candidateIdentity, changedInvocation.ordinaryCandidate?.candidateIdentity);
		assert.equal(recipeExecutions, 3, "changed Candidate identity must execute");

		const repeatedChangedCandidate = await invoke({ params: { variant: "other" } });
		assert.equal(repeatedChangedCandidate.validationReuse?.sourceRunId, changedCandidate.record?.run_id);
		assert.equal(recipeExecutions, 3);

		const noCache = await invoke({ params: { variant: "other" }, cacheMode: "no-cache" });
		assert.equal(noCache.validationReuse, undefined);
		assert.equal(recipeExecutions, 4, "explicit no-cache must execute");

		const refresh = await invoke({ params: { variant: "other" }, cacheMode: "refresh-cache" });
		assert.equal(refresh.validationReuse, undefined);
		assert.equal(recipeExecutions, 5, "explicit refresh must execute");

		const verifyMode = await invoke({ params: { variant: "other" }, mode: "VERIFY" });
		assert.equal(verifyMode.validationReuse, undefined);
		assert.equal(recipeExecutions, 6, "VERIFY mode remains an execution lane");

		const focusedFirst = await invoke({ recipeName: "focused", params: {} });
		const focusedSecond = await invoke({ recipeName: "focused", params: {} });
		assert.equal(focusedFirst.validationReuse, undefined);
		assert.equal(focusedSecond.validationReuse, undefined);
		assert.equal(recipeExecutions, 8, "focused checks never inherit final-check reuse");
	});
});

test("workbench_run_recipe presents Candidate verification reuse without claiming strict authority", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "candidate.ts"), "export const candidate = 1;\n", "utf8");
		await writeConfigFile(root, "recipes.yaml", RECIPES_YAML);
		await initializeGitFixture(root);

		let recipeExecutions = 0;
		const exec: ExecFn = async (command, args, options) => {
			if (command === "env") recipeExecutions += 1;
			return spawnExec(command, args, options);
		};
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> }>();
		registerRecipeTools({
			pi: {
				registerTool: (definition: { name: string }) => {
					tools.set(definition.name, definition as unknown as (typeof tools extends Map<string, infer T> ? T : never));
				},
			},
			getMode: () => "DEV",
			getIdentity: () => SOL_FACTS,
			exec,
			trustedOrError: () => undefined,
			projectRootFor: async () => root,
			buildReadOnlyWorkerFirstGateFacts: async () => { throw new Error("not called"); },
			peekOutputAuthorization: () => undefined,
			rememberTrustedRunLogContinuation: () => {},
			bindTrustedIngressAuthority: () => undefined,
			rememberTrustedIngressAuthority: () => {},
		} as never);
		const tool = tools.get("workbench_run_recipe");
		assert.ok(tool);
		const updates: string[] = [];
		const execute = () => tool.execute(
			"wp4-final-check",
			{ recipe: "check", params: { variant: "stable" } },
			undefined,
			(update: { content?: Array<{ text?: string }> }) => updates.push(update.content?.[0]?.text ?? ""),
			{},
		);

		const first = await execute();
		const second = await execute();
		assert.equal(recipeExecutions, 1);
		assert.equal(updates[0], "Resolving declared recipe...");
		assert.match(first.content[0]?.text ?? "", /candidate\s+: VERIFIED/);
		assert.match(second.content[0]?.text ?? "", /REUSED_CURRENT_CANDIDATE; execution=SKIPPED/);
		assert.match(second.content[0]?.text ?? "", /Gate\/research\/release\/profit=NOT_GRANTED/);
		const details = second.details as {
			validation_reuse?: { execution_skipped?: boolean };
			ordinary_candidate?: Record<string, unknown>;
		};
		assert.equal(details.validation_reuse?.execution_skipped, true);
		assert.deepEqual(details.ordinary_candidate, {
			schema_version: 1,
			status: "VERIFIED",
			candidate_identity: (details.ordinary_candidate as { candidate_identity: string }).candidate_identity,
			validation_identity: (details.ordinary_candidate as { validation_identity: string }).validation_identity,
			source_run_id: (details.ordinary_candidate as { source_run_id: string }).source_run_id,
			authority_scope: "DEVELOPMENT_ONLY",
			gate_authority: false,
			research_authority: false,
			release_authority: false,
			profit_authority: false,
		});
	});
});
