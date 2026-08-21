import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	captureStreamingIdentities,
	createNodeStreamingIdentityAdapter,
	STREAMING_IDENTITY_FAULT_POINTS,
	streamingIdentityEqual,
	type CaptureStreamingIdentitiesResult,
	type StreamingFileIdentity,
	type StreamingIdentityAdapter,
	type StreamingIdentityErrorCode,
	type StreamingIdentityFaultPoint,
	type StreamingIdentityMeter,
} from "../extensions/workbench-runtime/core/streaming-identity.ts";

async function tempProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "streaming-identity-"));
}

async function cleanup(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

function sha256(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function success(result: CaptureStreamingIdentitiesResult) {
	assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
	if (!result.ok) throw new Error("expected capture success");
	return result;
}

function failure(result: CaptureStreamingIdentitiesResult, code: StreamingIdentityErrorCode) {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected capture failure");
	assert.equal(result.error.code, code);
	assert.ok(!("identities" in result), "a failed capture never exposes a partial identity set");
	return result;
}

test("ChangeSet v2 full hash distinguishes >4 MiB files with equal prefix and equal size but different tails", async () => {
	const root = await tempProject();
	try {
		const prefix = Buffer.alloc(4 * 1024 * 1024, 0x61);
		const left = Buffer.concat([prefix, Buffer.from("left-tail")]);
		const right = Buffer.concat([prefix, Buffer.from("rite-tail")]);
		assert.equal(left.length, right.length);
		await writeFile(join(root, "left.bin"), left);
		await writeFile(join(root, "right.bin"), right);

		const result = success(await captureStreamingIdentities({ project_root: root, paths: ["left.bin", "right.bin"] }));
		const identities = result.identities as readonly StreamingFileIdentity[];
		assert.equal(identities[0]?.sha256, sha256(left));
		assert.equal(identities[1]?.sha256, sha256(right));
		assert.notEqual(identities[0]?.sha256, identities[1]?.sha256);
		assert.equal(result.meter.bytes_read, left.length + right.length, "every byte contributes to the meter and digest");
	} finally {
		await cleanup(root);
	}
});

test("empty, small, Unicode-name, missing, and repeated file identities are deterministic and JSON-safe", async () => {
	const root = await tempProject();
	try {
		await writeFile(join(root, "empty.txt"), "");
		await writeFile(join(root, "small.txt"), "small\n");
		await writeFile(join(root, "你好-🌱.txt"), "unicode-name\n");
		const paths = ["small.txt", "missing.txt", "你好-🌱.txt", "empty.txt"];
		const first = success(await captureStreamingIdentities({ project_root: root, paths }));
		const second = success(await captureStreamingIdentities({ project_root: root, paths }));

		assert.deepEqual(paths, ["small.txt", "missing.txt", "你好-🌱.txt", "empty.txt"], "caller path order is not mutated");
		assert.deepEqual(first.identities, second.identities);
		for (let index = 0; index < first.identities.length; index += 1) {
			assert.equal(streamingIdentityEqual(first.identities[index]!, second.identities[index]!), true);
		}
		const missing = first.identities.find((identity) => identity.path === "missing.txt");
		assert.deepEqual(missing, { schema_version: 2, kind: "missing", path: "missing.txt" });
		const empty = first.identities.find((identity) => identity.path === "empty.txt");
		assert.equal(empty?.kind, "file");
		if (empty?.kind === "file") {
			assert.equal(empty.byte_size, 0);
			assert.equal(empty.sha256, sha256(""));
			assert.match(empty.stat.dev, /^\d+$/);
			assert.match(empty.stat.ino, /^\d+$/);
			assert.match(empty.stat.mtime_ns, /^\d+$/);
			assert.match(empty.stat.ctime_ns, /^\d+$/);
		}
		assert.equal(JSON.stringify(first.identities).includes("unicode-name"), false, "identity never retains file content");
	} finally {
		await cleanup(root);
	}
});

test("strict paths reject absolute, traversal, noncanonical, separator, and control-character forms before I/O", async () => {
	const root = await tempProject();
	try {
		for (const path of ["/absolute", "../escape", "a/../escape", "./a", "a//b", "a/", "a\\b", "a\nb", ".", "a/./b"]) {
			const meter: StreamingIdentityMeter = { paths_attempted: 0, paths_completed: 0, bytes_read: 0 };
			const result = failure(await captureStreamingIdentities({ project_root: root, paths: [path], meter }), "invalid_path");
			assert.deepEqual(result.meter, meter);
			assert.equal(meter.paths_attempted, 0);
		}
		failure(await captureStreamingIdentities({ project_root: root, paths: ["same", "same"] }), "duplicate_path");
	} finally {
		await cleanup(root);
	}
});

test("target symlinks, directories, and a parent-symlink realpath escape fail closed", async () => {
	const root = await tempProject();
	const outside = await tempProject();
	try {
		await writeFile(join(root, "regular.txt"), "inside");
		await symlink("regular.txt", join(root, "target-link"));
		await mkdir(join(root, "directory"));
		await writeFile(join(outside, "secret.txt"), "OUTSIDE_SECRET_CONTENT");
		await symlink(outside, join(root, "outside-parent"));

		failure(await captureStreamingIdentities({ project_root: root, paths: ["target-link"] }), "path_symlink");
		failure(await captureStreamingIdentities({ project_root: root, paths: ["directory"] }), "path_not_regular");
		const escaped = failure(await captureStreamingIdentities({ project_root: root, paths: ["outside-parent/secret.txt"] }), "path_escape");
		assert.ok(!JSON.stringify(escaped).includes("OUTSIDE_SECRET_CONTENT"));
	} finally {
		await cleanup(root);
		await cleanup(outside);
	}
});

test("meter is exact, proportional to touched paths, caller-safe, and cumulative across captures", async () => {
	const root = await tempProject();
	try {
		await writeFile(join(root, "a.txt"), "aa");
		await writeFile(join(root, "b.txt"), "bbb");
		await writeFile(join(root, "unrelated.bin"), Buffer.alloc(2 * 1024 * 1024, 0x7f));
		const paths = ["b.txt", "a.txt"];
		const limits = { max_paths: 4, max_total_bytes: 12, max_file_bytes: 10 } as const;
		const meter: StreamingIdentityMeter = { paths_attempted: 0, paths_completed: 0, bytes_read: 0 };
		const first = success(await captureStreamingIdentities({ project_root: root, paths, limits, meter }));
		assert.deepEqual(paths, ["b.txt", "a.txt"]);
		assert.deepEqual(limits, { max_paths: 4, max_total_bytes: 12, max_file_bytes: 10 });
		assert.deepEqual(meter, { paths_attempted: 2, paths_completed: 2, bytes_read: 5 });
		assert.deepEqual(first.meter, meter);

		const second = success(await captureStreamingIdentities({ project_root: root, paths: ["a.txt"], limits, meter }));
		assert.deepEqual(second.meter, { paths_attempted: 3, paths_completed: 3, bytes_read: 7 });
		failure(await captureStreamingIdentities({ project_root: root, paths: ["b.txt", "a.txt"], limits, meter }), "path_count_overflow");
		assert.deepEqual(meter, { paths_attempted: 3, paths_completed: 3, bytes_read: 7 }, "preflight overflow performs no I/O");
	} finally {
		await cleanup(root);
	}
});

test("path-count, per-file, and cumulative total-byte overflow return no partial identity success", async () => {
	const root = await tempProject();
	try {
		await writeFile(join(root, "a.txt"), "aa");
		await writeFile(join(root, "b.txt"), "bbb");
		failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["a.txt", "b.txt"],
			limits: { max_paths: 1 },
		}), "path_count_overflow");

		const fileOverflow = failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["b.txt"],
			limits: { max_file_bytes: 2 },
		}), "file_bytes_overflow");
		assert.equal(fileOverflow.meter.bytes_read, 0);

		const totalOverflow = failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["a.txt", "b.txt"],
			limits: { max_total_bytes: 4 },
		}), "total_bytes_overflow");
		assert.deepEqual(totalOverflow.meter, { paths_attempted: 2, paths_completed: 1, bytes_read: 2 });

		const reused: StreamingIdentityMeter = { paths_attempted: 1, paths_completed: 1, bytes_read: 4 };
		const reusedOverflow = failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["a.txt"],
			limits: { max_paths: 3, max_total_bytes: 5 },
			meter: reused,
		}), "total_bytes_overflow");
		assert.equal(reusedOverflow.meter.bytes_read, 4);
		assert.equal(reused.bytes_read, 4);
	} finally {
		await cleanup(root);
	}
});

