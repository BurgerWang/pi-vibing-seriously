/**
 * Workbench command guard — token-based detection of destructive shell
 * commands. Pure logic, no Pi imports.
 *
 * P5: the guard was rewritten from regex/substring matching to a real
 * shell-token scan so that quoted text, branch names, commit messages and
 * other harmless strings can never trigger a false positive, while the
 * destructive forms (including quoted ones like `rm -rf "/"`) are still
 * caught.
 *
 * Blocked command classes (P1 + P5):
 *   rm-rf-root                rm -rf / and root-glob variants
 *   rm-rf-home                rm -rf ~ / $HOME
 *   git-reset-hard            git reset --hard (any target)
 *   git-clean-fd              git clean -fd / -fdx / ... (force + dirs)
 *   git-push-force            git push -f / --force / --force-with-lease
 *   git-checkout-restore-all  git checkout -- . / git restore . (whole-tree)
 *   git-remote-mutation       git remote add/remove/rm/set-url/rename
 *   rm-git-dir                rm of any .git directory
 *   git-config-global-write   git config --global/--system write operations
 *   sudo-command              any command started with sudo
 *   package-publish           npm/yarn/pnpm/bun publish|unpublish (not --dry-run)
 *
 * The guard is a discipline layer, not a sandbox — see docs/security.md.
 */

export interface ShellToken {
	text: string;
	quoted: boolean;
}

/**
 * Scan a shell command into tokens. Quote-aware: quoted whitespace, quotes
 * and separators stay inside one token, so `git commit -m "rm -rf /"` is a
 * single argument and can never match an rm rule. Backslash escapes outside
 * quotes are honored.
 */
export function scanShell(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let cur = "";
	let quoted = false;
	let i = 0;
	const n = command.length;
	while (i < n) {
		const ch = command[i] ?? "";
		if (ch === "'" || ch === '"') {
			quoted = true;
			i++;
			while (i < n && command[i] !== ch) {
				if (ch === '"' && command[i] === "\\" && i + 1 < n) {
					cur += command[i + 1] ?? "";
					i += 2;
					continue;
				}
				cur += command[i] ?? "";
				i++;
			}
			i++; // closing quote
			continue;
		}
		if (ch === "\\" && i + 1 < n) {
			cur += command[i + 1] ?? "";
			i += 2;
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur.length > 0) {
				tokens.push({ text: cur, quoted });
				cur = "";
				quoted = false;
			}
			i++;
			continue;
		}
		cur += ch;
		i++;
	}
	if (cur.length > 0) tokens.push({ text: cur, quoted });
	return tokens;
}

/** Group tokens into command segments on unquoted &&, ||, ;, | separators. */
export function splitCommandSegments(command: string): string[][] {
	const tokens = scanShell(command);
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of tokens) {
		if (!token.quoted && (token.text === "&&" || token.text === "||" || token.text === ";" || token.text === "|")) {
			if (current.length > 0) {
				segments.push(current);
				current = [];
			}
			continue;
		}
		current.push(token.text);
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SEP = "/";
const ROOT_GLOB_RE = /^\/\*+$/;
const HOME_TARGETS = new Set(["~", "~/", "$HOME", "$HOME/", "~/*"]);

function isFlag(token: string): boolean {
	return token.startsWith("-") && token !== "--";
}

/** Leading flags of a segment starting at `start`; stops at "--" or first non-flag. */
function leadingFlags(tokens: string[], start: number): { flags: string[]; positionals: string[] } {
	const flags: string[] = [];
	const positionals: string[] = [];
	let i = start;
	while (i < tokens.length) {
		const t = tokens[i] ?? "";
		if (t === "--") {
			positionals.push(...tokens.slice(i + 1));
			break;
		}
		if (isFlag(t)) {
			flags.push(t);
			i++;
			continue;
		}
		positionals.push(t);
		i++;
	}
	return { flags, positionals };
}

function flagHas(flags: readonly string[], needle: "r" | "f" | "d"): boolean {
	return flags.some(
		(f) =>
			f === `-${needle}` ||
			f === `--${needle === "r" ? "recursive" : needle === "f" ? "force" : "directories"}` ||
			(f.length > 2 && f.startsWith("-") && !f.startsWith("--") && f.includes(needle)),
	);
}

function basenameOf(path: string): string {
	const stripped = path.replace(/\/+$/, "");
	const idx = stripped.lastIndexOf(SEP);
	return idx === -1 ? stripped : stripped.slice(idx + 1);
}

/** git global options that consume a value (-C dir, -c key=value, ...). */
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "-c"]);

