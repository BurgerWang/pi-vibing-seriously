/**
 * NRO N1/N2 wiring tests — the REGISTERED native read/grep/find overrides
 * through the actual workbench runtime (Commander Native Tool Optimization
 * plan §9 matrix rows 1, 5–7, 10–12, 16–18, 20–22):
 *
 *   - registration surface: exactly read → grep → find + the 11 catalog
 *     tools, static metadata, built-in-identical schemas (grep = the
 *     byte-identical legacy property prefix + exactly the two N2 optional
 *     selectors output/count_kind), no custom renderers (built-in slot
 *     renderer inheritance);
 *   - read legacy parity: explicit offset/limit, images, @-paths,
 *     relative/absolute paths, missing files, offset beyond end and abort
 *     are byte-identical to the captured built-in definition;
 *   - no-offset/limit text reads: small files keep the built-in text
 *     byte-for-byte and append complete=true facts; oversized files return
 *     the deterministic preview with exact facts; following next_offset via
 *     legacy pagination reaches complete=true with no line skipped;
 *   - the >50KB-first-line case exercises the second read-only read through
 *     the Pi-equivalent path normalization (@/relative/absolute parity);
 *   - details shape: undefined when complete, exactly a valid
 *     TruncationResult-only object when truncated;
 *   - grep legacy parity: output omitted, output="matches" and a
 *     count_kind present while output is omitted stay byte-identical to the
 *     equivalent LEGACY parameter set (the new selectors never reach the
 *     built-in delegation);
 *   - grep count mode (N2): output=count runs the exact uncapped Pi-free
 *     adapter scan through the registered override — one compact
 *     `count kind=… value=… files=…` line, details undefined, legacy
 *     limit/context never applied, zero is an exact result, missing paths
 *     and pre-abort fail with explicit semantics;
 *   - find stays an exact legacy pass-through (N3 not implemented):
 *     uncapped results/errors/aborts stay byte-identical to the captured
 *     built-in and the source wiring is the literal built-in delegation;
 *     the capped limit=2 case validates BOTH independent fd processes
 *     against the strict shared cap contract instead of cross-process byte
 *     equality (fd --max-results enumeration subset/order is
 *     nondeterministic across processes);
 *   - the exact-name mode/path guard still fires for read in AUDIT/VERIFY
 *     and the active tool inventory is unchanged.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import { checkToolCall } from "../extensions/workbench-runtime/core/mode-policy.ts";
import {
	formatGrepCountLine,
	NATIVE_OVERRIDE_METADATA,
	NATIVE_OVERRIDE_NAMES,
	NATIVE_OVERRIDE_PARAMETERS,
	NRO_FACTS_MARKER,
	nativeResolvePath,
	PREVIEW_MAX_LINES,
	PREVIEW_MAX_LINE_UTF8_BYTES,
	PREVIEW_MAX_UTF8_BYTES,
} from "../extensions/workbench-runtime/core/native-tool-policy.ts";
import { resolveRgPath } from "../extensions/workbench-runtime/core/native-search-adapter.ts";
import { WORKBENCH_TOOL_NAMES } from "../extensions/workbench-runtime/core/tool-catalog.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

// ------------------------------------------------------------------ stubs

interface StubAPI {
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: never, ctx: never) => unknown>>;
	activeTools: string[];
	entries: Array<{ type: string; customType: string; data?: unknown }>;
}

/** Same stub ExtensionAPI surface as the other wiring tests, with the REAL spawnExec. */
function makeStub(): StubAPI & ExtensionAPI {
	const stub: StubAPI & ExtensionAPI = {
		tools: new Map(),
		events: new Map(),
		activeTools: [],
		entries: [],
		registerCommand: () => {},
		registerTool: (def: { name: string }) => {
			stub.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			const list = stub.events.get(event) ?? [];
			list.push(handler);
			stub.events.set(event, list);
		},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => {
			stub.activeTools = [...tools];
		},
		getActiveTools: () => stub.activeTools,
		getAllTools: () => [...stub.tools.values()] as never[],
		getThinkingLevel: () => "high" as never,
		exec: spawnExec,
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

/** Minimal trusted ctx whose cwd is the temp project root (only ctx.cwd is used by the overrides). */
function trustedCtx(root: string): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => `${root}/session.jsonl`,
			getSessionId: () => "native-tool-wiring-test",
		} as unknown as ExtensionContext["sessionManager"],
		model: undefined,
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: () => false,
		} as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionCommandContext;
}

interface ReadTool {
	execute: (
		toolCallId: string,
		params: { path: string; offset?: number; limit?: number },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: Record<string, unknown> | undefined }>;
}

interface GrepTool {
	execute: (
		toolCallId: string,
		params: {
			pattern: string;
			path?: string;
			glob?: string;
			ignoreCase?: boolean;
			literal?: boolean;
			context?: number;
			limit?: number;
			output?: "matches" | "count";
			count_kind?: "matches" | "lines";
		},
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> | undefined }>;
}

interface FindTool {
	execute: (
		toolCallId: string,
		params: { pattern: string; path?: string; limit?: number },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> | undefined }>;
}

function registered(stub: StubAPI & ExtensionAPI): { read: ReadTool; grep: GrepTool; find: FindTool } {
	const read = stub.tools.get("read") as unknown as ReadTool | undefined;
	const grep = stub.tools.get("grep") as unknown as GrepTool | undefined;
	const find = stub.tools.get("find") as unknown as FindTool | undefined;
	assert.ok(read && grep && find, "read/grep/find overrides registered");
	return { read, grep, find };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/** The captured built-in definitions for the same cwd (the parity oracle). */
function builtins(root: string): { read: ReadTool; grep: GrepTool; find: FindTool } {
	return {
		read: createReadToolDefinition(root) as unknown as ReadTool,
		grep: createGrepToolDefinition(root) as unknown as GrepTool,
		find: createFindToolDefinition(root) as unknown as FindTool,
	};
}

/** The nine facts of a result text (frozen §8.4 parser semantics). */
function parseFacts(text: string): Record<string, string | number | boolean> | null {
	const idx = text.indexOf(NRO_FACTS_MARKER);
	if (idx === -1) return null;
	const lineEnd = text.indexOf("\n", idx);
	const line = text.slice(idx + NRO_FACTS_MARKER.length, lineEnd === -1 ? text.length : lineEnd).trim();
	const facts: Record<string, string | number | boolean> = {};
	for (const token of line.split(/\s+/).filter((t) => t.length > 0)) {
		const eq = token.indexOf("=");
		const key = token.slice(0, eq);
		const raw = token.slice(eq + 1);
		facts[key] = raw === "true" ? true : raw === "false" ? false : Number(raw);
	}
	return facts;
}

async function fireSessionStart(stub: StubAPI & ExtensionAPI, root: string): Promise<void> {
	const handlers = stub.events.get("session_start") ?? [];
	assert.ok(handlers.length > 0, "session_start handler registered");
	for (const handler of handlers) {
		await handler({ reason: "reload" } as never, trustedCtx(root) as never);
	}
}

/** Commander tests must never inherit a worker-role env from the harness. */
before(() => {
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

// ---------------------------------------------------------------- fixtures

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** A file whose magic bytes claim JPEG but whose payload is garbage (decode/resize fails). */
const CORRUPT_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.from("not a real jpeg payload".repeat(8))]);

/** A file whose magic bytes claim PNG but whose payload is garbage (decode/resize fails). */
const CORRUPT_PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from([0x00, 0x00, 0x00, 0x0d]),
	Buffer.from("IHDR"),
	Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
	Buffer.from("not a real png payload".repeat(8)),
]);

