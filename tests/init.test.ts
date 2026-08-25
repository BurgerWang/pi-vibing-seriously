/**
 * Tests for q-init planning/application (P1 + P2).
 * Covers: non-overwrite of existing files, per-file overwrite confirmation,
 * unsupported profiles (no hft/market-making/lob/execution-engine), the
 * display-before-write plan, and the P2 AGENTS.md entry (selected by
 * profile, written to the project root, never overwritten by default).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { AGENTS_ENTRY_FILE, applyInit, planInit, renderInitPlan, retainInitContentSnapshot, type InitPlanEntry } from "../extensions/workbench-runtime/core/init.ts";
import { isSupportedInitProfile, UNSUPPORTED_PROFILES } from "../extensions/workbench-runtime/core/templates.ts";
import { withTempDir } from "./helpers.ts";

const exists = async (p: string): Promise<boolean> => access(p).then(() => true, () => false);

function memoryIO(written: Map<string, string>) {
	return {
		exists,
		write: async (path: string, content: string): Promise<void> => {
			written.set(path, content);
		},
	};
}

test("q-init plans the four config files plus AGENTS.md for a new project and writes them", async () => {
	await withTempDir(async (dir) => {
		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		assert.equal(plan.entries.length, 5);
		assert.ok(plan.entries.every((e) => e.action === "create"));
		assert.deepEqual(
			plan.entries.map((e) => e.file).sort(),
			["AGENTS.md", "gates.yaml", "profiles.yaml", "project.yaml", "recipes.yaml"],
		);

		const written = new Map<string, string>();
		await applyInit(plan, memoryIO(written));
		assert.equal(written.size, 5);
		assert.ok(written.get(join(plan.workbenchDir, "project.yaml"))?.includes("profile: generic"));
	});
});

test("AGENTS.md is planned at the project root, config files in the workbench dir", async () => {
	await withTempDir(async (dir) => {
		const plan = await planInit(dir, "quant-research/stock-selection", { exists, confirmOverwrite: async () => false });
		const agents = plan.entries.find((e) => e.file === AGENTS_ENTRY_FILE);
		assert.ok(agents);
		assert.equal(agents.path, join(dir, "AGENTS.md"));
		assert.ok(!agents.path.includes(join(dir, ".pi")), "AGENTS.md must not live inside .pi/workbench");
		for (const entry of plan.entries.filter((e) => e.file !== AGENTS_ENTRY_FILE) as InitPlanEntry[]) {
			assert.ok(entry.path.startsWith(join(dir, ".pi", "workbench")), entry.path);
		}
	});
});

test("AGENTS.md content is selected by profile (generic vs quant-research)", async () => {
	await withTempDir(async (dir) => {
		const genericPlan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		const written = new Map<string, string>();
		await applyInit(genericPlan, memoryIO(written));
		assert.ok(written.get(join(dir, "AGENTS.md"))?.includes("generic profile"), "generic profile writes the generic AGENTS template");

		const selectionPlan = await planInit(dir, "quant-research/stock-selection", { exists, confirmOverwrite: async () => false });
		const written2 = new Map<string, string>();
		await applyInit(selectionPlan, memoryIO(written2));
		const agents = written2.get(join(dir, "AGENTS.md"));
		assert.ok(agents?.includes("quant-research profile"), "quant profile writes the quant-research AGENTS template");
		assert.ok(agents?.includes("backtest"), "quant AGENTS template covers backtesting guidance");
	});
});

test("an existing AGENTS.md is NEVER overwritten by default", async () => {
	await withTempDir(async (dir) => {
		const original = "# My own AGENTS.md\nKeep me.\n";
		await writeFile(join(dir, "AGENTS.md"), original, "utf8");

		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		const agents = plan.entries.find((e) => e.file === AGENTS_ENTRY_FILE);
		assert.equal(agents?.action, "skip", "existing AGENTS.md defaults to skip");

		const written = new Map<string, string>();
		await applyInit(plan, memoryIO(written));
		assert.ok(!written.has(join(dir, "AGENTS.md")), "existing AGENTS.md must not be touched");
		assert.equal(written.size, 4, "only the four missing config files are written");
	});
});

test("AGENTS.md is overwritten only after explicit confirmation", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "AGENTS.md"), "old\n", "utf8");

		const plan = await planInit(dir, "generic", {
			exists,
			confirmOverwrite: async (file) => file === AGENTS_ENTRY_FILE,
		});
		const agents = plan.entries.find((e) => e.file === AGENTS_ENTRY_FILE);
		assert.equal(agents?.action, "overwrite");

		const written = new Map<string, string>();
		await applyInit(plan, memoryIO(written));
		assert.ok(written.get(join(dir, "AGENTS.md"))?.includes("generic profile"), "confirmed AGENTS.md is replaced by the profile template");
	});
});

test("a pre-release Git instruction migrates only through explicit AGENTS overwrite", async () => {
	await withTempDir(async (dir) => {
		const agentsPath = join(dir, AGENTS_ENTRY_FILE);
		await writeFile(agentsPath, "Use workbench_commit_reviewed after acceptance.\n", "utf8");

		const declined = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		assert.equal(declined.entries.find((entry) => entry.file === AGENTS_ENTRY_FILE)?.action, "skip");

		const approved = await planInit(dir, "generic", {
			exists,
			confirmOverwrite: async (file) => file === AGENTS_ENTRY_FILE,
		});
		const written = new Map<string, string>();
		await applyInit(approved, memoryIO(written));
		const migrated = written.get(agentsPath) ?? "";
		assert.match(migrated, /workbench_git action=checkpoint/);
		assert.doesNotMatch(migrated, /workbench_commit_reviewed/);
	});
});

test("q-init does NOT overwrite existing config files by default", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".pi", "workbench"), { recursive: true });
		const original = "recipes:\n  - name: mine\n    command: [\"ls\"]\n";
		await writeFile(join(dir, ".pi", "workbench", "recipes.yaml"), original, "utf8");

		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		const recipesEntry = plan.entries.find((e) => e.file === "recipes.yaml");
		assert.equal(recipesEntry?.action, "skip");

		const written = new Map<string, string>();
		await applyInit(plan, memoryIO(written));
		assert.ok(!written.has(join(plan.workbenchDir, "recipes.yaml")), "existing file must not be touched");
		assert.equal(written.size, 4, "only the three missing config files plus AGENTS.md are written");
	});
});

test("q-init overwrites only after per-file confirmation", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, ".pi", "workbench"), { recursive: true });
		await writeFile(join(dir, ".pi", "workbench", "project.yaml"), "name: old\n", "utf8");

		const confirmed: string[] = [];
		const plan = await planInit(dir, "generic", {
			exists,
			confirmOverwrite: async (file) => {
				confirmed.push(file);
				return file === "project.yaml"; // user says yes for project.yaml only
			},
		});
		assert.ok(confirmed.includes("project.yaml"));
		const projectEntry = plan.entries.find((e) => e.file === "project.yaml");
		assert.equal(projectEntry?.action, "overwrite");
		assert.ok(plan.entries.filter((e) => e.file !== "project.yaml").every((e) => e.action === "create"));

		const written = new Map<string, string>();
		await applyInit(plan, memoryIO(written));
		assert.ok(written.get(join(plan.workbenchDir, "project.yaml"))?.includes("profile: generic"), "confirmed file is replaced");
	});
});

test("unsupported profiles are rejected (no hft/market-making/lob/execution-engine)", async () => {
	await withTempDir(async (dir) => {
		for (const profile of UNSUPPORTED_PROFILES) {
			await assert.rejects(
				planInit(dir, profile, { exists, confirmOverwrite: async () => false }),
				/unsupported profile/,
			);
			assert.equal(isSupportedInitProfile(profile), false);
		}
		assert.equal(isSupportedInitProfile("generic"), true);
		assert.equal(isSupportedInitProfile("quant-research/stock-selection"), true);
		assert.equal(isSupportedInitProfile("quant-research/market-timing"), true);
		assert.equal(isSupportedInitProfile("quant-research"), false);
	});
});

test("the plan is rendered for display before anything is written", async () => {
	await withTempDir(async (dir) => {
		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		const lines = renderInitPlan(plan, ".pi");
		assert.ok(lines.some((l) => l.includes("Will create:")));
		assert.ok(lines.some((l) => l.includes("project.yaml")));
		assert.ok(lines.some((l) => l.includes("AGENTS.md (project root)")));
		assert.ok(lines.some((l) => l.includes("profile \"generic\"")));
	});
});

test("the plan marks an existing AGENTS.md as skipped in the display", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "AGENTS.md"), "keep\n", "utf8");
		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		const lines = renderInitPlan(plan, ".pi");
		assert.ok(lines.some((l) => l.includes("Already exists — will NOT overwrite")));
		assert.ok(lines.some((l) => l.includes("AGENTS.md (project root)")));
	});
});

test("generic q-init emits only package scripts that actually exist", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "node --test" } }), "utf8");
		await writeFile(join(dir, "package-lock.json"), "{}\n", "utf8");
		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		assert.equal(plan.recipePreset, "javascript-typescript/npm");
		const recipes = plan.contents["recipes.yaml"] ?? "";
		assert.match(recipes, /name: check:typecheck/);
		assert.match(recipes, /name: test:unit/);
		assert.doesNotMatch(recipes, /name: check:lint/);
		assert.doesNotMatch(recipes, /npm run build/);
	});
});

test("generic q-init fails closed when multiple package-manager lockfiles conflict", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
		await writeFile(join(dir, "package-lock.json"), "{}\n", "utf8");
		await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		assert.equal(plan.recipePreset, "javascript-typescript/not-configured-ambiguous-package-manager");
		assert.match(plan.contents["recipes.yaml"] ?? "", /NOT_CONFIGURED/);
		assert.match(plan.contents["recipes.yaml"] ?? "", /recipes: \[\]/);
		assert.doesNotMatch(plan.contents["recipes.yaml"] ?? "", /npm run|pnpm run/);
	});
});

test("q-init rechecks file actions but applies the exact recipe bytes shown in preview", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }), "utf8");
		const preview = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
		const currentActions = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		const applyPlan = retainInitContentSnapshot(currentActions, preview);
		assert.match(applyPlan.contents["recipes.yaml"] ?? "", /name: check:typecheck/);
		assert.doesNotMatch(applyPlan.contents["recipes.yaml"] ?? "", /name: test:unit/);
		assert.notEqual(currentActions.contents["recipes.yaml"], applyPlan.contents["recipes.yaml"]);
	});
});

test("generic q-init never promotes lint into whitespace validation authority", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }), "utf8");
		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		const parsed = parseYaml(plan.contents["recipes.yaml"] ?? "") as { recipes?: Array<{ name?: string; validation_components?: string[] }> };
		const lint = parsed.recipes?.find((entry) => entry.name === "check:lint");
		assert.deepEqual(lint?.validation_components, []);
	});
});

test("generic q-init produces Go presets and never injects npm into non-Node projects", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "go.mod"), "module example.test/project\n\ngo 1.24\n", "utf8");
		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		assert.equal(plan.recipePreset, "go");
		const recipes = plan.contents["recipes.yaml"] ?? "";
		assert.match(recipes, /command:\s*\n\s*- go\s*\n\s*- vet/);
		assert.match(recipes, /name: test:unit/);
		assert.doesNotMatch(recipes, /npm/);
	});
});

test("generic q-init leaves unsupported conventions explicitly NOT_CONFIGURED", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "pyproject.toml"), "[project]\nname='example'\n", "utf8");
		const plan = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		assert.match(plan.recipePreset, /python\/not-configured/i);
		const recipes = plan.contents["recipes.yaml"] ?? "";
		assert.match(recipes, /NOT_CONFIGURED/);
		assert.match(recipes, /recipes: \[\]/);
		assert.doesNotMatch(recipes, /npm/);
	});
});

test("generic q-init requires a Rust lockfile and never inventories target as evidence", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "Cargo.toml"), "[package]\nname='example'\nversion='0.1.0'\n", "utf8");
		const missingLock = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		assert.equal(missingLock.recipePreset, "rust/not-configured-no-lockfile");
		assert.match(missingLock.contents["recipes.yaml"] ?? "", /NOT_CONFIGURED/);

		await writeFile(join(dir, "Cargo.lock"), "# generated fixture\n", "utf8");
		const locked = await planInit(dir, "generic", { exists, confirmOverwrite: async () => false });
		assert.equal(locked.recipePreset, "rust");
		const recipes = locked.contents["recipes.yaml"] ?? "";
		assert.match(recipes, /--locked/);
		assert.match(recipes, /writes:\s*\n\s*- target\/\*\*/);
		assert.match(recipes, /artifacts: \[\]/);
	});
});