/** Locate the git subcommand, skipping global flags and their values. */
function gitSubcommand(tokens: readonly string[]): { sub: string | undefined; after: string[] } {
	let i = 1;
	while (i < tokens.length) {
		const t = tokens[i] ?? "";
		if (isFlag(t)) {
			if (GIT_GLOBAL_VALUE_FLAGS.has(t)) i += 2;
			else i += 1;
			continue;
		}
		return { sub: t, after: tokens.slice(i + 1) };
	}
	return { sub: undefined, after: [] };
}

/** Positionals of a git subcommand invocation (flags and "--" dropped). */
function gitPositionals(after: readonly string[]): string[] {
	return after.filter((t) => t !== "--" && !isFlag(t));
}

// ---------------------------------------------------------------------------
// rules (operate on one segment's tokens)
// ---------------------------------------------------------------------------

/** `rm -rf /`, `rm -fr /*`, `sudo rm -rf /`, quoted `/`, with -r and -f. */
function rmRfRoot(tokens: string[]): boolean {
	if (tokens[0] !== "rm") return false;
	const { flags, positionals } = leadingFlags(tokens, 1);
	if (!flagHas(flags, "r") || !flagHas(flags, "f")) return false;
	return positionals.some((p) => p === "/" || ROOT_GLOB_RE.test(p));
}

/** `rm -rf ~`, `rm -rf $HOME`, `rm -rf ~/*`. */
function rmRfHome(tokens: string[]): boolean {
	if (tokens[0] !== "rm") return false;
	const { flags, positionals } = leadingFlags(tokens, 1);
	if (!flagHas(flags, "r") || !flagHas(flags, "f")) return false;
	return positionals.some((p) => HOME_TARGETS.has(p));
}

/** `rm -rf .git` / `rm -rf sub/.git/` — any rm whose target basename is .git. */
function rmGitDir(tokens: string[]): boolean {
	if (tokens[0] !== "rm") return false;
	const { positionals } = leadingFlags(tokens, 1);
	return positionals.some((p) => basenameOf(p) === ".git");
}

/** `git reset --hard` (any target). */
function gitResetHard(tokens: string[]): boolean {
	if (tokens[0] !== "git") return false;
	const { sub, after } = gitSubcommand(tokens);
	return sub === "reset" && after.includes("--hard");
}

/** `git clean -fd`, `-fdx`, `-dfx`, `--force --directories` (force + dirs). */
function gitCleanFD(tokens: string[]): boolean {
	if (tokens[0] !== "git") return false;
	const { sub, after } = gitSubcommand(tokens);
	if (sub !== "clean") return false;
	const { flags } = leadingFlags(after, 0);
	return flagHas(flags, "f") && flagHas(flags, "d");
}

/** `git push -f/--force/--force-with-lease` anywhere after the subcommand. */
function gitPushForce(tokens: string[]): boolean {
	if (tokens[0] !== "git") return false;
	const { sub, after } = gitSubcommand(tokens);
	if (sub !== "push") return false;
	return after.some(
		(t) => t === "-f" || t === "--force" || t.startsWith("--force=") || t.startsWith("--force-with-lease"),
	);
}

/** `git checkout -- .` / `git checkout .` / `git restore .` (whole-tree). */
function gitCheckoutRestoreAll(tokens: string[]): boolean {
	if (tokens[0] !== "git") return false;
	const { sub, after } = gitSubcommand(tokens);
	if (sub !== "checkout" && sub !== "restore") return false;
	return gitPositionals(after).includes(".");
}

/** `git remote add|remove|rm|set-url|rename ...` — mutates remote configuration. */
function gitRemoteMutation(tokens: string[]): boolean {
	if (tokens[0] !== "git") return false;
	const { sub, after } = gitSubcommand(tokens);
	if (sub !== "remote") return false;
	const positionals = gitPositionals(after);
	const op = positionals[0];
	return op === "add" || op === "remove" || op === "rm" || op === "set-url" || op === "rename";
}

