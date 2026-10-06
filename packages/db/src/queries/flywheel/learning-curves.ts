import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";

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
 * `WITH raw_episodes AS (${learningCurveRawEpisodesSql(access, since)})`.
 * Reference-class forecasting (queries/reference-class.ts) reuses this
 * fragment so the outside view is computed over the exact same episode
 * population as the learning curves — never a parallel SQL definition.
 */
export function learningCurveRawEpisodesSql(
	access: FlywheelAccess,
	since: string,
) {
	return sql`SELECT id, outcome_status,
			CASE
				WHEN json_valid(evidence) AND (
					json_extract(evidence, '$.skillSlug') LIKE 'platform-%-dogfood'
					OR json_extract(evidence, '$.taskType') LIKE 'skill:platform-%-dogfood'
				) THEN 'scheduled_dogfood'
				WHEN work_item_id IS NOT NULL THEN 'operator'
				ELSE 'organic'
			END AS cohort,
			COALESCE(
				CASE WHEN json_valid(evidence)
					THEN json_extract(evidence, '$.taskType') END,
				CASE WHEN json_valid(evidence) AND json_extract(evidence, '$.skillSlug') IS NOT NULL
					THEN 'skill:' || json_extract(evidence, '$.skillSlug') END,
				category
			) AS taskType,
			created_at,
			CASE
				WHEN run_id IS NOT NULL
					AND (SELECT min(runtime.created_at) FROM tedi_runtime_events runtime
						WHERE runtime.tedi_id = ${access.tediId}
							AND runtime.organization_id = ${access.orgId}
							AND runtime.run_id = tedi_rationale_records.run_id
							AND runtime.kind = 'run.started') IS NOT NULL
					AND (SELECT max(runtime.created_at) FROM tedi_runtime_events runtime
						WHERE runtime.tedi_id = ${access.tediId}
							AND runtime.organization_id = ${access.orgId}
							AND runtime.run_id = tedi_rationale_records.run_id
							AND runtime.kind IN ('run.completed', 'run.failed', 'run.canceled')) IS NOT NULL
				THEN max(0, CAST(round((julianday((
					SELECT max(runtime.created_at) FROM tedi_runtime_events runtime
					WHERE runtime.tedi_id = ${access.tediId}
						AND runtime.organization_id = ${access.orgId}
						AND runtime.run_id = tedi_rationale_records.run_id
						AND runtime.kind IN ('run.completed', 'run.failed', 'run.canceled')
				)) - julianday((
					SELECT min(runtime.created_at) FROM tedi_runtime_events runtime
					WHERE runtime.tedi_id = ${access.tediId}
						AND runtime.organization_id = ${access.orgId}
						AND runtime.run_id = tedi_rationale_records.run_id
						AND runtime.kind = 'run.started'
				))) * 86400000) AS INTEGER))
				WHEN completed_at IS NOT NULL
					THEN max(0, CAST(round((julianday(completed_at) - julianday(created_at)) * 86400000) AS INTEGER))
				ELSE NULL
			END AS durationMs,
			CASE
				WHEN tool_call_refs IS NOT NULL AND json_valid(tool_call_refs)
					THEN json_array_length(tool_call_refs)
				WHEN run_id IS NOT NULL THEN (
					SELECT count(*) FROM tedi_runtime_events runtime
					WHERE runtime.tedi_id = ${access.tediId}
						AND runtime.organization_id = ${access.orgId}
						AND runtime.run_id = tedi_rationale_records.run_id
						AND runtime.kind IN ('tool.completed', 'tool.failed')
				)
				ELSE 0 END AS steps,
			CASE WHEN run_id IS NOT NULL THEN (
				-- run.completed carries the scalar total as payload.tokensUsed (body
				-- parity with the kernel; see ledger-mirror.ts). The usage object has
				-- only input/output/cache token fields — no totalTokens — so the old
				-- '$.usage.totalTokens' read was structurally always NULL, leaving
				-- averageTokenCost dark. Read the correct sibling field.
				SELECT CAST(json_extract(runtime.payload, '$.tokensUsed') AS REAL)
				FROM tedi_runtime_events runtime
				WHERE runtime.tedi_id = ${access.tediId}
					AND runtime.organization_id = ${access.orgId}
					AND runtime.run_id = tedi_rationale_records.run_id
					AND runtime.kind = 'run.completed'
					AND json_valid(runtime.payload)
				ORDER BY runtime.created_at DESC LIMIT 1
			) END AS tokenCost,
			CASE WHEN work_item_id IS NOT NULL THEN 1 ELSE 0 END AS workItemLinked
		FROM tedi_rationale_records
		WHERE tedi_id = ${access.tediId}
			AND org_id = ${access.orgId}
			AND created_at >= ${since}
			AND outcome_status != 'pending'
			AND (run_id IS NOT NULL OR work_item_id IS NOT NULL
				OR (tool_call_refs IS NOT NULL AND json_valid(tool_call_refs)
					AND json_array_length(tool_call_refs) > 0))
			AND (outcome_status != 'success' OR proof_ref IS NOT NULL)`;
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
	const rows = await db.all<LearningCurveAggregateRow>(
		sql`WITH raw_episodes AS (
			${learningCurveRawEpisodesSql(access, since)}
		), filtered_episodes AS (
			SELECT * FROM raw_episodes
			WHERE ${cohort === "all" ? sql`1 = 1` : sql`cohort = ${cohort}`}
		), task_types AS (
			SELECT cohort, taskType, count(*) AS totalEpisodes
			FROM filtered_episodes GROUP BY cohort, taskType HAVING count(*) >= ${minEpisodes}
		), eligible_types AS (
			SELECT cohort, taskType, totalEpisodes, count(*) OVER () AS totalTaskTypes
			FROM task_types
			ORDER BY totalEpisodes DESC, cohort ASC, taskType ASC
		), selected_types AS (
			SELECT * FROM eligible_types LIMIT ${limit} OFFSET ${offset}
		), ranked AS (
			SELECT episode.*, selected.totalEpisodes, selected.totalTaskTypes,
				row_number() OVER (
					PARTITION BY episode.cohort, episode.taskType ORDER BY episode.created_at, episode.id
				) AS episodeNumber
			FROM filtered_episodes episode
			JOIN selected_types selected ON selected.cohort = episode.cohort
				AND selected.taskType = episode.taskType
		), phased AS (
			SELECT *, CASE WHEN episodeNumber <= totalEpisodes / 2.0
				THEN 'baseline' ELSE 'recent' END AS phase
			FROM ranked
		), phase_ranked AS (
			SELECT *,
				row_number() OVER (
					PARTITION BY cohort, taskType, phase ORDER BY episodeNumber
				) AS phaseEpisodeNumber,
				count(*) OVER (PARTITION BY cohort, taskType, phase) AS phaseEpisodes
			FROM phased
		)
		SELECT cohort, taskType, totalEpisodes, totalTaskTypes, phase,
			min(episodeNumber) AS fromEpisode,
			max(episodeNumber) AS cumulativeEpisodes,
			count(*) AS episodeCount,
			sum(CASE WHEN outcome_status = 'success' THEN 1 ELSE 0 END) AS successes,
			sum(steps) AS steps,
			coalesce(sum(durationMs), 0) AS durationMs,
			sum(CASE WHEN durationMs IS NOT NULL THEN 1 ELSE 0 END) AS durationSamples,
			coalesce(sum(tokenCost), 0) AS tokenCost,
			sum(CASE WHEN tokenCost IS NOT NULL THEN 1 ELSE 0 END) AS tokenCostSamples,
			sum(workItemLinked) AS workItemLinks
		FROM phase_ranked
		GROUP BY cohort, taskType, phase,
			CAST((phaseEpisodeNumber - 1) * ${pointsPerPhase} / phaseEpisodes AS INTEGER)
		ORDER BY cohort, taskType, cumulativeEpisodes`,
	);
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
