import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { EvidencePolicy } from "@tedix/api-contract/schemas/earned-delegation";
import type {
	competencyObservationAttestations,
	competencyObservations,
} from "../../schema/earned-delegation";

function mean(values: number[]): number {
	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Conservative 95% Wilson lower bound for a Bernoulli success rate. */
export function wilsonLowerBound(successes: number, total: number): number {
	if (total <= 0) return 0;
	const z = 1.96;
	const proportion = successes / total;
	const z2 = z * z;
	const denominator = 1 + z2 / total;
	const centre = proportion + z2 / (2 * total);
	const margin =
		z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total);
	return Math.max(0, (centre - margin) / denominator);
}

const _VALIDATED_EXPERIENCE_OUTCOME_WEIGHT = {
	success: 1,
	partial: 0.4,
	failure: 0,
	unverified: 0,
} as const;

function _rounded(value: number, digits = 4): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function trustedIndependentAttestation(
	attestation: AttestationForEvaluation,
	observation: ObservationForEvaluation,
): boolean {
	return (
		attestation.independenceVerified &&
		(attestation.principalType === "user" ||
			attestation.principalType === "certification_service") &&
		Boolean(observation.evaluatorType && observation.evaluatorId) &&
		(attestation.principalType !== observation.evaluatorType ||
			attestation.principalId !== observation.evaluatorId)
	);
}

function trustedIndependentSupport(
	attestation: AttestationForEvaluation,
	observation: ObservationForEvaluation,
): boolean {
	return (
		attestation.verdict === "supports" &&
		trustedIndependentAttestation(attestation, observation)
	);
}

function hasCanonicalEvaluationProvenance(
	observation: ObservationForEvaluation,
): boolean {
	return (
		observation.sourceKind === "harness_eval_run" &&
		Boolean(observation.evaluationRunId) &&
		observation.sourceId === observation.evaluationRunId &&
		observation.classificationMethod.startsWith(
			"canonical_harness_eval_run:",
		) &&
		typeof observation.metadata?.experienceClusterId === "string" &&
		observation.metadata.experienceClusterId.length > 0
	);
}

export interface PromotionReadiness extends Record<string, JsonValue> {
	eligible: boolean;
	reasons: string[];
	eligibleObservationIds: string[];
	metrics: {
		verifiedObservations: number;
		distinctVerifierPrincipals: number;
		distinctTaskFamilies: number;
		failureRate: number;
		reliabilityLowerBound: number;
		meanComplexity: number;
		meanCalibration: number;
		meanEscalationQuality: number;
		learningTransferCount: number;
		rejectedObservations: number;
		maximumPolicyViolationSeverity: number;
		meanOwnerReviewMinutes: number;
		meanCostMinorUnits: number;
		costCurrency: string | null;
		mostRecentEvidenceAt: string | null;
		evidenceEnvironments: string[];
		missingTargetEnvironments: string[];
	} & Record<string, JsonValue>;
}

type ObservationForEvaluation = typeof competencyObservations.$inferSelect;
type AttestationForEvaluation =
	typeof competencyObservationAttestations.$inferSelect;
