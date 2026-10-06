import type { DbClient } from "../../client";
import type { ExternalAgentReviewEvidence } from "../../schema/external-agent-identity";

type ExternalReviewContext = {
	taskFamily: string;
	repositoryKey: string;
	repositoryVersion: string;
	riskLevel: "low" | "medium" | "high" | "critical";
	environment: string;
};

type ContextualReviewRow = ExternalAgentReviewEvidence & {
	harness: string;
	harnessVersion: string;
	modelProvider: string;
	modelId: string;
	modelVersion: string;
};

function wilsonFromRate(rate: number, effectiveN: number): number {
	if (effectiveN <= 0) return 0;
	const z = 1.96;
	const z2 = z * z;
	const denominator = 1 + z2 / effectiveN;
	const centre = rate + z2 / (2 * effectiveN);
	const margin =
		z * Math.sqrt((rate * (1 - rate) + z2 / (4 * effectiveN)) / effectiveN);
	return Math.max(0, (centre - margin) / denominator);
}

export function evaluateExternalAgentContextualReputation(input: {
	subjectPrincipalId: string;
	context: ExternalReviewContext & {
		harness: string;
		harnessVersion: string;
		modelProvider: string;
		modelId: string;
		modelVersion: string;
	};
	reviews: ContextualReviewRow[];
	now: string;
	halfLifeDays: number;
}) {
	const reviewerPrincipals = new Set(
		input.reviews.map(
			(review) =>
				`${review.reviewerPrincipalType}:${review.reviewerPrincipalId}`,
		),
	);
	const byExecution = new Map<string, ContextualReviewRow[]>();
	for (const review of input.reviews) {
		const rows = byExecution.get(review.executionAttributionId) ?? [];
		rows.push(review);
		byExecution.set(review.executionAttributionId, rows);
	}
	const nowMs = new Date(input.now).getTime();
	const episodes = [...byExecution.values()].map((reviews) => {
		const conservative = [...reviews].sort(
			(a, b) =>
				b.policyViolationSeverity - a.policyViolationSeverity ||
				a.score - b.score,
		)[0]!;
		const ageDays = Math.max(
			0,
			(nowMs - new Date(conservative.occurredAt).getTime()) /
				(24 * 60 * 60 * 1_000),
		);
		const weight = 0.5 ** (ageDays / input.halfLifeDays);
		const criticalNegative = reviews.some(
			(review) =>
				review.resolutionStatus === "open" &&
				(review.policyViolationSeverity > 0 ||
					review.outcome === "policy_violation" ||
					(review.outcome === "failure" &&
						(review.riskLevel === "high" || review.riskLevel === "critical"))),
		);
		return {
			score: conservative.score,
			success: conservative.outcome === "success" ? 1 : 0,
			weight,
			criticalNegative,
			occurredAt: conservative.occurredAt,
		};
	});
	const sumWeight = episodes.reduce((sum, row) => sum + row.weight, 0);
	const sumSquaredWeight = episodes.reduce(
		(sum, row) => sum + row.weight * row.weight,
		0,
	);
	const kishEffectiveSampleSize =
		sumSquaredWeight > 0 ? (sumWeight * sumWeight) / sumSquaredWeight : 0;
	// Kish ESS describes concentration between observations but intentionally
	// cancels a uniform scale factor. Cap it by absolute recency weight so a
	// uniformly stale history cannot retain the same effective evidence as fresh
	// episodes merely because all observations aged together.
	const effectiveSampleSize = Math.min(kishEffectiveSampleSize, sumWeight);
	const weightedMeanScore =
		sumWeight > 0
			? episodes.reduce((sum, row) => sum + row.score * row.weight, 0) /
				sumWeight
			: 0;
	const weightedSuccessRate =
		sumWeight > 0
			? episodes.reduce((sum, row) => sum + row.success * row.weight, 0) /
				sumWeight
			: 0;
	const reliabilityLowerBound = wilsonFromRate(
		weightedSuccessRate,
		effectiveSampleSize,
	);
	const criticalNegativeCount = episodes.filter(
		(row) => row.criticalNegative,
	).length;
	const blockedByCriticalNegative = criticalNegativeCount > 0;
	const status =
		blockedByCriticalNegative || effectiveSampleSize < 3
			? ("insufficient" as const)
			: effectiveSampleSize >= 5 &&
				  reliabilityLowerBound >= 0.6 &&
				  reviewerPrincipals.size >= 2
				? ("established" as const)
				: ("fragile" as const);
	return {
		subjectPrincipalId: input.subjectPrincipalId,
		context: input.context,
		halfLifeDays: input.halfLifeDays,
		rawReviewCount: input.reviews.length,
		reviewedExecutions: episodes.length,
		distinctReviewerPrincipals: reviewerPrincipals.size,
		effectiveSampleSize,
		weightedMeanScore,
		reliabilityLowerBound,
		criticalNegativeCount,
		blockedByCriticalNegative,
		mostRecentEvidenceAt:
			episodes
				.map((row) => row.occurredAt)
				.sort()
				.at(-1) ?? null,
		status,
		descriptiveOnly: true as const,
	};
}

export async function getExternalAgentContextualReputation(
	db: DbClient,
	input: {
		organizationId: string;
		subjectPrincipalId: string;
		context: ExternalReviewContext & {
			harness: string;
			harnessVersion: string;
			modelProvider: string;
			modelId: string;
			modelVersion: string;
		};
		now: string;
		halfLifeDays: number;
	},
) {
	const rows = await db.query.externalAgentReviewEvidence.findMany({
		where: {
			organizationId: input.organizationId,
			subjectPrincipalId: input.subjectPrincipalId,
			taskFamily: input.context.taskFamily,
			repositoryKey: input.context.repositoryKey,
			repositoryVersion: input.context.repositoryVersion,
			riskLevel: input.context.riskLevel,
			environment: input.context.environment,
			executionAttribution: {},
			subjectSession: {
				harness: input.context.harness,
				harnessVersion: input.context.harnessVersion,
				modelProvider: input.context.modelProvider,
				modelId: input.context.modelId,
				modelVersion: input.context.modelVersion,
				creditEligible: true,
			},
		},
		with: {
			subjectSession: {
				columns: {
					harness: true,
					harnessVersion: true,
					modelProvider: true,
					modelId: true,
					modelVersion: true,
				},
			},
		},
	});
	return evaluateExternalAgentContextualReputation({
		subjectPrincipalId: input.subjectPrincipalId,
		context: input.context,
		reviews: rows.flatMap(({ subjectSession, ...review }) =>
			subjectSession ? [{ ...review, ...subjectSession }] : [],
		),
		now: input.now,
		halfLifeDays: input.halfLifeDays,
	});
}
