import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import { tediRuntimeEvents } from "../../schema/cognitive-runtime";
import { tediRationaleRecords } from "../../schema/rationale-records";

export interface FlywheelAccess {
	tediId: string;
	orgId: string;
}

function rate(count: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(1, Math.round((count / total) * 1000) / 1000);
}

export interface LearningCurvePoint {
	phase: "baseline" | "recent";
	fromEpisode: number;
	cumulativeEpisodes: number;
	episodeCount: number;
	successRate: number;
	averageSteps: number;
	averageDurationMs: number | null;
	durationSamples: number;
	averageTokenCost: number | null;
	tokenCostSamples: number;
	workItemLinkRate: number;
}

export interface LearningCurveRegressionAlert {
	cohort: LearningCurveCohort;
	taskType: string;
	metric: "success_rate" | "steps" | "duration" | "token_cost";
	severity: "warning" | "critical";
	baseline: number;
	recent: number;
	delta: number;
	message: string;
}

export type LearningCurveCohort = "organic" | "operator" | "scheduled_dogfood";

export interface TaskTypeLearningCurve {
	cohort: LearningCurveCohort;
	taskType: string;
	totalEpisodes: number;
	points: LearningCurvePoint[];
	baseline: LearningCurvePoint | null;
	recent: LearningCurvePoint | null;
	direction: "improved" | "regressed" | "flat" | "insufficient_data";
}

export interface LearningCurvesReport {
	tediId: string;
	orgId: string;
	windowDays: number;
	cohort: "all" | LearningCurveCohort;
	since: string;
	generatedAt: string;
	curves: TaskTypeLearningCurve[];
	alerts: LearningCurveRegressionAlert[];
	pagination: {
		offset: number;
		limit: number;
		totalTaskTypes: number;
		nextOffset: number | null;
	};
	summary: {
		taskTypeCount: number;
		episodeCount: number;
		improvingTaskTypes: number;
		regressingTaskTypes: number;
		alertCount: number;
		cohortCounts: Record<LearningCurveCohort, number>;
	};
}

type LearningCurveAggregateRow = {
	cohort: LearningCurveCohort;
	taskType: string;
	totalEpisodes: number;
	totalTaskTypes: number;
	phase: "baseline" | "recent";
	fromEpisode: number;
	cumulativeEpisodes: number;
	episodeCount: number;
	successes: number;
	steps: number;
	durationMs: number;
	durationSamples: number;
	tokenCost: number;
	tokenCostSamples: number;
	workItemLinks: number;
};

function roundedAverage(total: number, count: number): number | null {
	if (count <= 0) return null;
	return Math.round((total / count) * 100) / 100;
}

function mergeLearningCurvePoints(
	points: LearningCurvePoint[],
	phase: LearningCurvePoint["phase"],
): LearningCurvePoint | null {
	const selected = points.filter((point) => point.phase === phase);
	const episodeCount = selected.reduce(
		(sum, point) => sum + point.episodeCount,
		0,
	);
	if (episodeCount === 0) return null;
	const weighted = (key: "successRate" | "averageSteps" | "workItemLinkRate") =>
		selected.reduce((sum, point) => sum + point[key] * point.episodeCount, 0) /
		episodeCount;
	const nullableWeighted = (key: "averageDurationMs" | "averageTokenCost") => {
		const sampleKey =
			key === "averageDurationMs" ? "durationSamples" : "tokenCostSamples";
		const available = selected.filter((point) => point[key] !== null);
		const samples = available.reduce((sum, point) => sum + point[sampleKey], 0);
		if (samples === 0) return null;
		return (
			available.reduce(
				(sum, point) => sum + (point[key] ?? 0) * point[sampleKey],
				0,
			) / samples
		);
	};
	const averageDurationMs = nullableWeighted("averageDurationMs");
	const averageTokenCost = nullableWeighted("averageTokenCost");
	return {
		phase,
		fromEpisode: Math.min(...selected.map((point) => point.fromEpisode)),
		cumulativeEpisodes: Math.max(
			...selected.map((point) => point.cumulativeEpisodes),
		),
		episodeCount,
		successRate: Math.round(weighted("successRate") * 1000) / 1000,
		averageSteps: Math.round(weighted("averageSteps") * 100) / 100,
		averageDurationMs:
			averageDurationMs === null
				? null
				: Math.round(averageDurationMs * 100) / 100,
		durationSamples: selected.reduce(
			(sum, point) => sum + point.durationSamples,
			0,
		),
		averageTokenCost:
			averageTokenCost === null
				? null
				: Math.round(averageTokenCost * 100) / 100,
		tokenCostSamples: selected.reduce(
			(sum, point) => sum + point.tokenCostSamples,
			0,
		),
		workItemLinkRate: Math.round(weighted("workItemLinkRate") * 1000) / 1000,
	};
}

