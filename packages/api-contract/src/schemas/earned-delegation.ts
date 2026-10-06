import * as z from "zod";
import { JsonValueSchema } from "./common";

export const TEDI_CAREER_STAGES = [
	"shadow",
	"apprentice",
	"operator",
	"specialist",
	"lead",
	"executive",
] as const;
export const TediCareerStageSchema = z.enum(TEDI_CAREER_STAGES);
export type TediCareerStage = z.infer<typeof TediCareerStageSchema>;

/** Ordered task-scoped authority. It never follows from role or stage alone. */
export const ENTRUSTMENT_LEVELS = [
	"observe",
	"recommend",
	"execute_preapproved",
	"execute_reviewed",
	"autonomous",
	"delegate",
] as const;
export const EntrustmentLevelSchema = z.enum(ENTRUSTMENT_LEVELS);
export type EntrustmentLevel = z.infer<typeof EntrustmentLevelSchema>;

export const ENTRUSTMENT_STATUSES = [
	"active",
	"restricted",
	"expired",
	"revoked",
] as const;
export const EntrustmentStatusSchema = z.enum(ENTRUSTMENT_STATUSES);

export const COMPETENCY_OUTCOMES = [
	"success",
	"partial",
	"failure",
	"unverified",
] as const;
export const CompetencyOutcomeSchema = z.enum(COMPETENCY_OUTCOMES);

/**
 * Versioned, descriptive career-progress score. It is intentionally bounded
 * and cannot be interpreted as task authority; only an applied entrustment
 * grant can authorize execution.
 */
export const VALIDATED_EXPERIENCE_FORMULA_VERSION =
	"validated-experience-v1" as const;
export const VALIDATED_EXPERIENCE_FAMILY_CAP_UNITS = 5;
export const VALIDATED_EXPERIENCE_TOTAL_CAP_UNITS = 30;
export const VALIDATED_EXPERIENCE_POINTS_PER_UNIT = 100;

export const ValidatedExperienceTaskFamilySchema = z.object({
	taskFamily: z.string(),
	points: z.number().int().min(0).max(500),
	maxPoints: z.literal(500),
	validatedUnits: z.number().min(0).max(5),
	uncappedUnits: z.number().nonnegative(),
	creditedOpportunities: z.number().int().nonnegative(),
	saturated: z.boolean(),
});

export const ValidatedExperienceSchema = z.object({
	formulaVersion: z.literal(VALIDATED_EXPERIENCE_FORMULA_VERSION),
	descriptiveOnly: z.literal(true),
	authorityEffect: z.literal("none"),
	provisional: z.literal(true),
	limitations: z.array(z.string().min(1)).min(1),
	points: z.number().int().min(0).max(3000),
	maxPoints: z.literal(3000),
	validatedUnits: z.number().min(0).max(30),
	uncappedUnits: z.number().nonnegative(),
	creditedOpportunities: z.number().int().nonnegative(),
	negativeOpportunities: z.number().int().nonnegative(),
	maximumPolicyViolationSeverity: z.number().int().nonnegative(),
	standing: z.enum(["clear", "contested", "blocked"]),
	observationsEvaluated: z.number().int().nonnegative(),
	truncated: z.boolean(),
	saturated: z.boolean(),
	lastValidatedAt: z.iso.datetime().nullable(),
	taskFamilies: z.array(ValidatedExperienceTaskFamilySchema),
});
export type ValidatedExperience = z.infer<typeof ValidatedExperienceSchema>;

export const DelegationYieldValueSchema = z.object({
	currency: z.string().regex(/^[A-Z]{3}$/),
	verifiedValueMinorUnits: z
		.number()
		.int()
		.nonnegative()
		.max(Number.MAX_SAFE_INTEGER),
	ownerReviewMinutes: z.number().nonnegative(),
	valuePerOwnerReviewHourMinorUnits: z
		.number()
		.int()
		.nonnegative()
		.max(Number.MAX_SAFE_INTEGER)
		.nullable(),
});

