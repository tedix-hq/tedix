import { and, asc, desc, eq, exists, gt, gte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import { tediRationaleRecords } from "../../schema/rationale-records";
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

export async function getLearningReplayValidation(
	db: DbClient,
	access: FlywheelAccess,
	windowDays = 30,
): Promise<LearningReplayValidation> {
	const since = new Date(
		Date.now() - windowDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const records = tediRationaleRecords;
	const fail = alias(tediRationaleRecords, "fail");
	const success = alias(tediRationaleRecords, "success");
	const candidate = alias(tediRationaleRecords, "candidate");
	const failureScope = and(
		eq(fail.tediId, access.tediId),
		eq(fail.orgId, access.orgId),
		gte(fail.createdAt, since),
		eq(fail.outcomeStatus, "failure"),
	);
	const total = sql<number>`count(*)`.as("total");
	const [categoryRows, transitionRows, transitionCountRows] = await Promise.all(
		[
			db
				.select({
					category: records.category,
					total,
					successes:
						sql<number>`sum(CASE WHEN ${records.outcomeStatus} = 'success' THEN 1 ELSE 0 END)`.as(
							"successes",
						),
					failures:
						sql<number>`sum(CASE WHEN ${records.outcomeStatus} = 'failure' THEN 1 ELSE 0 END)`.as(
							"failures",
						),
					withFacts:
						sql<number>`sum(CASE WHEN ${evidenceReferencesFactsSql()} THEN 1 ELSE 0 END)`.as(
							"withFacts",
						),
				})
				.from(records)
				.where(
					and(
						eq(records.tediId, access.tediId),
						eq(records.orgId, access.orgId),
						gte(records.createdAt, since),
						ne(records.outcomeStatus, "pending"),
					),
				)
				.groupBy(records.category)
				.orderBy(desc(total))
				.limit(20),
			db
				.select({
					failureDecisionId: sql<string>`${fail.id}`.as("failureDecisionId"),
					successDecisionId: sql<string | null>`${success.id}`.as(
						"successDecisionId",
					),
					category: sql<string>`${fail.category}`.as("category"),
					failureAction: sql<string>`${fail.action}`.as("failureAction"),
					successAction: sql<string | null>`${success.action}`.as(
						"successAction",
					),
					failureAt: sql<string>`${fail.createdAt}`.as("failureAt"),
					successAt: sql<string | null>`${success.createdAt}`.as("successAt"),
					// Raw JSON text, as stored; the fact-id extractor parses it.
					failureEvidence: sql<unknown>`${fail.evidence}`.as("failureEvidence"),
					successEvidence: sql<unknown>`${success.evidence}`.as(
						"successEvidence",
					),
				})
				.from(fail)
				.leftJoin(
					success,
					eq(
						success.id,
						db
							.select({ id: candidate.id })
							.from(candidate)
							.where(
								and(
									eq(candidate.tediId, fail.tediId),
									eq(candidate.orgId, fail.orgId),
									eq(candidate.category, fail.category),
									eq(candidate.outcomeStatus, "success"),
									gt(candidate.createdAt, fail.createdAt),
								),
							)
							.orderBy(asc(candidate.createdAt))
							.limit(1),
					),
				)
				.where(failureScope)
				.orderBy(desc(fail.createdAt))
				.limit(20),
			db
				.select({
					failures: sql<number>`count(*)`.as("failures"),
					matchedFailures: sql<number>`sum(CASE WHEN ${exists(
						db
							.select({ one: sql`1` })
							.from(success)
							.where(
								and(
									eq(success.tediId, fail.tediId),
									eq(success.orgId, fail.orgId),
									eq(success.category, fail.category),
									eq(success.outcomeStatus, "success"),
									gt(success.createdAt, fail.createdAt),
								),
							),
					)} THEN 1 ELSE 0 END)`.as("matchedFailures"),
				})
				.from(fail)
				.where(failureScope),
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
