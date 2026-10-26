import { and, asc, eq, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../../query-client";
import { tediRuntimeEvents } from "../../schema/cognitive-runtime";
import {
	decisionExposures,
	decisionOutcomeLabels,
	learningInteractionEvents,
} from "../../schema/learning-feedback";
import { providerExecutionAttempts } from "../../schema/provider-executions";
import { tediCallCosts } from "../../schema/tedis";
import { workAdmissions } from "../../schema/work-factory";
import { workAttempts, workItems } from "../../schema/work-items";
import {
	effectiveCallCostsRelation,
	effectiveCostKnown,
	effectiveCostUsd,
} from "./provider-cost-evidence";

type Coverage = { known: number; total: number };

export type ModelFitReport = {
	task: {
		workItemId: string;
		currentVersion: number;
	};
	calls: Array<{
		callId: string;
		runId: string | null;
		taskVersion: number | null;
		executionId: string | null;
		requestedProvider: string | null;
		requestedModel: string | null;
		actualProvider: string | null;
		actualModel: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
		callerWallTimeMs: number | null;
		providerDurationMs: null;
		runFallbackTransitions: number | null;
		errorKind: null;
		success: boolean;
		costUsd: number | null;
		origin: Record<string, JsonValue> | null;
		policy: Record<string, JsonValue> | null;
	}>;
	routes: Array<{
		provider: string | null;
		model: string;
		observedCalls: number;
		initialObservedRuns: number;
		fallbackTransitionsToRoute: number;
	}>;
	latency: {
		semantics: "caller_wall_time_including_admission_and_response_parsing";
		p50Ms: number | null;
		p95Ms: number | null;
		coverage: Coverage;
		providerDurationP50Ms: null;
		providerDurationP95Ms: null;
	};
	cost: {
		knownSubtotalUsd: number | null;
		knownCostPer1kTokensUsd: number | null;
		knownTokens: number;
		coverage: Coverage;
	};
	retries: {
		initialAttemptDenominator: null;
		initialObservedRunDenominator: number;
		observedFallbackTransitions: number;
		runsWithFallback: number;
		exhaustedFallbackDenominator: null;
		exhaustedFallbacks: null;
		coverage: Coverage;
	};
	human: {
		explicitCorrectionEvents: number;
		attentionOutcomes: number;
		editedAttentionOutcomes: number;
		attentionOutcomeLabels: Record<string, number>;
	};
	coverage: {
		taskVersion: Coverage;
		providerExecution: Coverage;
		retryLedger: Coverage;
		errorKind: Coverage;
		rawInput: Coverage;
	};
};

function percentile(values: number[], quantile: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}

function isExplicitCorrection(
	eventKind: string,
	metadata: Record<string, JsonValue> | null,
): boolean {
	return (
		eventKind === "edited" ||
		eventKind === "manually_replaced" ||
		(eventKind === "undone" && metadata?.learningCorrection === true)
	);
}

function fallbackRoute(modelRef: string) {
	const separator = modelRef.indexOf("/");
	return separator < 0
		? { provider: null, model: modelRef }
		: {
				provider: modelRef.slice(0, separator),
				model: modelRef.slice(separator + 1),
			};
}

/**
 * Joins canonical Work, provider admission, call-cost, fallback, correction and
 * attention ledgers without treating missing evidence as a zero observation.
 */
export async function getModelFitReport(
	db: DbQueryClient,
	params: { organizationId: string; workItemId: string },
): Promise<ModelFitReport | null> {
	const task = await db
		.select({ currentVersion: workItems.version })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.organizationId),
				eq(workItems.id, params.workItemId),
			),
		)
		.limit(1);
	if (!task[0]) return null;

	const [callRows, attemptRows, retryRows, correctionRows, attentionRows] =
		await Promise.all([
			db
				.select({
					callId: tediCallCosts.id,
					runId: tediCallCosts.runId,
					executionId: tediCallCosts.executionId,
					requestedProvider: sql<
						string | null
					>`${providerExecutionAttempts.provider}`.as("requested_provider"),
					requestedModel: providerExecutionAttempts.requestModel,
					actualProvider: sql<string | null>`${tediCallCosts.provider}`.as(
						"actual_provider",
					),
					actualModel: tediCallCosts.model,
					inputTokens: tediCallCosts.inputTokens,
					outputTokens: tediCallCosts.outputTokens,
					cacheReadTokens: tediCallCosts.cacheReadTokens,
					cacheWriteTokens: tediCallCosts.cacheWriteTokens,
					totalTokens: tediCallCosts.totalTokens,
					callerWallTimeMs: tediCallCosts.callDurationMs,
					success: tediCallCosts.success,
					costUsd: sql<number | null>`CASE WHEN ${effectiveCostKnown}
						THEN ${effectiveCostUsd} ELSE NULL END`.as("known_cost_usd"),
					origin: providerExecutionAttempts.origin,
					policy: providerExecutionAttempts.policy,
					snapshotAt: tediCallCosts.snapshotAt,
				})
				.from(effectiveCallCostsRelation())
				.leftJoin(
					providerExecutionAttempts,
					and(
						eq(providerExecutionAttempts.id, tediCallCosts.executionId),
						eq(providerExecutionAttempts.organizationId, tediCallCosts.orgId),
					),
				)
				.where(
					and(
						eq(tediCallCosts.orgId, params.organizationId),
						eq(tediCallCosts.workItemId, params.workItemId),
					),
				)
				.orderBy(asc(tediCallCosts.snapshotAt), asc(tediCallCosts.id)),
			db
				.select({
					runId: workAttempts.runId,
					taskVersion: workAdmissions.workItemVersion,
				})
				.from(workAttempts)
				.innerJoin(
					workAdmissions,
					and(
						eq(workAdmissions.id, workAttempts.admissionId),
						eq(workAdmissions.orgId, workAttempts.orgId),
						eq(workAdmissions.workItemId, workAttempts.workItemId),
					),
				)
				.where(
					and(
						eq(workAttempts.orgId, params.organizationId),
						eq(workAttempts.workItemId, params.workItemId),
					),
				),
			db
				.select({
					runId: tediRuntimeEvents.runId,
					payload: tediRuntimeEvents.payload,
				})
				.from(tediRuntimeEvents)
				.where(
					and(
						eq(tediRuntimeEvents.organizationId, params.organizationId),
						eq(tediRuntimeEvents.kind, "step.retry"),
						sql`json_extract(${tediRuntimeEvents.payload}, '$.operation') = 'model_fallback'`,
						sql`${tediRuntimeEvents.runId} IN (SELECT run_id FROM work_attempts WHERE org_id = ${params.organizationId} AND work_item_id = ${params.workItemId} AND run_id IS NOT NULL)`,
					),
				),
			db
				.select({
					eventKind: learningInteractionEvents.eventKind,
					metadata: learningInteractionEvents.metadata,
				})
				.from(learningInteractionEvents)
				.where(
					and(
						eq(learningInteractionEvents.organizationId, params.organizationId),
						eq(learningInteractionEvents.actorType, "user"),
						sql`((${learningInteractionEvents.targetType} = 'work_item' AND ${learningInteractionEvents.targetId} = ${params.workItemId}) OR json_extract(${learningInteractionEvents.metadata}, '$.workItemId') = ${params.workItemId})`,
					),
				),
			db
				.select({
					label:
						sql<string>`json_extract(${decisionOutcomeLabels.outcome}, '$.label')`.as(
							"outcome_label",
						),
				})
				.from(decisionExposures)
				.innerJoin(
					decisionOutcomeLabels,
					and(
						eq(
							decisionOutcomeLabels.organizationId,
							decisionExposures.organizationId,
						),
						eq(decisionOutcomeLabels.actorId, decisionExposures.actorId),
						eq(decisionOutcomeLabels.window, "immediate"),
						sql`json_extract(${decisionOutcomeLabels.outcome}, '$.exposureId') = ${decisionExposures.id}`,
					),
				)
				.where(
					and(
						eq(decisionExposures.organizationId, params.organizationId),
						sql`json_extract(${decisionExposures.snapshot}, '$.workItemId') = ${params.workItemId}`,
					),
				),
		]);

	const versionByRun = new Map(
		attemptRows.flatMap((row) =>
			row.runId ? [[row.runId, row.taskVersion] as const] : [],
		),
	);
	const retriesByRun = new Map<string, number>();
	const fallbackRoutes = new Map<string, number>();
	for (const row of retryRows) {
		if (row.runId)
			retriesByRun.set(row.runId, (retriesByRun.get(row.runId) ?? 0) + 1);
		if (typeof row.payload?.to === "string") {
			const route = fallbackRoute(row.payload.to);
			const key = `${route.provider ?? ""}\u0000${route.model}`;
			fallbackRoutes.set(key, (fallbackRoutes.get(key) ?? 0) + 1);
		}
	}

	const firstCallByRun = new Map<string, string>();
	for (const row of callRows)
		if (row.runId && !firstCallByRun.has(row.runId))
			firstCallByRun.set(row.runId, row.callId);
	const routes = new Map<string, ModelFitReport["routes"][number]>();
	for (const row of callRows) {
		const key = `${row.actualProvider ?? ""}\u0000${row.actualModel}`;
		const route = routes.get(key) ?? {
			provider: row.actualProvider,
			model: row.actualModel,
			observedCalls: 0,
			initialObservedRuns: 0,
			fallbackTransitionsToRoute: fallbackRoutes.get(key) ?? 0,
		};
		route.observedCalls++;
		if (row.runId && firstCallByRun.get(row.runId) === row.callId)
			route.initialObservedRuns++;
		routes.set(key, route);
	}
	for (const [key, transitions] of fallbackRoutes)
		if (!routes.has(key)) {
			const [provider, model] = key.split("\u0000");
			routes.set(key, {
				provider: provider || null,
				model: model!,
				observedCalls: 0,
				initialObservedRuns: 0,
				fallbackTransitionsToRoute: transitions,
			});
		}

	const durations = callRows.flatMap((row) =>
		row.callerWallTimeMs === null ? [] : [row.callerWallTimeMs],
	);
	const knownCostRows = callRows.filter((row) => row.costUsd !== null);
	const knownSubtotalUsd = knownCostRows.reduce(
		(total, row) => total + row.costUsd!,
		0,
	);
	const knownTokens = knownCostRows.reduce(
		(total, row) => total + row.totalTokens,
		0,
	);
	const attentionOutcomeLabels: Record<string, number> = {};
	for (const row of attentionRows)
		attentionOutcomeLabels[row.label] =
			(attentionOutcomeLabels[row.label] ?? 0) + 1;
	const callsWithRetryLedger = callRows.filter(
		(row) => row.runId !== null && versionByRun.has(row.runId),
	).length;
	const calls = callRows.map((row) => ({
		callId: row.callId,
		runId: row.runId,
		taskVersion: row.runId ? (versionByRun.get(row.runId) ?? null) : null,
		executionId: row.executionId,
		requestedProvider: row.requestedProvider,
		requestedModel: row.requestedModel,
		actualProvider: row.actualProvider,
		actualModel: row.actualModel,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheReadTokens: row.cacheReadTokens,
		cacheWriteTokens: row.cacheWriteTokens,
		totalTokens: row.totalTokens,
		callerWallTimeMs: row.callerWallTimeMs,
		providerDurationMs: null,
		runFallbackTransitions:
			row.runId && versionByRun.has(row.runId)
				? (retriesByRun.get(row.runId) ?? 0)
				: null,
		errorKind: null,
		success: row.success,
		costUsd: row.costUsd,
		origin: row.origin,
		policy: row.policy,
	}));

	return {
		task: {
			workItemId: params.workItemId,
			currentVersion: task[0].currentVersion,
		},
		calls,
		routes: [...routes.values()].sort(
			(a, b) =>
				b.observedCalls - a.observedCalls || a.model.localeCompare(b.model),
		),
		latency: {
			semantics: "caller_wall_time_including_admission_and_response_parsing",
			p50Ms: percentile(durations, 0.5),
			p95Ms: percentile(durations, 0.95),
			coverage: { known: durations.length, total: calls.length },
			providerDurationP50Ms: null,
			providerDurationP95Ms: null,
		},
		cost: {
			knownSubtotalUsd: knownCostRows.length ? knownSubtotalUsd : null,
			knownCostPer1kTokensUsd:
				knownCostRows.length && knownTokens > 0
					? (knownSubtotalUsd * 1000) / knownTokens
					: null,
			knownTokens,
			coverage: { known: knownCostRows.length, total: calls.length },
		},
		retries: {
			initialAttemptDenominator: null,
			initialObservedRunDenominator: firstCallByRun.size,
			observedFallbackTransitions: retryRows.length,
			runsWithFallback: retriesByRun.size,
			exhaustedFallbackDenominator: null,
			exhaustedFallbacks: null,
			coverage: { known: callsWithRetryLedger, total: calls.length },
		},
		human: {
			explicitCorrectionEvents: correctionRows.filter((row) =>
				isExplicitCorrection(row.eventKind, row.metadata ?? null),
			).length,
			attentionOutcomes: attentionRows.length,
			editedAttentionOutcomes: attentionOutcomeLabels.edited_then_approved ?? 0,
			attentionOutcomeLabels,
		},
		coverage: {
			taskVersion: {
				known: calls.filter((row) => row.taskVersion !== null).length,
				total: calls.length,
			},
			providerExecution: {
				known: calls.filter((row) => row.requestedModel !== null).length,
				total: calls.length,
			},
			retryLedger: { known: callsWithRetryLedger, total: calls.length },
			errorKind: { known: 0, total: calls.length },
			rawInput: { known: 0, total: calls.length },
		},
	};
}
