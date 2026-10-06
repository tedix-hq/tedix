import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	competencyObservations,
	entrustableActivities,
} from "../../schema/earned-delegation";
import { harnessEvalRuns } from "../../schema/harness-versions";
import { workItems } from "../../schema/work-items";
import { attestCompetencyObservation } from "./attestations";
import { EarnedDelegationError } from "./authority-policy";

export const EARNED_DELEGATION_PROOF_CERTIFIER_ID =
	"earned-delegation-proof-certifier:v1";

/**
 * Independently certify one observation from canonical server-owned surfaces.
 *
 * The caller cannot choose the verdict. This verifier cross-checks both the
 * immutable harness run and the proof-gated terminal Work Item. It is a
 * versioned certification-service principal, so changing the algorithm
 * requires a new principal id and makes the evidence transition explicit.
 */
export async function certifyCompetencyObservation(
	db: DbClient,
	input: {
		organizationId: string;
		observationId: string;
		now: string;
	},
) {
	const [observation] = await db
		.select()
		.from(competencyObservations)
		.where(
			and(
				eq(competencyObservations.id, input.observationId),
				eq(competencyObservations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!observation) {
		throw new EarnedDelegationError("not_found", "Observation not found");
	}

	const [runs, activities, scopedWorkItems] = await Promise.all([
		observation.evaluationRunId
			? db
					.select()
					.from(harnessEvalRuns)
					.where(
						and(
							eq(harnessEvalRuns.id, observation.evaluationRunId),
							eq(harnessEvalRuns.tediId, observation.tediId),
						),
					)
					.limit(1)
			: Promise.resolve([]),
		db
			.select()
			.from(entrustableActivities)
			.where(
				and(
					eq(entrustableActivities.id, observation.activityId),
					eq(entrustableActivities.status, "active"),
				),
			)
			.limit(1),
		observation.workItemId
			? db
					.select({
						id: workItems.id,
						status: workItems.disposition,
						metadata: workItems.metadata,
						completedAt: workItems.completedAt,
					})
					.from(workItems)
					.where(
						and(
							eq(workItems.id, observation.workItemId),
							eq(workItems.orgId, input.organizationId),
						),
					)
					.limit(1)
			: Promise.resolve([]),
	]);
	const run = runs[0];
	const activity = activities[0];
	const workItem = scopedWorkItems[0];
	const runMetadata = run?.metadata ?? {};
	const workMetadata = workItem?.metadata ?? {};
	const pilotMetadata =
		workMetadata.earnedDelegationPilot &&
		typeof workMetadata.earnedDelegationPilot === "object" &&
		!Array.isArray(workMetadata.earnedDelegationPilot)
			? (workMetadata.earnedDelegationPilot as Record<string, unknown>)
			: null;
	const canonicalHarnessEvidence = Boolean(
		run &&
		activity &&
		(run.orgId === input.organizationId || run.orgId === null) &&
		run.id === observation.sourceId &&
		run.id === observation.evaluationRunId &&
		observation.sourceKind === "harness_eval_run" &&
		observation.proofVerifiedAt === run.createdAt &&
		observation.rubricVersion === activity.version &&
		observation.outcome === "success" &&
		observation.eligibilityStatus === "eligible" &&
		observation.nonTrivial &&
		observation.heldOut &&
		run.total > 0 &&
		run.failed === 0 &&
		run.eligible &&
		["locked-test", "canary"].includes(run.lane) &&
		runMetadata.trustedForEarnedDelegation === true &&
		runMetadata.earnedDelegationActivityId === activity.id &&
		runMetadata.earnedDelegationActivityVersion === activity.version &&
		runMetadata.earnedDelegationRubricHash === activity.rubricHash,
	);
	const expectedChildRunId =
		typeof workMetadata.childRunId === "string"
			? workMetadata.childRunId
			: null;
	const proofGatedWorkItem = Boolean(
		workItem &&
		workItem.status === "completed" &&
		workItem.completedAt &&
		workMetadata.proofCertifiedAt === workItem.completedAt &&
		workMetadata.hasProof === true &&
		workMetadata.evidenceState === "verified" &&
		workMetadata.childRunStatus === "completed" &&
		typeof workMetadata.delegatedTediId === "string" &&
		workMetadata.delegatedTediId === observation.tediId &&
		expectedChildRunId &&
		workMetadata.proof === `child-run:${expectedChildRunId}` &&
		pilotMetadata?.activityId === activity?.id &&
		pilotMetadata?.activityVersion === activity?.version &&
		pilotMetadata?.heldOut === true &&
		pilotMetadata?.environment === observation.environment,
	);
	const checks = { canonicalHarnessEvidence, proofGatedWorkItem };
	const attestation = await attestCompetencyObservation(db, {
		organizationId: input.organizationId,
		observationId: input.observationId,
		principalType: "certification_service",
		principalId: EARNED_DELEGATION_PROOF_CERTIFIER_ID,
		verdict:
			canonicalHarnessEvidence && proofGatedWorkItem ? "supports" : "rejects",
		verificationMethod: "canonical-harness-plus-proof-gated-work-item:v1",
		authenticatedAt: input.now,
		now: input.now,
	});
	return { attestation, checks };
}
