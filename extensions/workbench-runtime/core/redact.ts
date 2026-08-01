/**
 * Workbench secret redaction — pure logic, no Pi imports.
 *
 * Run artifacts (stdout.log, stderr.log, manifest.json, command.json,
 * environment.json) must never contain API keys, tokens, or auth material.
 * Redaction is applied on top of Pi's process-level permissions: it is a
 * hygiene layer for run records, not a security boundary.
 */

/** Environment variable names that carry credentials. */
const SECRET_NAME_RE =
	/(api[_-]?key|secret|token|password|passwd|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?id)/i;

export function isSecretEnvName(name: string): boolean {
	return SECRET_NAME_RE.test(name);
}

/** Well-known credential value shapes (defense in depth for log text). */
const TOKEN_PATTERNS: readonly RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{8,}\b/g, // OpenAI-style API keys
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
	/\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API keys
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
	/\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
];

/**
 * Collect the values of secret-looking env vars so they can be scrubbed from
 * logs and records. Values shorter than 4 chars are skipped to avoid mangling
 * ordinary text.
 */
export function collectSecretValues(env: Readonly<Record<string, string | undefined>>): string[] {
	const values: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && value.length >= 4 && isSecretEnvName(name)) values.push(value);
	}
	return values;
}

/**
 * Replace every occurrence of the given secret values in `text` with
 * `[REDACTED]`, then scrub well-known credential shapes.
 */
export function redactText(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (!secret || secret.length < 4) continue;
		out = out.split(secret).join("[REDACTED]");
	}
	for (const pattern of TOKEN_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

/** Redact a single env value for storage in environment.json. */
export function redactEnvValue(name: string, value: string): string {
	if (isSecretEnvName(name)) return "[REDACTED]";
	return redactText(value, []);
}

/**
 * Redact an argv entry whose key looks like a credential carrier:
 * `--api-key=sk-...` becomes `--api-key=[REDACTED]`. Only `key=value` forms
 * are touched; plain flags (`--verbose`), file names (`auth.json`) and
 * words that merely CONTAIN a secret keyword (`--tokenizer=...`,
 * `secretkey`) are left alone — no substring false positives.
 */
const SECRET_ARGV_KEY_RE = /(?:^|[-_])(api[-_]?key|access[-_]?key|client[-_]?secret|secret|token|password|passwd|credential|private[-_]?key)(?:$|[-_=])/i;
/** Bare `auth` (--auth=..., --auth=<value>) is redacted; compounds like
 * `--auth-type` are not (they name a mechanism, not a secret). */
const AUTH_ARGV_KEY_RE = /(?:^|[-_])auth(?:$|=)/i;

export function redactArgvEntry(entry: string): string {
	const eq = entry.indexOf("=");
	if (eq <= 0) return entry;
	const key = entry.slice(0, eq);
	const value = entry.slice(eq + 1);
	if (value.length === 0) return entry;
	if (!SECRET_ARGV_KEY_RE.test(key) && !AUTH_ARGV_KEY_RE.test(key)) return entry;
	return `${key}=[REDACTED]`;
}
