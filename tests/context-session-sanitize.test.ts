import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { SessionManager, type SessionTreeNode } from "@earendil-works/pi-coding-agent";

import {
	SESSION_SANITIZE_ENTRY_MAX_BYTES,
	SESSION_SANITIZE_READ_CHUNK_BYTES,
	SessionSanitizeError,
	sanitizeSession,
} from "../scripts/workbench-session-sanitize.ts";
import {
	HISTORY_DESCRIPTOR_MAX_BYTES,
	validateContextToolPairing,
	type AgentMessage,
} from "../extensions/workbench-runtime/core/context-history-budget.ts";

const FIXTURE = resolve("fixtures/context-output/legacy-large-details-session.jsonl");
const SCRIPT = resolve("scripts/workbench-session-sanitize.ts");
const TSX = resolve("node_modules/.bin/tsx");

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "workbench-session-sanitize-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function jsonl(raw: string): Array<Record<string, unknown>> {
	return raw.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function entryPointers(entries: readonly Record<string, unknown>[]): unknown[] {
	return entries.map((entry, order) => ({
		order,
		type: entry.type,
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		fromId: entry.fromId,
		targetId: entry.targetId,
		firstKeptEntryId: entry.firstKeptEntryId,
	}));
}

function treeShape(nodes: readonly SessionTreeNode[]): unknown[] {
	return nodes.map((node) => ({
		id: node.entry.id,
		parentId: node.entry.parentId,
		type: node.entry.type,
		children: treeShape(node.children),
	}));
}

function toolResultEntries(entries: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
	return entries.filter((entry) => {
		const message = entry.message as Record<string, unknown> | undefined;
		return entry.type === "message" && message?.role === "toolResult";
	});
}