const GIT_CONFIG_WRITE_OPS = new Set([
	"set",
	"add",
	"unset",
	"unset-all",
	"remove-section",
	"rename-section",
	"replace-all",
	"--add",
	"--unset",
	"--unset-all",
	"--remove-section",
	"--rename-section",
	"--replace-all",
]);
const GIT_CONFIG_READ_OPS = new Set(["--list", "--get", "--get-all", "--get-regexp", "list"]);

/**
 * `git config --global` / `--system` writes. Local (`--local`, or no scope)
 * project config stays allowed — it lives inside the project the agent works
 * on. Read operations with a global scope (`--list`, `--get ...`) stay
 * allowed.
 */
function gitConfigGlobalWrite(tokens: string[]): boolean {
	if (tokens[0] !== "git") return false;
	const { sub, after } = gitSubcommand(tokens);
	if (sub !== "config") return false;
	if (!after.includes("--global") && !after.includes("--system")) return false;
	if (after.some((t) => GIT_CONFIG_WRITE_OPS.has(t))) return true;
	if (after.some((t) => GIT_CONFIG_READ_OPS.has(t))) return false;
	// No explicit op: `git config --global key value` is an implicit set.
	return gitPositionals(after).length >= 2;
}

/** Any command that starts with `sudo`. */
function sudoCommand(tokens: string[]): boolean {
	return (tokens[0] ?? "") === "sudo";
}

const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);

/** `npm publish` / `yarn publish` / `pnpm publish` / `bun publish` (and unpublish). `--dry-run` is a safe preview and stays allowed. */
function packagePublish(tokens: string[]): boolean {
	const pm = tokens[0];
	if (!pm || !PACKAGE_MANAGERS.has(pm)) return false;
	const verb = tokens[1];
	if (verb !== "publish" && verb !== "unpublish") return false;
	return !tokens.includes("--dry-run");
}

export interface CatastrophicRule {
	id: string;
	description: string;
	matches: (segment: string) => boolean;
}

const RULE_FNS: Readonly<Record<string, (tokens: string[]) => boolean>> = {
	"rm-rf-root": rmRfRoot,
	"rm-rf-home": rmRfHome,
	"rm-git-dir": rmGitDir,
	"git-reset-hard": gitResetHard,
	"git-clean-fd": gitCleanFD,
	"git-push-force": gitPushForce,
	"git-checkout-restore-all": gitCheckoutRestoreAll,
	"git-remote-mutation": gitRemoteMutation,
	"git-config-global-write": gitConfigGlobalWrite,
	"sudo-command": sudoCommand,
	"package-publish": packagePublish,
};

const RULE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	"rm-rf-root": "rm -rf / (recursive force delete of the filesystem root)",
	"rm-rf-home": "rm -rf ~ / $HOME (recursive force delete of the home directory)",
	"rm-git-dir": "rm of a .git directory (destroys repository history)",
	"git-reset-hard": "git reset --hard (destroys uncommitted work)",
	"git-clean-fd": "git clean -fd/-fdx (deletes untracked files/directories)",
	"git-push-force": "git push --force / -f (rewrites remote history)",
	"git-checkout-restore-all": "git checkout -- . / git restore . (discards the whole working tree)",
	"git-remote-mutation": "git remote add/remove/set-url/rename (modifies remote configuration)",
	"git-config-global-write": "git config --global/--system write operations (modifies global Git configuration)",
	"sudo-command": "sudo (privilege escalation — never run by the agent)",
	"package-publish": "npm/yarn/pnpm/bun publish (registry publication; --dry-run is allowed)",
};

export const CATASTROPHIC_RULES: readonly CatastrophicRule[] = Object.entries(RULE_FNS).map(([id, fn]) => ({
	id,
	description: RULE_DESCRIPTIONS[id] ?? id,
	matches: (segment) => fn(scanShell(segment).map((t) => t.text)),
}));

/**
 * Returns the id of the first rule matched by any segment of the command,
 * or undefined when the command is allowed. Rules run on the segment's own
 * tokens, so quoted strings (e.g. `git commit -m "rm -rf /"`) can never
 * match: the quoted text is a single argument, not a command.
 */
export function findCatastrophicCommand(command: string): string | undefined {
	for (const segment of splitCommandSegments(command)) {
		for (const [id, fn] of Object.entries(RULE_FNS)) {
			if (fn(segment)) return id;
		}
	}
	return undefined;
}