export const DelegationYieldCostSchema = z.object({
	currency: z.string().regex(/^[A-Z]{3}$/),
	costMinorUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/**
 * Verified organizational value relative to owner supervision. This is an
 * observed-evidence ratio, never a currency-conversion engine or authority
 * signal; incomplete issued-opportunity coverage remains explicit.
 */
export const DelegationYieldSchema = z.object({
	metric: z.literal("verified_value_per_owner_review_hour"),
	authorityEffect: z.literal("none"),
	measurementStatus: z.enum(["unmeasured", "partial", "measured"]),
	provisional: z.literal(true),
	coverage: z.literal("observed_issued_work_items_only"),
	observedOpportunities: z.number().int().nonnegative(),
	issuedOpportunities: z.number().int().nonnegative(),
	reviewedOpportunities: z.number().int().nonnegative(),
	valueCertifiedOpportunities: z.number().int().nonnegative(),
	ownerReviewMinutes: z.number().nonnegative(),
	valueByCurrency: z.array(DelegationYieldValueSchema),
	costByCurrency: z.array(DelegationYieldCostSchema),
	truncated: z.boolean(),
	limitations: z.array(z.string().min(1)).min(1),
});
export type DelegationYield = z.infer<typeof DelegationYieldSchema>;

export const DELEGATION_ACTOR_TYPES = [
	"user",
	"tedi",
	"service",
	"api_key",
	"external_agent",
] as const;
export const DelegationActorTypeSchema = z.enum(DELEGATION_ACTOR_TYPES);

/** Principals permitted to settle a promotion or activate authority. */
export const DECISION_AUTHORITY_ACTOR_TYPES = [
	"user",
	"api_key",
	"certification_service",
] as const;
export const DecisionAuthorityActorTypeSchema = z.enum(
	DECISION_AUTHORITY_ACTOR_TYPES,
);

export const PROMOTION_DECISION_KINDS = [
	"promote",
	"demote",
	"grant",
	"raise",
	"restrict",
	"revoke",
	"recertify",
	"reinstate",
	"role_change",
] as const;
export const PromotionDecisionKindSchema = z.enum(PROMOTION_DECISION_KINDS);

export const PROMOTION_DECISION_STATUSES = [
	"proposed",
	"approved",
	"rejected",
	"applied",
	"cancelled",
] as const;
export const PromotionDecisionStatusSchema = z.enum(
	PROMOTION_DECISION_STATUSES,
);

const JsonRecordSchema = z.record(z.string(), JsonValueSchema);
const IsoDateTimeSchema = z.iso.datetime();

export const EvidencePolicySchema = z.object({
	minimumVerifiedObservations: z.number().int().positive().default(3),
	minimumDistinctVerifierPrincipals: z.number().int().min(2).default(2),
	maximumFailureRate: z.number().min(0).max(1).default(0.2),
	maximumPolicyViolationSeverity: z.number().int().min(0).default(0),
	maximumEvidenceAgeDays: z.number().int().positive().default(90),
	requireNonTrivialWork: z.boolean().default(true),
	minimumReliabilityLowerBound: z.number().min(0).max(1).default(0.5),
	minimumMeanComplexity: z.number().min(0).max(1).default(0.25),
	// Readiness is evaluated per entrustable activity, whose task family is
	// server-classified and therefore necessarily singular. Cross-family breadth
	// belongs in career-stage policy, not an individual activity grant.
	minimumTaskFamilies: z.number().int().positive().default(1),
	minimumCalibrationScore: z.number().min(0).max(1).default(0.7),
	minimumEscalationQuality: z.number().min(0).max(1).default(0.7),
	requireLearningTransfer: z.boolean().default(false),
});
export type EvidencePolicy = z.infer<typeof EvidencePolicySchema>;

/** Spending stays in the budget subsystem; entrustment may only reference it. */
export const EntrustmentScopeSchema = z
	.object({
		actions: z.array(z.string()).min(1),
		toolIds: z.array(z.string()).default([]),
		environments: z.array(z.string()).min(1),
		spendPermission: z.enum(["none", "policy_bound"]),
		budgetPolicyId: z.string().nullable(),
		constraints: JsonRecordSchema.default({}),
	})
	.superRefine((scope, context) => {
		const requiresPolicy = scope.spendPermission === "policy_bound";
		if (requiresPolicy !== Boolean(scope.budgetPolicyId)) {
			context.addIssue({
				code: "custom",
				message:
					"budgetPolicyId must be present exactly when spendPermission is policy_bound",
				path: ["budgetPolicyId"],
			});
		}
	});
export type EntrustmentScope = z.infer<typeof EntrustmentScopeSchema>;

export const TediRoleAssignmentSchema = z
	.object({
		id: z.uuid(),
		organizationId: z.uuid(),
		tediId: z.uuid(),
		roleTemplateId: z.string().nullable(),
		roleKey: z.string(),
		roleName: z.string(),
		status: z.enum(["active", "ended"]),
		careerStage: TediCareerStageSchema,
		assignedAt: IsoDateTimeSchema,
		stageChangedAt: IsoDateTimeSchema,
		endedAt: IsoDateTimeSchema.nullable(),
		revision: z.number().int().positive(),
		lastDecisionId: z.uuid().nullable(),
		evidenceSnapshotHash: z.string().nullable(),
		metadata: JsonRecordSchema.nullable(),
		createdAt: IsoDateTimeSchema,
		updatedAt: IsoDateTimeSchema,
	})
	.superRefine((assignment, context) => {
		if (assignment.careerStage === "shadow") return;
		if (!assignment.lastDecisionId || !assignment.evidenceSnapshotHash) {
			context.addIssue({
				code: "custom",
				message: "non-shadow stages require an applied decision and evidence",
				path: ["lastDecisionId"],
			});
		}
	});

export const EntrustableActivitySchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid().nullable(),
	key: z.string(),
	version: z.number().int().positive(),
	supersedesId: z.uuid().nullable(),
	roleTemplateId: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	status: z.enum(["active", "retired"]),
	taskFamily: z.string(),
	riskLevel: z.enum(["low", "medium", "high", "critical"]),
	maximumLevel: EntrustmentLevelSchema,
	actionPatterns: z.array(z.string()),
	toolIds: z.array(z.string()),
	rubric: JsonRecordSchema,
	rubricHash: z.string(),
	evidencePolicy: EvidencePolicySchema,
	evidencePolicyHash: z.string(),
	createdAt: IsoDateTimeSchema,
	updatedAt: IsoDateTimeSchema,
});

