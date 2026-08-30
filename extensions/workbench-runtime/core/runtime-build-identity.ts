/** Stable, load-time identity for one workbench extension runtime instance. */

import { createHash, type Hash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTENSION_VERSION } from "../cache/cache-types.ts";
import { workbenchToolRequiresCheckoutLaneV1 } from "./checkout-tool-classification.ts";

export const WORKBENCH_RUNTIME_BUILD_SCHEMA_VERSION = 1 as const;
export const WORKBENCH_RUNTIME_EXTENSION_NAME = "pi-dev-workbench/workbench-runtime" as const;

export interface WorkbenchRuntimeBuildIdentityV1 {
	readonly schema_version: typeof WORKBENCH_RUNTIME_BUILD_SCHEMA_VERSION;
	readonly build: string;
	readonly version: string;
	readonly source_hash: string;
}

interface RuntimeSourceFile {
	path: string;
	bytes: Buffer;
}

interface RuntimeSourcePath {
	path: string;
	absolutePath: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = dirname(MODULE_DIR);
const HASH_DOMAIN = "pi-dev-workbench/workbench-runtime/source/v1\0";

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalRelativePath(path: string): string {
	return relative(RUNTIME_ROOT, path).split(sep).join("/");
}

function collectRuntimeSourcePaths(directory = RUNTIME_ROOT): RuntimeSourcePath[] {
	const files: RuntimeSourcePath[] = [];
	const entries = readdirSync(directory, { withFileTypes: true })
		.sort((left, right) => compareUtf8(left.name, right.name));
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectRuntimeSourcePaths(path));
		else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push({ path: canonicalRelativePath(path), absolutePath: path });
		}
	}
	return files;
}

function updateRuntimeSourceHash(hash: Hash, path: string, bytes: Buffer): void {
	hash.update(path, "utf8");
	hash.update("\0", "utf8");
	hash.update(String(bytes.byteLength), "utf8");
	hash.update("\0", "utf8");
	hash.update(bytes);
	hash.update("\0", "utf8");
}

/** Hash canonical relative paths and exact bytes; absolute checkout paths never enter the identity. */
export function hashWorkbenchRuntimeSourcesV1(sources: readonly RuntimeSourceFile[]): string {
	const hash = createHash("sha256");
	hash.update(HASH_DOMAIN, "utf8");
	const sorted = sources
		.map((source) => ({ source, pathBytes: Buffer.from(source.path, "utf8") }))
		.sort((left, right) => left.pathBytes.compare(right.pathBytes));
	for (const { source } of sorted) {
		updateRuntimeSourceHash(hash, source.path, source.bytes);
	}
	return `sha256:${hash.digest("hex")}`;
}

/** Hash the live tree in canonical path order without retaining every source buffer. */
function hashCurrentWorkbenchRuntimeSourcesV1(): string {
	const hash = createHash("sha256");
	hash.update(HASH_DOMAIN, "utf8");
	const paths = collectRuntimeSourcePaths()
		.map((source) => ({ source, pathBytes: Buffer.from(source.path, "utf8") }))
		.sort((left, right) => left.pathBytes.compare(right.pathBytes));
	for (const { source } of paths) {
		updateRuntimeSourceHash(hash, source.path, readFileSync(source.absolutePath));
	}
	return `sha256:${hash.digest("hex")}`;
}

export function snapshotCurrentWorkbenchRuntimeBuildIdentityV1(): WorkbenchRuntimeBuildIdentityV1 {
	const sourceHash = hashCurrentWorkbenchRuntimeSourcesV1();
	const shortHash = sourceHash.slice("sha256:".length, "sha256:".length + 16);
	return Object.freeze({
		schema_version: WORKBENCH_RUNTIME_BUILD_SCHEMA_VERSION,
		build: `${WORKBENCH_RUNTIME_EXTENSION_NAME}@${EXTENSION_VERSION}+sha256.${shortHash}`,
		version: EXTENSION_VERSION,
		source_hash: sourceHash,
	});
}

/**
 * Captured exactly once when this module loads. An old Pi session therefore
 * keeps reporting its old build after source files change; only a real reload
 * or restart can acquire the new source fingerprint.
 */
export const WORKBENCH_RUNTIME_BUILD_IDENTITY = snapshotCurrentWorkbenchRuntimeBuildIdentityV1();

export interface WorkbenchRuntimeBuildDoctorV1 {
	readonly loaded: WorkbenchRuntimeBuildIdentityV1;
	readonly disk: WorkbenchRuntimeBuildIdentityV1;
	readonly status: "CURRENT" | "STALE";
}

/** Compare the load-time snapshot with the exact source tree currently on disk. */
export function doctorWorkbenchRuntimeBuildV1(): WorkbenchRuntimeBuildDoctorV1 {
	const disk = snapshotCurrentWorkbenchRuntimeBuildIdentityV1();
	return Object.freeze({
		loaded: WORKBENCH_RUNTIME_BUILD_IDENTITY,
		disk,
		status: disk.source_hash === WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash ? "CURRENT" : "STALE",
	});
}

export function workbenchRuntimeDoctorLinesV1(doctor = doctorWorkbenchRuntimeBuildV1()): string[] {
	return [
		`runtime status   : ${doctor.status}`,
		`loaded build     : ${doctor.loaded.build}`,
		`loaded source    : ${doctor.loaded.source_hash}`,
		`disk build       : ${doctor.disk.build}`,
		`disk source      : ${doctor.disk.source_hash}`,
		...(doctor.status === "STALE"
			? ["next action      : run /reload (or restart Pi), then repeat /q-runtime-doctor before any write"]
			: ["write readiness  : this session is running the current on-disk workbench source"]),
	];
}

/** Fail closed only at mutation boundaries; current-state diagnosis stays available. */
export function workbenchRuntimeMutationBlockReasonV1(
	toolName: unknown,
	doctor?: WorkbenchRuntimeBuildDoctorV1,
): string | undefined {
	if (!workbenchToolRequiresCheckoutLaneV1(toolName)) return undefined;
	const current = doctor ?? doctorWorkbenchRuntimeBuildV1();
	if (current.status === "CURRENT") return undefined;
	return `Workbench runtime is stale (loaded ${current.loaded.source_hash}, disk ${current.disk.source_hash}); run /reload and verify /q-runtime-doctor before mutation`;
}

export function workbenchRuntimeBuildLinesV1(
	identity: WorkbenchRuntimeBuildIdentityV1 = WORKBENCH_RUNTIME_BUILD_IDENTITY,
): string[] {
	return [
		`extension build  : ${identity.build}`,
		`extension version: ${identity.version}`,
		`extension source : ${identity.source_hash}`,
	];
}

export function workbenchRuntimeBuildDetailsV1(
	identity: WorkbenchRuntimeBuildIdentityV1 = WORKBENCH_RUNTIME_BUILD_IDENTITY,
): Record<string, string | number> {
	return {
		extension_build_schema: identity.schema_version,
		extension_build: identity.build,
		extension_version: identity.version,
		extension_source_hash: identity.source_hash,
	};
}