/** 1x1 GIF89a (transparent; decodable by the Pi 0.83.0 pipeline). */
const TINY_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** 1x1 JFIF JPEG (decodable by the Pi 0.83.0 pipeline). */
const TINY_JPEG = Buffer.from(
	"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
	"base64",
);

/** 1x1 lossless VP8L WebP (decodable by the Pi 0.83.0 pipeline). */
const TINY_WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

/** 1x1 24-bit BMP with a valid BITMAPINFOHEADER (passes the built-in header checks). */
function tinyBmp(): Buffer {
	const bmp = Buffer.alloc(54 + 4);
	bmp.write("BM", 0, "ascii");
	bmp.writeUInt32LE(bmp.length, 2); // declared file size
	bmp.writeUInt32LE(54, 10); // pixel data offset
	bmp.writeUInt32LE(40, 14); // BITMAPINFOHEADER size
	bmp.writeInt32LE(1, 18); // width
	bmp.writeInt32LE(1, 22); // height
	bmp.writeUInt16LE(1, 26); // color planes
	bmp.writeUInt16LE(24, 28); // bits per pixel
	bmp.writeUInt32LE(0, 30); // BI_RGB compression
	bmp.writeUInt32LE(4, 34); // image size (1 row of 3 bytes padded to 4)
	// one black pixel (BGR) padded to the 4-byte row stride
	bmp[54] = 0;
	bmp[55] = 0;
	bmp[56] = 0;
	bmp[57] = 0;
	return bmp;
}

