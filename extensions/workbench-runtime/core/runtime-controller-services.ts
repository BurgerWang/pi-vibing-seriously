/** Concrete runtime adapters for public tool controllers. */

import { compareRuns } from "./compare.ts";
import { completeDefaultDelegationDeliveryV2 } from "./delegation-default-delivery.ts";
import { acquireProjectDelegationStartLockV1, releaseProjectDelegationStartLockV1 } from "./delegation-start-lock.ts";
import { executeDelegationV2 } from "./delegation-execution-v2.ts";
import { makeDelegationId, readDelegationLedger } from "./delegation-ledger.ts";
import { reviewDelegationV2 } from "./delegation-review-v2.ts";
import { readDelegationCommittedGenerationV2 } from "./delegation-transaction-storage.ts";
import { reviewDelegation } from "./diff-review.ts";
import {
	collectCurrentDelegationBindingV2,
	readRecoverableUnpublishedDelegationV2,
	reconcileProjectDelegationAuthorityV2,
} from "./delegation-project-authority.ts";
import { recoverReceipt } from "./tool-result-recovery.ts";
import { buildTrustedRecoveryAuthority } from "./trusted-recovery-authority.ts";
import type { CompareToolServices } from "./compare-tool-controller.ts";
import type { DelegateToolServices } from "./delegate-tool-controller.ts";
import type { RecoveryToolServices } from "./recovery-tool-controller.ts";
import type { ReviewToolServices } from "./review-tool-controller.ts";
import type { DelegationSessionServices } from "./delegation-session-controller.ts";

const now = (): Date => new Date();

const compare = Object.freeze({ compareRuns, buildTrustedRecoveryAuthority }) satisfies CompareToolServices;
const delegate = Object.freeze({
	now,
	makeDelegationId,
	acquireStartLock: acquireProjectDelegationStartLockV1,
	releaseStartLock: releaseProjectDelegationStartLockV1,
	readCommittedGeneration: readDelegationCommittedGenerationV2,
	readRecoverableUnpublished: readRecoverableUnpublishedDelegationV2,
	readLegacyLedger: readDelegationLedger,
	executeDelegation: executeDelegationV2,
	completeDefaultDelivery: completeDefaultDelegationDeliveryV2,
	buildTrustedRecoveryAuthority,
}) satisfies DelegateToolServices;
const review = Object.freeze({
	now,
	readCommittedGeneration: readDelegationCommittedGenerationV2,
	readRecoverableUnpublished: readRecoverableUnpublishedDelegationV2,
	reviewV2: reviewDelegationV2,
	reviewLegacy: reviewDelegation,
}) satisfies ReviewToolServices;
const recovery = Object.freeze({ recoverReceipt }) satisfies RecoveryToolServices;
const delegationSession = Object.freeze({
	collectCurrentBinding: collectCurrentDelegationBindingV2,
	reconcileProjectAuthority: reconcileProjectDelegationAuthorityV2,
}) satisfies DelegationSessionServices;

/** Immutable production dependency bundle; tests inject bounded alternatives. */
export const RUNTIME_CONTROLLER_SERVICES = Object.freeze({ compare, delegate, review, recovery, delegationSession });
