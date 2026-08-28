/** Pure WP5 Candidate identity derived only from existing committed run facts. */

import { canonicalHash } from "../cache/canonical-hash.ts";
import type { ArtifactManifestV2 } from "./artifact-contract.ts";
import { WORKBENCH_RUNTIME_BUILD_IDENTITY } from "./runtime-build-identity.ts";
import type { RunRecord, RunRuntimeIdentityV1 } from "./runs.ts";
import { VALIDATION_COMPONENTS } from "./recipe-schema.ts";
import {
	validationEvidenceIdentity,
	validationEvidenceSourceEligible,
} from "./validation-evidence.ts";

export interface OrdinaryCandidateProjectionV1 {
	schemaVersion: 1;
	status: "VERIFIED";
	candidateIdentity: string;
	validationIdentity: string;
	artifactManifestIdentity: string;
	runtimeIdentityHash: string;
	sourceRunId: string;
	authorityScope: "DEVELOPMENT_ONLY";
}

export {
	candidateVersionPathV1,
	gateCandidateSourceAuthorityV1,
	parseGateCandidateBindingV1,
	type GateCandidateBindingV1,
} from "./candidate-binding.ts";

export function currentRunRuntimeIdentityV1(): RunRuntimeIdentityV1 {
	return {
		schema_version: 1,
		kind: "workbench-run-runtime-v1",
		workbench_version: WORKBENCH_RUNTIME_BUILD_IDENTITY.version,
		workbench_build: WORKBENCH_RUNTIME_BUILD_IDENTITY.build,
		workbench_source_hash: WORKBENCH_RUNTIME_BUILD_IDENTITY.source_hash,
		node_version: process.version,
		platform: process.platform,
		architecture: process.arch,
	};
}

export function runRuntimeIdentityIsCurrentV1(value: RunRecord["runtime_identity"]): value is RunRuntimeIdentityV1 {
	const current = currentRunRuntimeIdentityV1();
	return value !== undefined && value.schema_version === current.schema_version && value.kind === current.kind &&
		value.workbench_version === current.workbench_version && value.workbench_build === current.workbench_build &&
		value.workbench_source_hash === current.workbench_source_hash && value.node_version === current.node_version &&
		value.platform === current.platform && value.architecture === current.architecture;
}

/** Complete ordinary final-check source; focused or Gate runs never qualify. */
export function isOrdinaryCandidateSourceRunV1(record: RunRecord): boolean {
	return record.recipe !== "gate" && record.mode === "DEV" && record.run_outcome === "SUCCESS" &&
		record.declared_writes.length === 0 &&
		record.validation_components.length === VALIDATION_COMPONENTS.length &&
		VALIDATION_COMPONENTS.every((component) => record.validation_components.includes(component)) &&
		runRuntimeIdentityIsCurrentV1(record.runtime_identity) &&
		typeof record.argv_hash === "string" &&
		validationEvidenceSourceEligible(record.validation_evidence, {
			recipe: record.recipe,
			argvHash: record.argv_hash,
		});
}

export function ordinaryCandidateProjectionFromRunV1(
	record: RunRecord,
	artifactManifest: ArtifactManifestV2,
): OrdinaryCandidateProjectionV1 | undefined {
	if (!isOrdinaryCandidateSourceRunV1(record) || artifactManifest.run_id !== record.run_id || artifactManifest.status === "INVALID") {
		return undefined;
	}
	const validationIdentity = validationEvidenceIdentity(record.validation_evidence);
	if (validationIdentity === null) return undefined;
	const artifactManifestIdentity = canonicalHash(artifactManifest);
	const runtimeIdentity = record.runtime_identity!;
	const runtimeIdentityHash = canonicalHash(runtimeIdentity);
	return {
		schemaVersion: 1,
		status: "VERIFIED",
		candidateIdentity: canonicalHash({
			schema_version: 1,
			kind: "ordinary-development-candidate-v1",
			validation_identity: validationIdentity,
			artifact_manifest_identity: artifactManifestIdentity,
			runtime_identity: runtimeIdentity,
		}),
		validationIdentity,
		artifactManifestIdentity,
		runtimeIdentityHash,
		sourceRunId: record.run_id,
		authorityScope: "DEVELOPMENT_ONLY",
	};
}
