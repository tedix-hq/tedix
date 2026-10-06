import type {
	EntrustmentLevel,
	EntrustmentScope,
	TediCareerStage,
} from "@tedix/api-contract/schemas/earned-delegation";
import { and, eq, isNull, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
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
	type DelegationActorType,
	EarnedDelegationError,
	ENTRUSTMENT_LEVEL_ORDER,
	type EntrustmentStatus,
	effectiveGrantStatus,
	hashSnapshot,
	requireScopedTedi,
} from "./authority-policy";
import { loadPromotionReadiness } from "./promotion-readiness-store";

function isPositiveDecision(kind: DecisionKind): boolean {
	return ["promote", "grant", "raise", "recertify", "reinstate"].includes(kind);
}

export async function createPromotionProposal(
	db: DbClient,
	input: {
		organizationId: string;
		clientProposalId: string;
		tediId: string;
		kind: DecisionKind;
		activityId?: string | null;
		targetCareerStage?: TediCareerStage | null;
		targetEntrustmentLevel?: EntrustmentLevel | null;
		targetRoleTemplateId?: string | null;
		targetRoleKey?: string | null;
		targetRoleName?: string | null;
		targetScope?: EntrustmentScope | null;
		targetExpiresAt?: string | null;
		targetNextReviewAt?: string | null;
		evidenceRefs: string[];
		proposedByType: DelegationActorType;
		proposedById: string;
		reason?: string | null;
		now: string;
		proposalExpiresAt: string;
	},
) {
	const { now: _requestTime, ...hashInput } = input;
	const inputHash = await hashSnapshot(hashInput);
	if (input.evidenceRefs.length === 0)
		throw new EarnedDelegationError(
			"ineligible",
			"Every proposal requires durable evidence or incident references",
		);
	if (input.proposalExpiresAt <= input.now)
		throw new EarnedDelegationError(
			"expired",
			"Proposal expiry must be in the future",
		);
	const retried = await db
		.select()
		.from(promotionDecisions)
		.where(
			and(
				eq(promotionDecisions.organizationId, input.organizationId),
				eq(promotionDecisions.clientProposalId, input.clientProposalId),
			),
		)
		.limit(1);
	if (retried[0]) {
		if (retried[0].inputHash !== inputHash) {
			throw new EarnedDelegationError(
				"conflict",
				"Proposal idempotency key was reused with different authority",
			);
		}
		return retried[0];
	}
	await requireScopedTedi(db, input.organizationId, input.tediId);
	const roles = await db
		.select()
		.from(tediRoleAssignments)
		.where(
			and(
				eq(tediRoleAssignments.organizationId, input.organizationId),
				eq(tediRoleAssignments.tediId, input.tediId),
				eq(tediRoleAssignments.status, "active"),
			),
		)
		.limit(1);
	const role = roles[0] ?? null;
	let activity: typeof entrustableActivities.$inferSelect | null = null;
	let grant: typeof tediEntrustmentGrants.$inferSelect | null = null;
	if (input.activityId) {
		const activities = await db
			.select()
			.from(entrustableActivities)
			.where(
				and(
					eq(entrustableActivities.id, input.activityId),
					eq(entrustableActivities.status, "active"),
					or(
						eq(entrustableActivities.organizationId, input.organizationId),
						isNull(entrustableActivities.organizationId),
					),
				),
			)
			.limit(1);
		activity = activities[0] ?? null;
		const grants = await db
			.select()
			.from(tediEntrustmentGrants)
			.where(
				and(
					eq(tediEntrustmentGrants.organizationId, input.organizationId),
					eq(tediEntrustmentGrants.tediId, input.tediId),
					eq(tediEntrustmentGrants.activityId, input.activityId),
				),
			)
			.limit(1);
		grant = grants[0] ?? null;
	}

	let fromCareerStage: TediCareerStage | null = null;
	let toCareerStage: TediCareerStage | null = null;
	let fromEntrustmentLevel: EntrustmentLevel | null = null;
	let fromEntrustmentStatus: EntrustmentStatus | null = null;
	let toEntrustmentLevel: EntrustmentLevel | null = null;
	let policy = CAREER_POLICY;
	if (input.kind === "role_change") {
		if (
			!role ||
			!input.targetRoleKey ||
			!input.targetRoleName ||
			input.targetRoleKey === role.roleKey ||
			input.activityId ||
			input.targetCareerStage ||
			input.targetEntrustmentLevel ||
			input.targetScope
		) {
			throw new EarnedDelegationError(
				"invalid_transition",
				"Role changes require an existing assignment and a different target role",
			);
		}
	} else if (input.kind === "promote" || input.kind === "demote") {
		if (!role || !input.targetCareerStage)
			throw new EarnedDelegationError(
				"invalid_transition",
				"Career changes require an active role and target stage",
			);
		fromCareerStage = role.careerStage;
		toCareerStage = input.targetCareerStage;
		const fromRank = CAREER_STAGES.indexOf(fromCareerStage);
		const toRank = CAREER_STAGES.indexOf(toCareerStage);
		if (
			(input.kind === "promote" && toRank !== fromRank + 1) ||
			(input.kind === "demote" && toRank >= fromRank)
		) {
			throw new EarnedDelegationError(
				"invalid_transition",
				"Career promotion is one step upward; demotion must lower the stage",
			);
		}
		policy = {
			...CAREER_POLICY,
			requireLearningTransfer: toRank >= CAREER_STAGES.indexOf("lead"),
		};
	} else {
		if (!activity)
			throw new EarnedDelegationError(
				"invalid_transition",
				"Entrustment decisions require an active activity",
			);
		fromEntrustmentLevel = grant?.level ?? null;
		fromEntrustmentStatus = grant
			? effectiveGrantStatus(grant, input.now)
			: null;
		toEntrustmentLevel = input.targetEntrustmentLevel ?? null;
		policy = activity.evidencePolicy;
		const fromRank = fromEntrustmentLevel
			? ENTRUSTMENT_LEVEL_ORDER.indexOf(fromEntrustmentLevel)
			: -1;
		const toRank = toEntrustmentLevel
			? ENTRUSTMENT_LEVEL_ORDER.indexOf(toEntrustmentLevel)
			: -1;
		const legalState =
			(input.kind === "grant" && !grant && toRank >= 0) ||
			(input.kind === "raise" &&
				fromEntrustmentStatus === "active" &&
				toRank > fromRank) ||
			(input.kind === "recertify" &&
				fromEntrustmentStatus === "active" &&
				toRank === fromRank) ||
			(input.kind === "reinstate" &&
				(fromEntrustmentStatus === "restricted" ||
					fromEntrustmentStatus === "expired") &&
				toRank === fromRank) ||
			(input.kind === "restrict" && fromEntrustmentStatus === "active") ||
			(input.kind === "revoke" &&
				fromEntrustmentStatus !== null &&
				fromEntrustmentStatus !== "revoked");
		if (!legalState) {
			throw new EarnedDelegationError(
				"invalid_transition",
				"Entrustment transition does not match current grant state",
			);
		}
		if (toRank > ENTRUSTMENT_LEVEL_ORDER.indexOf(activity.maximumLevel)) {
			throw new EarnedDelegationError(
				"invalid_transition",
				"Requested entrustment exceeds the activity ceiling",
			);
		}
		if (
			isPositiveDecision(input.kind) &&
			(!input.targetScope ||
				!input.targetExpiresAt ||
				!input.targetNextReviewAt ||
				input.targetExpiresAt <= input.now ||
				input.targetNextReviewAt <= input.now)
		) {
			throw new EarnedDelegationError(
				"invalid_transition",
				"Positive entrustment decisions require a future validity window and exact scope",
			);
		}
		if (isPositiveDecision(input.kind) && input.targetScope) {
			assertScopeWithinActivity(input.targetScope, activity);
			if (input.targetNextReviewAt! > input.targetExpiresAt!) {
				throw new EarnedDelegationError(
					"invalid_transition",
					"The next review must not be later than authority expiry",
				);
			}
		}
	}

	const readinessSnapshot = isPositiveDecision(input.kind)
		? await loadPromotionReadiness(db, {
				organizationId: input.organizationId,
				tediId: input.tediId,
				activityId: activity?.id ?? null,
				policy,
				requiredEnvironments: input.targetScope?.environments,
				now: input.now,
			})
		: null;
	const readiness = readinessSnapshot?.readiness ?? null;
	if (readiness && !readiness.eligible) {
		throw new EarnedDelegationError(
			"ineligible",
			`Promotion evidence is not ready: ${readiness.reasons.join("; ")}`,
		);
	}
	const evidenceObservationIds = readiness?.eligibleObservationIds ?? [];
	const evidenceSnapshot = {
		computedAt: input.now,
		policy,
		readiness,
		evidenceRevision: readinessSnapshot?.evidenceRevision ?? null,
		activityVersion: activity?.version ?? null,
		rubricHash: activity?.rubricHash ?? null,
		evidencePolicyHash: activity?.evidencePolicyHash ?? null,
	};
	const decisionId = crypto.randomUUID();
	const decisionValues = {
		id: decisionId,
		organizationId: input.organizationId,
		clientProposalId: input.clientProposalId,
		inputHash,
		tediId: input.tediId,
		roleAssignmentId: role?.id ?? null,
		activityId: activity?.id ?? null,
		kind: input.kind,
		status: "proposed" as const,
		fromCareerStage,
		toCareerStage,
		fromEntrustmentLevel,
		fromEntrustmentStatus,
		toEntrustmentLevel:
			input.kind === "restrict" || input.kind === "revoke"
				? null
				: toEntrustmentLevel,
		targetRoleTemplateId:
			input.kind === "role_change"
				? (input.targetRoleTemplateId ?? null)
				: null,
		targetRoleKey:
			input.kind === "role_change" ? (input.targetRoleKey ?? null) : null,
		targetRoleName:
			input.kind === "role_change" ? (input.targetRoleName ?? null) : null,
		targetScope: isPositiveDecision(input.kind)
			? (input.targetScope ?? null)
			: null,
		targetExpiresAt: isPositiveDecision(input.kind)
			? (input.targetExpiresAt ?? null)
			: null,
		targetNextReviewAt: isPositiveDecision(input.kind)
			? (input.targetNextReviewAt ?? null)
			: null,
		expectedRoleRevision: role?.revision ?? null,
		expectedEntrustmentRevision: grant?.revision ?? null,
		evidenceObservationIds,
		evidenceRefs: input.evidenceRefs,
		evidenceSnapshot,
		proposedByType: input.proposedByType,
		proposedById: input.proposedById,
		decidedByType: null,
		decidedById: null,
		reason: input.reason ?? null,
		createdAt: input.now,
		updatedAt: input.now,
		proposalExpiresAt: input.proposalExpiresAt,
		decidedAt: null,
		appliedAt: null,
	};
	const insertDecision = db.insert(promotionDecisions).values(decisionValues);
	try {
		if (evidenceObservationIds.length > 0) {
			await db.batch([
				insertDecision,
				db.insert(promotionDecisionObservations).values(
					evidenceObservationIds.map((observationId) => ({
						id: crypto.randomUUID(),
						organizationId: input.organizationId,
						decisionId,
						observationId,
						createdAt: input.now,
					})),
				),
			]);
		} else {
			await insertDecision;
		}
	} catch (error) {
		const conflicting = await db
			.select()
			.from(promotionDecisions)
			.where(
				and(
					eq(promotionDecisions.organizationId, input.organizationId),
					eq(promotionDecisions.clientProposalId, input.clientProposalId),
				),
			)
			.limit(1);
		if (!conflicting[0]) throw error;
		if (conflicting[0].inputHash !== inputHash) {
			throw new EarnedDelegationError(
				"conflict",
				"Proposal idempotency key was reused with different authority",
			);
		}
		return conflicting[0];
	}
	const created = await db
		.select()
		.from(promotionDecisions)
		.where(eq(promotionDecisions.id, decisionId))
		.limit(1);
	return created[0]!;
}