const FAULT_CODES: Readonly<Record<StreamingIdentityFaultPoint, StreamingIdentityErrorCode>> = Object.freeze({
	path_before_stat: "stat_failed",
	path_before_realpath: "stat_failed",
	open: "open_failed",
	handle_before_stat: "stat_failed",
	read: "read_failed",
	after_hash: "unstable",
	handle_after_stat: "stat_failed",
	path_after_stat: "path_after_failed",
	path_after_realpath: "path_after_failed",
	close: "close_failed",
});

test("every declared deterministic fault point returns its stable bounded code and no content", async () => {
	const root = await tempProject();
	const secret = "SECRET_FAULT_VECTOR_987654321";
	try {
		await writeFile(join(root, "fault.txt"), secret);
		assert.deepEqual(Object.keys(FAULT_CODES).sort(), [...STREAMING_IDENTITY_FAULT_POINTS].sort());
		for (const point of STREAMING_IDENTITY_FAULT_POINTS) {
			const result = failure(await captureStreamingIdentities({
				project_root: root,
				paths: ["fault.txt"],
				hooks: { fault(candidate) { if (candidate === point) throw new Error(secret); } },
			}), FAULT_CODES[point]);
			const rendered = JSON.stringify(result);
			assert.ok(rendered.length < 500);
			assert.ok(!rendered.includes(secret), `${point} must not leak thrown text or file content`);
		}
	} finally {
		await cleanup(root);
	}
});