/**
 * Baseline-vs-recent learning-trend envelope, shared by the learning-curve
 * regression alerts / curve direction below AND the reference-class trend
 * verdict (queries/reference-class.ts), so both surfaces call the same
 * movement a regression or an improvement.
 */
export const LEARNING_TREND_THRESHOLDS = {
	/** Regressing when success rate drops by more than this (absolute). */
	successDrop: 0.1,
	/** Improving when success rate gains at least this (absolute). */
	successGain: 0.05,
	/** Regressing when duration grows beyond baseline × this factor (>25%). */
	durationGrowthFactor: 1.25,
	/** Improving when steps/duration/cost shrink to ≤ baseline × this factor. */
	improvementShrinkFactor: 0.9,
} as const;

function buildLearningCurveAlerts(
	cohort: LearningCurveCohort,
	taskType: string,
	baseline: LearningCurvePoint | null,
	recent: LearningCurvePoint | null,
): LearningCurveRegressionAlert[] {
	if (
		!baseline ||
		!recent ||
		baseline.episodeCount < 2 ||
		recent.episodeCount < 2
	) {
		return [];
	}
	const alerts: LearningCurveRegressionAlert[] = [];
	const push = (
		metric: LearningCurveRegressionAlert["metric"],
		baselineValue: number,
		recentValue: number,
		threshold: number,
		criticalThreshold: number,
	) => {
		const delta = Math.round((recentValue - baselineValue) * 1000) / 1000;
		if (delta <= threshold) return;
		const severity = delta >= criticalThreshold ? "critical" : "warning";
		alerts.push({
			cohort,
			taskType,
			metric,
			severity,
			baseline: baselineValue,
			recent: recentValue,
			delta,
			message: `${taskType} ${metric.replaceAll("_", " ")} regressed from ${baselineValue} to ${recentValue}`,
		});
	};
	const successDrop = baseline.successRate - recent.successRate;
	if (successDrop > LEARNING_TREND_THRESHOLDS.successDrop) {
		alerts.push({
			cohort,
			taskType,
			metric: "success_rate",
			severity: successDrop >= 0.25 ? "critical" : "warning",
			baseline: baseline.successRate,
			recent: recent.successRate,
			delta:
				Math.round((recent.successRate - baseline.successRate) * 1000) / 1000,
			message: `${taskType} success rate regressed from ${baseline.successRate} to ${recent.successRate}`,
		});
	}
	push("steps", baseline.averageSteps, recent.averageSteps, 1, 3);
	if (
		baseline.averageDurationMs !== null &&
		recent.averageDurationMs !== null
	) {
		push(
			"duration",
			baseline.averageDurationMs,
			recent.averageDurationMs,
			Math.max(
				1000,
				baseline.averageDurationMs *
					(LEARNING_TREND_THRESHOLDS.durationGrowthFactor - 1),
			),
			Math.max(5000, baseline.averageDurationMs * 0.75),
		);
	}
	if (baseline.averageTokenCost !== null && recent.averageTokenCost !== null) {
		push(
			"token_cost",
			baseline.averageTokenCost,
			recent.averageTokenCost,
			Math.max(500, baseline.averageTokenCost * 0.25),
			Math.max(2000, baseline.averageTokenCost * 0.75),
		);
	}
	return alerts;
}

/**
 * Shared raw-episodes selection for every learning-curve-derived surface.
 *
 * Emits one row per completed, execution-linked rationale episode with the
 * canonical learning-curve task identity (`taskType`: explicit
 * `evidence.taskType`, then `skill:{slug}` from `evidence.skillSlug`, then
 * rationale category) plus mechanical cost columns (`durationMs`, `steps`,
 * `tokenCost`, `workItemLinked`). Consumers wrap it as a CTE:
 * `db.$with("raw_episodes").as(learningCurveRawEpisodes(access, since))`.
 * Reference-class forecasting (queries/reference-class.ts) reuses this
 * fragment so the outside view is computed over the exact same episode
 * population as the learning curves — never a parallel SQL definition.
 */