export function evaluatePromotionReadiness(input: {
	policy: EvidencePolicy;
	observations: ObservationForEvaluation[];
	attestations: AttestationForEvaluation[];
	requiredEnvironments?: string[];
	now: string;
}): PromotionReadiness {
	const cutoff = new Date(input.now);
	cutoff.setUTCDate(cutoff.getUTCDate() - input.policy.maximumEvidenceAgeDays);
	const cutoffIso = cutoff.toISOString();
	const attestationsByObservation = new Map<
		string,
		AttestationForEvaluation[]
	>();
	for (const attestation of input.attestations) {
		const list = attestationsByObservation.get(attestation.observationId) ?? [];
		list.push(attestation);
		attestationsByObservation.set(attestation.observationId, list);
	}

	const verifiedCandidates = input.observations.filter((observation) => {
		if (
			observation.executorType !== "tedi" ||
			observation.executorId !== observation.tediId
		)
			return false;
		if (observation.eligibilityStatus !== "eligible") return false;
		if (!observation.proofVerifiedAt || observation.evidenceRefs.length === 0)
			return false;
		if (!observation.evaluatorType || !observation.evaluatorId) return false;
		if (!hasCanonicalEvaluationProvenance(observation)) return false;
		if (observation.occurredAt < cutoffIso) return false;
		if (input.policy.requireNonTrivialWork && !observation.nonTrivial)
			return false;
		const attestations = attestationsByObservation.get(observation.id) ?? [];
		const independentlyReviewed = attestations.some((attestation) =>
			trustedIndependentAttestation(attestation, observation),
		);
		const evaluatorProvenAdverse =
			observation.outcome !== "success" ||
			observation.policyViolationSeverity >
				input.policy.maximumPolicyViolationSeverity;
		return evaluatorProvenAdverse || independentlyReviewed;
	});
	// An execution opportunity is one chance to do the work. Re-running the
	// evaluator (or changing harness versions) may add evidence about that same
	// chance, but must never manufacture another unit of experience. When
	// duplicates exist, retain the most conservative eligible outcome.
	const outcomeSeverity = new Map([
		["failure", 3],
		["partial", 2],
		["success", 1],
		["unverified", 0],
	]);
	const independentlyRejected = (observation: ObservationForEvaluation) =>
		(attestationsByObservation.get(observation.id) ?? []).some(
			(attestation) =>
				attestation.verdict === "rejects" &&
				trustedIndependentAttestation(attestation, observation),
		);
	const evidenceSeverity = (observation: ObservationForEvaluation) => {
		if (
			observation.policyViolationSeverity >
			input.policy.maximumPolicyViolationSeverity
		)
			return 5;
		if (independentlyRejected(observation)) return 4;
		return outcomeSeverity.get(observation.outcome) ?? 0;
	};
	const observationsByOpportunity = new Map<string, ObservationForEvaluation>();
	for (const observation of verifiedCandidates) {
		const existing = observationsByOpportunity.get(
			observation.executionOpportunityId,
		);
		if (
			!existing ||
			evidenceSeverity(observation) > evidenceSeverity(existing)
		) {
			observationsByOpportunity.set(
				observation.executionOpportunityId,
				observation,
			);
		}
	}
	const eligibleObservations = [...observationsByOpportunity.values()];

	const verifierPrincipals = new Set<string>();
	for (const observation of eligibleObservations) {
		for (const attestation of attestationsByObservation.get(observation.id) ??
			[]) {
			if (trustedIndependentSupport(attestation, observation)) {
				verifierPrincipals.add(
					`${attestation.principalType}:${attestation.principalId}`,
				);
			}
		}
	}
	const successes = eligibleObservations.filter(
		(observation) =>
			observation.outcome === "success" &&
			!independentlyRejected(observation) &&
			observation.policyViolationSeverity <=
				input.policy.maximumPolicyViolationSeverity,
	).length;
	const failures = eligibleObservations.length - successes;
	const failureRate =
		eligibleObservations.length === 0
			? 1
			: failures / eligibleObservations.length;
	const reliabilityLowerBound = wilsonLowerBound(
		successes,
		eligibleObservations.length,
	);
	const taskFamilies = new Set(
		eligibleObservations.map((observation) => observation.taskFamily),
	);
	const calibrations = eligibleObservations
		.map((observation) => observation.calibrationScore)
		.filter((value): value is number => value != null);
	const escalations = eligibleObservations
		.map((observation) => observation.escalationQuality)
		.filter((value): value is number => value != null);
	const currencies = new Set(
		eligibleObservations
			.map((observation) => observation.costCurrency)
			.filter((value): value is string => value != null),
	);
	const evidenceEnvironments = [
		...new Set(
			eligibleObservations.map((observation) => observation.environment),
		),
	].sort();
	const evidenceEnvironmentSet = new Set(evidenceEnvironments);
	const missingTargetEnvironments = [
		...new Set(input.requiredEnvironments ?? []),
	]
		.filter((environment) => !evidenceEnvironmentSet.has(environment))
		.sort();
	const metrics: PromotionReadiness["metrics"] = {
		verifiedObservations: eligibleObservations.length,
		distinctVerifierPrincipals: verifierPrincipals.size,
		distinctTaskFamilies: taskFamilies.size,
		failureRate,
		reliabilityLowerBound,
		meanComplexity: mean(
			eligibleObservations.map((observation) => observation.complexity),
		),
		meanCalibration: mean(calibrations),
		meanEscalationQuality: mean(escalations),
		learningTransferCount: eligibleObservations.filter(
			(observation) => observation.learningTransfer === true,
		).length,
		rejectedObservations: eligibleObservations.filter(independentlyRejected)
			.length,
		maximumPolicyViolationSeverity: Math.max(
			0,
			...eligibleObservations.map(
				(observation) => observation.policyViolationSeverity,
			),
		),
		meanOwnerReviewMinutes: mean(
			eligibleObservations
				.map((observation) => observation.ownerReviewMinutes)
				.filter((value): value is number => value != null),
		),
		meanCostMinorUnits:
			currencies.size <= 1
				? mean(
						eligibleObservations
							.map((observation) => observation.costMinorUnits)
							.filter((value): value is number => value != null),
					)
				: 0,
		costCurrency: currencies.size === 1 ? [...currencies][0]! : null,
		mostRecentEvidenceAt:
			eligibleObservations
				.map((observation) => observation.occurredAt)
				.sort()
				.at(-1) ?? null,
		evidenceEnvironments,
		missingTargetEnvironments,
	};

	const reasons: string[] = [];
	if (metrics.verifiedObservations < input.policy.minimumVerifiedObservations)
		reasons.push("insufficient verified observations");
	if (
		metrics.distinctVerifierPrincipals <
		input.policy.minimumDistinctVerifierPrincipals
	)
		reasons.push("insufficient independent verifier principals");
	if (metrics.distinctTaskFamilies < input.policy.minimumTaskFamilies)
		reasons.push("insufficient task-family diversity");
	if (metrics.failureRate > input.policy.maximumFailureRate)
		reasons.push("failure rate exceeds policy");
	if (metrics.rejectedObservations > 0)
		reasons.push("independent verifier rejected evidence");
	if (
		metrics.maximumPolicyViolationSeverity >
		input.policy.maximumPolicyViolationSeverity
	)
		reasons.push("policy violation severity exceeds policy");
	if (metrics.reliabilityLowerBound < input.policy.minimumReliabilityLowerBound)
		reasons.push("reliability lower bound is below policy");
	if (metrics.meanComplexity < input.policy.minimumMeanComplexity)
		reasons.push("mean complexity is below policy");
	if (metrics.meanCalibration < input.policy.minimumCalibrationScore)
		reasons.push("calibration is below policy");
	if (metrics.meanEscalationQuality < input.policy.minimumEscalationQuality)
		reasons.push("escalation quality is below policy");
	if (
		input.policy.requireLearningTransfer &&
		metrics.learningTransferCount === 0
	)
		reasons.push("no verified learning transfer");
	if (metrics.missingTargetEnvironments.length > 0)
		reasons.push(
			`missing verified evidence for target environments: ${metrics.missingTargetEnvironments.join(", ")}`,
		);

	return {
		eligible: reasons.length === 0,
		reasons,
		eligibleObservationIds: eligibleObservations.map(
			(observation) => observation.id,
		),
		metrics,
	};
}
