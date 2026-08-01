/**
 * P5 tests for the protected-path policy (core/path-policy.ts).
 *
 * Default protected set: .env / .env.* (except .env.example and
 * .env.template), *.pem, *.key, id_rsa, id_ed25519, credentials.*,
 * secrets.*, auth.json, exchange-keys.*, private keys and token files.
 *
 * Policy: edit/write on protected paths is blocked in ALL modes; reads are
 * blocked in AUDIT/VERIFY and allowed in DEV (documented in docs/security.md).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	bashProtectedReadReason,
	extractToolPath,
	matchProtectedPath,
	pathPolicyBlockReason,
} from "../extensions/workbench-runtime/core/path-policy.ts";
import { checkToolCall } from "../extensions/workbench-runtime/core/mode-policy.ts";

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

test("protected: .env and .env.* (default set)", () => {
	assert.equal(matchProtectedPath(".env")?.rule, "env-file");
	assert.equal(matchProtectedPath("config/.env")?.rule, "env-file");
	assert.equal(matchProtectedPath(".env.local")?.rule, "env-file");
	assert.equal(matchProtectedPath(".env.production")?.rule, "env-file");
	assert.equal(matchProtectedPath("deep/nested/.env.development")?.rule, "env-file");
	assert.equal(matchProtectedPath(".ENV")?.rule, "env-file", "case-insensitive");
});

test("protected: .env.example and .env.template are explicitly allowed", () => {
	assert.equal(matchProtectedPath(".env.example"), undefined);
	assert.equal(matchProtectedPath("config/.env.example"), undefined);
	assert.equal(matchProtectedPath(".env.template"), undefined);
	assert.equal(matchProtectedPath("config/.env.template"), undefined);
});

test("protected: private keys and key material", () => {
	assert.equal(matchProtectedPath("id_rsa")?.rule, "credential-file");
	assert.equal(matchProtectedPath("~/.ssh/id_rsa")?.rule, "credential-file");
	assert.equal(matchProtectedPath("~/.ssh/id_ed25519")?.rule, "credential-file");
	assert.equal(matchProtectedPath("id_ecdsa")?.rule, "credential-file");
	assert.equal(matchProtectedPath("id_dsa")?.rule, "credential-file");
	assert.equal(matchProtectedPath("server.pem")?.rule, "private-key-file");
	assert.equal(matchProtectedPath("keys/private.key")?.rule, "private-key-file");
	assert.equal(matchProtectedPath("cert.p12")?.rule, "keystore-file");
	assert.equal(matchProtectedPath("keystore.jks")?.rule, "keystore-file");
	assert.equal(matchProtectedPath("secret.p8")?.rule, "private-key-file");
});

test("protected: credential, secret, token and exchange-key files", () => {
	assert.equal(matchProtectedPath("credentials.json")?.rule, "credential-file");
	assert.equal(matchProtectedPath("credentials.yaml")?.rule, "credential-file");
	assert.equal(matchProtectedPath("secrets.yaml")?.rule, "credential-file");
	assert.equal(matchProtectedPath("secrets.md")?.rule, "credential-file", "credentials.* / secrets.* cover any extension");
	assert.equal(matchProtectedPath("auth.json")?.rule, "credential-file");
	assert.equal(matchProtectedPath("exchange-keys.json")?.rule, "credential-file");
	assert.equal(matchProtectedPath(".netrc")?.rule, "credential-file");
	assert.equal(matchProtectedPath("api.token")?.rule, "token-file");
	assert.equal(matchProtectedPath("nested/deep/credentials.yaml")?.rule, "credential-file");
});

test("not protected: ordinary source and config files", () => {
	const safe = [
		"package.json",
		"tsconfig.json",
		"src/main.ts",
		"README.md",
		"results/quant-result.json",
		".gitignore",
		".gitconfig",
		".env.example",
		"token.ts",
		"tokenizer.ts",
		"id_rsa.pub",
		"public/cert.pem.crt",
		"auth.md",
		"config/credentials/prod.json", // directory named credentials, file itself is ordinary
		".pi/workbench/runs/20260101-120000-abcd/manifest.json",
	];
	for (const path of safe) {
		assert.equal(matchProtectedPath(path), undefined, `expected safe: ${path}`);
	}
});

// ---------------------------------------------------------------------------
// structured tool policy
// ---------------------------------------------------------------------------

test("edit/write on protected paths is blocked in every mode", () => {
	for (const mode of ["AUDIT", "DEV", "VERIFY"] as const) {
		for (const path of [".env", "config/.env.local", "keys/private.key", "id_rsa", "credentials.json", "auth.json"]) {
			const check = checkToolCall(mode, "write", { path });
			assert.equal(check.allowed, false, `${mode} write ${path}`);
		}
		const edit = checkToolCall(mode, "edit", { path: ".env" });
		assert.equal(edit.allowed, false, `${mode} edit .env`);
	}
	// In DEV the path policy is the reason; in AUDIT/VERIFY the mode denial
	// fires first and the path is protected on top of it.
	const devReason = checkToolCall("DEV", "write", { path: ".env" }).reason ?? "";
	assert.ok(devReason.includes("protected"), `DEV write reason mentions protection: ${devReason}`);
	const auditReason = checkToolCall("AUDIT", "write", { path: ".env" }).reason ?? "";
	assert.ok(auditReason.includes("AUDIT"), `AUDIT write reason mentions the mode: ${auditReason}`);
});

test("read of protected paths is blocked in AUDIT/VERIFY and allowed in DEV", () => {
	for (const mode of ["AUDIT", "VERIFY"] as const) {
		for (const path of [".env", "config/.env", "id_rsa", "credentials.json", "secrets.yaml", "server.pem"]) {
			assert.equal(checkToolCall(mode, "read", { path }).allowed, false, `${mode} read ${path}`);
		}
		assert.equal(checkToolCall(mode, "read", { path: ".env.example" }).allowed, true, `${mode} read .env.example`);
		assert.equal(checkToolCall(mode, "read", { path: "src/main.ts" }).allowed, true);
	}
	assert.equal(checkToolCall("DEV", "read", { path: ".env" }).allowed, true, "DEV read .env allowed");
	assert.equal(checkToolCall("DEV", "grep", { path: ".env", pattern: "API" }).allowed, true);
});

test("ls/find/grep on protected paths follow the same read policy", () => {
	assert.equal(checkToolCall("AUDIT", "ls", { path: ".env" }).allowed, false);
	assert.equal(checkToolCall("VERIFY", "find", { path: "config/.env" }).allowed, false);
	assert.equal(checkToolCall("VERIFY", "grep", { path: "auth.json" }).allowed, false);
	assert.equal(checkToolCall("DEV", "ls", { path: ".env" }).allowed, true);
});

test("tools without a path argument are unaffected", () => {
	assert.equal(checkToolCall("DEV", "write", {}).allowed, true);
	assert.equal(checkToolCall("AUDIT", "read", {}).allowed, true);
	assert.equal(checkToolCall("AUDIT", "read", { path: 42 }).allowed, true);
	assert.equal(checkToolCall("DEV", "edit", { path: "" }).allowed, true);
});

test("extractToolPath only reads the path from path-taking tools", () => {
	assert.equal(extractToolPath("read", { path: "x" }), "x");
	assert.equal(extractToolPath("bash", { command: "cat .env" }), undefined);
	assert.equal(extractToolPath("read", {}), undefined);
});

// ---------------------------------------------------------------------------
// bash counterpart
// ---------------------------------------------------------------------------

test("bash display-reads of protected files are blocked in AUDIT/VERIFY, allowed in DEV", () => {
	assert.ok(bashProtectedReadReason("AUDIT", "cat .env"));
	assert.ok(bashProtectedReadReason("VERIFY", "cat config/.env"));
	assert.ok(bashProtectedReadReason("VERIFY", "head -n 5 id_rsa"));
	assert.ok(bashProtectedReadReason("AUDIT", "cat ~/.ssh/id_ed25519"));
	assert.ok(bashProtectedReadReason("AUDIT", "cat .env && echo done"));
	assert.equal(bashProtectedReadReason("DEV", "cat .env"), undefined);
	assert.equal(bashProtectedReadReason("AUDIT", "cat package.json"), undefined);
	assert.equal(bashProtectedReadReason("AUDIT", "ls -la"), undefined);
	assert.equal(bashProtectedReadReason("AUDIT", "cat .env.example"), undefined);
	assert.equal(bashProtectedReadReason("AUDIT", "grep API .env"), undefined, "grep is not a display reader (structured grep tool is covered)");
});

test("path policy never blocks read of the workbench's own run records", () => {
	const runPath = ".pi/workbench/runs/20260101-120000-abcd/evidence.json";
	assert.equal(matchProtectedPath(runPath), undefined);
	assert.equal(checkToolCall("VERIFY", "read", { path: runPath }).allowed, true);
	assert.equal(checkToolCall("AUDIT", "read", { path: runPath }).allowed, true);
});

test("pathPolicyBlockReason returns descriptive reasons", () => {
	const write = pathPolicyBlockReason("DEV", "write", { path: ".env" });
	assert.ok(write?.includes("protected") && write.includes(".env"));
	const read = pathPolicyBlockReason("VERIFY", "read", { path: "id_rsa" });
	assert.ok(read?.includes("VERIFY"));
	assert.equal(pathPolicyBlockReason("DEV", "read", { path: "id_rsa" }), undefined);
	assert.equal(pathPolicyBlockReason("DEV", "write", { path: "src/main.ts" }), undefined);
});
