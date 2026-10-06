import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { extractFactIdsFromFlywheelEvidence } from "./evidence-fact-ids";
import { evidenceReferencesFactsSql } from "./evidence-references-facts";

interface FlywheelAccess {
	tediId: string;
	orgId: string;
}

function rate(count: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(1, Math.round((count / total) * 1000) / 1000);
}

function scoreStatus(value: number): "healthy" | "thin" | "missing" {
	if (value >= 0.7) return "healthy";
	if (value > 0) return "thin";
	return "missing";
}

export interface LearningReplayCategory {
	category: string;
	total: number;
	successes: number;
	failures: number;
	withFacts: number;
}

export interface LearningReplayTransition {
	failureDecisionId: string;
	successDecisionId: string;
	category: string;
	failureAction: string;
	successAction: string;
	failureAt: string;
	successAt: string;
	sharedEvidenceCount: number;
}

export interface LearningReplayValidation {
	windowDays: number;
	since: string;
	ready: boolean;
	score: number;
	categories: LearningReplayCategory[];
	transitions: LearningReplayTransition[];
	signals: Array<{
		key: string;
		label: string;
		value: number;
		status: "healthy" | "thin" | "missing";
	}>;
	gaps: string[];
}

type ReplayCategoryRow = {
	category: string;
	total: number;
	successes: number;
	failures: number;
	withFacts: number;
};

type ReplayTransitionRow = {
	failureDecisionId: string;
	successDecisionId: string | null;
	category: string;
	failureAction: string;
	successAction: string | null;
	failureAt: string;
	successAt: string | null;
	failureEvidence: unknown;
	successEvidence: unknown;
};

type ReplayTransitionCountRow = {
	failures: number;
	matchedFailures: number;
};

export async function getLearningReplayValidation(
	db: DbClient,
	access: FlywheelAccess,
	windowDays = 30,
): Promise<LearningReplayValidation> {
	const since = new Date(
		Date.now() - windowDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const [categoryRows, transitionRows, transitionCountRows] = await Promise.all(
		[
			db.all<ReplayCategoryRow>(
				sql`SELECT category,
					count(*) as total,
					sum(CASE WHEN outcome_status = 'success' THEN 1 ELSE 0 END) as successes,
					sum(CASE WHEN outcome_status = 'failure' THEN 1 ELSE 0 END) as failures,
					sum(CASE WHEN ${evidenceReferencesFactsSql()} THEN 1 ELSE 0 END) as withFacts
				FROM tedi_rationale_records
				WHERE tedi_id = ${access.tediId}
					AND org_id = ${access.orgId}
					AND created_at >= ${since}
					AND outcome_status != 'pending'
				GROUP BY category
				ORDER BY total DESC
				LIMIT 20`,
			),
			db.all<ReplayTransitionRow>(
				sql`SELECT fail.id as failureDecisionId,
					success.id as successDecisionId,
					fail.category as category,
					fail.action as failureAction,
					success.action as successAction,
					fail.created_at as failureAt,
					success.created_at as successAt,
					fail.evidence as failureEvidence,
					success.evidence as successEvidence
				FROM tedi_rationale_records fail
				LEFT JOIN tedi_rationale_records success
					ON success.id = (
						SELECT candidate.id
						FROM tedi_rationale_records candidate
						WHERE candidate.tedi_id = fail.tedi_id
							AND candidate.org_id = fail.org_id
							AND candidate.category = fail.category
							AND candidate.outcome_status = 'success'
							AND candidate.created_at > fail.created_at
						ORDER BY candidate.created_at ASC
						LIMIT 1
					)
				WHERE fail.tedi_id = ${access.tediId}
					AND fail.org_id = ${access.orgId}
					AND fail.created_at >= ${since}
					AND fail.outcome_status = 'failure'
				ORDER BY fail.created_at DESC
				LIMIT 20`,
			),
			db.all<ReplayTransitionCountRow>(
				sql`SELECT count(*) AS failures,
					sum(CASE WHEN EXISTS (
						SELECT 1 FROM tedi_rationale_records success
						WHERE success.tedi_id = fail.tedi_id
							AND success.org_id = fail.org_id
							AND success.category = fail.category
							AND success.outcome_status = 'success'
							AND success.created_at > fail.created_at
					) THEN 1 ELSE 0 END) AS matchedFailures
				FROM tedi_rationale_records fail
				WHERE fail.tedi_id = ${access.tediId}
					AND fail.org_id = ${access.orgId}
					AND fail.created_at >= ${since}
					AND fail.outcome_status = 'failure'`,
			),
		],
	);
	const transitions: LearningReplayTransition[] = transitionRows
		.filter(
			(
				row,
			): row is ReplayTransitionRow & {
				successDecisionId: string;
				successAction: string;
				successAt: string;
			} => Boolean(row.successDecisionId && row.successAction && row.successAt),
		)
		.map((row) => {
			const failureFacts = new Set(
				extractFactIdsFromFlywheelEvidence(row.failureEvidence),
			);
			const successFacts = extractFactIdsFromFlywheelEvidence(
				row.successEvidence,
			);
			const sharedEvidenceCount = successFacts.filter((id) =>
				failureFacts.has(id),
			).length;
			return {
				failureDecisionId: row.failureDecisionId,
				successDecisionId: row.successDecisionId,
				category: row.category,
				failureAction: row.failureAction,
				successAction: row.successAction,
				failureAt: row.failureAt,
				successAt: row.successAt,
				sharedEvidenceCount,
			};
		});
	const totals = categoryRows.reduce(
		(acc, row) => {
			acc.total += row.total;
			acc.successes += row.successes;
			acc.failures += row.failures;
			acc.withFacts += row.withFacts;
			return acc;
		},
		{ total: 0, successes: 0, failures: 0, withFacts: 0 },
	);
	const transitionCounts = transitionCountRows[0] ?? {
		failures: 0,
		matchedFailures: 0,
	};
	const transitionRate = rate(
		Number(transitionCounts.matchedFailures),
		Math.max(Number(transitionCounts.failures), 1),
	);
	const evidenceRate = rate(totals.withFacts, totals.total);
	const signals: LearningReplayValidation["signals"] = [
		{
			key: "outcome_corpus",
			label: "Completed decisions available for replay",
			value: totals.total,
			status:
				totals.total >= 20 ? "healthy" : totals.total > 0 ? "thin" : "missing",
		},
		{
			key: "evidence_citation",
			label: "Replay decisions cite evidence facts",
			value: evidenceRate,
			status: scoreStatus(evidenceRate),
		},
		{
			key: "failure_to_success",
			label: "Failures have later successful contrast cases",
			value: transitionRate,
			status: scoreStatus(transitionRate),
		},
	];
	const gaps = signals
		.filter((signal) => signal.status !== "healthy")
		.map((signal) => signal.label);
	const score =
		Math.round(
			((Math.min(totals.total / 20, 1) + evidenceRate + transitionRate) / 3) *
				100,
		) / 100;
	return {
		windowDays,
		since,
		ready: score >= 0.7,
		score,
		categories: categoryRows,
		transitions,
		signals,
		gaps,
	};
}
