/**
 * Workbench path policy — protected credential files and per-mode read/write
 * rules. Pure logic, no Pi imports.
 *
 * Protected path classes (P5 defaults, see docs/security.md):
 *   env files          .env, .env.* — EXCEPT .env.example and .env.template
 *   private keys       id_rsa, id_ed25519, id_ecdsa, id_dsa, *.pem, *.key,
 *                      *.p8, keystores (*.p12, *.pfx, *.jks)
 *   token files        *.token
 *   credential files   credentials.*, secrets.*, exchange-keys.*, auth.json,
 *                      .netrc
 *
 * Policy (per mode):
 *   edit/write on a protected path → blocked in ALL modes. Credential files
 *   are never modified by the agent; the human creates them directly.
 *   read/ls/find/grep on a protected path → blocked in AUDIT and VERIFY
 *   (audit and verification never need credentials), allowed in DEV (the
 *   developer may legitimately inspect local configuration; the content
 *   enters the session transcript — documented in docs/security.md).
 *   bash display-reads of protected files (`cat .env`, ...) follow the same
 *   per-mode rule as the read tool; bash is hard-denied in AUDIT/VERIFY
 *   anyway, so this is defense in depth.
 */

import { basename } from "node:path";

import { splitCommandSegments } from "./command-guard.ts";

export interface ProtectedPathMatch {
	/** Stable rule id, e.g. "env-file", "credential-file", "private-key-token-file". */
	rule: string;
	/** The matched basename (lower-cased). */
	basename: string;
	/** The rule's human description. */
	description: string;
}

const EXACT_NAMES: readonly string[] = [
	".env",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
	"auth.json",
	".netrc",
];

const PREFIX_NAMES: readonly string[] = ["credentials.", "secrets.", "exchange-keys."];

/** .env.* variants that are safe to read/write (documented allowlist). */
const ENV_DOT_ALLOWLIST = new Set([".env.example", ".env.template"]);

const RULE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	"env-file": "environment file (.env / .env.*, except .env.example and .env.template)",
	"credential-file": "credential file (credentials.*, secrets.*, exchange-keys.*, auth.json, .netrc)",
	"private-key-file": "private key (id_rsa/id_ed25519/id_ecdsa/id_dsa, *.pem, *.key, *.p8)",
	"keystore-file": "keystore/secret container (*.p12, *.pfx, *.jks)",
	"token-file": "token file (*.token)",
};

/**
 * Match a path against the protected set. Matching is basename-based (any
 * directory depth) and case-insensitive. A leading `~` (home shorthand) is
 * ignored, so `~/.ssh/id_rsa` is protected.
 */
export function matchProtectedPath(path: string): ProtectedPathMatch | undefined {
	const cleaned = path.replace(/^~\/?/, "");
	const name = basename(cleaned).toLowerCase();
	if (name === ".env") return { rule: "env-file", basename: name, description: RULE_DESCRIPTIONS["env-file"] ?? "env file" };
	if (name.startsWith(".env.") && !ENV_DOT_ALLOWLIST.has(name)) {
		return { rule: "env-file", basename: name, description: RULE_DESCRIPTIONS["env-file"] ?? "env file" };
	}
	if (EXACT_NAMES.includes(name)) {
		return { rule: "credential-file", basename: name, description: RULE_DESCRIPTIONS["credential-file"] ?? "credential file" };
	}
	for (const prefix of PREFIX_NAMES) {
		if (name.startsWith(prefix)) {
			return { rule: "credential-file", basename: name, description: RULE_DESCRIPTIONS["credential-file"] ?? "credential file" };
		}
	}
	if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p8")) {
		return { rule: "private-key-file", basename: name, description: RULE_DESCRIPTIONS["private-key-file"] ?? "private key" };
	}
	if (name.endsWith(".p12") || name.endsWith(".pfx") || name.endsWith(".jks")) {
		return { rule: "keystore-file", basename: name, description: RULE_DESCRIPTIONS["keystore-file"] ?? "keystore" };
	}
	if (name.endsWith(".token")) {
		return { rule: "token-file", basename: name, description: RULE_DESCRIPTIONS["token-file"] ?? "token file" };
	}
	return undefined;
}

/** Structured tools whose path argument is a file/directory target. */
const PATH_ARG_TOOLS = new Set(["read", "edit", "write", "ls", "find", "grep"]);
/** Tools that modify the target file. */
const WRITE_TOOLS = new Set(["edit", "write"]);

/** Extract the target path from a tool call input, when it has one. */
export function extractToolPath(toolName: string, input: unknown): string | undefined {
	if (!PATH_ARG_TOOLS.has(toolName)) return undefined;
	if (typeof input !== "object" || input === null) return undefined;
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Path-policy verdict for a structured tool call.
 * Returns a human reason when the call must be blocked, undefined otherwise.
 */
export function pathPolicyBlockReason(mode: string, toolName: string, input: unknown): string | undefined {
	const path = extractToolPath(toolName, input);
	if (path === undefined) return undefined;
	const match = matchProtectedPath(path);
	if (!match) return undefined;
	if (WRITE_TOOLS.has(toolName)) {
		return `Workbench blocks modifying protected file "${path}" (${match.description}) — credential files are never modified by the agent.`;
	}
	if (mode !== "DEV") {
		return `Workbench ${mode} mode blocks reading protected file "${path}" (${match.description}) — audits and verification never read credentials.`;
	}
	return undefined;
}

/** Shell commands that display file content (bash counterpart of the read tool). */
const DISPLAY_READERS = new Set(["cat", "head", "tail", "less", "more", "sed", "xxd", "base64", "strings", "vi", "vim", "nano", "view"]);

/**
 * Bash counterpart of the path policy: `cat .env` and friends are blocked in
 * AUDIT/VERIFY (defense in depth — bash is already hard-denied there) and
 * allowed in DEV, mirroring the read tool.
 */
export function bashProtectedReadReason(mode: string, command: string): string | undefined {
	if (mode === "DEV") return undefined;
	for (const segment of splitCommandSegments(command)) {
		const first = segment[0];
		if (!first || !DISPLAY_READERS.has(first)) continue;
		for (const token of segment.slice(1)) {
			if (token.startsWith("-")) continue;
			const match = matchProtectedPath(token);
			if (match) {
				return `Workbench ${mode} mode blocks reading protected file "${token}" (${match.description}) via ${first}.`;
			}
		}
	}
	return undefined;
}
