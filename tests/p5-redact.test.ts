/**
 * P5 tests for argv redaction hardening (core/redact.ts).
 *
 * Recipe argv entries of the form `--key=value` where the key names a
 * credential carrier must be redacted in run records (manifest.json,
 * command.json) — in addition to env-derived secret values and well-known
 * token shapes. Plain flags, file names and words that merely contain a
 * secret keyword must NOT be touched (no substring false positives).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { redactArgvEntry, isSecretEnvName, redactText } from "../extensions/workbench-runtime/core/redact.ts";

test("argv entries with secret keys are redacted (key=value forms)", () => {
	assert.equal(redactArgvEntry("--api-key=sk-abc123"), "--api-key=[REDACTED]");
	assert.equal(redactArgvEntry("--api_key=xyz"), "--api_key=[REDACTED]");
	assert.equal(redactArgvEntry("--token=abc"), "--token=[REDACTED]");
	assert.equal(redactArgvEntry("--password=hunter2"), "--password=[REDACTED]");
	assert.equal(redactArgvEntry("--passwd=1234"), "--passwd=[REDACTED]");
	assert.equal(redactArgvEntry("--client-secret=zzz"), "--client-secret=[REDACTED]");
	assert.equal(redactArgvEntry("--auth=basic"), "--auth=[REDACTED]", "auth values are redacted by design");
	assert.equal(redactArgvEntry("--access-key=AKIA1234"), "--access-key=[REDACTED]");
	assert.equal(redactArgvEntry("--private-key=/tmp/k.pem"), "--private-key=[REDACTED]");
	assert.equal(redactArgvEntry("--credential=42"), "--credential=[REDACTED]");
});

test("argv entries without secret keys are untouched", () => {
	const safe = [
		"--verbose",
		"--tokenizer=x", // contains "token" but is not a credential carrier
		"token.ts",
		"auth.json",
		"--auth-type=oauth", // "auth" + "-" boundary: redacted? no — see below
		"secretkey",
		"--top_n=50",
		"--seed=42",
		"results/quant-result.json",
		"python",
		"-m",
		"pytest",
	];
	for (const entry of safe) {
		assert.equal(redactArgvEntry(entry), entry, `expected untouched: ${entry}`);
	}
});

test("empty values and non-flag entries stay untouched", () => {
	assert.equal(redactArgvEntry("--api-key="), "--api-key=");
	assert.equal(redactArgvEntry("--api-key"), "--api-key");
	assert.equal(redactArgvEntry("=secret"), "=secret");
});

test("redactArgvEntry composes with redactText for full argv redaction", () => {
	const argv = ["python", "backtest.py", "--api-key=hunter2", "sk-live-ABCDEFGH12345678"];
	const redacted = redactText(argv.join("\u0000"), []).split("\u0000").map(redactArgvEntry);
	assert.ok(redacted[2] === "--api-key=[REDACTED]", JSON.stringify(redacted));
	assert.ok(redacted[3] === "[REDACTED]", "known token shapes still caught");
	assert.equal(redacted[0], "python");
});

test("isSecretEnvName keeps its documented coverage", () => {
	for (const name of ["API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "AUTH_TOKEN", "CLIENT_SECRET", "PRIVATE_KEY", "ACCESS_KEY_ID", "SESSION_ID"]) {
		assert.ok(isSecretEnvName(name), name);
	}
	for (const name of ["NODE_ENV", "PATH", "HOME", "PYTHONPATH", "CI"]) {
		assert.ok(!isSecretEnvName(name), name);
	}
});
