/** Stable extension-build identity and delegation-status exposure. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { projectToolResultDetails } from "../extensions/workbench-runtime/core/details-projection.ts";
import { registerDelegationStatusTool } from "../extensions/workbench-runtime/core/delegation-status-tool-controller.ts";
import {
	WORKBENCH_RUNTIME_BUILD_IDENTITY,
	doctorWorkbenchRuntimeBuildV1,
	hashWorkbenchRuntimeSourcesV1,
	workbenchRuntimeDoctorLinesV1,
	workbenchRuntimeMutationBlockReasonV1,
} from "../extensions/workbench-runtime/core/runtime-build-identity.ts";

interface RuntimeResult {
	content: Array<{ type: string; text?: string }>;
	details: Record<string, unknown>;
}

interface RuntimeTool {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<RuntimeResult>;
}

function statusTool(trustError?: string): RuntimeTool {
	let tool: RuntimeTool | undefined;
	registerDelegationStatusTool({
		pi: {
			registerTool(definition: unknown) { tool = definition as RuntimeTool; },
		} as never,
		trustedOrError: () => trustError,
		projectRootFor: async () => "/project",
		syncLease: () => {},
		delegationStatusLines: async () => ({ lines: ["latest       : (no delegation)"], gitRefresh: "fresh" }),
	});
	assert.ok(tool);
	return tool;
}

function context(): ExtensionContext {
	return {
		cwd: "/project",
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
}

function textOf(result: RuntimeResult): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

test("runtime source hashing is deterministic, order independent, and byte sensitive", () => {
	const first = { path: "core/a.ts", bytes: Buffer.from("export const a = 1;\n") };
	const second = { path: "worker/b.ts", bytes: Buffer.from("export const b = 2;\n") };
	assert.equal(hashWorkbenchRuntimeSourcesV1([first, second]), hashWorkbenchRuntimeSourcesV1([second, first]));
	assert.notEqual(
		hashWorkbenchRuntimeSourcesV1([first, second]),
		hashWorkbenchRuntimeSourcesV1([first, { ...second, bytes: Buffer.from("export const b = 3;\n") }]),
	);
});

test("runtime doctor compares the immutable load snapshot with the current source tree", () => {
	const doctor = doctorWorkbenchRuntimeBuildV1();
	assert.equal(doctor.status, "CURRENT");
	assert.deepEqual(doctor.loaded, WORKBENCH_RUNTIME_BUILD_IDENTITY);
	assert.equal(doctor.disk.source_hash, WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash);
	assert.match(workbenchRuntimeDoctorLinesV1(doctor).join("\n"), /write readiness\s+: this session is running the current on-disk workbench source/);

	const stale = {
		...doctor,
		status: "STALE" as const,
		disk: { ...doctor.disk, source_hash: `sha256:${"0".repeat(64)}` },
	};
	assert.match(workbenchRuntimeDoctorLinesV1(stale).join("\n"), /run \/reload/);
	assert.match(workbenchRuntimeMutationBlockReasonV1("workbench_delegate_worker", stale) ?? "", /runtime is stale/);
	assert.match(workbenchRuntimeMutationBlockReasonV1("workbench_repair_delegation", stale) ?? "", /runtime is stale/);
	assert.match(workbenchRuntimeMutationBlockReasonV1("third_party_unknown_writer", stale) ?? "", /runtime is stale/);
	assert.match(workbenchRuntimeMutationBlockReasonV1(undefined, stale) ?? "", /runtime is stale/);
	assert.equal(workbenchRuntimeMutationBlockReasonV1("workbench_delegation_status", stale), undefined);
	assert.equal(workbenchRuntimeMutationBlockReasonV1("workbench_delegate_worker", doctor), undefined);
});

test("delegation status exposes the same stable build identity in text and structured details", async () => {
	const result = await statusTool().execute("status", {}, undefined, undefined, context());
	const text = textOf(result);
	assert.match(text, new RegExp(`^extension build  : ${WORKBENCH_RUNTIME_BUILD_IDENTITY.build.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
	assert.match(text, new RegExp(`^extension version: ${WORKBENCH_RUNTIME_BUILD_IDENTITY.version}$`, "m"));
	assert.match(text, new RegExp(`^extension source : ${WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash}$`, "m"));
	assert.equal(result.details.extension_build_schema, 1);
	assert.equal(result.details.extension_build, WORKBENCH_RUNTIME_BUILD_IDENTITY.build);
	assert.equal(result.details.extension_version, WORKBENCH_RUNTIME_BUILD_IDENTITY.version);
	assert.equal(result.details.extension_source_hash, WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash);
	assert.match(String(result.details.extension_source_hash), /^sha256:[0-9a-f]{64}$/);

	const projected = projectToolResultDetails({
		toolName: "workbench_delegation_status",
		details: result.details,
		envelope: {
			schema: "workbench-output-v1",
			policy: "default",
			truncated: false,
			originalTextBytes: 0,
			originalTextLines: 0,
			shownTextBytes: 0,
			shownTextLines: 0,
			omittedTextBytes: 0,
			omittedTextLines: 0,
			originalImageCount: 0,
			shownImageCount: 0,
			omittedImageCount: 0,
			reason: "none",
		},
	});
	assert.equal((projected.details as Record<string, unknown>).extension_build, WORKBENCH_RUNTIME_BUILD_IDENTITY.build);
	assert.equal((projected.details as Record<string, unknown>).extension_source_hash, WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash);
});

test("untrusted status still reports runtime identity for reload diagnosis", async () => {
	const result = await statusTool("untrusted project").execute("status", {}, undefined, undefined, context());
	assert.match(textOf(result), /workbench_delegation_status: untrusted project/);
	assert.equal(result.details.extension_build, WORKBENCH_RUNTIME_BUILD_IDENTITY.build);
	assert.equal(result.details.extension_source_hash, WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash);
});

test("four independently loaded runtimes converge on one fingerprint after reload", async () => {
	const moduleUrl = new URL("../extensions/workbench-runtime/core/runtime-build-identity.ts", import.meta.url).href;
	// Query-separated ESM instances model four live Pi extension loaders without
	// depending on nested child-process execution (which is unavailable in the
	// repository test sandbox). Each instance recomputes its immutable snapshot.
	const loads = await Promise.all(Array.from({ length: 4 }, (_, index) => import(`${moduleUrl}?reload-session=${index}`)));
	const identities = loads.map((loaded) => loaded.WORKBENCH_RUNTIME_BUILD_IDENTITY as Record<string, unknown>);
	for (const identity of identities) assert.deepEqual(identity, identities[0]);
	assert.deepEqual(identities[0], WORKBENCH_RUNTIME_BUILD_IDENTITY);
});