async function assertMissing(path: string): Promise<void> {
	await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("sanitizer streams a v3 fixture into a resumable 0600 copy with exact tree and hash evidence", async () => {
	await withTempDir(async (dir) => {
		const input = join(dir, "legacy.jsonl");
		const output = join(dir, "sanitized.jsonl");
		await copyFile(FIXTURE, input);
		const originalRaw = await readFile(input, "utf8");
		const original = jsonl(originalRaw);

		const manifest = await sanitizeSession({ input, output });
		const outputBytes = await readFile(output);
		const projected = jsonl(outputBytes.toString("utf8"));
		const manifestBytes = await readFile(`${output}.manifest.json`);

		assert.equal(SESSION_SANITIZE_READ_CHUNK_BYTES, 64 * 1_024);
		assert.equal(manifest.schema_version, 1);
		assert.equal(manifest.kind, "workbench-session-sanitize");
		assert.equal(manifest.input.sha256, sha256(Buffer.from(originalRaw)));
		assert.equal(manifest.output.sha256, sha256(outputBytes));
		assert.equal(manifest.input.bytes, Buffer.byteLength(originalRaw));
		assert.equal(manifest.output.bytes, outputBytes.length);
		assert.equal(manifest.input.entry_count, original.length - 1);
		assert.equal(manifest.output.entry_count, projected.length - 1);
		assert.equal(manifest.tool_results, 2);
		assert.equal(manifest.details_projected, 2);
		assert.equal(manifest.content_collapsed, 0);
		assert.ok(manifest.removed_bytes.details > 10_000);
		assert.ok(manifest.removed_bytes.file > 10_000);
		assert.equal(manifest.removed_bytes.content, 0);
		assert.equal(manifest.tree.canonical_sha256_before, manifest.tree.canonical_sha256_after);
		assert.equal(manifest.tree.preserved, true);
		assert.equal(manifest.tree.active_leaf_id_before, "active-leaf-label");
		assert.equal(manifest.tree.active_leaf_id_after, "active-leaf-label");
		assert.equal((await stat(output)).mode & 0o777, 0o600);
		assert.equal((await stat(`${output}.manifest.json`)).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(manifestBytes.toString("utf8")), manifest);

		assert.deepEqual(projected[0], original[0], "header is unchanged");
		assert.deepEqual(entryPointers(projected.slice(1)), entryPointers(original.slice(1)));
		const serialized = outputBytes.toString("utf8");
		assert.ok(!serialized.includes("FULL LEGACY REPORT"));
		assert.ok(!serialized.includes("gates_full"));
		assert.ok(!serialized.includes("legacy stdout that must never survive details projection"));
		for (const entry of toolResultEntries(projected)) {
			const message = entry.message as Record<string, unknown>;
			assert.ok(Buffer.byteLength(JSON.stringify(message.details), "utf8") <= 8 * 1_024);
		}
		assert.ok(serialized.includes('"type":"image"'), "content is unchanged without --collapse-content");

		const beforeManager = SessionManager.open(input);
		const afterManager = SessionManager.open(output);
		assert.equal(afterManager.getLeafId(), beforeManager.getLeafId());
		assert.deepEqual(treeShape(afterManager.getTree()), treeShape(beforeManager.getTree()));
		assert.equal(validateContextToolPairing(afterManager.buildSessionContext().messages as AgentMessage[]), true);
	});
});
test("--collapse-content keeps call/result entries paired while replacing text and images with bounded descriptors", async () => {
	await withTempDir(async (dir) => {
		const input = join(dir, "legacy.jsonl");
		const output = join(dir, "collapsed.jsonl");
		await copyFile(FIXTURE, input);
		const before = jsonl(await readFile(input, "utf8"));
		const manifest = await sanitizeSession({ input, output, collapseContent: true });
		const after = jsonl(await readFile(output, "utf8"));

		assert.equal(manifest.content_collapsed, 2);
		assert.ok(manifest.removed_bytes.content > 0);
		assert.equal(after.length, before.length);
		assert.deepEqual(entryPointers(after.slice(1)), entryPointers(before.slice(1)));
		for (const entry of toolResultEntries(after)) {
			const message = entry.message as Record<string, unknown>;
			const content = message.content as Array<Record<string, unknown>>;
			assert.equal(content.length, 1);
			assert.equal(content[0]?.type, "text");
			assert.match(String(content[0]?.text), /^\[historical tool result collapsed\]/);
			assert.ok(Buffer.byteLength(String(content[0]?.text), "utf8") <= HISTORY_DESCRIPTOR_MAX_BYTES);
		}
		assert.ok(!(await readFile(output, "utf8")).includes('"type":"image"'));
		const manager = SessionManager.open(output);
		assert.equal(manager.getLeafId(), "active-leaf-label");
		assert.equal(validateContextToolPairing(manager.buildSessionContext().messages as AgentMessage[]), true);
	});
});

test("CLI is exact: help succeeds; missing, unknown, duplicate, and positional arguments are usage errors", () => {
	const help = spawnSync(TSX, [SCRIPT, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /--input <session\.jsonl> --output <new-session\.jsonl> \[--collapse-content\]/);
	assert.equal(help.stderr, "");

	for (const args of [
		[],
		["--wat"],
		["input.jsonl"],
		["--input", "a", "--input", "b", "--output", "c"],
		["--input", "a", "--output", "b", "--collapse-content", "--collapse-content"],
	]) {
		const result = spawnSync(TSX, [SCRIPT, ...args], { encoding: "utf8" });
		assert.equal(result.status, 2, JSON.stringify(args));
		assert.equal(result.stdout, "", JSON.stringify(args));
		assert.match(result.stderr, /workbench-session-sanitize:/, JSON.stringify(args));
		assert.match(result.stderr, /Usage:/, JSON.stringify(args));
	}
});

test("in-place, existing output, and existing manifest are rejected without overwriting any file", async () => {
	await withTempDir(async (dir) => {
		const input = join(dir, "input.jsonl");
		await copyFile(FIXTURE, input);
		await assert.rejects(
			sanitizeSession({ input, output: join(dir, ".", "input.jsonl") }),
			(error: unknown) => error instanceof SessionSanitizeError && error.code === "USAGE",
		);

		const output = join(dir, "output.jsonl");
		await writeFile(output, "sentinel", "utf8");
		await assert.rejects(
			sanitizeSession({ input, output }),
			(error: unknown) => error instanceof SessionSanitizeError && error.code === "OUTPUT_EXISTS",
		);
		assert.equal(await readFile(output, "utf8"), "sentinel");
		await assertMissing(`${output}.manifest.json`);

		const reservedOutput = join(dir, "reserved.jsonl");
		await writeFile(`${reservedOutput}.manifest.json`, "reserved", "utf8");
		await assert.rejects(
			sanitizeSession({ input, output: reservedOutput }),
			(error: unknown) => error instanceof SessionSanitizeError && error.code === "OUTPUT_EXISTS",
		);
		await assertMissing(reservedOutput);
		assert.equal(await readFile(`${reservedOutput}.manifest.json`, "utf8"), "reserved");
	});
});

test("strict parsing rejects malformed/header/tree/blank/non-regular/over-limit inputs and removes partial artifacts", async () => {
	await withTempDir(async (dir) => {
		const validHeader = '{"type":"session","version":3,"id":"s","timestamp":"2026-08-13T00:00:00.000Z","cwd":"/tmp"}';
		const cases = [
			["malformed", `${validHeader}\n{nope}\n`],
			["blank", `${validHeader}\n\n`],
			["wrong-version", '{"type":"session","version":2,"id":"s","timestamp":"x","cwd":"/tmp"}\n'],
			["orphan", `${validHeader}\n{"type":"custom","id":"x","parentId":"missing","timestamp":"x","customType":"x"}\n`],
			["duplicate", `${validHeader}\n{"type":"custom","id":"x","parentId":null,"timestamp":"x","customType":"x"}\n{"type":"custom","id":"x","parentId":"x","timestamp":"x","customType":"x"}\n`],
		] as const;
		for (const [name, raw] of cases) {
			const input = join(dir, `${name}.jsonl`);
			const output = join(dir, `${name}.out.jsonl`);
			await writeFile(input, raw, "utf8");
			await assert.rejects(
				sanitizeSession({ input, output }),
				(error: unknown) => error instanceof SessionSanitizeError && error.code === "SESSION_INVALID",
				name,
			);
			await assertMissing(output);
			await assertMissing(`${output}.manifest.json`);
		}

		const directoryInput = join(dir, "directory-input");
		await mkdir(directoryInput);
		await assert.rejects(
			sanitizeSession({ input: directoryInput, output: join(dir, "directory.out") }),
			(error: unknown) => error instanceof SessionSanitizeError && (
				error.code === "INPUT_NOT_REGULAR" || error.code === "INPUT_INVALID"
			),
		);
		const linkInput = join(dir, "link.jsonl");
		await symlink(FIXTURE, linkInput);
		await assert.rejects(
			sanitizeSession({ input: linkInput, output: join(dir, "link.out") }),
			(error: unknown) => error instanceof SessionSanitizeError && error.code === "INPUT_INVALID",
		);

		const overLimit = join(dir, "over-limit.jsonl");
		const overOutput = join(dir, "over-limit.out.jsonl");
		const hugeEntry = `{"type":"custom","id":"x","parentId":null,"timestamp":"x","customType":"x","data":"${"x".repeat(SESSION_SANITIZE_ENTRY_MAX_BYTES)}"}`;
		await writeFile(overLimit, `${validHeader}\n${hugeEntry}\n`, "utf8");
		await assert.rejects(
			sanitizeSession({ input: overLimit, output: overOutput }),
			(error: unknown) => error instanceof SessionSanitizeError && error.code === "ENTRY_OVER_LIMIT",
		);
		await assertMissing(overOutput);
		await assertMissing(`${overOutput}.manifest.json`);
	});
});

test("input inode replacement after the source handle opens is detected and all partial outputs are removed", async () => {
	await withTempDir(async (dir) => {
		const input = join(dir, "moving.jsonl");
		const moved = join(dir, "moving.original.jsonl");
		const output = join(dir, "moving.out.jsonl");
		const header = { type: "session", version: 3, id: "moving", timestamp: "2026-08-13T00:00:00.000Z", cwd: "/tmp" };
		const root = { type: "message", id: "u", parentId: null, timestamp: "2026-08-13T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 } };
		const call = { type: "message", id: "a", parentId: "u", timestamp: "2026-08-13T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }], timestamp: 2 } };
		const result = { type: "message", id: "r", parentId: "a", timestamp: "2026-08-13T00:00:03.000Z", message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "ok" }], details: { legacy: "x".repeat(8 * 1_024 * 1_024) }, timestamp: 3 } };
		const raw = `${[header, root, call, result].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		await writeFile(input, raw, "utf8");

		const operation = sanitizeSession({ input, output });
		for (let attempt = 0; attempt < 10_000; attempt += 1) {
			try {
				await lstat(output);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await new Promise<void>((done) => setImmediate(done));
			}
		}
		await rename(input, moved);
		await writeFile(input, raw, "utf8");
		await assert.rejects(
			operation,
			(error: unknown) => error instanceof SessionSanitizeError && error.code === "INPUT_MUTATED",
		);
		await assertMissing(output);
		await assertMissing(`${output}.manifest.json`);
	});
});