async function writeFixture(root: string): Promise<void> {
	await mkdir(join(root, "sub"), { recursive: true });
	await writeFile(join(root, "small.txt"), "alpha\nbeta\ngamma\n", "utf8");
	await writeFile(join(root, "sub", "nested.txt"), "nested line\n", "utf8");
	await writeFile(join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");
	await writeFile(join(root, "bom.txt"), "\uFEFFalpha\nbeta\n", "utf8");
	await writeFile(join(root, "empty.txt"), "", "utf8");
	await writeFile(join(root, "unicode.txt"), "مرحبا بالعالم\n日本語テキスト\nключ=значение\n", "utf8");
	await writeFile(join(root, "large.txt"), Array.from({ length: 500 }, (_, i) => `line-${i}-${"x".repeat(40)}`).join("\n"), "utf8");
	await writeFile(join(root, "hugeline.txt"), "H".repeat(5000) + "\ntail\n", "utf8");
	await writeFile(join(root, "hugefirst.txt"), "H".repeat(60 * 1024) + "\ntail\n", "utf8");
	await writeFile(join(root, "search.txt"), "needle here\nnothing\ntwo needle needles\n", "utf8");
	// a GENUINE text file whose first line starts like the built-in image note
	await writeFile(join(root, "note.txt"), "Read image file [image/jpeg]\nThis is genuine text that merely starts like the built-in image note.\n", "utf8");
	// trailing-newline boundary fixtures: 12288 bytes without / 12289 with
	// the terminal newline
	await writeFile(join(root, "boundary.txt"), "a".repeat(12286) + "\nb", "utf8");
	await writeFile(join(root, "boundarynl.txt"), "a".repeat(12286) + "\nb\n", "utf8");
	await writeFile(join(root, "image.png"), TINY_PNG);
	await writeFile(join(root, "image.jpg"), TINY_JPEG);
	await writeFile(join(root, "image.gif"), TINY_GIF);
	await writeFile(join(root, "image.webp"), TINY_WEBP);
	await writeFile(join(root, "image.bmp"), tinyBmp());
	await writeFile(join(root, "corrupt.jpg"), CORRUPT_JPEG);
	await writeFile(join(root, "corrupt.png"), CORRUPT_PNG);
}

// --------------------------------------------------------------------------
// 1. Registration surface (matrix rows 16, 19, 22)
// --------------------------------------------------------------------------

test("registration surface: exactly read → grep → find then the 11 catalog tools; static metadata; inherited renderers", async () => {
	await withTempDir(async (root) => {
		const stub = makeStub();
		workbenchRuntime(stub);
		assert.deepEqual(
			[...stub.tools.keys()],
			[...NATIVE_OVERRIDE_NAMES, ...WORKBENCH_TOOL_NAMES],
			"three fixed native overrides first (read → grep → find), then the 11 catalog tools in order",
		);
		const builtin = builtins(root);
		for (const name of NATIVE_OVERRIDE_NAMES) {
			const def = stub.tools.get(name) as { name: string; label: string; description: string; promptSnippet: string; promptGuidelines: string[]; parameters: unknown; renderCall?: unknown; renderResult?: unknown };
			assert.equal(def.name, NATIVE_OVERRIDE_METADATA[name].name, name);
			assert.equal(def.label, NATIVE_OVERRIDE_METADATA[name].label, name);
			assert.equal(def.description, NATIVE_OVERRIDE_METADATA[name].description, name);
			assert.equal(def.promptSnippet, NATIVE_OVERRIDE_METADATA[name].promptSnippet, name);
			assert.deepEqual(def.promptGuidelines, NATIVE_OVERRIDE_METADATA[name].promptGuidelines, name);
			assert.equal(def.renderCall, undefined, `${name} must omit renderCall (built-in slot renderer inheritance)`);
			assert.equal(def.renderResult, undefined, `${name} must omit renderResult (built-in slot renderer inheritance)`);
			const builtinParams = name === "read" ? builtin.read : name === "grep" ? builtin.grep : builtin.find;
			const builtinSchema = (builtinParams as unknown as { parameters: { properties: Record<string, unknown> } }).parameters;
			if (name === "grep") {
				// N2: the grep schema is the byte-identical built-in property
				// prefix followed by exactly the two optional selectors
				const overrideProps = (def.parameters as { properties: Record<string, unknown> }).properties;
				const legacyKeys = ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"];
				assert.deepEqual(Object.keys(builtinSchema.properties), legacyKeys, "built-in grep property order (oracle sanity)");
				assert.deepEqual(
					Object.keys(overrideProps),
					[...legacyKeys, "output", "count_kind"],
					"grep exposes exactly the two N2 additions after the byte-identical legacy prefix",
				);
				for (const key of legacyKeys) {
					assert.deepEqual(overrideProps[key], builtinSchema.properties[key], `grep legacy property ${key} byte-identical`);
				}
			} else {
				// read (N1) and find (N3 not implemented) stay byte-identical
				assert.deepEqual(def.parameters, builtinSchema, `${name} schema byte-identical to the Pi 0.83.0 built-in`);
			}
		}
		// grep exposes exactly output/count_kind (the two N2 additions); find
		// exposes NO count/depth parameters (N3 not implemented)
		const grepParams = NATIVE_OVERRIDE_PARAMETERS.grep as unknown as { properties: Record<string, unknown> };
		const findParams = NATIVE_OVERRIDE_PARAMETERS.find as unknown as { properties: Record<string, unknown> };
		assert.deepEqual(
			Object.keys(grepParams.properties),
			["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit", "output", "count_kind"],
			"grep exposes exactly the two N2 selectors (nothing else)",
		);
		assert.ok(!("output" in findParams.properties), "find count mode is NOT exposed");
		assert.ok(!("count_kind" in findParams.properties), "find count_kind is NOT exposed");
		assert.ok(!("max_depth" in findParams.properties), "find max_depth is NOT exposed");
	});
});

test("active tool inventory and names are unchanged after session_start (no new active tool names)", async () => {
	await withTempDir(async (root) => {
		const stub = makeStub();
		workbenchRuntime(stub);
		await fireSessionStart(stub, root);
		// DEV default: the exact unchanged matrix — read/grep/find/ls +
		// bash/edit/write + the 11 workbench tools; the overrides add no names.
		assert.deepEqual(stub.activeTools, ["read", "grep", "find", "ls", "bash", "edit", "write", ...WORKBENCH_TOOL_NAMES]);
	});
});

// --------------------------------------------------------------------------
// 2. Read legacy parity (matrix row 1)
// --------------------------------------------------------------------------

test("read with explicit offset and/or limit is byte-identical to the built-in (content/details/errors)", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { read } = registered(stub);
		const oracle = builtins(root);
		const ctx = trustedCtx(root);
		const cases: Array<{ path: string; offset?: number; limit?: number }> = [
			{ path: "large.txt", offset: 10 },
			{ path: "large.txt", limit: 5 },
			{ path: "large.txt", offset: 100, limit: 50 },
			{ path: "small.txt", offset: 2 },
			// Pi's offset is 1-indexed over the built-in's split lines, which
			// include the trailing newline's phantom empty line: the
			// three-real-line small.txt ("alpha\nbeta\ngamma\n") has offset
			// positions 1..4, so offset=4 reads the phantom line and is a
			// valid built-in call — covered as successful parity here.
			{ path: "small.txt", offset: 4 },
			{ path: "small.txt", limit: 1 },
			{ path: "@small.txt", offset: 1 },
			{ path: join(root, "small.txt"), limit: 2 },
			{ path: "sub/nested.txt", offset: 1 },
			{ path: "crlf.txt", limit: 2 },
			{ path: "hugeline.txt", offset: 1 },
			{ path: "hugeline.txt", limit: 1 },
			{ path: "empty.txt", offset: 1 },
		];
		for (const params of cases) {
			const override = await read.execute("call-1", params, undefined, undefined, ctx);
			const builtin = await oracle.read.execute("call-1", params, undefined, undefined, ctx);
			assert.deepEqual(override, builtin, `legacy parity for ${JSON.stringify(params)}`);
		}
		// offset beyond end of file: identical error text (the oracle error is
		// captured first — the validator must return a plain boolean).
		// offset=5 is the first TRUE beyond-end position for small.txt — the
		// phantom trailing line occupies offset=4 (covered as a successful
		// parity case above), so only 5 and beyond are rejected.
		for (const params of [{ path: "small.txt", offset: 99 }, { path: "small.txt", offset: 5 }, { path: "empty.txt", offset: 2 }]) {
			const expectedError = await oracle.read.execute("call-2", params, undefined, undefined, ctx).then(
				() => null,
				(e: unknown) => e as Error,
			);
			assert.ok(expectedError, `oracle rejects for ${JSON.stringify(params)}`);
			await assert.rejects(
				() => read.execute("call-2", params, undefined, undefined, ctx),
				(error: unknown) => (error as Error).message === (expectedError as Error).message,
				`offset-beyond-end parity for ${JSON.stringify(params)}`,
			);
		}
		// missing / unreadable files: identical error text
		for (const path of ["missing.txt", "@missing.txt", join(root, "missing.txt"), "sub/missing.txt"]) {
			const expectedError = await oracle.read.execute("call-3", { path }, undefined, undefined, ctx).then(
				() => null,
				(e: unknown) => e as Error,
			);
			assert.ok(expectedError, `oracle rejects for ${path}`);
			await assert.rejects(
				() => read.execute("call-3", { path }, undefined, undefined, ctx),
				(error: unknown) => (error as Error).message === (expectedError as Error).message,
				`missing-file parity for ${path}`,
			);
		}
	});
});

test("read abort parity: a pre-aborted signal rejects with the exact built-in 'Operation aborted' error on legacy and preview paths", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { read } = registered(stub);
		const oracle = builtins(root);
		const ctx = trustedCtx(root);
		const aborted = new AbortController();
		aborted.abort();
		for (const params of [{ path: "small.txt" }, { path: "small.txt", offset: 1 }, { path: "large.txt", limit: 3 }]) {
			await assert.rejects(() => read.execute("call-1", params, aborted.signal, undefined, ctx), (error: unknown) => (error as Error).message === "Operation aborted", `abort parity for ${JSON.stringify(params)}`);
			await assert.rejects(() => oracle.read.execute("call-1", params, aborted.signal, undefined, ctx), (error: unknown) => (error as Error).message === "Operation aborted");
		}
	});
});