export const TediEntrustmentSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	tediId: z.uuid(),
	roleAssignmentId: z.uuid().nullable(),
	activityId: z.uuid(),
	level: EntrustmentLevelSchema,
	status: EntrustmentStatusSchema,
	scope: EntrustmentScopeSchema,
	revision: z.number().int().positive(),
	lastCertifiedAt: IsoDateTimeSchema.nullable(),
	expiresAt: IsoDateTimeSchema.nullable(),
	nextReviewAt: IsoDateTimeSchema,
	restrictedAt: IsoDateTimeSchema.nullable(),
	reason: z.string().nullable(),
	lastDecisionId: z.uuid(),
	activityVersion: z.number().int().positive(),
	rubricHash: z.string(),
	evidencePolicyHash: z.string(),
	evidenceSnapshotHash: z.string(),
	grantedByType: DecisionAuthorityActorTypeSchema,
	grantedById: z.string(),
	createdAt: IsoDateTimeSchema,
	updatedAt: IsoDateTimeSchema,
});

export const CompetencyObservationSchema = z
	.object({
		id: z.uuid(),
		organizationId: z.uuid(),
		tediId: z.uuid(),
		executorType: z.enum(["tedi", "external_agent", "service"]),
		executorId: z.string(),
		activityId: z.uuid(),
		clientObservationId: z.string(),
		inputHash: z.string(),
		executionOpportunityId: z.string(),
		workItemId: z.uuid().nullable(),
		sourceKind: z.string(),
		sourceId: z.string(),
		traceBundleId: z.string().nullable(),
		rationaleId: z.string().nullable(),
		taskFamily: z.string(),
		riskLevel: z.enum(["low", "medium", "high", "critical"]),
		environment: z.string(),
		rubricVersion: z.number().int().positive(),
		harness: z.string(),
		harnessVersion: z.string(),
		modelProvider: z.string(),
		modelId: z.string(),
		modelVersion: z.string(),
		outcome: CompetencyOutcomeSchema,
		complexity: z.number().min(0).max(1),
		nonTrivial: z.boolean(),
		heldOut: z.boolean(),
		calibrationScore: z.number().min(0).max(1).nullable(),
		escalationQuality: z.number().min(0).max(1).nullable(),
		learningTransfer: z.boolean().nullable(),
		evidenceRefs: z.array(z.string().min(1)),
		eligibilityStatus: z.enum(["pending", "eligible", "ineligible"]),
		evaluatorType: z
			.enum(["user", "api_key", "certification_service"])
			.nullable(),
		evaluatorId: z.string().nullable(),
		classificationMethod: z.string(),
		evaluationRunId: z.string().nullable(),
		proofVerifiedAt: IsoDateTimeSchema.nullable(),
		costMinorUnits: z.number().int().nonnegative().nullable(),
		costCurrency: z.string().length(3).nullable(),
		durationMs: z.number().int().nonnegative().nullable(),
		ownerReviewMinutes: z.number().min(0).nullable(),
		policyViolationSeverity: z.number().int().nonnegative(),
		confidence: z.number().min(0).max(1),
		metadata: JsonRecordSchema.nullable(),
		occurredAt: IsoDateTimeSchema,
		createdAt: IsoDateTimeSchema,
	})
	.superRefine((observation, context) => {
		if (
			(observation.costMinorUnits === null) !==
			(observation.costCurrency === null)
		) {
			context.addIssue({
				code: "custom",
				message: "cost amount and currency must be present together",
				path: ["costCurrency"],
			});
		}
		if (
			(observation.evaluatorType === null) !==
			(observation.evaluatorId === null)
		) {
			context.addIssue({
				code: "custom",
				message: "evaluator type and identity must be present together",
				path: ["evaluatorId"],
			});
		}
		if (observation.eligibilityStatus !== "eligible") return;
		if (!observation.evaluatorType || !observation.evaluatorId) {
			context.addIssue({
				code: "custom",
				message: "eligible observations require evaluator provenance",
				path: ["evaluatorId"],
			});
		}
		if (observation.evidenceRefs.length === 0) {
			context.addIssue({
				code: "custom",
				message: "eligible observations require durable proof",
				path: ["evidenceRefs"],
			});
		}
		if (!observation.proofVerifiedAt) {
			context.addIssue({
				code: "custom",
				message: "eligible observations require proof verification",
				path: ["proofVerifiedAt"],
			});
		}
	});

