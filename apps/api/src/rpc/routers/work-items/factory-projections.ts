import {
	readAgentScorecardActivity,
	readAgentScorecardHistory,
} from "@tedix/db/queries/work-items/agent-scorecard";
import { summarizeAgentHistory } from "../../../services/agent-history";
import { summarizeTediScorecard } from "../../../services/agent-scorecard";
import {
	listOrgWorkAttempts,
	listOrgWorkRecovery,
} from "@tedix/db/queries/work-items/projections";
import { listWorkItemReadinessProjection } from "@tedix/db/queries/work-items/readiness";
import { requireOrgId } from "../../org-scope";
import { withAuthorization } from "../../orpc";
import { authOs } from "./policy-helpers";
import { readLaneState } from "@tedix/db/queries/work-items/lane-lifecycle";

const projectionOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Read-only Work factory projections are restricted to the caller's organization",
		},
		"mcp:messaging.read",
	),
);

export const listReadinessProjectionProcedure =
	projectionOs.listReadinessProjection.handler(async ({ input, context }) => {
		const page = await listWorkItemReadinessProjection(context.db, {
			orgId: requireOrgId(context),
			projectId: input?.projectId,
			workKind: input?.workKind,
			cursor: input?.cursor
				? { createdAt: input.cursor.at, id: input.cursor.id }
				: undefined,
			limit: input?.limit,
			observedAt: new Date().toISOString(),
		});
		return {
			...page,
			nextCursor: page.nextCursor
				? { at: page.nextCursor.createdAt, id: page.nextCursor.id }
				: null,
		};
	});

/**
 * Attempt summaries can hold a whole agent transcript. The org-wide projection
 * is a paging index, so each row keeps a short summary; the full text stays on
 * the per-item attempt ledger. Without this, five settled rows overflow a
 * delegated tedi's tool-result budget and every page arrives clipped.
 */
export const ATTEMPT_PROJECTION_SUMMARY_CHARS = 480;

export function boundAttemptProjectionSummary(
	summary: string | null,
): string | null {
	if (summary === null || summary.length <= ATTEMPT_PROJECTION_SUMMARY_CHARS)
		return summary;
	return `${summary.slice(0, ATTEMPT_PROJECTION_SUMMARY_CHARS - 1).trimEnd()}…`;
}

export const listAttemptProjectionProcedure =
	projectionOs.listAttemptProjection.handler(async ({ input, context }) => {
		const page = await listOrgWorkAttempts(context.db, {
			orgId: requireOrgId(context),
			viewerUserId: context.authType === "user" ? context.user?.sub : undefined,
			projectId: input.projectId,
			workItemId: input.workItemId,
			runtimeStates: input.runtimeStates,
			outcomes: input.outcomes,
			executorType: input.executorType,
			cursor: input.cursor,
			limit: input.limit,
		});
		const now = new Date().toISOString();
		return {
			...page,
			data: await Promise.all(
				page.data.map(async (row) => ({
					...row,
					attempt: {
						...row.attempt,
						summary: boundAttemptProjectionSummary(row.attempt.summary),
					},
					laneState:
						input.includeLaneState === false
							? undefined
							: row.attempt.metadata.lane === true
								? await readLaneState(
										context.db,
										requireOrgId(context),
										row.attempt.id,
										now,
									)
								: null,
				})),
			),
		};
	});

export const listRecoveryProjectionProcedure =
	projectionOs.listRecoveryProjection.handler(async ({ input, context }) => {
		const observedAt = new Date().toISOString();
		return {
			...(await listOrgWorkRecovery(context.db, {
				orgId: requireOrgId(context),
				projectId: input.projectId,
				workKind: input.workKind,
				riskLevel: input.riskLevel,
				priority: input.priority,
				signal: input.signal,
				observedAt,
				cursor: input.cursor,
				limit: input.limit,
			})),
			observedAt,
		};
	});

export const getAgentScorecardProcedure =
	projectionOs.getAgentScorecard.handler(async ({ context, input }) => {
		const now = Date.now();
		const activity = await readAgentScorecardActivity(context.db, {
			orgId: requireOrgId(context),
			projectId: input.projectId,
			projectIds: input.projectIds,
			viewerUserId: context.authType === "user" ? context.user?.sub : undefined,
			since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
			now: new Date(now).toISOString(),
		});
		return {
			tedis: summarizeTediScorecard(activity, now),
			history: summarizeAgentHistory(
				await readAgentScorecardHistory(context.db, {
					orgId: requireOrgId(context),
					projectId: input.projectId,
					projectIds: input.projectIds,
					viewerUserId:
						context.authType === "user" ? context.user?.sub : undefined,
					since: new Date(now - 30 * 86_400_000).toISOString(),
					now: new Date(now).toISOString(),
				}),
				now,
			),
			localMetrics: activity.localMetrics.map((metric) => ({
				attemptId: metric.attemptId,
				telemetryStartedAt:
					typeof metric.telemetryStartedAt === "string"
						? metric.telemetryStartedAt
						: null,
				inputTokens:
					typeof metric.inputTokens === "number" ? metric.inputTokens : null,
				outputTokens:
					typeof metric.outputTokens === "number" ? metric.outputTokens : null,
				costUsd: typeof metric.costUsd === "number" ? metric.costUsd : null,
			})),
		};
	});
