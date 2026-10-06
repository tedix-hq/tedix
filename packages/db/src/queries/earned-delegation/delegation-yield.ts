import type { DelegationYield } from "@tedix/api-contract/schemas/earned-delegation";
import type {
	competencyObservationAttestations,
	competencyObservations,
	delegationValueClaims,
} from "../../schema/earned-delegation";

type ObservationForEvaluation = typeof competencyObservations.$inferSelect;
type AttestationForEvaluation =
	typeof competencyObservationAttestations.$inferSelect;
type ValueClaimForEvaluation = typeof delegationValueClaims.$inferSelect;

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

export function evaluateDelegationYield(input: {
	observations: ObservationForEvaluation[];
	attestations: AttestationForEvaluation[];
	valueClaims?: ValueClaimForEvaluation[];
	verifiedIssuedWorkItemIds?: ReadonlySet<string>;
	truncated?: boolean;
}): DelegationYield {
	const attestationsByObservation = new Map<
		string,
		AttestationForEvaluation[]
	>();
	for (const attestation of input.attestations) {
		const rows = attestationsByObservation.get(attestation.observationId) ?? [];
		rows.push(attestation);
		attestationsByObservation.set(attestation.observationId, rows);
	}
	const valueClaimsByObservation = new Map(
		(input.valueClaims ?? []).map((claim) => [claim.observationId, claim]),
	);
	const canonicalRows = input.observations.filter(
		(observation) =>
			observation.executorType === "tedi" &&
			observation.executorId === observation.tediId &&
			observation.eligibilityStatus === "eligible" &&
			Boolean(observation.proofVerifiedAt) &&
			observation.evidenceRefs.length > 0 &&
			observation.nonTrivial &&
			observation.heldOut &&
			Boolean(observation.evaluatorType && observation.evaluatorId) &&
			hasCanonicalEvaluationProvenance(observation),
	);
	// One immutable eval run can be recorded more than once. Collapse those rows
	// before economic aggregation so replay cannot duplicate review time or cost.
	const byEvaluationRun = new Map<string, ObservationForEvaluation[]>();
	for (const observation of canonicalRows) {
		const key = observation.evaluationRunId ?? observation.sourceId;
		const rows = byEvaluationRun.get(key) ?? [];
		rows.push(observation);
		byEvaluationRun.set(key, rows);
	}
	const canonical = [...byEvaluationRun.values()].map(
		(rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id))[0]!,
	);
	const observationsForEvaluationRun = (
		observation: ObservationForEvaluation,
	) =>
		byEvaluationRun.get(
			observation.evaluationRunId ?? observation.sourceId,
		) ?? [observation];
	const attestationsForEvaluationRun = (
		observation: ObservationForEvaluation,
	) =>
		observationsForEvaluationRun(observation).flatMap(
			(row) => attestationsByObservation.get(row.id) ?? [],
		);
	const independentlyRejected = (observation: ObservationForEvaluation) =>
		observationsForEvaluationRun(observation).some((row) =>
			(attestationsByObservation.get(row.id) ?? []).some(
				(attestation) =>
					attestation.verdict === "rejects" &&
					trustedIndependentAttestation(attestation, row),
			),
		);
	const supporterCount = (observation: ObservationForEvaluation) =>
		new Set(
			attestationsForEvaluationRun(observation)
				.filter((attestation) =>
					observationsForEvaluationRun(observation).some((row) =>
						trustedIndependentSupport(attestation, row),
					),
				)
				.map(
					(attestation) =>
						`${attestation.principalType}:${attestation.principalId}`,
				),
		).size;

	// A Work Item is the current server-owned issued-work identity. Eval runs
	// without one remain observed but cannot produce organizational value.
	const byIssuedOpportunity = new Map<string, ObservationForEvaluation[]>();
	for (const observation of canonical) {
		if (!observation.workItemId) continue;
		if (
			input.verifiedIssuedWorkItemIds &&
			!input.verifiedIssuedWorkItemIds.has(observation.workItemId)
		)
			continue;
		const rows = byIssuedOpportunity.get(observation.workItemId) ?? [];
		rows.push(observation);
		byIssuedOpportunity.set(observation.workItemId, rows);
	}

	const valueTotals = new Map<
		string,
		{ verifiedValueMinorUnits: number; ownerReviewMinutes: number }
	>();
	const costTotals = new Map<string, number>();
	const opportunitySummaries: Array<{
		workItemId: string;
		reviewed: boolean;
		reviewComplete: boolean;
		ownerReviewMinutes: number;
		adverse: boolean;
		claim: {
			currency: string;
			amount: number;
			valueEventId: string;
			valueEvidenceRef: string;
		} | null;
	}> = [];
	for (const [workItemId, observations] of byIssuedOpportunity) {
		let reviewComplete = true;
		let ownerReviewMinutes = 0;
		for (const observation of observations) {
			if (
				observation.costMinorUnits !== null &&
				observation.costCurrency &&
				Number.isSafeInteger(observation.costMinorUnits)
			) {
				const next =
					(costTotals.get(observation.costCurrency) ?? 0) +
					observation.costMinorUnits;
				if (Number.isSafeInteger(next)) {
					costTotals.set(observation.costCurrency, next);
				}
			}
			if (
				observation.ownerReviewMinutes === null ||
				!Number.isFinite(observation.ownerReviewMinutes) ||
				observation.ownerReviewMinutes < 1
			) {
				reviewComplete = false;
			} else {
				ownerReviewMinutes += observation.ownerReviewMinutes;
			}
		}
		const adverse = observations.some(
			(observation) =>
				observation.outcome === "failure" ||
				observation.outcome === "unverified" ||
				observation.policyViolationSeverity > 0 ||
				independentlyRejected(observation),
		);
		const reviewed =
			adverse || observations.every((row) => supporterCount(row) >= 2);
		const claims = observations.flatMap((observation) => {
			const persistedClaim = valueClaimsByObservation.get(observation.id);
			const amount = input.valueClaims
				? persistedClaim?.valueMinorUnits
				: observation.metadata?.verifiedValueMinorUnits;
			const currency = input.valueClaims
				? persistedClaim?.currency
				: observation.metadata?.verifiedValueCurrency;
			const valueEventId = input.valueClaims
				? persistedClaim?.valueEventId
				: observation.metadata?.verifiedValueEventId;
			const valueEvidenceRef = input.valueClaims
				? persistedClaim?.valueEvidenceRef
				: observation.metadata?.verifiedValueEvidenceRef;
			if (
				typeof amount !== "number" ||
				!Number.isSafeInteger(amount) ||
				amount < 0 ||
				typeof currency !== "string" ||
				!/^[A-Z]{3}$/.test(currency) ||
				typeof valueEventId !== "string" ||
				valueEventId.length === 0 ||
				typeof valueEvidenceRef !== "string" ||
				valueEvidenceRef.length === 0
			)
				return [];
			return [{ currency, amount, valueEventId, valueEvidenceRef }];
		});
		const distinctClaims = [
			...new Map(
				claims.map((claim) => [
					`${claim.currency}:${claim.amount}:${claim.valueEventId}:${claim.valueEvidenceRef}`,
					claim,
				]),
			).values(),
		];
		const firstClaim = distinctClaims[0] ?? null;
		const claim =
			firstClaim && distinctClaims.length === 1
				? { ...firstClaim, amount: adverse ? 0 : firstClaim.amount }
				: null;
		opportunitySummaries.push({
			workItemId,
			reviewed,
			reviewComplete,
			ownerReviewMinutes,
			adverse,
			claim,
		});
	}
	const workItemsByValueEvent = new Map<string, Set<string>>();
	const workItemsByValueEvidence = new Map<string, Set<string>>();
	for (const opportunity of opportunitySummaries) {
		if (!opportunity.claim) continue;
		const workItems =
			workItemsByValueEvent.get(opportunity.claim.valueEventId) ?? new Set();
		workItems.add(opportunity.workItemId);
		workItemsByValueEvent.set(opportunity.claim.valueEventId, workItems);
		const evidenceWorkItems =
			workItemsByValueEvidence.get(opportunity.claim.valueEvidenceRef) ??
			new Set();
		evidenceWorkItems.add(opportunity.workItemId);
		workItemsByValueEvidence.set(
			opportunity.claim.valueEvidenceRef,
			evidenceWorkItems,
		);
	}
	const certified = opportunitySummaries.filter(
		(opportunity) =>
			opportunity.reviewed &&
			opportunity.reviewComplete &&
			Boolean(opportunity.claim) &&
			workItemsByValueEvent.get(opportunity.claim!.valueEventId)?.size === 1 &&
			workItemsByValueEvidence.get(opportunity.claim!.valueEvidenceRef)
				?.size === 1,
	);
	for (const opportunity of certified) {
		const claim = opportunity.claim!;
		const current = valueTotals.get(claim.currency) ?? {
			verifiedValueMinorUnits: 0,
			ownerReviewMinutes: 0,
		};
		const nextValue = current.verifiedValueMinorUnits + claim.amount;
		if (!Number.isSafeInteger(nextValue)) continue;
		current.verifiedValueMinorUnits = nextValue;
		current.ownerReviewMinutes += opportunity.ownerReviewMinutes;
		valueTotals.set(claim.currency, current);
	}
	const ownerReviewMinutes = opportunitySummaries.reduce(
		(total, opportunity) => total + opportunity.ownerReviewMinutes,
		0,
	);
	const measurementStatus =
		certified.length === 0
			? ("unmeasured" as const)
			: certified.length < opportunitySummaries.length || input.truncated
				? ("partial" as const)
				: ("measured" as const);
	const exposeRates = measurementStatus === "measured";

	return {
		metric: "verified_value_per_owner_review_hour",
		authorityEffect: "none",
		measurementStatus,
		provisional: true,
		coverage: "observed_issued_work_items_only",
		observedOpportunities: canonical.length,
		issuedOpportunities: opportunitySummaries.length,
		reviewedOpportunities: opportunitySummaries.filter((row) => row.reviewed)
			.length,
		valueCertifiedOpportunities: certified.length,
		ownerReviewMinutes: rounded(ownerReviewMinutes, 2),
		valueByCurrency: [...valueTotals.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([currency, row]) => ({
				currency,
				verifiedValueMinorUnits: row.verifiedValueMinorUnits,
				ownerReviewMinutes: rounded(row.ownerReviewMinutes, 2),
				valuePerOwnerReviewHourMinorUnits:
					exposeRates && row.ownerReviewMinutes > 0
						? Math.round(
								(row.verifiedValueMinorUnits * 60) / row.ownerReviewMinutes,
							)
						: null,
			})),
		costByCurrency: [...costTotals.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([currency, costMinorUnits]) => ({ currency, costMinorUnits })),
		truncated: input.truncated ?? false,
		limitations: [
			"Coverage includes only canonical eval runs bound to proof-gated completed Work Items; it is not complete issued-work coverage.",
			"Known adverse work contributes zero value while retaining recorded review time and cost.",
			"A positive value requires two independent supporters, one immutable value-event identity, and one accounting evidence reference.",
			"Currencies remain separate and are never converted, combined, or netted against cost.",
			...(measurementStatus !== "measured"
				? [
						"The hourly rate is withheld until every observed issued opportunity has a complete, non-conflicting value and review record.",
					]
				: []),
			...(input.truncated
				? [
						"The evidence window is truncated, so the hourly rate is suppressed.",
					]
				: []),
		],
	};
}