test("adapter read and close failures are structured and close failure is authoritative over a completed digest", async () => {
	const root = await tempProject();
	try {
		await writeFile(join(root, "file.txt"), "adapter-failure");
		const node = createNodeStreamingIdentityAdapter();
		const readFail: StreamingIdentityAdapter = {
			...node,
			async openNoFollow(path) {
				const handle = await node.openNoFollow(path);
				return { ...handle, read: async () => { throw new Error("raw read detail"); } };
			},
		};
		failure(await captureStreamingIdentities({ project_root: root, paths: ["file.txt"], adapter: readFail }), "read_failed");

		const closeFail: StreamingIdentityAdapter = {
			...node,
			async openNoFollow(path) {
				const handle = await node.openNoFollow(path);
				return {
					...handle,
					async close() {
						await handle.close();
						throw new Error("raw close detail");
					},
				};
			},
		};
		const closed = failure(await captureStreamingIdentities({ project_root: root, paths: ["file.txt"], adapter: closeFail }), "close_failed");
		assert.equal(closed.meter.bytes_read, Buffer.byteLength("adapter-failure"));
		assert.ok(!JSON.stringify(closed).includes("raw close detail"));
	} finally {
		await cleanup(root);
	}
});

test("mutation after hashing, rename replacement, and same-size tail rewrite are all unstable", async () => {
	const root = await tempProject();
	try {
		const during = Buffer.alloc(3 * 64 * 1024, 0x61);
		await writeFile(join(root, "during.bin"), during);
		let mutatedDuring = false;
		failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["during.bin"],
			hooks: {
				async fault(point, context) {
					if (point === "read" && context.offset === 64 * 1024 && !mutatedDuring) {
						mutatedDuring = true;
						const changed = Buffer.from(during);
						changed[changed.length - 1] = 0x62;
						await writeFile(join(root, "during.bin"), changed);
					}
				},
			},
		}), "unstable");

		await writeFile(join(root, "renamed.txt"), "original");
		failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["renamed.txt"],
			hooks: {
				async fault(point) {
					if (point === "after_hash") {
						await rename(join(root, "renamed.txt"), join(root, "old.txt"));
						await writeFile(join(root, "renamed.txt"), "original");
					}
				},
			},
		}), "unstable");

		await writeFile(join(root, "tail.bin"), "equal-prefix-A");
		failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["tail.bin"],
			hooks: {
				async fault(point) {
					if (point === "after_hash") await writeFile(join(root, "tail.bin"), "equal-prefix-B");
				},
			},
		}), "unstable");
	} finally {
		await cleanup(root);
	}
});

test("a missing path created between its two path checks is unstable, never a missing identity", async () => {
	const root = await tempProject();
	try {
		let created = false;
		const result = failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["appears.txt"],
			hooks: {
				async fault(point) {
					if (point === "path_after_stat" && !created) {
						created = true;
						await writeFile(join(root, "appears.txt"), "created-during-capture");
					}
				},
			},
		}), "unstable");
		assert.equal(result.meter.bytes_read, 0);
	} finally {
		await cleanup(root);
	}
});

test("invalid meters and attempts to raise hard limits fail before file access", async () => {
	const root = await tempProject();
	try {
		await writeFile(join(root, "file.txt"), "safe");
		failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["file.txt"],
			meter: { paths_attempted: -1, paths_completed: 0, bytes_read: 0 },
		}), "invalid_input");
		failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["file.txt"],
			meter: { paths_attempted: 0, paths_completed: 1, bytes_read: 0 },
		}), "invalid_input");
		failure(await captureStreamingIdentities({
			project_root: root,
			paths: ["file.txt"],
			limits: { max_total_bytes: 256 * 1024 * 1024 + 1 },
		}), "invalid_input");
		assert.equal((await readFile(join(root, "file.txt"), "utf8")), "safe");
	} finally {
		await cleanup(root);
	}
});
