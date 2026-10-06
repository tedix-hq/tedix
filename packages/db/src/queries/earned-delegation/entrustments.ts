import { and, desc, eq, exists, inArray, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	competencyObservationAttestations,
	competencyObservations,
	delegationValueClaims,
	tediRoleAssignments,
} from "../../schema/earned-delegation";
import { workAttempts, workItems } from "../../schema/work-items";
import { chunkForBoundParams } from "../../utils/batch";
import { requireScopedTedi } from "./authority-policy";
import { evaluateDelegationYield } from "./delegation-yield";
import { evaluateValidatedExperience } from "./validated-experience";

type AttestationForEvaluation =
	typeof competencyObservationAttestations.$inferSelect;

export interface ActiveDelegationEntrustmentProjection {
	grantId: string;
	grantRevision: number;
	decisionId: string;
	activityId: string;
	activityVersion: number;
	expiresAt: string | null;
	level: string;
	tediId: string;
	taskFamily: string;
	riskLevel: string;
	actionPatterns: string[];
	activityToolIds: string[];
	scope: {
		actions: string[];
		toolIds: string[];
		environments: string[];
		spendPermission: "none" | "policy_bound";
		budgetPolicyId: string | null;
		constraints: Record<string, unknown>;
	};
}

/**
 * Load the currently usable earned-delegation grants without a join-shaped
 * result. RQB v2 gives every selected field a stable alias and expresses the
 * activity, decision, and optional role constraints as relation filters.
 */
export async function getActiveDelegationEntrustmentProjections(
	db: DbClient,
	input: { organizationId: string; tediIds: string[]; now: string },
): Promise<ActiveDelegationEntrustmentProjection[]> {
	if (input.tediIds.length === 0) return [];
	const rowBatches = await Promise.all(
		chunkForBoundParams([...new Set(input.tediIds)], 50).map((tediIds) =>
			db.query.tediEntrustmentGrants.findMany({
				columns: {
					id: true,
					tediId: true,
					revision: true,
					lastDecisionId: true,
					activityVersion: true,
					expiresAt: true,
					level: true,
					scope: true,
					roleAssignmentId: true,
				},
				where: {
					organizationId: input.organizationId,
					tediId: { in: tediIds },
					status: "active",
					activity: { status: "active" },
					lastDecision: { status: "applied" },
					AND: [
						{
							OR: [
								{ expiresAt: { isNull: true } },
								{ expiresAt: { gt: input.now } },
							],
						},
						{
							OR: [
								{ roleAssignmentId: { isNull: true } },
								{ roleAssignment: { status: "active" } },
							],
						},
					],
				},
				with: {
					activity: {
						columns: {
							id: true,
							version: true,
							taskFamily: true,
							riskLevel: true,
							actionPatterns: true,
							toolIds: true,
						},
					},
				},
			}),
		),
	);
	const rows = rowBatches.flat();
	return rows.flatMap((row) => {
		if (!row.activity || row.activity.version !== row.activityVersion)
			return [];
		if (row.level !== "autonomous" && row.level !== "delegate") return [];
		return [
			{
				grantId: row.id,
				grantRevision: row.revision,
				decisionId: row.lastDecisionId,
				activityId: row.activity.id,
				activityVersion: row.activityVersion,
				expiresAt: row.expiresAt,
				level: row.level,
				tediId: row.tediId,
				taskFamily: row.activity.taskFamily,
				riskLevel: row.activity.riskLevel,
				actionPatterns: row.activity.actionPatterns,
				activityToolIds: row.activity.toolIds,
				scope: row.scope,
			},
		];
	});
}

