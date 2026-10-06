import { describe, expect, it } from "vite-plus/test";
import type {
	CompetencyObservationAttestationRow,
	CompetencyObservationRow,
} from "../schema/earned-delegation";
import { scopeFitsActivityDefinition } from "./earned-delegation/authority-policy";
import { evaluateDelegationYield } from "./earned-delegation/delegation-yield";
import {
	evaluatePromotionReadiness,
	wilsonLowerBound,
} from "./earned-delegation/promotion-readiness";
import { evaluateValidatedExperience } from "./earned-delegation/validated-experience";

const NOW = "2026-07-20T00:00:00.000Z";

function observation(
	id: string,
	overrides: Partial<CompetencyObservationRow> = {},
): CompetencyObservationRow {
	return {
		id,
		organizationId: "org-1",
		tediId: "tedi-1",
		executorType: "tedi",
		executorId: "tedi-1",
		activityId: "activity-1",
		clientObservationId: `client-${id}`,
		inputHash: `sha256:${id}`,
		executionOpportunityId: `episode-${id}`,
		workItemId: `work-${id}`,
		sourceKind: "harness_eval_run",
		sourceId: `eval-${id}`,
		traceBundleId: null,
		rationaleId: null,
		taskFamily: Number(id.at(-1)) % 2 === 0 ? "research" : "delivery",
		riskLevel: "medium",
		environment: "production",
		rubricVersion: 1,
		harness: "agent",
		harnessVersion: "harness-1",
		modelProvider: "openai",
		modelId: "gpt",
		modelVersion: "1",
		outcome: "success",
		complexity: 0.6,
		nonTrivial: true,
		heldOut: true,
		calibrationScore: 0.9,
		escalationQuality: 0.8,
		learningTransfer: true,
		evidenceRefs: [`artifact://${id}`],
		eligibilityStatus: "eligible",
		evaluatorType: "api_key",
		evaluatorId: "evaluator-key-1",
		classificationMethod: "canonical_harness_eval_run:locked-test",
		evaluationRunId: `eval-${id}`,
		proofVerifiedAt: NOW,
		costMinorUnits: 100,
		costCurrency: "USD",
		durationMs: 1000,
		ownerReviewMinutes: 1,
		policyViolationSeverity: 0,
		confidence: 0.9,
		metadata: {
			experienceClusterId: `cluster-${id}`,
			verifiedValueMinorUnits: 1_000,
			verifiedValueCurrency: "USD",
			verifiedValueEventId: `value-${id}`,
			verifiedValueEvidenceRef: `ledger://${id}`,
		},
		occurredAt: "2026-07-19T00:00:00.000Z",
		createdAt: NOW,
		...overrides,
	};
}

function attestation(
	observationId: string,
	principalId: string,
	verdict: "supports" | "rejects" = "supports",
): CompetencyObservationAttestationRow {
	return {
		id: `${observationId}-${principalId}`,
		organizationId: "org-1",
		observationId,
		principalType: "user",
		principalId,
		verdict,
		verificationMethod: "review",
		independenceVerified: true,
		authenticatedAt: NOW,
		createdAt: NOW,
	};
}

const POLICY = {
	minimumVerifiedObservations: 5,
	minimumDistinctVerifierPrincipals: 2,
	maximumFailureRate: 0.2,
	maximumPolicyViolationSeverity: 0,
	maximumEvidenceAgeDays: 90,
	requireNonTrivialWork: true,
	minimumReliabilityLowerBound: 0.5,
	minimumMeanComplexity: 0.25,
	minimumTaskFamilies: 2,
	minimumCalibrationScore: 0.7,
	minimumEscalationQuality: 0.7,
	requireLearningTransfer: true,
} as const;

