import type { ValidatedExperience } from "@tedix/api-contract/schemas/earned-delegation";
import {
	VALIDATED_EXPERIENCE_FAMILY_CAP_UNITS,
	VALIDATED_EXPERIENCE_FORMULA_VERSION,
	VALIDATED_EXPERIENCE_POINTS_PER_UNIT,
	VALIDATED_EXPERIENCE_TOTAL_CAP_UNITS,
} from "@tedix/api-contract/schemas/earned-delegation";
import type {
	competencyObservationAttestations,
	competencyObservations,
} from "../../schema/earned-delegation";

type ObservationForEvaluation = typeof competencyObservations.$inferSelect;
type AttestationForEvaluation =
	typeof competencyObservationAttestations.$inferSelect;
function mean(values: number[]): number {
	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

const VALIDATED_EXPERIENCE_OUTCOME_WEIGHT = {
	success: 1,
	partial: 0.4,
	failure: 0,
	unverified: 0,
} as const;

function rounded(value: number, digits = 4): number {
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

function validatedExperienceUnits(
	observation: ObservationForEvaluation,
): number {
	const outcomeWeight =
		VALIDATED_EXPERIENCE_OUTCOME_WEIGHT[observation.outcome];
	if (outcomeWeight === 0) return 0;
	// Easy work can demonstrate something, but cannot score like difficult work.
	const complexityWeight = 0.25 + 0.75 * observation.complexity;
	// These are evaluator-owned measures. They scale evidence quality without
	// allowing any one dimension or a second reviewer to manufacture a new unit.
	const qualityWeight = mean([
		observation.confidence,
		observation.calibrationScore,
		observation.escalationQuality,
	]);
	return Math.min(1, outcomeWeight * complexityWeight * qualityWeight);
}

/**
 * Compute explanatory career progress from independently verified work.
 *
 * One execution opportunity contributes at most one unit, regardless of
 * evaluator reruns, activity labels, sessions, or reviewer count. Each task
 * family saturates after five units and the whole profile after thirty. The
 * score is therefore useful as a progress visualization but deliberately has
 * no authority effect; entrustment readiness is evaluated separately.
 */
export function evaluateValidatedExperience(input: {
	observations: ObservationForEvaluation[];
	attestations: AttestationForEvaluation[];
	truncated?: boolean;
}): ValidatedExperience {
	const attestationsByObservation = new Map<
		string,
		AttestationForEvaluation[]
	>();
	for (const attestation of input.attestations) {
		const rows = attestationsByObservation.get(attestation.observationId) ?? [];
		rows.push(attestation);
		attestationsByObservation.set(attestation.observationId, rows);
	}
	const independentlyRejected = (observation: ObservationForEvaluation) =>
		(attestationsByObservation.get(observation.id) ?? []).some(
			(attestation) =>
				attestation.verdict === "rejects" &&
				trustedIndependentAttestation(attestation, observation),
		);
	const supportingPrincipalCount = (observation: ObservationForEvaluation) =>
		new Set(
			(attestationsByObservation.get(observation.id) ?? [])
				.filter((attestation) =>
					trustedIndependentSupport(attestation, observation),
				)
				.map(
					(attestation) =>
						`${attestation.principalType}:${attestation.principalId}`,
				),
		).size;
	const creditedUnits = (observation: ObservationForEvaluation) => {
		const experienceClusterId = observation.metadata?.experienceClusterId;
		if (
			typeof experienceClusterId !== "string" ||
			experienceClusterId.length === 0 ||
			observation.policyViolationSeverity > 0 ||
			independentlyRejected(observation) ||
			supportingPrincipalCount(observation) < 2
		)
			return 0;
		return validatedExperienceUnits(observation);
	};

	const candidates = input.observations.filter((observation) => {
		if (
			observation.executorType !== "tedi" ||
			observation.executorId !== observation.tediId ||
			observation.eligibilityStatus !== "eligible" ||
			!observation.proofVerifiedAt ||
			observation.evidenceRefs.length === 0 ||
			!observation.nonTrivial ||
			!observation.heldOut ||
			!observation.evaluationRunId ||
			!observation.evaluatorType ||
			!observation.evaluatorId ||
			!hasCanonicalEvaluationProvenance(observation)
		)
			return false;
		const attestations = attestationsByObservation.get(observation.id) ?? [];
		const independentlyReviewed = attestations.some((attestation) =>
			trustedIndependentAttestation(attestation, observation),
		);
		const evaluatorProvenAdverse =
			observation.outcome !== "success" ||
			observation.policyViolationSeverity > 0;
		return evaluatorProvenAdverse || independentlyReviewed;
	});

	// Keep the most conservative independently validated representation of an
	// opportunity. A later evaluator run can lower credit, never multiply it.
	const outcomeSeverity = new Map([
		["failure", 3],
		["partial", 2],
		["success", 1],
		["unverified", 0],
	]);
	const evidenceSeverity = (observation: ObservationForEvaluation) => {
		if (observation.policyViolationSeverity > 0) return 5;
		if (independentlyRejected(observation)) return 4;
		return outcomeSeverity.get(observation.outcome) ?? 0;
	};
	const byOpportunity = new Map<string, ObservationForEvaluation>();
	for (const observation of candidates) {
		const existing = byOpportunity.get(observation.executionOpportunityId);
		const observationSeverity = evidenceSeverity(observation);
		const existingSeverity = existing ? evidenceSeverity(existing) : -1;
		if (
			!existing ||
			observationSeverity > existingSeverity ||
			(observationSeverity === existingSeverity &&
				creditedUnits(observation) < creditedUnits(existing))
		) {
			byOpportunity.set(observation.executionOpportunityId, observation);
		}
	}

	const clusterTotals = new Map<
		string,
		{
			uncappedUnits: number;
			taskFamily: string;
			creditedOpportunities: number;
		}
	>();
	for (const observation of byOpportunity.values()) {
		const units = creditedUnits(observation);
		if (units > 0) {
			const clusterId = observation.metadata?.experienceClusterId as string;
			const current = clusterTotals.get(clusterId) ?? {
				uncappedUnits: 0,
				taskFamily: observation.taskFamily,
				creditedOpportunities: 0,
			};
			current.uncappedUnits += units;
			current.taskFamily = [
				current.taskFamily,
				observation.taskFamily,
			].sort()[0]!;
			current.creditedOpportunities += 1;
			clusterTotals.set(clusterId, current);
		}
	}
	const familyTotals = new Map<
		string,
		{ uncappedUnits: number; creditedOpportunities: number }
	>();
	for (const cluster of clusterTotals.values()) {
		const current = familyTotals.get(cluster.taskFamily) ?? {
			uncappedUnits: 0,
			creditedOpportunities: 0,
		};
		current.uncappedUnits += Math.min(1, cluster.uncappedUnits);
		current.creditedOpportunities += cluster.creditedOpportunities;
		familyTotals.set(cluster.taskFamily, current);
	}

	const taskFamilies = [...familyTotals.entries()]
		.map(([taskFamily, totals]) => {
			const uncappedUnits = rounded(totals.uncappedUnits);
			const validatedUnits = rounded(
				Math.min(VALIDATED_EXPERIENCE_FAMILY_CAP_UNITS, uncappedUnits),
			);
			return {
				taskFamily,
				points: Math.round(
					validatedUnits * VALIDATED_EXPERIENCE_POINTS_PER_UNIT,
				),
				maxPoints: 500 as const,
				validatedUnits,
				uncappedUnits,
				creditedOpportunities: totals.creditedOpportunities,
				saturated: uncappedUnits >= VALIDATED_EXPERIENCE_FAMILY_CAP_UNITS,
			};
		})
		.sort((a, b) => a.taskFamily.localeCompare(b.taskFamily));
	const uncappedUnits = rounded(
		taskFamilies.reduce((sum, family) => sum + family.uncappedUnits, 0),
	);
	const validatedUnits = rounded(
		Math.min(
			VALIDATED_EXPERIENCE_TOTAL_CAP_UNITS,
			taskFamilies.reduce((sum, family) => sum + family.validatedUnits, 0),
		),
	);
	const lastValidatedAt = [...byOpportunity.values()]
		.filter((observation) => creditedUnits(observation) > 0)
		.map((observation) => observation.occurredAt)
		.sort()
		.at(-1);
	const negativeOpportunities = [...byOpportunity.values()].filter(
		(observation) =>
			observation.outcome === "failure" ||
			observation.outcome === "partial" ||
			independentlyRejected(observation) ||
			observation.policyViolationSeverity > 0,
	).length;
	const maximumPolicyViolationSeverity = Math.max(
		0,
		...[...byOpportunity.values()].map(
			(observation) => observation.policyViolationSeverity,
		),
	);
	const standing =
		maximumPolicyViolationSeverity > 0
			? ("blocked" as const)
			: negativeOpportunities > 0
				? ("contested" as const)
				: ("clear" as const);

	return {
		formulaVersion: VALIDATED_EXPERIENCE_FORMULA_VERSION,
		descriptiveOnly: true,
		authorityEffect: "none",
		provisional: true,
		limitations: [
			"Issued-opportunity coverage is not yet measured; points may reflect selective evidence.",
			...(standing !== "clear"
				? [
						"Negative evidence remains visible and cannot be offset by points; resolve it through independently verified remediation.",
					]
				: []),
			...(input.truncated
				? ["Only the most recent bounded evidence window was scanned."]
				: []),
		],
		points: Math.round(validatedUnits * VALIDATED_EXPERIENCE_POINTS_PER_UNIT),
		maxPoints: 3000 as const,
		validatedUnits,
		uncappedUnits,
		creditedOpportunities: [...byOpportunity.values()].filter(
			(observation) => creditedUnits(observation) > 0,
		).length,
		negativeOpportunities,
		maximumPolicyViolationSeverity,
		standing,
		observationsEvaluated: input.observations.length,
		truncated: input.truncated ?? false,
		saturated: validatedUnits >= VALIDATED_EXPERIENCE_TOTAL_CAP_UNITS,
		lastValidatedAt: lastValidatedAt ?? null,
		taskFamilies,
	};
}

/**
 * Compute the observed value-per-supervision signal from the same canonical,
 * independently supported evidence used by earned delegation. Currency is
 * never converted or combined; coverage remains explicitly provisional.
 */