export async function getDelegationProfile(
	db: DbClient,
	input: { organizationId: string; tediId: string; now: string },
) {
	const observationScanLimit = 1_000;
	const attestationBatchSize = 50;
	await requireScopedTedi(db, input.organizationId, input.tediId);
	const [roles, grants, observationRows] = await Promise.all([
		db
			.select()
			.from(tediRoleAssignments)
			.where(
				and(
					eq(tediRoleAssignments.organizationId, input.organizationId),
					eq(tediRoleAssignments.tediId, input.tediId),
				),
			)
			.orderBy(desc(tediRoleAssignments.assignedAt)),
		// RQB nests grants under their activity and aliases every selected key, so
		// the two tables' shared id/status/json column names cannot collapse in D1.
		db.query.entrustableActivities
			.findMany({
				where: {
					entrustmentGrants: {
						organizationId: input.organizationId,
						tediId: input.tediId,
					},
				},
				with: {
					entrustmentGrants: {
						where: {
							organizationId: input.organizationId,
							tediId: input.tediId,
						},
					},
				},
				orderBy: { key: "asc" },
			})
			.then((activities) =>
				activities.flatMap(({ entrustmentGrants, ...activity }) =>
					entrustmentGrants.map((grant) => ({ grant, activity })),
				),
			),
		db
			.select()
			.from(competencyObservations)
			.where(
				and(
					eq(competencyObservations.organizationId, input.organizationId),
					eq(competencyObservations.tediId, input.tediId),
				),
			)
			.orderBy(
				desc(competencyObservations.occurredAt),
				desc(competencyObservations.createdAt),
				desc(competencyObservations.id),
			)
			.limit(observationScanLimit + 1),
	]);
	const truncated = observationRows.length > observationScanLimit;
	const observations = observationRows.slice(0, observationScanLimit);
	const observationIds = observations.map((observation) => observation.id);
	const valueClaimBatches = await Promise.all(
		Array.from(
			{ length: Math.ceil(observationIds.length / attestationBatchSize) },
			(_, batchIndex) =>
				db
					.select()
					.from(delegationValueClaims)
					.where(
						and(
							eq(delegationValueClaims.organizationId, input.organizationId),
							eq(delegationValueClaims.tediId, input.tediId),
							inArray(
								delegationValueClaims.observationId,
								observationIds.slice(
									batchIndex * attestationBatchSize,
									(batchIndex + 1) * attestationBatchSize,
								),
							),
						),
					),
		),
	);
	const valueClaims = valueClaimBatches.flat();
	// Construct the issued-work denominator from every bounded observation, not
	// from the optional value ledger. Starting with claims would let an omitted
	// claim make failed, costly, or merely unvalued work disappear from coverage.
	const referencedWorkItemIds = [
		...new Set(
			observations.flatMap((observation) =>
				observation.workItemId ? [observation.workItemId] : [],
			),
		),
	];
	const verifiedIssuedWorkItemBatches = await Promise.all(
		Array.from(
			{
				length: Math.ceil(referencedWorkItemIds.length / attestationBatchSize),
			},
			(_, batchIndex) =>
				db
					.select({ id: workItems.id })
					.from(workItems)
					.where(
						and(
							eq(workItems.orgId, input.organizationId),
							eq(workItems.disposition, "completed"),
							sql`${workItems.completedAt} IS NOT NULL`,
							sql`NULLIF(TRIM(CAST(json_extract(${workItems.metadata}, '$.proofCertifiedAt') AS TEXT)), '') = ${workItems.completedAt}`,
							or(
								exists(
									db
										.select({ id: workAttempts.id })
										.from(workAttempts)
										.where(
											and(
												eq(workAttempts.orgId, input.organizationId),
												eq(workAttempts.workItemId, workItems.id),
												eq(workAttempts.executorType, "tedi"),
												eq(workAttempts.executorId, input.tediId),
												eq(workAttempts.runtimeState, "finished"),
												eq(workAttempts.finishedAt, workItems.completedAt),
											),
										),
								),
								exists(
									db
										.select({ id: workAttempts.id })
										.from(workAttempts)
										.where(
											and(
												eq(workAttempts.orgId, input.organizationId),
												eq(workAttempts.workItemId, workItems.id),
												eq(workAttempts.executorId, input.tediId),
												eq(workAttempts.runtimeState, "finished"),
												eq(workAttempts.finishedAt, workItems.completedAt),
											),
										),
								),
							),
							inArray(
								workItems.id,
								referencedWorkItemIds.slice(
									batchIndex * attestationBatchSize,
									(batchIndex + 1) * attestationBatchSize,
								),
							),
						),
					),
		),
	);
	const verifiedIssuedWorkItems = verifiedIssuedWorkItemBatches.flat();
	const attestationBatches: AttestationForEvaluation[][] = [];
	for (
		let offset = 0;
		offset < observationIds.length;
		offset += attestationBatchSize
	) {
		attestationBatches.push(
			await db
				.select()
				.from(competencyObservationAttestations)
				.where(
					and(
						eq(
							competencyObservationAttestations.organizationId,
							input.organizationId,
						),
						inArray(
							competencyObservationAttestations.observationId,
							observationIds.slice(offset, offset + attestationBatchSize),
						),
					),
				),
		);
	}
	const attestations =
		attestationBatches.length === 0 ? [] : attestationBatches.flat();
	return {
		tediId: input.tediId,
		activeRole: roles.find((role) => role.status === "active") ?? null,
		roleHistory: roles,
		validatedExperience: evaluateValidatedExperience({
			observations,
			attestations,
			truncated,
		}),
		delegationYield: evaluateDelegationYield({
			observations,
			attestations,
			valueClaims,
			verifiedIssuedWorkItemIds: new Set(
				verifiedIssuedWorkItems.map((workItem) => workItem.id),
			),
			truncated,
		}),
		entrustments: grants.map(({ grant, activity }) => ({
			...grant,
			effectiveStatus:
				grant.status === "active" &&
				(!grant.expiresAt || grant.expiresAt > input.now)
					? ("active" as const)
					: grant.status === "active"
						? ("expired" as const)
						: grant.status,
			activity,
		})),
	};
}