describe("earned delegation evidence", () => {
	it("computes verified value per owner review hour without mixing currencies", () => {
		const usd = observation("obs-usd", {
			ownerReviewMinutes: 30,
			metadata: {
				experienceClusterId: "cluster-usd",
				verifiedValueMinorUnits: 12_000,
				verifiedValueCurrency: "USD",
				verifiedValueEventId: "value-usd",
				verifiedValueEvidenceRef: "ledger://usd",
			},
		});
		const eur = observation("obs-eur", {
			ownerReviewMinutes: 15,
			costMinorUnits: 80,
			costCurrency: "EUR",
			metadata: {
				experienceClusterId: "cluster-eur",
				verifiedValueMinorUnits: 5_000,
				verifiedValueCurrency: "EUR",
				verifiedValueEventId: "value-eur",
				verifiedValueEvidenceRef: "ledger://eur",
			},
		});
		const rows = [usd, eur];
		const result = evaluateDelegationYield({
			observations: rows,
			attestations: rows.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
		});
		expect(result).toMatchObject({
			metric: "verified_value_per_owner_review_hour",
			authorityEffect: "none",
			measurementStatus: "measured",
			coverage: "observed_issued_work_items_only",
			observedOpportunities: 2,
			issuedOpportunities: 2,
			reviewedOpportunities: 2,
			valueCertifiedOpportunities: 2,
			ownerReviewMinutes: 45,
		});
		expect(result.valueByCurrency).toEqual([
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
		]);
		expect(result.costByCurrency).toEqual([
			{ currency: "EUR", costMinorUnits: 80 },
			{ currency: "USD", costMinorUnits: 100 },
		]);
	});

	it("keeps yield partial and excludes adverse or unsupported evidence", () => {
		const measured = observation("obs-measured", {
			metadata: {
				experienceClusterId: "cluster-measured",
				verifiedValueMinorUnits: 1_000,
				verifiedValueCurrency: "USD",
				verifiedValueEventId: "value-measured",
				verifiedValueEvidenceRef: "ledger://measured",
			},
		});
		const missingValue = observation("obs-missing", {
			metadata: { experienceClusterId: "cluster-missing" },
		});
		const failed = observation("obs-failed", {
			outcome: "failure",
			metadata: {
				experienceClusterId: "cluster-failed",
				verifiedValueMinorUnits: 50_000,
				verifiedValueCurrency: "USD",
				verifiedValueEventId: "value-failed",
				verifiedValueEvidenceRef: "ledger://failed",
			},
		});
		const unsupported = observation("obs-unsupported", {
			metadata: {
				experienceClusterId: "cluster-unsupported",
				verifiedValueMinorUnits: 50_000,
				verifiedValueCurrency: "USD",
				verifiedValueEventId: "value-unsupported",
				verifiedValueEvidenceRef: "ledger://unsupported",
			},
		});
		const reviewed = [measured, missingValue, failed];
		const result = evaluateDelegationYield({
			observations: [...reviewed, unsupported],
			attestations: reviewed.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
			truncated: true,
		});
		expect(result).toMatchObject({
			measurementStatus: "partial",
			observedOpportunities: 4,
			issuedOpportunities: 4,
			reviewedOpportunities: 3,
			valueCertifiedOpportunities: 2,
			truncated: true,
		});
		expect(result.valueByCurrency[0]).toMatchObject({
			verifiedValueMinorUnits: 1_000,
		});
	});

	it("does not manufacture an infinite yield from zero review time", () => {
		const zeroReview = observation("obs-zero-review", {
			ownerReviewMinutes: 0,
			metadata: {
				experienceClusterId: "cluster-zero-review",
				verifiedValueMinorUnits: 10_000,
				verifiedValueCurrency: "USD",
				verifiedValueEventId: "value-zero-review",
				verifiedValueEvidenceRef: "ledger://zero-review",
			},
		});
		const result = evaluateDelegationYield({
			observations: [zeroReview],
			attestations: [
				attestation(zeroReview.id, "reviewer-1"),
				attestation(zeroReview.id, "reviewer-2"),
			],
		});
		expect(result).toMatchObject({
			measurementStatus: "unmeasured",
			observedOpportunities: 1,
			issuedOpportunities: 1,
			reviewedOpportunities: 1,
			valueCertifiedOpportunities: 0,
			ownerReviewMinutes: 0,
			valueByCurrency: [],
		});
		expect(result.costByCurrency).toEqual([
			{ currency: "USD", costMinorUnits: 100 },
		]);
	});

	it("retains adverse review time and cost as zero value", () => {
		const success = observation("obs-value-success", {
			ownerReviewMinutes: 1,
		});
		const failure = observation("obs-value-failure", {
			outcome: "failure",
			ownerReviewMinutes: 100,
		});
		const rows = [success, failure];
		const result = evaluateDelegationYield({
			observations: rows,
			attestations: rows.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
		});
		expect(result).toMatchObject({
			measurementStatus: "measured",
			issuedOpportunities: 2,
			valueCertifiedOpportunities: 2,
			ownerReviewMinutes: 101,
		});
		expect(result.valueByCurrency).toEqual([
			{
				currency: "USD",
				verifiedValueMinorUnits: 1_000,
				ownerReviewMinutes: 101,
				valuePerOwnerReviewHourMinorUnits: 594,
			},
		]);
		expect(result.costByCurrency).toEqual([
			{ currency: "USD", costMinorUnits: 200 },
		]);
	});

	it("counts one value event once across repeated eval runs", () => {
		const first = observation("obs-replay-1", {
			workItemId: "work-replayed",
			ownerReviewMinutes: 10,
			metadata: {
				experienceClusterId: "cluster-replayed",
				verifiedValueMinorUnits: 2_000,
				verifiedValueCurrency: "USD",
				verifiedValueEventId: "value-replayed",
				verifiedValueEvidenceRef: "ledger://replayed",
			},
		});
		const second = observation("obs-replay-2", {
			workItemId: "work-replayed",
			ownerReviewMinutes: 20,
			metadata: first.metadata,
		});
		const rows = [first, second];
		const result = evaluateDelegationYield({
			observations: rows,
			attestations: rows.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
		});
		expect(result).toMatchObject({
			observedOpportunities: 2,
			issuedOpportunities: 1,
			valueCertifiedOpportunities: 1,
			ownerReviewMinutes: 30,
		});
		expect(result.valueByCurrency[0]).toMatchObject({
			verifiedValueMinorUnits: 2_000,
			ownerReviewMinutes: 30,
			valuePerOwnerReviewHourMinorUnits: 4_000,
		});
	});

	it("withholds yield when one value event is claimed by two Work Items", () => {
		const first = observation("obs-duplicate-value-1", {
			metadata: {
				experienceClusterId: "cluster-duplicate-1",
				verifiedValueMinorUnits: 2_000,
				verifiedValueCurrency: "USD",
				verifiedValueEventId: "duplicated-value-event",
				verifiedValueEvidenceRef: "ledger://duplicated",
			},
		});
		const second = observation("obs-duplicate-value-2", {
			metadata: {
				...first.metadata,
				experienceClusterId: "cluster-duplicate-2",
			},
		});
		const rows = [first, second];
		const result = evaluateDelegationYield({
			observations: rows,
			attestations: rows.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
		});
		expect(result).toMatchObject({
			measurementStatus: "unmeasured",
			issuedOpportunities: 2,
			valueCertifiedOpportunities: 0,
		});
		expect(result.valueByCurrency).toEqual([]);
	});

	it("computes bounded descriptive experience without granting authority", () => {
		const row = observation("obs-1");
		const score = evaluateValidatedExperience({
			observations: [row],
			attestations: [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			],
		});
		expect(score).toMatchObject({
			formulaVersion: "validated-experience-v1",
			descriptiveOnly: true,
			authorityEffect: "none",
			provisional: true,
			maxPoints: 3000,
			creditedOpportunities: 1,
			truncated: false,
		});
		expect(score.points).toBe(61);
		expect(score.taskFamilies[0]).toMatchObject({
			maxPoints: 500,
			points: 61,
		});
	});

	it("selects the worst representation of one opportunity", () => {
		const success = observation("obs-success", {
			executionOpportunityId: "same-opportunity",
		});
		const failure = observation("obs-failure", {
			executionOpportunityId: "same-opportunity",
			outcome: "failure",
		});
		const rows = [success, failure];
		const score = evaluateValidatedExperience({
			observations: rows,
			attestations: rows.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
		});
		expect(score.points).toBe(0);
		expect(score.creditedOpportunities).toBe(0);
	});

	it("cannot hide a rejected or policy-violating duplicate behind a success", () => {
		const success = observation("obs-success", {
			executionOpportunityId: "same-opportunity",
		});
		const rejected = observation("obs-rejected", {
			executionOpportunityId: "same-opportunity",
		});
		const policyViolation = observation("obs-policy", {
			executionOpportunityId: "same-opportunity",
			policyViolationSeverity: 3,
		});
		const rows = [success, rejected, policyViolation];
		const score = evaluateValidatedExperience({
			observations: rows,
			attestations: [
				...rows.flatMap((row) => [
					attestation(row.id, "reviewer-1"),
					attestation(row.id, "reviewer-2"),
				]),
				attestation(rejected.id, "reviewer-3", "rejects"),
			],
		});
		expect(score.points).toBe(0);
		expect(score.creditedOpportunities).toBe(0);
	});

	it("requires evaluator provenance and two independent trusted supporters", () => {
		const row = observation("obs-1");
		const oneReviewer = evaluateValidatedExperience({
			observations: [row],
			attestations: [attestation(row.id, "reviewer-1")],
		});
		const legacy = evaluateValidatedExperience({
			observations: [{ ...row, evaluatorType: null, evaluatorId: null }],
			attestations: [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			],
		});
		expect(oneReviewer.points).toBe(0);
		expect(legacy.points).toBe(0);
	});

	it("never credits external execution to a tedi", () => {
		const row = observation("obs-1", {
			executorType: "external_agent",
			executorId: "codex-principal",
		});
		const score = evaluateValidatedExperience({
			observations: [row],
			attestations: [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			],
		});
		expect(score.points).toBe(0);
	});

	it("saturates repeated work per family and across the profile", () => {
		const rows = Array.from({ length: 42 }, (_, index) =>
			observation(`obs-${index}`, {
				taskFamily: `family-${Math.floor(index / 6)}`,
				complexity: 1,
				confidence: 1,
				calibrationScore: 1,
				escalationQuality: 1,
				policyViolationSeverity: index === 41 ? 4 : 0,
			}),
		);
		const score = evaluateValidatedExperience({
			observations: rows,
			attestations: rows.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
		});
		expect(score.points).toBe(3000);
		expect(score.saturated).toBe(true);
		expect(score.standing).toBe("blocked");
		expect(score.negativeOpportunities).toBe(1);
		expect(score.maximumPolicyViolationSeverity).toBe(4);
		expect(score.taskFamilies).toHaveLength(7);
		expect(score.taskFamilies.every((family) => family.points === 500)).toBe(
			true,
		);
	});

	it("caps repeated easy work at one equivalent-task cluster", () => {
		const rows = Array.from({ length: 100 }, (_, index) =>
			observation(`obs-easy-${index}`, {
				complexity: 0,
				metadata: { experienceClusterId: "same-easy-task" },
			}),
		);
		const score = evaluateValidatedExperience({
			observations: rows,
			attestations: rows.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
		});
		expect(score.points).toBeLessThanOrEqual(100);
		expect(score.validatedUnits).toBeLessThanOrEqual(1);
	});

	it("uses a conservative reliability lower bound", () => {
		expect(wilsonLowerBound(5, 5)).toBeGreaterThan(0.5);
		expect(wilsonLowerBound(4, 5)).toBeLessThan(0.5);
	});

	it("qualifies only corroborated, diverse, recent verified work", () => {
		const observations = [1, 2, 3, 4, 5].map((index) =>
			observation(`obs-${index}`),
		);
		const attestations = observations.flatMap((row) => [
			attestation(row.id, "reviewer-1"),
			attestation(row.id, "reviewer-2"),
		]);
		const readiness = evaluatePromotionReadiness({
			policy: POLICY,
			observations,
			attestations,
			now: NOW,
		});
		expect(readiness.eligible).toBe(true);
		expect(readiness.metrics.distinctVerifierPrincipals).toBe(2);
		expect(readiness.metrics.distinctTaskFamilies).toBe(2);
	});

	it("requires verified evidence in every requested authority environment", () => {
		const observations = [1, 2, 3, 4, 5].map((index) =>
			observation(`obs-${index}`, { environment: "staging" }),
		);
		const readiness = evaluatePromotionReadiness({
			policy: POLICY,
			observations,
			attestations: observations.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
			requiredEnvironments: ["staging", "production"],
			now: NOW,
		});
		expect(readiness.eligible).toBe(false);
		expect(readiness.metrics.evidenceEnvironments).toEqual(["staging"]);
		expect(readiness.metrics.missingTargetEnvironments).toEqual(["production"]);
		expect(readiness.reasons).toContain(
			"missing verified evidence for target environments: production",
		);
	});

	it("counts one execution opportunity once across repeated evaluations", () => {
		const observations = [1, 2, 3, 4, 5].map((index) =>
			observation(`obs-${index}`, {
				executionOpportunityId: index === 5 ? "episode-4" : `episode-${index}`,
			}),
		);
		const readiness = evaluatePromotionReadiness({
			policy: POLICY,
			observations,
			attestations: observations.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
			now: NOW,
		});
		expect(readiness.eligible).toBe(false);
		expect(readiness.metrics.verifiedObservations).toBe(4);
		expect(readiness.reasons).toContain("insufficient verified observations");
	});

	it("does not credit external-agent work to the accountable tedi", () => {
		const observations = [1, 2, 3, 4, 5].map((index) =>
			observation(`obs-${index}`, {
				executorType: index === 5 ? "external_agent" : "tedi",
				executorId: index === 5 ? "codex-principal" : "tedi-1",
			}),
		);
		const readiness = evaluatePromotionReadiness({
			policy: POLICY,
			observations,
			attestations: observations.flatMap((row) => [
				attestation(row.id, "reviewer-1"),
				attestation(row.id, "reviewer-2"),
			]),
			now: NOW,
		});
		expect(readiness.eligible).toBe(false);
		expect(readiness.metrics.verifiedObservations).toBe(4);
	});

	it("does not count external-agent or API-key recommendations as independent promotion authority", () => {
		const observations = [1, 2, 3, 4, 5].map((index) =>
			observation(`obs-${index}`),
		);
		const attestations = observations.flatMap((row) => [
			{
				...attestation(row.id, "agent-1"),
				principalType: "external_agent" as const,
			},
			{ ...attestation(row.id, "key-1"), principalType: "api_key" as const },
		]);
		const readiness = evaluatePromotionReadiness({
			policy: POLICY,
			observations,
			attestations,
			now: NOW,
		});
		expect(readiness.eligible).toBe(false);
		expect(readiness.metrics.verifiedObservations).toBe(0);
		expect(readiness.metrics.distinctVerifierPrincipals).toBe(0);
	});

	it("does not launder externally attested observations through two trusted verifiers on one episode", () => {
		const observations = [1, 2, 3, 4, 5].map((index) =>
			observation(`obs-${index}`),
		);
		const attestations = observations.flatMap((row, index) =>
			index === 0
				? [attestation(row.id, "reviewer-1"), attestation(row.id, "reviewer-2")]
				: [
						{
							...attestation(row.id, `agent-${index}`),
							principalType: "external_agent" as const,
						},
					],
		);
		const readiness = evaluatePromotionReadiness({
			policy: POLICY,
			observations,
			attestations,
			now: NOW,
		});
		expect(readiness.eligible).toBe(false);
		expect(readiness.metrics.verifiedObservations).toBe(1);
	});

	it("keeps proposed authority inside the evaluated activity", () => {
		const activity = {
			actionPatterns: ["kernel.receive_delegation", "reports.draft"],
			toolIds: ["get_report"],
		};
		expect(
			scopeFitsActivityDefinition(
				{
					actions: ["kernel.receive_delegation"],
					toolIds: ["get_report"],
					environments: ["production"],
					spendPermission: "none",
					budgetPolicyId: null,
					constraints: {},
				},
				activity,
			),
		).toEqual({ actions: true, tools: true });
		expect(
			scopeFitsActivityDefinition(
				{
					actions: ["payments.send"],
					toolIds: ["send_payment"],
					environments: ["production"],
					spendPermission: "none",
					budgetPolicyId: null,
					constraints: {},
				},
				activity,
			),
		).toEqual({ actions: false, tools: false });
	});

	it("fails closed on rejection, missing proof, or reliability regression", () => {
		const observations = [1, 2, 3, 4, 5].map((index) =>
			observation(`obs-${index}`, {
				outcome: index === 5 ? "failure" : "success",
				evidenceRefs: index === 4 ? [] : [`artifact://obs-${index}`],
			}),
		);
		const attestations = observations.flatMap((row) => [
			attestation(row.id, "reviewer-1"),
			attestation(
				row.id,
				"reviewer-2",
				row.id === "obs-3" ? "rejects" : "supports",
			),
		]);
		const readiness = evaluatePromotionReadiness({
			policy: POLICY,
			observations,
			attestations,
			now: NOW,
		});
		expect(readiness.eligible).toBe(false);
		expect(readiness.metrics.verifiedObservations).toBe(4);
		expect(readiness.reasons).toContain("insufficient verified observations");
		expect(readiness.reasons).toContain(
			"independent verifier rejected evidence",
		);
	});

	it("keeps policy violations in the readiness cohort as blockers", () => {
		const observations = [1, 2, 3, 4, 5, 6].map((index) =>
			observation(`obs-${index}`, {
				policyViolationSeverity: index === 6 ? 5 : 0,
			}),
		);
		const readiness = evaluatePromotionReadiness({
			policy: POLICY,
			observations,
			attestations: observations
				.slice(0, 5)
				.flatMap((row) => [
					attestation(row.id, "reviewer-1"),
					attestation(row.id, "reviewer-2"),
				]),
			now: NOW,
		});
		const score = evaluateValidatedExperience({
			observations,
			attestations: observations
				.slice(0, 5)
				.flatMap((row) => [
					attestation(row.id, "reviewer-1"),
					attestation(row.id, "reviewer-2"),
				]),
		});
		expect(readiness.eligible).toBe(false);
		expect(readiness.metrics.verifiedObservations).toBe(6);
		expect(readiness.metrics.maximumPolicyViolationSeverity).toBe(5);
		expect(readiness.reasons).toContain(
			"policy violation severity exceeds policy",
		);
		expect(score.standing).toBe("blocked");
		expect(score.maximumPolicyViolationSeverity).toBe(5);
	});
});
