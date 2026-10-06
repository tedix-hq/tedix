import type {
	EntrustmentLevel,
	EntrustmentScope,
} from "@tedix/api-contract/schemas/earned-delegation";
import {
	and,
	eq,
	exists,
	gt,
	inArray,
	isNull,
	lte,
	notExists,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	earnedDelegationEvidenceRevisions,
	entrustableActivities,
	promotionDecisionObservations,
	promotionDecisions,
	tediEntrustmentGrants,
	tediRoleAssignments,
} from "../../schema/earned-delegation";
import {
	assertScopeWithinActivity,
	CAREER_POLICY,
	CAREER_STAGES,
	type DecisionKind,
	EarnedDelegationError,
	ENTRUSTMENT_LEVEL_ORDER,
	hashSnapshot,
} from "./authority-policy";
import type { PromotionReadiness } from "./promotion-readiness";
import { loadPromotionReadiness } from "./promotion-readiness-store";

function isPositiveDecision(kind: DecisionKind): boolean {
	return ["promote", "grant", "raise", "recertify", "reinstate"].includes(kind);
}

export async function decidePromotionProposal(
	db: DbClient,
	input: {
		organizationId: string;
		decisionId: string;
		approved: boolean;
		decidedByType: "user" | "api_key" | "certification_service";
		decidedById: string;
		reason?: string | null;
		now: string;
	},
	testHooks?: { beforeApplicationBatch?: () => void | Promise<void> },
) {
	const decisions = await db
		.select()
		.from(promotionDecisions)
		.where(
			and(
				eq(promotionDecisions.id, input.decisionId),
				eq(promotionDecisions.organizationId, input.organizationId),
			),
		)
		.limit(1);
	const decision = decisions[0];
	if (!decision)
		throw new EarnedDelegationError(
			"not_found",
			"Promotion decision not found",
		);
	if (decision.status === "applied" && input.approved) return decision;
	const resumingReservation =
		input.approved &&
		decision.status === "approved" &&
		decision.decidedByType === input.decidedByType &&
		decision.decidedById === input.decidedById;
	const cancelApprovedReservation = async (reason: string) => {
		await db
			.update(promotionDecisions)
			.set({ status: "cancelled", reason, updatedAt: input.now })
			.where(
				and(
					eq(promotionDecisions.id, decision.id),
					eq(promotionDecisions.status, "approved"),
					eq(promotionDecisions.decidedByType, input.decidedByType),
					eq(promotionDecisions.decidedById, input.decidedById),
				),
			);
	};
	if (decision.status !== "proposed" && !resumingReservation)
		throw new EarnedDelegationError(
			"conflict",
			`Decision is already ${decision.status}`,
		);
	if (decision.proposalExpiresAt <= input.now) {
		if (resumingReservation)
			await cancelApprovedReservation(
				"Approved reservation expired before authority application",
			);
		throw new EarnedDelegationError(
			"expired",
			"Promotion proposal has expired",
		);
	}
	if (
		decision.proposedByType === input.decidedByType &&
		decision.proposedById === input.decidedById
	) {
		throw new EarnedDelegationError(
			"untrusted_authority",
			"The proposal author cannot dispose its own decision",
		);
	}
	if (!input.approved) {
		const rejected = await db
			.update(promotionDecisions)
			.set({
				status: "rejected",
				decidedByType: input.decidedByType,
				decidedById: input.decidedById,
				reason: input.reason ?? decision.reason,
				decidedAt: input.now,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(promotionDecisions.id, decision.id),
					eq(promotionDecisions.status, "proposed"),
					gt(promotionDecisions.proposalExpiresAt, input.now),
				),
			)
			.returning();
		if (!rejected[0])
			throw new EarnedDelegationError(
				"conflict",
				"Decision was settled concurrently",
			);
		return rejected[0];
	}

	const positive = isPositiveDecision(decision.kind);
	let activity: typeof entrustableActivities.$inferSelect | null = null;
	let readiness: PromotionReadiness | null = null;
	let evidenceRevision: number | null = null;
	try {
		if (decision.activityId) {
			const activities = await db
				.select()
				.from(entrustableActivities)
				.where(
					and(
						eq(entrustableActivities.id, decision.activityId),
						eq(entrustableActivities.status, "active"),
						or(
							eq(entrustableActivities.organizationId, input.organizationId),
							isNull(entrustableActivities.organizationId),
						),
					),
				)
				.limit(1);
			activity = activities[0] ?? null;
			if (!activity)
				throw new EarnedDelegationError(
					"conflict",
					"Entrustable activity is no longer active",
				);
		}
		if (positive) {
			if (activity) {
				const requestedRank = decision.toEntrustmentLevel
					? ENTRUSTMENT_LEVEL_ORDER.indexOf(decision.toEntrustmentLevel)
					: -1;
				if (
					requestedRank < 0 ||
					requestedRank >
						ENTRUSTMENT_LEVEL_ORDER.indexOf(activity.maximumLevel) ||
					!decision.targetScope ||
					!decision.targetExpiresAt ||
					!decision.targetNextReviewAt ||
					decision.targetExpiresAt <= input.now ||
					decision.targetNextReviewAt <= input.now ||
					decision.targetNextReviewAt > decision.targetExpiresAt
				) {
					throw new EarnedDelegationError(
						"invalid_transition",
						"Proposed authority no longer satisfies the activity ceiling or validity window",
					);
				}
				assertScopeWithinActivity(decision.targetScope, activity);
				if (
					decision.evidenceSnapshot.activityVersion !== activity.version ||
					decision.evidenceSnapshot.rubricHash !== activity.rubricHash ||
					decision.evidenceSnapshot.evidencePolicyHash !==
						activity.evidencePolicyHash
				) {
					throw new EarnedDelegationError(
						"conflict",
						"The activity rubric or evidence policy changed after proposal",
					);
				}
			}
			const policy = activity?.evidencePolicy ?? {
				...CAREER_POLICY,
				requireLearningTransfer:
					decision.toCareerStage != null &&
					CAREER_STAGES.indexOf(decision.toCareerStage) >=
						CAREER_STAGES.indexOf("lead"),
			};
			const readinessSnapshot = await loadPromotionReadiness(db, {
				organizationId: input.organizationId,
				tediId: decision.tediId,
				activityId: activity?.id ?? null,
				policy,
				requiredEnvironments: decision.targetScope?.environments,
				now: input.now,
			});
			readiness = readinessSnapshot.readiness;
			evidenceRevision = readinessSnapshot.evidenceRevision;
			if (!readiness.eligible)
				throw new EarnedDelegationError(
					"ineligible",
					`Promotion evidence regressed: ${readiness.reasons.join("; ")}`,
				);
			const linked = await db
				.select({ observationId: promotionDecisionObservations.observationId })
				.from(promotionDecisionObservations)
				.where(
					and(
						eq(
							promotionDecisionObservations.organizationId,
							input.organizationId,
						),
						eq(promotionDecisionObservations.decisionId, decision.id),
					),
				);
			const currentEligible = new Set(readiness.eligibleObservationIds);
			if (
				linked.length === 0 ||
				linked.some((edge) => !currentEligible.has(edge.observationId))
			) {
				throw new EarnedDelegationError(
					"ineligible",
					"Canonical proposal evidence is no longer eligible",
				);
			}
		}
	} catch (error) {
		if (resumingReservation && error instanceof EarnedDelegationError) {
			await cancelApprovedReservation(
				`Approved reservation failed revalidation: ${error.message}`,
			);
		}
		throw error;
	}
	const evidenceRevisionFence: SQL<unknown> =
		evidenceRevision == null
			? sql`1 = 1`
			: evidenceRevision === 0
				? notExists(
						db
							.select({ one: sql`1` })
							.from(earnedDelegationEvidenceRevisions)
							.where(
								and(
									eq(
										earnedDelegationEvidenceRevisions.organizationId,
										input.organizationId,
									),
									eq(earnedDelegationEvidenceRevisions.tediId, decision.tediId),
								),
							),
					)
				: exists(
						db
							.select({ one: sql`1` })
							.from(earnedDelegationEvidenceRevisions)
							.where(
								and(
									eq(
										earnedDelegationEvidenceRevisions.organizationId,
										input.organizationId,
									),
									eq(earnedDelegationEvidenceRevisions.tediId, decision.tediId),
									eq(
										earnedDelegationEvidenceRevisions.revision,
										evidenceRevision,
									),
								),
							),
					);
	const activityRevisionFence: SQL<unknown> = activity
		? exists(
				db
					.select({ one: sql`1` })
					.from(entrustableActivities)
					.where(
						and(
							eq(entrustableActivities.id, activity.id),
							eq(entrustableActivities.status, "active"),
							eq(entrustableActivities.version, activity.version),
							eq(entrustableActivities.rubricHash, activity.rubricHash),
							eq(
								entrustableActivities.evidencePolicyHash,
								activity.evidencePolicyHash,
							),
						),
					),
			)
		: sql`1 = 1`;
	const settlementRevisionFence = and(
		evidenceRevisionFence,
		activityRevisionFence,
	)!;
	const evidenceSnapshot = {
		...decision.evidenceSnapshot,
		appliedReadiness: readiness,
		appliedEvidenceRevision: evidenceRevision,
		appliedAt: input.now,
	};
	const evidenceSnapshotHash = await hashSnapshot(evidenceSnapshot);

	if (!resumingReservation) {
		const latch = await db
			.update(promotionDecisions)
			.set({
				status: "approved",
				decidedByType: input.decidedByType,
				decidedById: input.decidedById,
				reason: input.reason ?? decision.reason,
				decidedAt: input.now,
				updatedAt: input.now,
				evidenceSnapshot,
			})
			.where(
				and(
					eq(promotionDecisions.id, decision.id),
					eq(promotionDecisions.status, "proposed"),
					gt(promotionDecisions.proposalExpiresAt, input.now),
				),
			)
			.returning({ id: promotionDecisions.id });
		if (!latch[0])
			throw new EarnedDelegationError(
				"conflict",
				"Decision was settled concurrently",
			);
	}

	const appliedDecision = (targetAppliedCondition: SQL<unknown>) =>
		db
			.update(promotionDecisions)
			.set({
				status: "applied",
				appliedAt: input.now,
				updatedAt: input.now,
				evidenceSnapshot,
			})
			.where(
				and(
					eq(promotionDecisions.id, decision.id),
					eq(promotionDecisions.status, "approved"),
					eq(promotionDecisions.decidedByType, input.decidedByType),
					eq(promotionDecisions.decidedById, input.decidedById),
					settlementRevisionFence,
					targetAppliedCondition,
				),
			)
			.returning();

	let changed: { id: string }[] = [];
	let applied: (typeof promotionDecisions.$inferSelect)[] = [];
	const cancelReservation = async () => {
		await cancelApprovedReservation(
			"Application revision fence failed; no authority was changed",
		);
	};
	try {
		await testHooks?.beforeApplicationBatch?.();
		if (decision.kind === "role_change") {
			if (
				!decision.roleAssignmentId ||
				!decision.targetRoleKey ||
				!decision.targetRoleName ||
				decision.expectedRoleRevision == null
			) {
				throw new EarnedDelegationError(
					"invalid_transition",
					"Role change is missing its target or revision fence",
				);
			}
			const endCurrent = db
				.update(tediRoleAssignments)
				.set({
					status: "ended",
					endedAt: input.now,
					revision: decision.expectedRoleRevision + 1,
					lastDecisionId: decision.id,
					evidenceSnapshotHash,
					updatedAt: input.now,
				})
				.where(
					and(
						eq(tediRoleAssignments.id, decision.roleAssignmentId),
						eq(tediRoleAssignments.organizationId, input.organizationId),
						eq(tediRoleAssignments.tediId, decision.tediId),
						eq(tediRoleAssignments.status, "active"),
						eq(tediRoleAssignments.revision, decision.expectedRoleRevision),
					)!,
				)
				.returning({ id: tediRoleAssignments.id });
			const newAssignmentId = crypto.randomUUID();
			const revokeRoleBoundGrants = db
				.update(tediEntrustmentGrants)
				.set({
					status: "revoked",
					restrictedAt: input.now,
					reason: `Role assignment changed by decision ${decision.id}`,
					revision: sql`${tediEntrustmentGrants.revision} + 1`,
					lastDecisionId: decision.id,
					updatedAt: input.now,
				})
				.where(
					and(
						eq(tediEntrustmentGrants.organizationId, input.organizationId),
						eq(tediEntrustmentGrants.tediId, decision.tediId),
						eq(
							tediEntrustmentGrants.roleAssignmentId,
							decision.roleAssignmentId,
						),
						inArray(tediEntrustmentGrants.status, [
							"active",
							"restricted",
							"expired",
						]),
					),
				);
			const createTarget = db
				.insert(tediRoleAssignments)
				.values({
					id: newAssignmentId,
					organizationId: input.organizationId,
					tediId: decision.tediId,
					roleTemplateId: decision.targetRoleTemplateId,
					roleKey: decision.targetRoleKey,
					roleName: decision.targetRoleName,
					status: "active",
					careerStage: "shadow",
					assignedAt: input.now,
					stageChangedAt: input.now,
					endedAt: null,
					revision: 1,
					lastDecisionId: decision.id,
					evidenceSnapshotHash,
					metadata: { previousRoleAssignmentId: decision.roleAssignmentId },
					createdAt: input.now,
					updatedAt: input.now,
				})
				.returning({ id: tediRoleAssignments.id });
			let ended: { id: string }[];
			[ended, , changed, applied] = await db.batch([
				endCurrent,
				revokeRoleBoundGrants,
				createTarget,
				appliedDecision(
					and(
						exists(
							db
								.select({ one: sql`1` })
								.from(tediRoleAssignments)
								.where(
									and(
										eq(tediRoleAssignments.id, newAssignmentId),
										eq(tediRoleAssignments.status, "active"),
										eq(tediRoleAssignments.lastDecisionId, decision.id),
									),
								),
						),
						notExists(
							db
								.select({ one: sql`1` })
								.from(tediEntrustmentGrants)
								.where(
									and(
										eq(
											tediEntrustmentGrants.roleAssignmentId,
											decision.roleAssignmentId,
										),
										inArray(tediEntrustmentGrants.status, [
											"active",
											"restricted",
											"expired",
										]),
									),
								),
						),
					)!,
				),
			]);
			if (!ended[0]) changed = [];
		} else if (decision.kind === "promote" || decision.kind === "demote") {
			if (
				!decision.roleAssignmentId ||
				!decision.fromCareerStage ||
				!decision.toCareerStage ||
				decision.expectedRoleRevision == null
			)
				throw new EarnedDelegationError(
					"invalid_transition",
					"Career decision is missing its revision fence",
				);
			const targetChange = db
				.update(tediRoleAssignments)
				.set({
					careerStage: decision.toCareerStage,
					stageChangedAt: input.now,
					revision: decision.expectedRoleRevision + 1,
					lastDecisionId: decision.id,
					evidenceSnapshotHash,
					updatedAt: input.now,
				})
				.where(
					and(
						eq(tediRoleAssignments.id, decision.roleAssignmentId),
						eq(tediRoleAssignments.organizationId, input.organizationId),
						eq(tediRoleAssignments.tediId, decision.tediId),
						eq(tediRoleAssignments.status, "active"),
						eq(tediRoleAssignments.revision, decision.expectedRoleRevision),
						eq(tediRoleAssignments.careerStage, decision.fromCareerStage),
						decision.kind === "promote" ? settlementRevisionFence : sql`1 = 1`,
					),
				)
				.returning({ id: tediRoleAssignments.id });
			[changed, applied] = await db.batch([
				targetChange,
				appliedDecision(
					exists(
						db
							.select({ one: sql`1` })
							.from(tediRoleAssignments)
							.where(
								and(
									eq(tediRoleAssignments.id, decision.roleAssignmentId),
									eq(tediRoleAssignments.lastDecisionId, decision.id),
								),
							),
					),
				),
			]);
		} else if (decision.kind === "grant") {
			if (
				!activity ||
				!decision.toEntrustmentLevel ||
				!decision.targetScope ||
				!decision.targetExpiresAt ||
				!decision.targetNextReviewAt
			)
				throw new EarnedDelegationError(
					"invalid_transition",
					"Grant decision is missing its authority scope",
				);
			const grantId = crypto.randomUUID();
			const targetChange = db
				.insert(tediEntrustmentGrants)
				.select(
					db
						.select({
							id: sql<string>`${grantId}`.as("id"),
							organizationId: sql<string>`${input.organizationId}`.as(
								"organization_id",
							),
							tediId: sql<string>`${decision.tediId}`.as("tedi_id"),
							roleAssignmentId: sql<
								string | null
							>`${decision.roleAssignmentId}`.as("role_assignment_id"),
							activityId: sql<string>`${activity.id}`.as("activity_id"),
							level: sql<EntrustmentLevel>`${decision.toEntrustmentLevel}`.as(
								"level",
							),
							status: sql<"active">`'active'`.as("status"),
							scope:
								sql<EntrustmentScope>`${JSON.stringify(decision.targetScope)}`.as(
									"scope",
								),
							revision: sql<number>`1`.as("revision"),
							lastCertifiedAt: sql<string>`${input.now}`.as(
								"last_certified_at",
							),
							expiresAt: sql<string>`${decision.targetExpiresAt}`.as(
								"expires_at",
							),
							nextReviewAt: sql<string>`${decision.targetNextReviewAt}`.as(
								"next_review_at",
							),
							restrictedAt: sql<string | null>`NULL`.as("restricted_at"),
							reason: sql<string | null>`${input.reason ?? decision.reason}`.as(
								"reason",
							),
							lastDecisionId: sql<string>`${decision.id}`.as(
								"last_decision_id",
							),
							activityVersion: sql<number>`${activity.version}`.as(
								"activity_version",
							),
							rubricHash: sql<string>`${activity.rubricHash}`.as("rubric_hash"),
							evidencePolicyHash:
								sql<string>`${activity.evidencePolicyHash}`.as(
									"evidence_policy_hash",
								),
							evidenceSnapshotHash: sql<string>`${evidenceSnapshotHash}`.as(
								"evidence_snapshot_hash",
							),
							grantedByType: sql<
								"user" | "api_key" | "certification_service"
							>`${input.decidedByType}`.as("granted_by_type"),
							grantedById: sql<string>`${input.decidedById}`.as(
								"granted_by_id",
							),
							createdAt: sql<string>`${input.now}`.as("created_at"),
							updatedAt: sql<string>`${input.now}`.as("updated_at"),
						})
						.from(promotionDecisions)
						.where(
							and(
								eq(promotionDecisions.id, decision.id),
								eq(promotionDecisions.status, "approved"),
								settlementRevisionFence,
							),
						),
				)
				.onConflictDoNothing()
				.returning({ id: tediEntrustmentGrants.id });
			[changed, applied] = await db.batch([
				targetChange,
				appliedDecision(
					exists(
						db
							.select({ one: sql`1` })
							.from(tediEntrustmentGrants)
							.where(
								and(
									eq(
										tediEntrustmentGrants.organizationId,
										input.organizationId,
									),
									eq(tediEntrustmentGrants.tediId, decision.tediId),
									eq(tediEntrustmentGrants.activityId, activity.id),
									eq(tediEntrustmentGrants.lastDecisionId, decision.id),
								),
							),
					),
				),
			]);
		} else {
			if (
				!activity ||
				!decision.fromEntrustmentLevel ||
				!decision.fromEntrustmentStatus ||
				decision.expectedEntrustmentRevision == null
			)
				throw new EarnedDelegationError(
					"invalid_transition",
					"Entrustment decision is missing its revision fence",
				);
			const positiveGrant = isPositiveDecision(decision.kind);
			const expectedStatusCondition =
				decision.fromEntrustmentStatus === "active"
					? and(
							eq(tediEntrustmentGrants.status, "active"),
							or(
								isNull(tediEntrustmentGrants.expiresAt),
								gt(tediEntrustmentGrants.expiresAt, input.now),
							),
						)
					: decision.fromEntrustmentStatus === "expired"
						? and(
								eq(tediEntrustmentGrants.status, "active"),
								lte(tediEntrustmentGrants.expiresAt, input.now),
							)
						: eq(tediEntrustmentGrants.status, decision.fromEntrustmentStatus);
			const targetChange = db
				.update(tediEntrustmentGrants)
				.set({
					level: positiveGrant
						? (decision.toEntrustmentLevel ?? decision.fromEntrustmentLevel)
						: decision.fromEntrustmentLevel,
					status:
						decision.kind === "restrict"
							? "restricted"
							: decision.kind === "revoke"
								? "revoked"
								: "active",
					scope: positiveGrant
						? (decision.targetScope ?? undefined)
						: undefined,
					revision: decision.expectedEntrustmentRevision + 1,
					lastCertifiedAt: positiveGrant ? input.now : undefined,
					expiresAt: positiveGrant
						? (decision.targetExpiresAt ?? undefined)
						: undefined,
					nextReviewAt: positiveGrant
						? (decision.targetNextReviewAt ?? undefined)
						: undefined,
					restrictedAt: positiveGrant ? null : input.now,
					reason: input.reason ?? decision.reason,
					lastDecisionId: decision.id,
					activityVersion: activity.version,
					rubricHash: activity.rubricHash,
					evidencePolicyHash: activity.evidencePolicyHash,
					evidenceSnapshotHash,
					updatedAt: input.now,
				})
				.where(
					and(
						eq(tediEntrustmentGrants.organizationId, input.organizationId),
						eq(tediEntrustmentGrants.tediId, decision.tediId),
						eq(tediEntrustmentGrants.activityId, activity.id),
						eq(
							tediEntrustmentGrants.revision,
							decision.expectedEntrustmentRevision,
						),
						eq(tediEntrustmentGrants.level, decision.fromEntrustmentLevel),
						expectedStatusCondition,
						positiveGrant ? settlementRevisionFence : sql`1 = 1`,
					),
				)
				.returning({ id: tediEntrustmentGrants.id });
			[changed, applied] = await db.batch([
				targetChange,
				appliedDecision(
					exists(
						db
							.select({ one: sql`1` })
							.from(tediEntrustmentGrants)
							.where(
								and(
									eq(
										tediEntrustmentGrants.organizationId,
										input.organizationId,
									),
									eq(tediEntrustmentGrants.tediId, decision.tediId),
									eq(tediEntrustmentGrants.activityId, activity.id),
									eq(tediEntrustmentGrants.lastDecisionId, decision.id),
								),
							),
					),
				),
			]);
		}
	} catch (error) {
		await cancelReservation();
		throw error;
	}

	if (changed[0] && applied[0]) return applied[0];
	await cancelReservation();
	throw new EarnedDelegationError(
		"conflict",
		"Authority state changed after proposal; decision was not applied",
	);
}
