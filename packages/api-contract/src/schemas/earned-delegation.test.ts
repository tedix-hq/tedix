import { describe, expect, it } from "vite-plus/test";
import {
	CompetencyObservationSchema,
	DelegationYieldSchema,
	EntrustmentScopeSchema,
	EvidencePolicySchema,
	PromotionDecisionSchema,
	TediEntrustmentSchema,
	TediRoleAssignmentSchema,
	ValidatedExperienceSchema,
} from "./earned-delegation";

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-20T00:00:00.000Z";

describe("earned delegation schemas", () => {
	it("keeps delegation yield provisional, currency-separated, and bounded", () => {
		const delegationYield = {
			metric: "verified_value_per_owner_review_hour",
			authorityEffect: "none",
			measurementStatus: "measured",
			provisional: true,
			coverage: "observed_issued_work_items_only",
			observedOpportunities: 2,
			issuedOpportunities: 2,
			reviewedOpportunities: 2,
			valueCertifiedOpportunities: 2,
			ownerReviewMinutes: 45,
			valueByCurrency: [
				{
					currency: "EUR",
					verifiedValueMinorUnits: 5_000,
					ownerReviewMinutes: 15,
					valuePerOwnerReviewHourMinorUnits: 20_000,
				},
				{
					currency: "USD",
					verifiedValueMinorUnits: 12_000,
					ownerReviewMinutes: 30,
					valuePerOwnerReviewHourMinorUnits: 24_000,
				},
			],
			costByCurrency: [{ currency: "USD", costMinorUnits: 100 }],
			truncated: false,
			limitations: ["Observed evidence only."],
		};
		expect(() => DelegationYieldSchema.parse(delegationYield)).not.toThrow();
		expect(() =>
			DelegationYieldSchema.parse({
				...delegationYield,
				provisional: false,
			}),
		).toThrow();
		expect(() =>
			DelegationYieldSchema.parse({
				...delegationYield,
				valueByCurrency: [
					{ ...delegationYield.valueByCurrency[0], currency: "US" },
				],
			}),
		).toThrow();
	});

	it("keeps validated experience bounded and non-authoritative", () => {
		const score = {
			formulaVersion: "validated-experience-v1",
			descriptiveOnly: true,
			authorityEffect: "none",
			provisional: true,
			limitations: ["Coverage is not measured."],
			points: 500,
			maxPoints: 3000,
			validatedUnits: 5,
			uncappedUnits: 7,
			creditedOpportunities: 7,
			negativeOpportunities: 0,
			maximumPolicyViolationSeverity: 0,
			standing: "clear",
			observationsEvaluated: 7,
			truncated: false,
			saturated: false,
			lastValidatedAt: NOW,
			taskFamilies: [
				{
					taskFamily: "engineering",
					points: 500,
					maxPoints: 500,
					validatedUnits: 5,
					uncappedUnits: 7,
					creditedOpportunities: 7,
					saturated: true,
				},
			],
		};
		expect(() => ValidatedExperienceSchema.parse(score)).not.toThrow();
		expect(() =>
			ValidatedExperienceSchema.parse({ ...score, points: 3001 }),
		).toThrow();
		expect(() =>
			ValidatedExperienceSchema.parse({
				...score,
				descriptiveOnly: false,
			}),
		).toThrow();
	});

	it("defaults evidence policy to corroborated, recent proof", () => {
		expect(EvidencePolicySchema.parse({})).toEqual({
			minimumVerifiedObservations: 3,
			minimumDistinctVerifierPrincipals: 2,
			maximumFailureRate: 0.2,
			maximumPolicyViolationSeverity: 0,
			maximumEvidenceAgeDays: 90,
			requireNonTrivialWork: true,
			minimumReliabilityLowerBound: 0.5,
			minimumMeanComplexity: 0.25,
			minimumTaskFamilies: 1,
			minimumCalibrationScore: 0.7,
			minimumEscalationQuality: 0.7,
			requireLearningTransfer: false,
		});
	});

	it("keeps spend policy external to entrustment", () => {
		const base = {
			actions: ["publish"],
			toolIds: [],
			environments: ["production"],
			constraints: {},
		};
		expect(() =>
			EntrustmentScopeSchema.parse({
				...base,
				spendPermission: "policy_bound",
				budgetPolicyId: null,
			}),
		).toThrow();
		expect(() =>
			EntrustmentScopeSchema.parse({
				...base,
				spendPermission: "none",
				budgetPolicyId: "budget-1",
			}),
		).toThrow();
	});

	it("rejects a tedi as entrustment granting authority", () => {
		const grant = {
			id: ID_A,
			organizationId: ID_A,
			tediId: ID_A,
			roleAssignmentId: null,
			activityId: ID_B,
			level: "observe",
			status: "active",
			scope: {
				actions: ["observe"],
				toolIds: [],
				environments: ["production"],
				spendPermission: "none",
				budgetPolicyId: null,
				constraints: {},
			},
			revision: 1,
			lastCertifiedAt: NOW,
			expiresAt: null,
			nextReviewAt: NOW,
			restrictedAt: null,
			reason: null,
			lastDecisionId: ID_B,
			activityVersion: 1,
			rubricHash: "rubric",
			evidencePolicyHash: "policy",
			evidenceSnapshotHash: "evidence",
			grantedByType: "tedi",
			grantedById: ID_A,
			createdAt: NOW,
			updatedAt: NOW,
		};
		expect(() => TediEntrustmentSchema.parse(grant)).toThrow();
	});

	it("does not accept an eligible observation without verified proof", () => {
		const observation = {
			id: ID_A,
			organizationId: ID_A,
			tediId: ID_A,
			executorType: "tedi",
			executorId: ID_A,
			activityId: ID_B,
			clientObservationId: "client-1",
			inputHash: "sha256:observation",
			executionOpportunityId: "episode-1",
			workItemId: null,
			sourceKind: "run",
			sourceId: "run-1",
			traceBundleId: null,
			rationaleId: null,
			taskFamily: "coding",
			riskLevel: "medium",
			environment: "production",
			rubricVersion: 1,
			harness: "codex",
			harnessVersion: "1",
			modelProvider: "openai",
			modelId: "gpt",
			modelVersion: "1",
			outcome: "success",
			complexity: 0.5,
			nonTrivial: true,
			heldOut: true,
			calibrationScore: 0.9,
			escalationQuality: 0.8,
			learningTransfer: true,
			evidenceRefs: [],
			eligibilityStatus: "eligible",
			evaluatorType: "api_key",
			evaluatorId: "evaluator-key-1",
			classificationMethod: "server",
			evaluationRunId: "eval-1",
			proofVerifiedAt: null,
			costMinorUnits: null,
			costCurrency: null,
			durationMs: 100,
			ownerReviewMinutes: 1,
			policyViolationSeverity: 0,
			confidence: 0.9,
			metadata: null,
			occurredAt: NOW,
			createdAt: NOW,
		};
		expect(() => CompetencyObservationSchema.parse(observation)).toThrow();
		expect(() =>
			CompetencyObservationSchema.parse({
				...observation,
				eligibilityStatus: "pending",
				costMinorUnits: 100,
				costCurrency: null,
			}),
		).toThrow();
	});

	it("requires decision lineage for every non-shadow career stage", () => {
		const assignment = {
			id: ID_A,
			organizationId: ID_A,
			tediId: ID_A,
			roleTemplateId: null,
			roleKey: "cto",
			roleName: "CTO",
			status: "active",
			careerStage: "executive",
			assignedAt: NOW,
			stageChangedAt: NOW,
			endedAt: null,
			revision: 1,
			lastDecisionId: null,
			evidenceSnapshotHash: null,
			metadata: null,
			createdAt: NOW,
			updatedAt: NOW,
		};
		expect(() => TediRoleAssignmentSchema.parse(assignment)).toThrow();
		expect(() =>
			TediRoleAssignmentSchema.parse({
				...assignment,
				careerStage: "shadow",
			}),
		).not.toThrow();
	});

	it("requires independent settlement before a decision can be applied", () => {
		const decision = {
			id: ID_A,
			organizationId: ID_A,
			clientProposalId: "proposal-1",
			inputHash: "sha256:proposal",
			tediId: ID_A,
			roleAssignmentId: ID_B,
			activityId: null,
			kind: "promote",
			status: "applied",
			fromCareerStage: "shadow",
			toCareerStage: "apprentice",
			fromEntrustmentLevel: null,
			fromEntrustmentStatus: null,
			toEntrustmentLevel: null,
			targetRoleTemplateId: null,
			targetRoleKey: null,
			targetRoleName: null,
			targetScope: null,
			targetExpiresAt: null,
			targetNextReviewAt: null,
			expectedRoleRevision: 1,
			expectedEntrustmentRevision: null,
			evidenceObservationIds: [ID_B],
			evidenceRefs: ["artifact://review/1"],
			evidenceSnapshot: {},
			proposedByType: "user",
			proposedById: "user-1",
			decidedByType: "user",
			decidedById: "user-1",
			reason: null,
			createdAt: NOW,
			updatedAt: NOW,
			proposalExpiresAt: NOW,
			decidedAt: NOW,
			appliedAt: NOW,
		};
		expect(() => PromotionDecisionSchema.parse(decision)).toThrow();
		expect(() =>
			PromotionDecisionSchema.parse({
				...decision,
				decidedById: "user-2",
			}),
		).not.toThrow();
		expect(() =>
			PromotionDecisionSchema.parse({
				...decision,
				decidedById: "user-2",
				fromCareerStage: null,
				toCareerStage: null,
			}),
		).toThrow();
		expect(() =>
			PromotionDecisionSchema.parse({
				...decision,
				kind: "restrict",
				decidedById: "user-2",
				roleAssignmentId: null,
				activityId: ID_B,
				fromCareerStage: null,
				toCareerStage: null,
				fromEntrustmentLevel: "autonomous",
				fromEntrustmentStatus: "active",
				evidenceObservationIds: [],
			}),
		).not.toThrow();
		expect(() =>
			PromotionDecisionSchema.parse({
				...decision,
				decidedById: "user-2",
				fromCareerStage: "lead",
				toCareerStage: "apprentice",
			}),
		).toThrow();
		expect(() =>
			PromotionDecisionSchema.parse({
				...decision,
				kind: "raise",
				decidedById: "user-2",
				roleAssignmentId: null,
				activityId: ID_B,
				fromCareerStage: null,
				toCareerStage: null,
				fromEntrustmentLevel: "autonomous",
				fromEntrustmentStatus: "active",
				toEntrustmentLevel: "recommend",
			}),
		).toThrow();
		expect(() =>
			PromotionDecisionSchema.parse({
				...decision,
				kind: "recertify",
				decidedById: "user-2",
				roleAssignmentId: null,
				activityId: ID_B,
				fromCareerStage: null,
				toCareerStage: null,
				fromEntrustmentLevel: null,
				fromEntrustmentStatus: "active",
				toEntrustmentLevel: "delegate",
			}),
		).toThrow();
	});
});
