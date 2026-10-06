/**
 * Corpus audit — rationale-corpus health telemetry.
 *
 * Pure, runtime-neutral computation over the tedi's completed rationale chain.
 * It only needs `platform.getRationaleChain` (no workspace dir, no filesystem),
 * so the Agent runtime can import this single source and log it as telemetry.
 *
 * Stats surfaced:
 *   - completionRate / outcome + category distributions
 *   - contrastiveViability (>=5 success AND >=5 failure in any category)
 *   - loraViability (>=50 records, >=60% completed, >=3 categories with >=5)
 *
 * These gate downstream training-data pipelines (contrastive decision pairs,
 * LoRA fine-tunes) so a young/skewed corpus does not waste a training run.
 */

import type { PlatformClient } from "./platform-client.js";

export interface CorpusAuditResult {
	totalRecords: number;
	completionRate: number;
	outcomeDistribution: Record<string, number>;
	categoryDistribution: Record<string, number>;
	avgConfidence: number;
	ageStats: { oldestDays: number; newestDays: number; medianAgeDays: number };
	actionLengthStats: { avg: number; min: number; max: number };
	rationaleLengthStats: { avg: number; min: number; max: number };
	uniqueCategories: string[];
	contrastiveViability: boolean;
	loraViability: boolean;
	auditedAt: string;
}

function lengthStats(values: number[]): {
	avg: number;
	min: number;
	max: number;
} {
	if (values.length === 0) return { avg: 0, min: 0, max: 0 };
	const sum = values.reduce((a, b) => a + b, 0);
	return {
		avg: Math.round(sum / values.length),
		min: Math.min(...values),
		max: Math.max(...values),
	};
}

function median(sorted: number[]): number {
	if (sorted.length === 0) return 0;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
		: sorted[mid]!;
}

/**
 * Compute corpus-health stats from the tedi's rationale chain.
 *
 * Reads up to `limit` records via `platform.getRationaleChain` and returns the
 * pure `CorpusAuditResult`. No side effects — callers persist/log as needed.
 */
export async function auditRationaleCorpus(
	platform: Pick<PlatformClient, "getRationaleChain">,
	limit = 100,
): Promise<CorpusAuditResult> {
	const { data: records } = await platform.getRationaleChain(limit);
	const now = Date.now();
	const totalRecords = records.length;

	const outcomeDistribution: Record<string, number> = {
		success: 0,
		failure: 0,
		partial: 0,
		pending: 0,
	};
	const categoryDistribution: Record<string, number> = {};
	let confidenceSum = 0;
	const ageDays: number[] = [];
	const actionLengths: number[] = [];
	const rationaleLengths: number[] = [];

	// Per-category outcome tracking for contrastive viability
	const categoryOutcomes = new Map<
		string,
		{ success: number; failure: number }
	>();

	for (const r of records) {
		const status = r.outcomeStatus || "pending";
		outcomeDistribution[status] = (outcomeDistribution[status] || 0) + 1;

		categoryDistribution[r.category] =
			(categoryDistribution[r.category] || 0) + 1;
		confidenceSum += r.confidence;

		const created = new Date(r.createdAt).getTime();
		ageDays.push(Math.round((now - created) / 86_400_000));

		actionLengths.push(r.action.length);
		rationaleLengths.push(r.rationale.length);

		if (!categoryOutcomes.has(r.category)) {
			categoryOutcomes.set(r.category, { success: 0, failure: 0 });
		}
		const co = categoryOutcomes.get(r.category)!;
		if (status === "success") co.success++;
		else if (status === "failure") co.failure++;
	}

	ageDays.sort((a, b) => a - b);
	const completed = totalRecords - (outcomeDistribution["pending"] || 0);

	const contrastiveViability = Array.from(categoryOutcomes.values()).some(
		(co) => co.success >= 5 && co.failure >= 5,
	);

	const categoriesWithEnough = Object.values(categoryDistribution).filter(
		(n) => n >= 5,
	).length;

	return {
		totalRecords,
		completionRate:
			totalRecords > 0 ? Math.round((completed / totalRecords) * 100) / 100 : 0,
		outcomeDistribution,
		categoryDistribution,
		avgConfidence:
			totalRecords > 0
				? Math.round((confidenceSum / totalRecords) * 100) / 100
				: 0,
		ageStats: {
			oldestDays: ageDays[ageDays.length - 1] ?? 0,
			newestDays: ageDays[0] ?? 0,
			medianAgeDays: median(ageDays),
		},
		actionLengthStats: lengthStats(actionLengths),
		rationaleLengthStats: lengthStats(rationaleLengths),
		uniqueCategories: Object.keys(categoryDistribution),
		contrastiveViability,
		loraViability:
			totalRecords >= 50 &&
			completed / totalRecords >= 0.6 &&
			categoriesWithEnough >= 3,
		auditedAt: new Date().toISOString(),
	};
}