test("image reads pass through byte-identically for ALL FIVE supported types (attachment or built-in text-only notes); genuine text starting the note phrase still gets facts", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { read } = registered(stub);
		const oracle = builtins(root);
		const ctx = trustedCtx(root);
		// plan §9 row 6: JPEG, PNG, GIF, WEBP and BMP no-offset reads through
		// BOTH the registered override and the captured Pi 0.83.0 built-in,
		// byte-for-byte. The outcome is whatever the built-in ACTUALLY
		// produced — an attachment (image block + note) when
		// decode/convert/resize succeeded (the built-in converts BMP to PNG
		// and the note says "[Image converted from image/bmp to image/png.]"),
		// or the built-in TEXT-ONLY note (failed decode/resize) — and the
		// override must reproduce it exactly: never a preview, never facts,
		// never a weakened result.
		const fiveTypes = [
			{ path: "image.jpg", mime: "image/jpeg" },
			{ path: "image.png", mime: "image/png" },
			{ path: "image.gif", mime: "image/gif" },
			{ path: "image.webp", mime: "image/webp" },
			{ path: "image.bmp", mime: "image/bmp" },
		] as const;
		for (const { path, mime } of fiveTypes) {
			const override = await read.execute("call-1", { path }, undefined, undefined, ctx);
			const builtin = await oracle.read.execute("call-1", { path }, undefined, undefined, ctx);
			assert.deepEqual(override, builtin, `image parity for ${path}`);
			assert.ok(!textOf(override).includes(NRO_FACTS_MARKER), `no facts marker on the image path for ${path}`);
			assert.equal(override.details, undefined, `image details undefined for ${path}`);
			const note = textOf(builtin);
			if (mime === "image/bmp") {
				// Pi 0.83.0's built-in converts BMP → PNG on read: the note
				// names the CONVERTED mime and identifies the source format.
				assert.match(note, /^Read image file \[image\/png\]/, `${path} conversion outcome names image/png`);
				assert.match(note, /\[Image converted from image\/bmp to image\/png\.\]/, `${path} note identifies the conversion from image/bmp`);
			} else {
				// non-converted formats: the note names the source MIME directly
				assert.match(note, new RegExp(`^Read image file \\[${mime.replace("/", "\\/")}\\]`), `${path} note names the source MIME`);
			}
			const builtinAttachment = builtin.content.some((c) => c.type === "image");
			if (builtinAttachment) {
				assert.ok(override.content.some((c) => c.type === "image"), `${path} keeps the built-in attachment content`);
			} else {
				assert.ok(!override.content.some((c) => c.type === "image"), `${path} keeps the built-in TEXT-ONLY note (no preview, no facts)`);
			}
			// @-path and absolute-path spellings stay byte-identical too
			const atPath = `@${path}`;
			assert.deepEqual(
				await read.execute("call-1", { path: atPath }, undefined, undefined, ctx),
				await oracle.read.execute("call-1", { path: atPath }, undefined, undefined, ctx),
				`@-path image parity for ${path}`,
			);
			assert.deepEqual(
				await read.execute("call-1", { path: join(root, path) }, undefined, undefined, ctx),
				await oracle.read.execute("call-1", { path: join(root, path) }, undefined, undefined, ctx),
				`absolute-path image parity for ${path}`,
			);
		}
		// corrupt magic-byte files (decode/resize fails) are text-only notes
		// and stay byte-identical — fail-closed, never a preview, never facts
		for (const path of ["corrupt.jpg", "corrupt.png", "@corrupt.jpg"]) {
			const override = await read.execute("call-1", { path }, undefined, undefined, ctx);
			const builtin = await oracle.read.execute("call-1", { path }, undefined, undefined, ctx);
			assert.deepEqual(override, builtin, `image parity for ${path}`);
			assert.ok(!textOf(override).includes(NRO_FACTS_MARKER), `no facts marker on the image path for ${path}`);
			assert.equal(override.details, undefined, `image details undefined for ${path}`);
			assert.ok(!override.content.some((c) => c.type === "image"), `${path} stays a text-only built-in note`);
		}
		// a real image yields the attachment content (image block) — the
		// built-in read pipeline produced it, the override kept it.
		const png = await read.execute("call-2", { path: "image.png" }, undefined, undefined, ctx);
		assert.ok(png.content.some((c) => c.type === "image"), "image block present");
		assert.match(textOf(png), /^Read image file \[image\/png\]/);
		// a GENUINE text file starting with the same note phrase has no
		// matching magic bytes and still receives the NRO facts (complete=true)
		const note = await read.execute("call-3", { path: "note.txt" }, undefined, undefined, ctx);
		const noteFacts = parseFacts(textOf(note));
		assert.ok(noteFacts, "facts present on genuine text starting the note phrase");
		assert.equal(noteFacts.complete, true);
		assert.equal(noteFacts.total_lines, 2);
		assert.equal(note.details, undefined);
		const noteBody = textOf(note).slice(0, textOf(note).indexOf("\n" + NRO_FACTS_MARKER));
		assert.equal(noteBody, await (await import("node:fs/promises")).readFile(join(root, "note.txt"), "utf8"), "genuine text kept byte-for-byte");
	});
});

// --------------------------------------------------------------------------
// 3. No-offset/limit preview path (matrix rows 1, 3–5, 7)
// --------------------------------------------------------------------------

test("small no-offset/limit read: built-in text byte-for-byte + complete=true facts; details undefined", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { read } = registered(stub);
		const oracle = builtins(root);
		const ctx = trustedCtx(root);
		for (const path of ["small.txt", "crlf.txt", "bom.txt", "unicode.txt", "empty.txt", "sub/nested.txt", "@small.txt"]) {
			const override = await read.execute("call-1", { path }, undefined, undefined, ctx);
			const builtin = await oracle.read.execute("call-1", { path }, undefined, undefined, ctx);
			const builtinText = textOf(builtin);
			const overrideText = textOf(override);
			assert.ok(overrideText.startsWith(builtinText), `built-in text kept byte-for-byte for ${path}`);
			const facts = parseFacts(overrideText);
			assert.ok(facts, `facts present for ${path}`);
			assert.equal(facts.complete, true, `complete=true for ${path}`);
			assert.equal(facts.returned_lines, facts.total_lines, path);
			assert.equal(facts.omitted_lines, 0, path);
			assert.equal(facts.next_offset, 0, path);
			assert.equal(override.details, undefined, `details undefined when complete for ${path}`);
			assert.deepEqual(override.details, builtin.details, `details parity (both undefined) for ${path}`);
		}
	});
});