export function learningCurveRawEpisodes(
	access: FlywheelAccess,
	since: string,
) {
	const records = tediRationaleRecords;
	const runtime = alias(tediRuntimeEvents, "runtime");
	const qb = new QueryBuilder();
	const runtimeOfRecord = (kind: SQL | undefined) =>
		and(
			eq(runtime.tediId, access.tediId),
			eq(runtime.organizationId, access.orgId),
			eq(runtime.runId, records.runId),
			kind,
		);
	const runStartedAt = qb
		.select({ at: sql<string | null>`min(${runtime.createdAt})`.as("at") })
		.from(runtime)
		.where(runtimeOfRecord(eq(runtime.kind, "run.started")));
	const runEndedAt = qb
		.select({ at: sql<string | null>`max(${runtime.createdAt})`.as("at") })
		.from(runtime)
		.where(
			runtimeOfRecord(
				inArray(runtime.kind, ["run.completed", "run.failed", "run.canceled"]),
			),
		);
	const runToolEvents = qb
		.select({ cnt: sql<number>`count(*)`.as("cnt") })
		.from(runtime)
		.where(
			runtimeOfRecord(inArray(runtime.kind, ["tool.completed", "tool.failed"])),
		);
	// run.completed carries the scalar total as payload.tokensUsed (body parity
	// with the kernel; see ledger-mirror.ts). The usage object has only
	// input/output/cache token fields — no totalTokens — so the old
	// '$.usage.totalTokens' read was structurally always NULL, leaving
	// averageTokenCost dark. Read the correct sibling field.
	const runTokensUsed = qb
		.select({
			tokens:
				sql<number>`CAST(json_extract(${runtime.payload}, '$.tokensUsed') AS REAL)`.as(
					"tokens",
				),
		})
		.from(runtime)
		.where(
			runtimeOfRecord(
				and(
					eq(runtime.kind, "run.completed"),
					sql`json_valid(${runtime.payload})`,
				),
			),
		)
		.orderBy(desc(runtime.createdAt))
		.limit(1);
	const linkedToolCalls = sql`(${records.toolCallRefs} IS NOT NULL AND json_valid(${records.toolCallRefs})
		AND json_array_length(${records.toolCallRefs}) > 0)`;
	return qb
		.select({
			id: records.id,
			outcomeStatus: records.outcomeStatus,
			cohort: sql<LearningCurveCohort>`CASE
				WHEN json_valid(${records.evidence}) AND (
					json_extract(${records.evidence}, '$.skillSlug') LIKE 'platform-%-dogfood'
					OR json_extract(${records.evidence}, '$.taskType') LIKE 'skill:platform-%-dogfood'
				) THEN 'scheduled_dogfood'
				WHEN ${records.workItemId} IS NOT NULL THEN 'operator'
				ELSE 'organic'
			END`.as("cohort"),
			taskType: sql<string>`COALESCE(
				CASE WHEN json_valid(${records.evidence})
					THEN json_extract(${records.evidence}, '$.taskType') END,
				CASE WHEN json_valid(${records.evidence}) AND json_extract(${records.evidence}, '$.skillSlug') IS NOT NULL
					THEN 'skill:' || json_extract(${records.evidence}, '$.skillSlug') END,
				${records.category}
			)`.as("taskType"),
			createdAt: records.createdAt,
			durationMs: sql<number | null>`CASE
				WHEN ${records.runId} IS NOT NULL
					AND ${runStartedAt} IS NOT NULL
					AND ${runEndedAt} IS NOT NULL
				THEN max(0, CAST(round((julianday(${runEndedAt}) - julianday(${runStartedAt})) * 86400000) AS INTEGER))
				WHEN ${records.completedAt} IS NOT NULL
					THEN max(0, CAST(round((julianday(${records.completedAt}) - julianday(${records.createdAt})) * 86400000) AS INTEGER))
				ELSE NULL
			END`.as("durationMs"),
			steps: sql<number>`CASE
				WHEN ${records.toolCallRefs} IS NOT NULL AND json_valid(${records.toolCallRefs})
					THEN json_array_length(${records.toolCallRefs})
				WHEN ${records.runId} IS NOT NULL THEN ${runToolEvents}
				ELSE 0 END`.as("steps"),
			tokenCost: sql<
				number | null
			>`CASE WHEN ${records.runId} IS NOT NULL THEN ${runTokensUsed} END`.as(
				"tokenCost",
			),
			workItemLinked:
				sql<number>`CASE WHEN ${records.workItemId} IS NOT NULL THEN 1 ELSE 0 END`.as(
					"workItemLinked",
				),
		})
		.from(records)
		.where(
			and(
				eq(records.tediId, access.tediId),
				eq(records.orgId, access.orgId),
				gte(records.createdAt, since),
				ne(records.outcomeStatus, "pending"),
				or(
					isNotNull(records.runId),
					isNotNull(records.workItemId),
					linkedToolCalls,
				),
				or(ne(records.outcomeStatus, "success"), isNotNull(records.proofRef)),
			),
		);
}

