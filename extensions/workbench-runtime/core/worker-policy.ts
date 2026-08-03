/**
 * Controlled worker-delegation policy — pure decision logic, no Pi imports.
 *
 * The parent commander must be GPT-5.6 Sol. The only worker is the pinned
 * DeepSeek V4 Flash model at max reasoning. A child worker cannot delegate,
 * run free-form bash, or execute final validation gates. Structured edit and
 * write calls are limited to paths approved by the parent task contract.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export const WORKER_TOOL_NAME = "workbench_delegate_worker";
export const WORKER_ROLE_ENV = "WORKBENCH_AGENT_ROLE";
export const WORKER_ALLOWED_PATHS_ENV = "WORKBENCH_WORKER_ALLOWED_PATHS";
export const WORKER_PROJECT_ROOT_ENV = "WORKBENCH_WORKER_PROJECT_ROOT";
export const WORKER_DEPTH_ENV = "WORKBENCH_WORKER_DEPTH";
export const WORKER_ROLE = "worker";

export const COMMANDER_MODEL_ID = "gpt-5.6-sol";
export const COMMANDER_PROVIDERS: readonly string[] = ["openai", "openai-codex"];
export const WORKER_PROVIDER = "deepseek";
export const WORKER_MODEL_ID = "deepseek-v4-flash";
export const WORKER_MODEL_SELECTOR = `${WORKER_PROVIDER}/${WORKER_MODEL_ID}:max`;
export const WORKER_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"workbench_run_gate",
	WORKER_TOOL_NAME,
]);

export interface WorkerTaskContract {
	task: string;
	allowedPaths: readonly string[];
	acceptanceCriteria: readonly string[];
	verification: readonly string[];
}

export interface WorkerRoleContext {
	role?: string;
	projectRoot?: string;
	allowedPaths?: readonly string[];
}

/** Only GPT-5.6 Sol on an approved first-party provider may command workers. */
export function commanderBlockReason(provider: string | undefined, model: string | undefined): string | undefined {
	if (model !== COMMANDER_MODEL_ID || !provider || !COMMANDER_PROVIDERS.includes(provider)) {
		return `Worker delegation requires commander ${COMMANDER_PROVIDERS.join("|")}/${COMMANDER_MODEL_ID}; active model is ${provider ?? "(none)"}/${model ?? "(none)"}`;
	}
	return undefined;
}

/** Parse the bounded path contract passed to a child process. Invalid input fails closed. */
export function parseWorkerAllowedPaths(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw) as unknown;
		if (!Array.isArray(value)) return [];
		return value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean)
			.slice(0, 100);
	} catch {
		return [];
	}
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeRule(root: string, rule: string): { path: string; subtree: boolean } | undefined {
	const trimmed = rule.trim();
	if (!trimmed || isAbsolute(trimmed)) return undefined;
	const subtree = trimmed.endsWith("/**") || trimmed.endsWith("/") || trimmed.endsWith(sep);
	const withoutSuffix = trimmed.endsWith("/**") ? trimmed.slice(0, -3) : trimmed.replace(/[\\/]+$/, "");
	if (!withoutSuffix) return undefined;
	const absolute = resolve(root, withoutSuffix);
	if (!isInside(root, absolute)) return undefined;
	return { path: absolute, subtree };
}

/**
 * Exact paths allow one file. Rules ending in `/` or `/**` allow a subtree.
 * Both the candidate and every rule must remain inside the project root.
 */
export function isWorkerPathAllowed(projectRoot: string, candidatePath: string, allowedPaths: readonly string[]): boolean {
	const root = resolve(projectRoot);
	if (isAbsolute(candidatePath)) return false;
	const candidate = resolve(root, candidatePath);
	if (!isInside(root, candidate)) return false;
	for (const rawRule of allowedPaths) {
		const rule = normalizeRule(root, rawRule);
		if (!rule) continue;
		if (candidate === rule.path) return true;
		if (rule.subtree && isInside(rule.path, candidate)) return true;
	}
	return false;
}

/** Fixed worker-role tool matrix: hide denied tools while preserving order. */
export function computeRoleActiveTools(tools: readonly string[], role: string | undefined): string[] {
	if (role !== WORKER_ROLE) return [...tools];
	return tools.filter((tool) => !WORKER_HIDDEN_TOOLS.has(tool));
}

/**
 * Extra hard guard used only inside a delegated worker process.
 *
 * Workers may inspect freely and may run declared recipes, but they cannot
 * recursively delegate, use free-form bash, or create final gate evidence.
 * edit/write are constrained to the parent-approved path contract.
 */
export function workerRoleToolCallBlockReason(
	context: WorkerRoleContext,
	toolName: string,
	input: unknown,
): string | undefined {
	if (context.role !== WORKER_ROLE) return undefined;
	if (toolName === WORKER_TOOL_NAME) return "Delegated workers cannot recursively delegate another worker";
	if (toolName === "workbench_run_gate") return "Delegated workers cannot run final validation gates; the Sol commander owns verification";
	if (toolName === "bash") return "Delegated workers cannot use free-form bash; use declared workbench recipes for project commands";
	if (toolName !== "edit" && toolName !== "write") return undefined;

	const path =
		typeof input === "object" && input !== null && "path" in input
			? (input as { path?: unknown }).path
			: undefined;
	if (typeof path !== "string" || !path.trim()) {
		return `Delegated worker ${toolName} requires a non-empty path`;
	}
	if (!context.projectRoot || !context.allowedPaths || context.allowedPaths.length === 0) {
		return "Delegated worker has no valid parent-approved path contract";
	}
	if (!isWorkerPathAllowed(context.projectRoot, path, context.allowedPaths)) {
		return `Delegated worker path is outside the parent-approved scope: ${path}`;
	}
	return undefined;
}

/** Workers may run validation recipes only when they declare no writes. */
export function workerRecipeBlockReason(role: string | undefined, recipeName: string, declaredWrites: readonly string[]): string | undefined {
	if (role !== WORKER_ROLE || declaredWrites.length === 0) return undefined;
	return `Delegated worker cannot run recipe "${recipeName}" because it declares writes: ${declaredWrites.join(", ")}`;
}

/** Stable task text: fixed instructions plus dynamic contract in the user message. */
export function formatWorkerTask(contract: WorkerTaskContract): string {
	const lines = [
		"Delegated implementation task:",
		contract.task.trim(),
		"",
		"Parent-approved paths (exact path, or subtree ending in / or /**):",
		...contract.allowedPaths.map((path) => `- ${path}`),
		"",
		"Acceptance criteria:",
		...contract.acceptanceCriteria.map((criterion) => `- ${criterion}`),
	];
	if (contract.verification.length > 0) {
		lines.push("", "Requested verification:", ...contract.verification.map((step) => `- ${step}`));
	}
	return lines.join("\n");
}