test("large no-offset/limit read: deterministic preview bounded at the caps with exact facts; legacy continuation reconstructs the file with no line skipped", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { read } = registered(stub);
		const ctx = trustedCtx(root);
		const fullText = await (await import("node:fs/promises")).readFile(join(root, "large.txt"), "utf8");

		const r1 = await read.execute("call-1", { path: "large.txt" }, undefined, undefined, ctx);
		const facts1 = parseFacts(textOf(r1));
		assert.ok(facts1);
		assert.equal(facts1.complete, false);
		assert.equal(facts1.total_lines, 500);
		assert.equal(facts1.returned_lines, PREVIEW_MAX_LINES);
		assert.equal(facts1.next_offset, PREVIEW_MAX_LINES + 1);
		assert.equal(facts1.line_truncated, false);
		assert.ok(Number(facts1.returned_bytes) <= PREVIEW_MAX_UTF8_BYTES, "returned_bytes ≤ 12 KiB");
		// details: exactly a valid truncation-only object
		assert.ok(r1.details, "truncated ⇒ details present");
		assert.deepEqual(Object.keys(r1.details), ["truncation"], "no additive details keys");
		const trunc = (r1.details as { truncation: Record<string, unknown> }).truncation;
		assert.equal(trunc.truncated, true);
		assert.equal(trunc.firstLineExceedsLimit, false);
		assert.equal(trunc.maxLines, PREVIEW_MAX_LINES);
		assert.equal(trunc.maxBytes, PREVIEW_MAX_UTF8_BYTES);
		assert.equal(trunc.outputLines, facts1.returned_lines);
		assert.equal(trunc.totalLines, 500);
		// determinism: same call again → identical result
		const r1b = await read.execute("call-1", { path: "large.txt" }, undefined, undefined, ctx);
		assert.deepEqual(r1, r1b, "preview is deterministic");

		// follow next_offset via legacy pagination — every page is a built-in
		// read (no facts marker on legacy pages), and the continuation
		// reconstructs the full file with no line skipped (no false
		// complete=true claim on the preview marker)
		const previewLines = textOf(r1).slice(0, textOf(r1).indexOf("\n" + NRO_FACTS_MARKER)).split("\n");
		assert.deepEqual(previewLines, fullText.split("\n").slice(0, 240), "preview lines are exactly the first 240 lines");
		let offset = Number(facts1.next_offset);
		const collected = [...previewLines];
		let guard = 0;
		while (guard < 10) {
			guard += 1;
			const page = await read.execute("call-2", { path: "large.txt", offset }, undefined, undefined, ctx);
			const pageText = textOf(page);
			collected.push(...pageText.split("\n"));
			if (collected.join("\n") === fullText) break;
			// legacy continuation notice: "[N more lines in file. Use offset=X to continue.]"
			const m = /Use offset=(\d+) to continue/.exec(pageText);
			assert.ok(m, "legacy continuation notice present");
			offset = Number(m[1]);
		}
		assert.equal(collected.join("\n"), fullText, "pagination reconstructs the file with no line skipped");
		assert.ok(guard < 10, "pagination terminates");
	});
});

test("huge single line: prefix representation with line_truncated=true; legacy pagination at next_offset re-reads the full line", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { read } = registered(stub);
		const oracle = builtins(root);
		const ctx = trustedCtx(root);
		const r1 = await read.execute("call-1", { path: "hugeline.txt" }, undefined, undefined, ctx);
		const facts = parseFacts(textOf(r1));
		assert.ok(facts);
		assert.equal(facts.complete, false);
		assert.equal(facts.line_truncated, true);
		assert.equal(facts.next_offset, 1, "next_offset points at the truncated line itself");
		assert.ok(textOf(r1).includes(" [line truncated]"), "fixed inline marker present");
		// legacy continuation: offset=1 returns the FULL first line
		const full = await oracle.read.execute("call-2", { path: "hugeline.txt", offset: 1 }, undefined, undefined, ctx);
		assert.ok(textOf(full).startsWith("H".repeat(5000)), "the full line is retrievable via legacy pagination");
		// and the override's legacy path returns it byte-identically
		const viaOverride = await read.execute("call-2", { path: "hugeline.txt", offset: 1 }, undefined, undefined, ctx);
		assert.deepEqual(viaOverride, full);
	});
});

test(">50KB first line: the second read-only read uses Pi-equivalent normalization (@/relative/absolute parity) and previews deterministically", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { read } = registered(stub);
		const ctx = trustedCtx(root);
		for (const path of ["hugefirst.txt", "@hugefirst.txt", join(root, "hugefirst.txt"), "./hugefirst.txt"]) {
			const r = await read.execute("call-1", { path }, undefined, undefined, ctx);
			const facts = parseFacts(textOf(r));
			assert.ok(facts, `facts present for ${path}`);
			assert.equal(facts.complete, false, `preview for ${path}`);
			assert.equal(facts.line_truncated, true, `huge first line prefix-represented for ${path}`);
			assert.equal(facts.next_offset, 1, path);
			assert.equal(facts.total_lines, 2, path);
			assert.equal(facts.total_bytes, 60 * 1024 + 1 + 5, path);
			assert.ok(Number(facts.returned_bytes) <= PREVIEW_MAX_LINE_UTF8_BYTES, path);
			// identical previews across the path spellings (deterministic)
			const r2 = await read.execute("call-1", { path: "hugefirst.txt" }, undefined, undefined, ctx);
			assert.deepEqual(r, r2, `deterministic across path spellings for ${path}`);
		}
		// the legacy continuation still works and is byte-identical to the built-in
		const oracle = builtins(root);
		const full = await oracle.read.execute("call-2", { path: "hugefirst.txt", offset: 1 }, undefined, undefined, ctx);
		const viaOverride = await read.execute("call-2", { path: "hugefirst.txt", offset: 1 }, undefined, undefined, ctx);
		assert.deepEqual(viaOverride, full);
	});
});

