/**
 * P5 tests for the token-based command guard (core/command-guard.ts).
 *
 * Focus: parsing, not substrings — quoted text, branch names, commit
 * messages and similar harmless strings must never false-positive, while all
 * destructive forms (including quoted ones) are caught.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CATASTROPHIC_RULES,
	findCatastrophicCommand,
	scanShell,
	splitCommandSegments,
} from "../extensions/workbench-runtime/core/command-guard.ts";

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

test("scanShell splits plain words and honors quotes", () => {
	assert.deepEqual(scanShell("rm -rf /").map((t) => t.text), ["rm", "-rf", "/"]);
	assert.deepEqual(scanShell("echo 'a b' \"c d\"").map((t) => t.text), ["echo", "a b", "c d"]);
	assert.deepEqual(scanShell("echo \"a;b\"").map((t) => t.text), ["echo", "a;b"]);
	assert.deepEqual(scanShell("git commit -m \"rm -rf /\"").map((t) => t.text), ["git", "commit", "-m", "rm -rf /"]);
	assert.deepEqual(scanShell("echo a\\ b").map((t) => t.text), ["echo", "a b"]);
	assert.deepEqual(scanShell(""), []);
	assert.deepEqual(scanShell("   "), []);
});

test("quoted tokens carry the quoted flag; separators inside quotes are not separators", () => {
	const tokens = scanShell("echo '&&' && ls");
	assert.equal(tokens[0]?.quoted, false);
	assert.equal(tokens[1]?.quoted, true);
	assert.equal(tokens[2]?.text, "&&");
	assert.equal(tokens[2]?.quoted, false);
});

test("splitCommandSegments groups on unquoted separators only", () => {
	assert.deepEqual(splitCommandSegments("echo hi && rm -rf /"), [
		["echo", "hi"],
		["rm", "-rf", "/"],
	]);
	assert.deepEqual(splitCommandSegments("rm -rf / ; ls"), [
		["rm", "-rf", "/"],
		["ls"],
	]);
	assert.deepEqual(splitCommandSegments("a | b || c"), [["a"], ["b"], ["c"]]);
	assert.deepEqual(splitCommandSegments("echo 'a;b'"), [["echo", "a;b"]]);
});

// ---------------------------------------------------------------------------
// blocked commands (every rule)
// ---------------------------------------------------------------------------

test("rm -rf / and root variants are blocked (rm-rf-root)", () => {
	const blocked = [
		"rm -rf /",
		"rm -rf /*",
		"rm -fr /",
		"rm -r -f /",
		"rm -rf / --no-preserve-root",
		"rm -rf \"/\"",
		"rm --recursive --force /",
		"echo hi && rm -rf /",
		"rm -rf / ; ls",
		"cd /tmp && rm -rf /",
	];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "rm-rf-root", cmd);
	}
	// sudo rm -rf / matches the sudo rule first (privilege escalation is the
	// headline violation); either way it is blocked.
	assert.equal(findCatastrophicCommand("sudo rm -rf /"), "sudo-command");
});

test("rm -rf ~ and $HOME variants are blocked (rm-rf-home)", () => {
	const blocked = ["rm -rf ~", "rm -rf ~/", "rm -rf $HOME", "rm -rf $HOME/", "rm -rf ~/*", "sudo rm -rf ~"];
	for (const cmd of blocked) {
		const rule = findCatastrophicCommand(cmd);
		assert.ok(rule === "rm-rf-home" || rule === "sudo-command", cmd);
	}
});

test("rm of a .git directory is blocked (rm-git-dir)", () => {
	const blocked = ["rm -rf .git", "rm -rf .git/", "rm -r sub/.git", "rm -rf vendor/sub/.git/", "rm .git -rf"];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "rm-git-dir", cmd);
	}
});

test("git reset --hard is blocked (git-reset-hard)", () => {
	const blocked = ["git reset --hard", "git reset --hard HEAD~1", "git --no-pager reset --hard", "git -C /tmp/x reset --hard HEAD"];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "git-reset-hard", cmd);
	}
});

test("git clean -fd or stronger is blocked (git-clean-fd)", () => {
	const blocked = ["git clean -fd", "git clean -fdx", "git clean -dfx", "git clean -fdX", "git clean --force --directories", "git clean -xdf"];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "git-clean-fd", cmd);
	}
});

test("git push --force / -f is blocked in any position (git-push-force)", () => {
	const blocked = [
		"git push --force",
		"git push -f",
		"git push -f origin main",
		"git push --force-with-lease origin main",
		"git push origin main --force",
		"git push origin --force-with-lease=main",
	];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "git-push-force", cmd);
	}
});

test("git checkout -- . / git restore . are blocked (git-checkout-restore-all)", () => {
	const blocked = ["git checkout -- .", "git checkout .", "git restore .", "git restore --staged .", "git restore --source HEAD~1 ."];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "git-checkout-restore-all", cmd);
	}
});

test("git remote mutations are blocked (git-remote-mutation)", () => {
	const blocked = [
		"git remote add origin https://x",
		"git remote remove origin",
		"git remote rm origin",
		"git remote set-url origin https://y",
		"git remote rename origin upstream",
	];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "git-remote-mutation", cmd);
	}
});

test("git config --global/--system writes are blocked (git-config-global-write)", () => {
	const blocked = [
		"git config --global user.name Alice",
		"git config --global --unset user.name",
		"git config --global --add safe.directory /x",
		"git config --global user.name Alice email a@b",
		"git config --system core.autocrlf true",
		"git config --global --remove-section user",
		"git config --global --replace-all core.pager cat",
	];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "git-config-global-write", cmd);
	}
});

test("sudo is blocked (sudo-command)", () => {
	const blocked = ["sudo ls", "sudo -u root npm install", "sudo !!", "sudo apt update", "sudo -E env FOO=1 bash"];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "sudo-command", cmd);
	}
});

test("package publish is blocked, --dry-run is allowed (package-publish)", () => {
	const blocked = ["npm publish", "npm publish --access public", "yarn publish", "pnpm publish", "bun publish", "npm unpublish -f"];
	for (const cmd of blocked) {
		assert.equal(findCatastrophicCommand(cmd), "package-publish", cmd);
	}
	assert.equal(findCatastrophicCommand("npm publish --dry-run"), undefined);
	assert.equal(findCatastrophicCommand("npm publish --dry-run --tag beta"), undefined);
});

// ---------------------------------------------------------------------------
// false-positive battery — harmless commands must stay allowed
// ---------------------------------------------------------------------------

test("harmless commands never false-positive", () => {
	const safe = [
		// plain shell
		"ls -la",
		"cat package.json",
		"rm file.txt",
		"rm -r ./build",
		"rm -rf ./node_modules",
		"rm -rf dist",
		"rm -rf /tmp/workbench-test-abc",
		"mkdir -p dist",
		"echo hello",
		"echo \"rm -rf /\"",
		// git reads and local operations
		"git status",
		"git diff",
		"git log --oneline -5",
		"git fetch --all",
		"git pull",
		"git push origin main",
		"git push --set-upstream origin feature/x",
		"git clean -n",
		"git clean -nd",
		"git reset --soft HEAD~1",
		"git reset HEAD~1",
		"git checkout -- src/main.ts",
		"git checkout main",
		"git checkout -b feature/x",
		"git restore src/main.ts",
		"git restore --staged src/main.ts",
		"git remote -v",
		"git remote show origin",
		"git remote set-head origin main",
		"git config user.name Alice",
		"git config --local user.email a@b",
		"git config --global user.name",
		"git config --global --list",
		"git config --global --get user.name",
		"git config --global --get-regexp user",
		"git commit -m \"rm -rf /\"",
		"git commit -m \"fix: git push --force is scary\"",
		// package managers
		"npm test",
		"npm run typecheck",
		"npm install",
		"npm view pi",
		"npm run publish",
		"yarn add lodash",
		"pnpm install",
		// text mentioning keywords
		"grep -r sudo .",
		"grep -rn \"publish\" package.json",
		"cat docs/sudo.md",
		"ls /etc/sudoers.d",
		"find . -name '*.key' -not -path './node_modules/*'",
		// quoted separators
		"echo 'a && b'",
		"git log --grep='git push --force'",
	];
	for (const cmd of safe) {
		assert.equal(findCatastrophicCommand(cmd), undefined, `expected safe: ${cmd}`);
	}
});

test("every rule id is descriptive and present", () => {
	const ids = CATASTROPHIC_RULES.map((r) => r.id);
	for (const expected of [
		"rm-rf-root",
		"rm-rf-home",
		"rm-git-dir",
		"git-reset-hard",
		"git-clean-fd",
		"git-push-force",
		"git-checkout-restore-all",
		"git-remote-mutation",
		"git-config-global-write",
		"sudo-command",
		"package-publish",
	]) {
		assert.ok(ids.includes(expected), `missing rule ${expected}`);
	}
	assert.equal(new Set(ids).size, ids.length, "rule ids are unique");
	for (const rule of CATASTROPHIC_RULES) {
		assert.ok(rule.description.length > 10, `description for ${rule.id}`);
	}
});

test("guard blocks in every mode via checkToolCall and keeps safe commands", async () => {
	const { checkToolCall } = await import("../extensions/workbench-runtime/core/mode-policy.ts");
	for (const mode of ["AUDIT", "DEV", "VERIFY"] as const) {
		assert.equal(checkToolCall(mode, "bash", { command: "rm -rf /" }).allowed, false, `${mode} rm -rf /`);
		assert.equal(checkToolCall(mode, "bash", { command: "git push --force" }).allowed, false, `${mode} git push --force`);
		assert.equal(checkToolCall(mode, "bash", { command: "npm publish" }).allowed, false, `${mode} npm publish`);
		assert.equal(checkToolCall(mode, "bash", { command: "sudo apt update" }).allowed, false, `${mode} sudo`);
	}
	// bash itself is hard-denied in AUDIT/VERIFY; in DEV safe commands pass.
	assert.equal(checkToolCall("AUDIT", "bash", { command: "npm test" }).allowed, false, "AUDIT has no bash at all");
	assert.equal(checkToolCall("VERIFY", "bash", { command: "npm test" }).allowed, false, "VERIFY has no bash at all");
	assert.equal(checkToolCall("DEV", "bash", { command: "npm test" }).allowed, true, "DEV npm test");
	assert.equal(checkToolCall("DEV", "bash", { command: "git push origin main" }).allowed, true);
});