/** Attestations are stable-principal statements, never extra experience rows. */
export const CompetencyObservationAttestationSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	observationId: z.uuid(),
	principalType: z.enum([
		"user",
		"api_key",
		"certification_service",
		"external_agent",
	]),
	principalId: z.string(),
	verdict: z.enum(["supports", "rejects"]),
	verificationMethod: z.string(),
	independenceVerified: z.boolean(),
	authenticatedAt: IsoDateTimeSchema,
	createdAt: IsoDateTimeSchema,
});

export const PromotionDecisionObservationSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	decisionId: z.uuid(),
	observationId: z.uuid(),
	createdAt: IsoDateTimeSchema,
});

export const PromotionDecisionSchema = z
	.object({
		id: z.uuid(),
		organizationId: z.uuid(),
		clientProposalId: z.string(),
		inputHash: z.string(),
		tediId: z.uuid(),
		roleAssignmentId: z.uuid().nullable(),
		activityId: z.uuid().nullable(),
		kind: PromotionDecisionKindSchema,
		status: PromotionDecisionStatusSchema,
		fromCareerStage: TediCareerStageSchema.nullable(),
		toCareerStage: TediCareerStageSchema.nullable(),
		fromEntrustmentLevel: EntrustmentLevelSchema.nullable(),
		fromEntrustmentStatus: EntrustmentStatusSchema.nullable(),
		toEntrustmentLevel: EntrustmentLevelSchema.nullable(),
		targetRoleTemplateId: z.string().nullable(),
		targetRoleKey: z.string().nullable(),
		targetRoleName: z.string().nullable(),
		targetScope: EntrustmentScopeSchema.nullable(),
		targetExpiresAt: z.string().nullable(),
		targetNextReviewAt: z.string().nullable(),
		expectedRoleRevision: z.number().int().positive().nullable(),
		expectedEntrustmentRevision: z.number().int().positive().nullable(),
		evidenceObservationIds: z.array(z.uuid()),
		evidenceRefs: z.array(z.string().min(1)).min(1),
		evidenceSnapshot: JsonRecordSchema,
		proposedByType: DelegationActorTypeSchema,
		proposedById: z.string(),
		decidedByType: DecisionAuthorityActorTypeSchema.nullable(),
		decidedById: z.string().nullable(),
		reason: z.string().nullable(),
		createdAt: IsoDateTimeSchema,
		updatedAt: IsoDateTimeSchema,
		proposalExpiresAt: IsoDateTimeSchema,
		decidedAt: IsoDateTimeSchema.nullable(),
		appliedAt: IsoDateTimeSchema.nullable(),
	})
	.superRefine((decision, context) => {
		const fromStage = decision.fromCareerStage
			? TEDI_CAREER_STAGES.indexOf(decision.fromCareerStage)
			: -1;
		const toStage = decision.toCareerStage
			? TEDI_CAREER_STAGES.indexOf(decision.toCareerStage)
			: -1;
		const fromLevel = decision.fromEntrustmentLevel
			? ENTRUSTMENT_LEVELS.indexOf(decision.fromEntrustmentLevel)
			: -1;
		const toLevel = decision.toEntrustmentLevel
			? ENTRUSTMENT_LEVELS.indexOf(decision.toEntrustmentLevel)
			: -1;
		const hasIrrelevantRoleTarget =
			decision.kind !== "role_change" &&
			Boolean(
				decision.targetRoleTemplateId ||
				decision.targetRoleKey ||
				decision.targetRoleName,
			);
		const careerShapeInvalid =
			!decision.roleAssignmentId ||
			fromStage < 0 ||
			toStage < 0 ||
			Boolean(decision.activityId) ||
			Boolean(decision.fromEntrustmentLevel) ||
			Boolean(decision.toEntrustmentLevel) ||
			Boolean(decision.fromEntrustmentStatus);
		if (
			(decision.kind === "promote" &&
				(careerShapeInvalid ||
					toStage !== fromStage + 1 ||
					decision.evidenceObservationIds.length === 0)) ||
			(decision.kind === "demote" &&
				(careerShapeInvalid || toStage >= fromStage))
		) {
			context.addIssue({
				code: "custom",
				message:
					"career decisions require a correctly directed role transition and competency evidence",
				path: ["kind"],
			});
		}
		const entrustmentShapeInvalid =
			!decision.activityId ||
			toLevel < 0 ||
			!decision.targetScope ||
			!decision.targetExpiresAt ||
			!decision.targetNextReviewAt ||
			Boolean(decision.fromCareerStage) ||
			Boolean(decision.toCareerStage) ||
			decision.evidenceObservationIds.length === 0;
		if (
			(decision.kind === "grant" &&
				(entrustmentShapeInvalid ||
					fromLevel !== -1 ||
					decision.fromEntrustmentStatus !== null)) ||
			(decision.kind === "raise" &&
				(entrustmentShapeInvalid ||
					fromLevel < 0 ||
					toLevel <= fromLevel ||
					decision.fromEntrustmentStatus !== "active")) ||
			(decision.kind === "recertify" &&
				(entrustmentShapeInvalid ||
					fromLevel < 0 ||
					toLevel !== fromLevel ||
					decision.fromEntrustmentStatus !== "active")) ||
			(decision.kind === "reinstate" &&
				(entrustmentShapeInvalid ||
					fromLevel < 0 ||
					toLevel !== fromLevel ||
					!["restricted", "expired"].includes(
						decision.fromEntrustmentStatus ?? "",
					)))
		) {
			context.addIssue({
				code: "custom",
				message:
					"entrustment decisions require a kind-consistent level transition and competency evidence",
				path: ["kind"],
			});
		}
		if (
			["restrict", "revoke"].includes(decision.kind) &&
			(!decision.activityId ||
				fromLevel < 0 ||
				(decision.kind === "restrict" &&
					decision.fromEntrustmentStatus !== "active") ||
				(decision.kind === "revoke" &&
					(!decision.fromEntrustmentStatus ||
						decision.fromEntrustmentStatus === "revoked")) ||
				decision.toEntrustmentLevel ||
				decision.targetScope ||
				decision.targetExpiresAt ||
				decision.targetNextReviewAt ||
				decision.fromCareerStage ||
				decision.toCareerStage)
		) {
			context.addIssue({
				code: "custom",
				message:
					"restriction decisions require the affected activity and current level",
				path: ["kind"],
			});
		}
		if (
			decision.kind === "role_change" &&
			(!decision.roleAssignmentId ||
				!decision.targetRoleKey ||
				!decision.targetRoleName ||
				decision.activityId ||
				decision.fromCareerStage ||
				decision.toCareerStage ||
				decision.fromEntrustmentLevel ||
				decision.toEntrustmentLevel ||
				decision.fromEntrustmentStatus)
		) {
			context.addIssue({
				code: "custom",
				message: "role changes require an existing assignment and target role",
				path: ["kind"],
			});
		}
		if (hasIrrelevantRoleTarget) {
			context.addIssue({
				code: "custom",
				message: "target role fields are only valid for role_change",
				path: ["targetRoleKey"],
			});
		}
		if (
			!["grant", "raise", "recertify", "reinstate"].includes(decision.kind) &&
			(decision.targetScope ||
				decision.targetExpiresAt ||
				decision.targetNextReviewAt)
		) {
			context.addIssue({
				code: "custom",
				message:
					"target scope and validity are only valid for positive entrustment decisions",
				path: ["targetScope"],
			});
		}
		const settled = ["approved", "applied", "rejected"].includes(
			decision.status,
		);
		if (
			settled &&
			(!decision.decidedByType || !decision.decidedById || !decision.decidedAt)
		) {
			context.addIssue({
				code: "custom",
				message: "settled decisions require an authenticated disposer",
				path: ["decidedById"],
			});
		}
		if (
			decision.decidedByType === decision.proposedByType &&
			decision.decidedById === decision.proposedById
		) {
			context.addIssue({
				code: "custom",
				message: "the proposer cannot dispose its own promotion decision",
				path: ["decidedById"],
			});
		}
		if (decision.status === "applied" && !decision.appliedAt) {
			context.addIssue({
				code: "custom",
				message: "applied decisions require appliedAt",
				path: ["appliedAt"],
			});
		}
	});