test("a file with an oversized middle line still previews deterministically with line_truncated (no hidden truncation)", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "mid.txt"), "first\n" + "M".repeat(3000) + "\nlast\n", "utf8");
		const stub = makeStub();
		workbenchRuntime(stub);
		const { read } = registered(stub);
		const ctx = trustedCtx(root);
		const r = await read.execute("call-1", { path: "mid.txt" }, undefined, undefined, ctx);
		const facts = parseFacts(textOf(r));
		assert.ok(facts);
		assert.equal(facts.complete, false);
		assert.equal(facts.line_truncated, true);
		assert.equal(facts.next_offset, 2, "next_offset = the truncated line's own number");
		assert.equal(facts.total_lines, 3);
		// continuation at offset 2 re-reads the full oversized line
		const page = await read.execute("call-2", { path: "mid.txt", offset: 2 }, undefined, undefined, ctx);
		assert.ok(textOf(page).startsWith("M".repeat(3000)), "full line retrievable via legacy pagination");
	});
});

// --------------------------------------------------------------------------
// 4. grep/find legacy pass-through (matrix rows 9, 14; the N2 selectors
// never reach the built-in delegation unless output=count)
// --------------------------------------------------------------------------

test("grep is an exact legacy pass-through: byte-identical results and errors", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { grep } = registered(stub);
		const oracle = builtins(root);
		const ctx = trustedCtx(root);
		const cases: Array<{ pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number; output?: "matches" | "count"; count_kind?: "matches" | "lines" }> = [
			{ pattern: "needle" },
			{ pattern: "needle", path: "." },
			{ pattern: "NEEDLE", ignoreCase: true },
			{ pattern: "needle", limit: 1 },
			{ pattern: "needle", context: 1 },
			{ pattern: "needle", literal: true },
			{ pattern: "*.txt", glob: "*.txt", literal: true },
		];
		for (const params of cases) {
			const override = await grep.execute("call-1", params, undefined, undefined, ctx);
			const builtin = await oracle.grep.execute("call-1", params, undefined, undefined, ctx);
			assert.deepEqual(override, builtin, `grep parity for ${JSON.stringify(params)}`);
		}
		// N2 selectors that do NOT select count mode never reach the adapter:
		// output="matches" and a count_kind present while output is omitted
		// are stripped before delegation, so the override is byte-identical
		// to the equivalent LEGACY parameter set
		const selectorCases: Array<{ params: (typeof cases)[number]; legacy: (typeof cases)[number] }> = [
			{ params: { pattern: "needle", output: "matches" }, legacy: { pattern: "needle" } },
			{ params: { pattern: "needle", output: "matches", limit: 1 }, legacy: { pattern: "needle", limit: 1 } },
			{ params: { pattern: "needle", output: "matches", ignoreCase: true }, legacy: { pattern: "needle", ignoreCase: true } },
			{ params: { pattern: "needle", count_kind: "lines" }, legacy: { pattern: "needle" } },
			{ params: { pattern: "needle", count_kind: "matches", literal: true }, legacy: { pattern: "needle", literal: true } },
		];
		for (const { params, legacy } of selectorCases) {
			const override = await grep.execute("call-4", params, undefined, undefined, ctx);
			const builtin = await oracle.grep.execute("call-4", legacy, undefined, undefined, ctx);
			assert.deepEqual(override, builtin, `grep selector parity for ${JSON.stringify(params)} vs legacy ${JSON.stringify(legacy)}`);
		}
		// missing path error parity (the oracle error is captured first — the
		// validator must return a plain boolean)
		const expectedGrepError = await oracle.grep.execute("call-2", { pattern: "x", path: "missing-dir" }, undefined, undefined, ctx).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.ok(expectedGrepError, "oracle rejects for the missing path");
		await assert.rejects(
			() => grep.execute("call-2", { pattern: "x", path: "missing-dir" }, undefined, undefined, ctx),
			(error: unknown) => (error as Error).message === (expectedGrepError as Error).message,
			"missing-path error parity",
		);
		// abort parity
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(() => grep.execute("call-3", { pattern: "x" }, aborted.signal, undefined, ctx), (error: unknown) => (error as Error).message === "Operation aborted");
	});
});

// --------------------------------------------------------------------------
// 4b. N2 grep count mode through the registered override (matrix rows
// 10–12, 18, 21)
// --------------------------------------------------------------------------

/** True when a real rg is available (the registered override's count mode needs it). */
function hasRealRg(): boolean {
	return resolveRgPath() !== null;
}

test("grep output=count: exact uncapped occurrences/lines/files with default kind=matches; compact one-line text; details undefined", async (t) => {
	if (!hasRealRg()) {
		t.skip("real ripgrep (rg) is not installed");
		return;
	}
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { grep } = registered(stub);
		const ctx = trustedCtx(root);
		// the deterministic fixture: search.txt = "needle here\nnothing\ntwo needle needles\n"
		// → 3 occurrences on 2 matching lines in exactly 1 file
		const matches = await grep.execute("call-1", { pattern: "needle", output: "count" }, undefined, undefined, ctx);
		assert.deepEqual(matches.content, [{ type: "text", text: formatGrepCountLine("matches", 3, 1) }], "exactly one compact text block");
		assert.equal(textOf(matches), "count kind=matches value=3 files=1", "no trailing newline, no legacy match lines");
		assert.equal(matches.details, undefined, "details undefined in count mode");
		// count_kind=lines counts matching LINES, not occurrences
		const lines = await grep.execute("call-2", { pattern: "needle", output: "count", count_kind: "lines" }, undefined, undefined, ctx);
		assert.equal(textOf(lines), formatGrepCountLine("lines", 2, 1));
		assert.deepEqual(lines.content, [{ type: "text", text: formatGrepCountLine("lines", 2, 1) }]);
		assert.equal(lines.details, undefined);
		// determinism: repeated count scans over the same fixture are identical
		assert.deepEqual(await grep.execute("call-3", { pattern: "needle", output: "count" }, undefined, undefined, ctx), matches);
	});
});