export async function getTaskTypeLearningCurves(
	db: DbClient,
	access: FlywheelAccess,
	options: {
		windowDays?: number;
		minEpisodes?: number;
		maxPointsPerTask?: number;
		limit?: number;
		offset?: number;
		cohort?: "all" | LearningCurveCohort;
	} = {},
): Promise<LearningCurvesReport> {
	const windowDays = Math.min(Math.max(options.windowDays ?? 30, 7), 180);
	const minEpisodes = Math.min(Math.max(options.minEpisodes ?? 4, 2), 100);
	const maxPointsPerTask = Math.min(
		Math.max(options.maxPointsPerTask ?? 20, 2),
		50,
	);
	const pointsPerPhase = Math.max(1, Math.floor(maxPointsPerTask / 2));
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
	const offset = Math.max(options.offset ?? 0, 0);
	const cohort = options.cohort ?? "all";
	const since = new Date(
		Date.now() - windowDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const rawEpisodes = db
		.$with("raw_episodes")
		.as(learningCurveRawEpisodes(access, since));
	const filtered = db.$with("filtered_episodes").as(
		db
			.select()
			.from(rawEpisodes)
			.where(cohort === "all" ? undefined : eq(rawEpisodes.cohort, cohort)),
	);
	const taskTypes = db.$with("task_types").as(
		db
			.select({
				cohort: filtered.cohort,
				taskType: filtered.taskType,
				totalEpisodes: sql<number>`count(*)`.as("totalEpisodes"),
			})
			.from(filtered)
			.groupBy(filtered.cohort, filtered.taskType)
			.having(sql`count(*) >= ${minEpisodes}`),
	);
	const eligibleTypes = db.$with("eligible_types").as(
		db
			.select({
				cohort: taskTypes.cohort,
				taskType: taskTypes.taskType,
				totalEpisodes: taskTypes.totalEpisodes,
				totalTaskTypes: sql<number>`count(*) OVER ()`.as("totalTaskTypes"),
			})
			.from(taskTypes)
			.orderBy(
				desc(taskTypes.totalEpisodes),
				asc(taskTypes.cohort),
				asc(taskTypes.taskType),
			),
	);
	const selectedTypes = db
		.$with("selected_types")
		.as(db.select().from(eligibleTypes).limit(limit).offset(offset));
	const ranked = db.$with("ranked").as(
		db
			.select({
				outcomeStatus: filtered.outcomeStatus,
				cohort: filtered.cohort,
				taskType: filtered.taskType,
				durationMs: filtered.durationMs,
				steps: filtered.steps,
				tokenCost: filtered.tokenCost,
				workItemLinked: filtered.workItemLinked,
				totalEpisodes: selectedTypes.totalEpisodes,
				totalTaskTypes: selectedTypes.totalTaskTypes,
				episodeNumber: sql<number>`row_number() OVER (
					PARTITION BY ${filtered.cohort}, ${filtered.taskType} ORDER BY ${filtered.createdAt}, ${filtered.id}
				)`.as("episodeNumber"),
			})
			.from(filtered)
			.innerJoin(
				selectedTypes,
				and(
					eq(selectedTypes.cohort, filtered.cohort),
					eq(selectedTypes.taskType, filtered.taskType),
				),
			),
	);
	const phased = db.$with("phased").as(
		db
			.select({
				outcomeStatus: ranked.outcomeStatus,
				cohort: ranked.cohort,
				taskType: ranked.taskType,
				durationMs: ranked.durationMs,
				steps: ranked.steps,
				tokenCost: ranked.tokenCost,
				workItemLinked: ranked.workItemLinked,
				totalEpisodes: ranked.totalEpisodes,
				totalTaskTypes: ranked.totalTaskTypes,
				episodeNumber: ranked.episodeNumber,
				phase: sql<
					"baseline" | "recent"
				>`CASE WHEN ${ranked.episodeNumber} <= ${ranked.totalEpisodes} / 2.0
					THEN 'baseline' ELSE 'recent' END`.as("phase"),
			})
			.from(ranked),
	);
	const phaseRanked = db.$with("phase_ranked").as(
		db
			.select({
				outcomeStatus: phased.outcomeStatus,
				cohort: phased.cohort,
				taskType: phased.taskType,
				durationMs: phased.durationMs,
				steps: phased.steps,
				tokenCost: phased.tokenCost,
				workItemLinked: phased.workItemLinked,
				totalEpisodes: phased.totalEpisodes,
				totalTaskTypes: phased.totalTaskTypes,
				episodeNumber: phased.episodeNumber,
				phase: phased.phase,
				phaseEpisodeNumber: sql<number>`row_number() OVER (
					PARTITION BY ${phased.cohort}, ${phased.taskType}, ${phased.phase} ORDER BY ${phased.episodeNumber}
				)`.as("phaseEpisodeNumber"),
				phaseEpisodes:
					sql<number>`count(*) OVER (PARTITION BY ${phased.cohort}, ${phased.taskType}, ${phased.phase})`.as(
						"phaseEpisodes",
					),
			})
			.from(phased),
	);
	const cumulativeEpisodes = sql<number>`max(${phaseRanked.episodeNumber})`.as(
		"cumulativeEpisodes",
	);
	const rows: LearningCurveAggregateRow[] = await db
		.with(
			rawEpisodes,
			filtered,
			taskTypes,
			eligibleTypes,
			selectedTypes,
			ranked,
			phased,
			phaseRanked,
		)
		.select({
			cohort: phaseRanked.cohort,
			taskType: phaseRanked.taskType,
			totalEpisodes: phaseRanked.totalEpisodes,
			totalTaskTypes: phaseRanked.totalTaskTypes,
			phase: phaseRanked.phase,
			fromEpisode: sql<number>`min(${phaseRanked.episodeNumber})`.as(
				"fromEpisode",
			),
			cumulativeEpisodes,
			episodeCount: sql<number>`count(*)`.as("episodeCount"),
			successes:
				sql<number>`sum(CASE WHEN ${phaseRanked.outcomeStatus} = 'success' THEN 1 ELSE 0 END)`.as(
					"successes",
				),
			steps: sql<number>`sum(${phaseRanked.steps})`.as("steps"),
			durationMs: sql<number>`coalesce(sum(${phaseRanked.durationMs}), 0)`.as(
				"durationMs",
			),
			durationSamples:
				sql<number>`sum(CASE WHEN ${phaseRanked.durationMs} IS NOT NULL THEN 1 ELSE 0 END)`.as(
					"durationSamples",
				),
			tokenCost: sql<number>`coalesce(sum(${phaseRanked.tokenCost}), 0)`.as(
				"tokenCost",
			),
			tokenCostSamples:
				sql<number>`sum(CASE WHEN ${phaseRanked.tokenCost} IS NOT NULL THEN 1 ELSE 0 END)`.as(
					"tokenCostSamples",
				),
			workItemLinks: sql<number>`sum(${phaseRanked.workItemLinked})`.as(
				"workItemLinks",
			),
		})
		.from(phaseRanked)
		.groupBy(
			phaseRanked.cohort,
			phaseRanked.taskType,
			phaseRanked.phase,
			sql`CAST((${phaseRanked.phaseEpisodeNumber} - 1) * ${pointsPerPhase} / ${phaseRanked.phaseEpisodes} AS INTEGER)`,
		)
		.orderBy(phaseRanked.cohort, phaseRanked.taskType, cumulativeEpisodes);
	const pointsByTaskType = new Map<string, LearningCurvePoint[]>();
	const totalEpisodesByTaskType = new Map<string, number>();
	const taskIdentity = new Map<
		string,
		{ cohort: LearningCurveCohort; taskType: string }
	>();
	for (const raw of rows) {
		const key = `${raw.cohort}\u0000${raw.taskType}`;
		const episodeCount = Number(raw.episodeCount);
		const point: LearningCurvePoint = {
			phase: raw.phase,
			fromEpisode: Number(raw.fromEpisode),
			cumulativeEpisodes: Number(raw.cumulativeEpisodes),
			episodeCount,
			successRate: rate(Number(raw.successes), episodeCount),
			averageSteps: roundedAverage(Number(raw.steps), episodeCount) ?? 0,
			averageDurationMs: roundedAverage(
				Number(raw.durationMs),
				Number(raw.durationSamples),
			),
			durationSamples: Number(raw.durationSamples),
			averageTokenCost: roundedAverage(
				Number(raw.tokenCost),
				Number(raw.tokenCostSamples),
			),
			tokenCostSamples: Number(raw.tokenCostSamples),
			workItemLinkRate: rate(Number(raw.workItemLinks), episodeCount),
		};
		const points = pointsByTaskType.get(key) ?? [];
		points.push(point);
		pointsByTaskType.set(key, points);
		totalEpisodesByTaskType.set(key, Number(raw.totalEpisodes));
		taskIdentity.set(key, { cohort: raw.cohort, taskType: raw.taskType });
	}
	const curves: TaskTypeLearningCurve[] = [];
	const alerts: LearningCurveRegressionAlert[] = [];
	for (const [key, points] of pointsByTaskType) {
		const identity = taskIdentity.get(key);
		if (!identity) continue;
		const { cohort: curveCohort, taskType } = identity;
		const baseline = mergeLearningCurvePoints(points, "baseline");
		const recent = mergeLearningCurvePoints(points, "recent");
		const taskAlerts = buildLearningCurveAlerts(
			curveCohort,
			taskType,
			baseline,
			recent,
		);
		alerts.push(...taskAlerts);
		const improved = Boolean(
			baseline &&
			recent &&
			(recent.successRate >=
				baseline.successRate + LEARNING_TREND_THRESHOLDS.successGain ||
				recent.averageSteps <=
					baseline.averageSteps *
						LEARNING_TREND_THRESHOLDS.improvementShrinkFactor ||
				(recent.averageDurationMs !== null &&
					baseline.averageDurationMs !== null &&
					recent.averageDurationMs <=
						baseline.averageDurationMs *
							LEARNING_TREND_THRESHOLDS.improvementShrinkFactor) ||
				(recent.averageTokenCost !== null &&
					baseline.averageTokenCost !== null &&
					recent.averageTokenCost <=
						baseline.averageTokenCost *
							LEARNING_TREND_THRESHOLDS.improvementShrinkFactor)),
		);
		curves.push({
			cohort: curveCohort,
			taskType,
			totalEpisodes: totalEpisodesByTaskType.get(key) ?? 0,
			points,
			baseline,
			recent,
			direction:
				!baseline || !recent
					? "insufficient_data"
					: taskAlerts.length > 0
						? "regressed"
						: improved
							? "improved"
							: "flat",
		});
	}
	const totalTaskTypes = Number(rows[0]?.totalTaskTypes ?? curves.length);
	const episodeCount = curves.reduce(
		(sum, curve) => sum + curve.totalEpisodes,
		0,
	);
	return {
		tediId: access.tediId,
		orgId: access.orgId,
		windowDays,
		cohort,
		since,
		generatedAt: new Date().toISOString(),
		curves,
		alerts,
		pagination: {
			offset,
			limit,
			totalTaskTypes,
			nextOffset:
				offset + curves.length < totalTaskTypes ? offset + curves.length : null,
		},
		summary: {
			taskTypeCount: curves.length,
			episodeCount,
			improvingTaskTypes: curves.filter(
				(curve) => curve.direction === "improved",
			).length,
			regressingTaskTypes: curves.filter(
				(curve) => curve.direction === "regressed",
			).length,
			alertCount: alerts.length,
			cohortCounts: {
				organic: curves
					.filter((curve) => curve.cohort === "organic")
					.reduce((sum, curve) => sum + curve.totalEpisodes, 0),
				operator: curves
					.filter((curve) => curve.cohort === "operator")
					.reduce((sum, curve) => sum + curve.totalEpisodes, 0),
				scheduled_dogfood: curves
					.filter((curve) => curve.cohort === "scheduled_dogfood")
					.reduce((sum, curve) => sum + curve.totalEpisodes, 0),
			},
		},
	};
}