test("grep output=count: zero result is exact zero; literal/ignoreCase/glob/path selectors; legacy limit/context never apply", async (t) => {
	if (!hasRealRg()) {
		t.skip("real ripgrep (rg) is not installed");
		return;
	}
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { grep } = registered(stub);
		const ctx = trustedCtx(root);
		// zero matches is an exact zero result (rg exit 1), never an error
		const zero = await grep.execute("call-1", { pattern: "zzz-absent", output: "count" }, undefined, undefined, ctx);
		assert.equal(textOf(zero), formatGrepCountLine("matches", 0, 0), "exact zero count");
		assert.equal(zero.details, undefined);
		// regex vs literal: "ne.dle" matches "needle" as a regex; with
		// literal=true the dot is a literal character and nothing matches
		assert.equal(textOf(await grep.execute("call-2", { pattern: "ne.dle", output: "count" }, undefined, undefined, ctx)), formatGrepCountLine("matches", 3, 1));
		assert.equal(textOf(await grep.execute("call-3", { pattern: "ne.dle", output: "count", literal: true }, undefined, undefined, ctx)), formatGrepCountLine("matches", 0, 0));
		// ignoreCase: the case-insensitive scan finds the same occurrences
		assert.equal(textOf(await grep.execute("call-4", { pattern: "NEEDLE", output: "count", ignoreCase: true }, undefined, undefined, ctx)), formatGrepCountLine("matches", 3, 1));
		// glob filters the scanned file set
		assert.equal(textOf(await grep.execute("call-5", { pattern: "needle", output: "count", glob: "*.txt" }, undefined, undefined, ctx)), formatGrepCountLine("matches", 3, 1));
		assert.equal(textOf(await grep.execute("call-6", { pattern: "needle", output: "count", glob: "*.md" }, undefined, undefined, ctx)), formatGrepCountLine("matches", 0, 0));
		// path scopes the scan (sub/ holds no needle text)
		assert.equal(textOf(await grep.execute("call-7", { pattern: "needle", output: "count", path: "sub" }, undefined, undefined, ctx)), formatGrepCountLine("matches", 0, 0));
		assert.equal(textOf(await grep.execute("call-8", { pattern: "needle", output: "count", path: "." }, undefined, undefined, ctx)), formatGrepCountLine("matches", 3, 1));
		// legacy limit/context are NEVER applied to count mode: limit=1 /
		// context=1 still produce the exact full-scan count (the legacy
		// matches path would have returned a single match line)
		assert.equal(textOf(await grep.execute("call-9", { pattern: "needle", output: "count", limit: 1, context: 1 }, undefined, undefined, ctx)), formatGrepCountLine("matches", 3, 1));
	});
});

test("grep output=count: missing search path fails with the built-in text; a pre-aborted signal rejects exactly Operation aborted", async (t) => {
	if (!hasRealRg()) {
		t.skip("real ripgrep (rg) is not installed");
		return;
	}
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { grep } = registered(stub);
		const ctx = trustedCtx(root);
		// missing path: the adapter resolves like the built-in and fails with
		// the built-in's own error text — never a partial count
		await assert.rejects(
			() => grep.execute("call-1", { pattern: "x", path: "missing-dir", output: "count" }, undefined, undefined, ctx),
			(error: unknown) => (error as Error).message === `Path not found: ${nativeResolvePath("missing-dir", root)}`,
			"missing-path error in count mode",
		);
		// pre-aborted signal: the count scan rejects exactly "Operation
		// aborted" before any scan work — never a partial count
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(
			() => grep.execute("call-2", { pattern: "x", output: "count" }, aborted.signal, undefined, ctx),
			(error: unknown) => (error as Error).message === "Operation aborted",
			"pre-abort in count mode",
		);
	});
});

/** Fixed cap contract for `{ pattern: "*.txt", limit: 2 }` — pi's fd-path notice suffix (2 = effectiveLimit). */
const FIND_LIMIT_2_WARNING_SUFFIX = "\n\n[2 results limit reached. Use limit=4 for more, or refine pattern]";

/** Every fixture file a `*.txt` basename glob matches (fd recurses, so sub/nested.txt counts). */
const FIND_TXT_GROUND_TRUTH = [
	"small.txt",
	"crlf.txt",
	"bom.txt",
	"empty.txt",
	"unicode.txt",
	"large.txt",
	"hugeline.txt",
	"hugefirst.txt",
	"search.txt",
	"note.txt",
	"boundary.txt",
	"boundarynl.txt",
	"sub/nested.txt",
];

/**
 * The strict capped-result contract for `{ pattern: "*.txt", limit: 2 }`.
 *
 * WHY byte equality is invalid here: the built-in runs `fd --max-results 2`
 * with parallel traversal. fd stops as soon as 2 matches are collected, so
 * WHICH 2 of the 13 matching fixture files a given process reports — and in
 * what order — depends on which worker threads' readdir/stat results land
 * first; two independent fd processes on the identical static tree can pick
 * different subsets (observed: one reported note.txt, the other small.txt).
 * This is a property of fd's parallel early-terminating enumeration, not a
 * timing fluke of the harness, so cross-process exact equality at a hard
 * cap can never be a stable parity invariant. The deterministic invariants
 * are the cap contract below plus the uncapped byte parity above.
 */
function assertCappedFindResult(result: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> | undefined }, label: string): void {
	// exact content shape: exactly one text block, no other blocks
	assert.equal(result.content.length, 1, `${label}: exactly one content block`);
	const first = result.content[0];
	assert.ok(first, `${label}: the single content block is present`);
	assert.equal(first.type, "text", `${label}: the single content block is text`);
	const text = first.text;
	// exact fixed limit-warning suffix (pi's fd-path notice for limit=2)
	assert.ok(text.endsWith(FIND_LIMIT_2_WARNING_SUFFIX), `${label}: exact limit-warning suffix`);
	// exactly 2 unique matching fixture paths before the warning
	const paths = text.slice(0, text.length - FIND_LIMIT_2_WARNING_SUFFIX.length).split("\n");
	assert.equal(paths.length, 2, `${label}: exactly two paths before the warning`);
	assert.equal(new Set(paths).size, 2, `${label}: the two paths are unique`);
	for (const p of paths) {
		assert.ok(FIND_TXT_GROUND_TRUTH.includes(p), `${label}: ${JSON.stringify(p)} is drawn from the full .txt ground-truth set`);
		assert.ok(p.length > 0 && !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."), `${label}: ${JSON.stringify(p)} is a safe relative path`);
	}
	// exact cap details — resultLimitReached === 2 and NO other keys
	assert.deepEqual(result.details, { resultLimitReached: 2 }, `${label}: exact cap details`);
}

test("find is an exact legacy pass-through: byte-identical uncapped results and errors", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { find } = registered(stub);
		const oracle = builtins(root);
		const ctx = trustedCtx(root);
		// UNCAPPED cases stay byte-exact deep-equal: without --max-results fd
		// emits the complete match set in stable enumeration order, so two
		// independent processes agree bit-for-bit. The capped limit:2 case is
		// deliberately excluded — cross-process equality at a hard cap is
		// invalid (see assertCappedFindResult and the cap-contract test).
		const cases: Array<{ pattern: string; path?: string; limit?: number }> = [
			{ pattern: "*.txt" },
			{ pattern: "*.txt", path: "." },
			{ pattern: "**/*.txt" },
			{ pattern: "sub/**" },
		];
		for (const params of cases) {
			const override = await find.execute("call-1", params, undefined, undefined, ctx);
			const builtin = await oracle.find.execute("call-1", params, undefined, undefined, ctx);
			assert.deepEqual(override, builtin, `find parity for ${JSON.stringify(params)}`);
		}
		// missing path error parity (the oracle error is captured first — the
		// validator must return a plain boolean)
		const expectedFindError = await oracle.find.execute("call-2", { pattern: "*.txt", path: "missing-dir" }, undefined, undefined, ctx).then(
			() => null,
			(e: unknown) => e as Error,
		);
		assert.ok(expectedFindError, "oracle rejects for the missing path");
		await assert.rejects(
			() => find.execute("call-2", { pattern: "*.txt", path: "missing-dir" }, undefined, undefined, ctx),
			(error: unknown) => (error as Error).message === (expectedFindError as Error).message,
			"missing-path error parity",
		);
		// abort parity
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(() => find.execute("call-3", { pattern: "*.txt" }, aborted.signal, undefined, ctx), (error: unknown) => (error as Error).message === "Operation aborted");
	});
});

test("find limit cap: the override and the oracle each satisfy the strict capped-result contract (subsets/order may differ across processes)", async () => {
	await withTempDir(async (root) => {
		await writeFixture(root);
		const stub = makeStub();
		workbenchRuntime(stub);
		const { find } = registered(stub);
		const oracle = builtins(root);
		const ctx = trustedCtx(root);
		const params = { pattern: "*.txt", limit: 2 };
		// TWO INDEPENDENT fd processes (the override delegates to its own
		// built-in definition; the oracle is the captured built-in). Each
		// output must satisfy the strict shared cap contract, but the two
		// 2-path subsets and their order are NOT required to be identical.
		const override = await find.execute("call-1", params, undefined, undefined, ctx);
		const builtin = await oracle.find.execute("call-1", params, undefined, undefined, ctx);
		assertCappedFindResult(override, "override");
		assertCappedFindResult(builtin, "oracle");
	});
});

test("find source wiring: the registered override is the literal built-in delegation — same five execute arguments, no transform/branch/N3 mode", async () => {
	const index = await (await import("node:fs/promises")).readFile(new URL("../extensions/workbench-runtime/index.ts", import.meta.url), "utf8");
	const findMarker = "NATIVE_OVERRIDE_METADATA.find";
	const findStart = index.indexOf(findMarker);
	assert.ok(findStart !== -1, "find override registration present in the runtime source");
	// the find override is its own registerTool block: from its opening
	// pi.registerTool({ up to (excluding) the next one (the custom tools)
	const findOpen = index.lastIndexOf("pi.registerTool({", findStart);
	const findClose = index.indexOf("pi.registerTool({", findStart + findMarker.length);
	assert.ok(findOpen !== -1 && findClose !== -1 && findClose > findOpen, "find override is a self-contained registerTool block");
	const findBlock = index.slice(findOpen, findClose);
	// the execute body must be exactly ONE literal delegation statement: the
	// same five arguments in the same order (toolCallId, params, signal,
	// onUpdate, ctx), no params rewriting, no branch, no N3 mode. Comments
	// are stripped first so the N1/N3 prose can never satisfy the assertion
	// by accident — any added statement, transform or branch changes the
	// normalized body and fails this exact equality.
	const executeStart = findBlock.indexOf("async execute(");
	assert.ok(executeStart !== -1, "find override declares async execute");
	// indexOf points at the `}` of the `},` terminator — include it so the
	// extracted body keeps the function's closing brace
	const executeEnd = findBlock.indexOf("},", executeStart);
	assert.ok(executeEnd !== -1 && executeEnd > executeStart, "find override execute body is delimited");
	const executeBody = findBlock.slice(executeStart, executeEnd + 1);
	const strippedBody = executeBody
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	assert.equal(
		strippedBody,
		"async execute(toolCallId, params, signal, onUpdate, ctx) { return createFindToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx); }",
		"find override execute is the literal built-in delegation — no transform/branch/new mode",
	);
});

// --------------------------------------------------------------------------
// 5. Security / mode semantics (matrix row 17)
// --------------------------------------------------------------------------

test("the exact-name mode/path guard still fires for read (protected paths blocked in AUDIT/VERIFY, allowed in DEV)", async () => {
	// checkToolCall matches by exact tool name — the override cannot bypass
	// the guard because it registers under the SAME name.
	assert.equal(checkToolCall("DEV", "read", { path: ".env" }).allowed, true, "DEV allows protected reads");
	assert.equal(checkToolCall("AUDIT", "read", { path: ".env" }).allowed, false, "AUDIT blocks protected reads");
	assert.match(checkToolCall("AUDIT", "read", { path: ".env" }).reason ?? "", /AUDIT mode blocks reading protected file/);
	assert.equal(checkToolCall("VERIFY", "read", { path: "secrets.json" }).allowed, false, "VERIFY blocks protected reads");
	assert.equal(checkToolCall("AUDIT", "read", { path: "src/main.ts" }).allowed, true, "ordinary reads stay allowed");
	assert.equal(checkToolCall("VERIFY", "grep", { pattern: "x", path: ".env" }).allowed, false, "grep protected path blocked in VERIFY");
	assert.equal(checkToolCall("VERIFY", "find", { pattern: "*", path: ".env" }).allowed, false, "find protected path blocked in VERIFY");
	// the override performs no writes: its execute paths only ever read
	const index = await (await import("node:fs/promises")).readFile(new URL("../extensions/workbench-runtime/index.ts", import.meta.url), "utf8");
	const overrideBlocks = index.split("pi.registerTool({").slice(1, 4).join("\n");
	// write CALL SITES only — comments may legitimately name the prohibited
	// operations ("no pi.exec, no writes")
	assert.ok(!/(?:^|[^A-Za-z])(?:writeFile|writeFileSync|mkdir|mkdirSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync|rename|renameSync)\s*\(/.test(overrideBlocks), "override registration contains no write call sites");
	assert.ok(!/pi\.exec\s*\(/.test(overrideBlocks), "override registration contains no pi.exec call site");
});
