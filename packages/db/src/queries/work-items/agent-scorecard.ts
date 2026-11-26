import {
	and,
	eq,
	exists,
	gte,
	lte,
	or,
	sql,
	type SQLWrapper,
} from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { anyIds, jsonRead, unixTime } from "../../core-store/dialect";
import { kernelRuntimeRuns as d1Home } from "../../schema/cognitive-runtime";
import { skillRuns as d1Skills } from "../../schema/cognitive";
import { machineToolCalls as d1Machines } from "../../schema/machines";
import { tedis as d1Tedis, tediCallCosts as d1Costs } from "../../schema/tedis";
import { billingUsageCharges as d1Charges } from "../../schema/billing";
import { workAgentSessions as d1Sessions } from "../../schema/work-agent-sessions";
import {
	workAttempts as d1Attempts,
	workItems as d1Work,
} from "../../schema/work-items";
import { personalWorkFeedPredicate } from "./personal-feed";

/** Start-time cohorts, scoped before aggregation; session reports can be overwritten. */
export async function readAgentScorecardHistory(
	db: DbQueryClient,
	input: {
		orgId: string;
		projectId?: string;
		projectIds?: string[];
		viewerUserId?: string;
		since: string;
		now: string;
	},
) {
	const attempts = coreTable(db, d1Attempts);
	const work = coreTable(db, d1Work);
	const sessions = coreTable(db, d1Sessions);
	const inWindow = (at: SQLWrapper) =>
		and(
			gte(at, input.since.slice(0, 10)),
			gte(unixTime(db, at), Math.floor(Date.parse(input.since) / 1000)),
			lte(unixTime(db, at), Math.floor(Date.parse(input.now) / 1000)),
		);
	const [rows, observations] = await Promise.all([
		db
			.select({
				id: attempts.id,
				workItemId: attempts.workItemId,
				executorType: attempts.executorType,
				executorId: attempts.executorId,
				externalSessionKey: attempts.externalSessionKey,
				startedAt: attempts.startedAt,
				finishedAt: attempts.finishedAt,
				outcome: attempts.outcome,
				metadata: attempts.metadata,
				sessionId: sql<string | null>`${sessions.id}`.as(
					"scorecard_session_id",
				),
				telemetryStartedAt: jsonRead(db, sessions.telemetry, ["startedAt"]),
				model: jsonRead(db, sessions.telemetry, ["model"]),
				inputTokens: jsonRead(
					db,
					sessions.telemetry,
					["usage", "input"],
					"number",
				),
				outputTokens: jsonRead(
					db,
					sessions.telemetry,
					["usage", "output"],
					"number",
				),
				costUsd: jsonRead(
					db,
					sessions.telemetry,
					["estimatedCostUsd"],
					"number",
				),
			})
			.from(attempts)
			.innerJoin(
				work,
				and(eq(work.orgId, attempts.orgId), eq(work.id, attempts.workItemId)),
			)
			.leftJoin(
				sessions,
				and(
					eq(sessions.organizationId, attempts.orgId),
					eq(sessions.workItemId, attempts.workItemId),
					or(
						eq(sessions.sessionKey, attempts.externalSessionKey),
						eq(
							sql`CASE WHEN ${sessions.harness} = 'claude-code' THEN 'claude' ELSE ${sessions.harness} END || ':' || ${sessions.sessionKey}`,
							attempts.externalSessionKey,
						),
					),
					gte(
						unixTime(db, jsonRead(db, sessions.telemetry, ["startedAt"])),
						unixTime(db, attempts.startedAt),
					),
					lte(
						unixTime(db, jsonRead(db, sessions.telemetry, ["startedAt"])),
						unixTime(db, sql`coalesce(${attempts.finishedAt}, ${input.now})`),
					),
				),
			)
			.where(
				and(
					eq(attempts.orgId, input.orgId),
					inWindow(attempts.startedAt),
					input.projectId ? eq(work.projectId, input.projectId) : undefined,
					input.projectIds
						? anyIds(db, work.projectId, input.projectIds)
						: undefined,
					input.viewerUserId
						? personalWorkFeedPredicate(input.viewerUserId)
						: undefined,
				),
			),
		// Observers may belong to a different project than the commit's Work.
		db
			.select({
				createdAt: work.createdAt,
				kind: jsonRead(db, work.metadata, ["event", "kind"]),
				repository: jsonRead(db, work.metadata, ["event", "repository"]),
				branch: jsonRead(db, work.metadata, ["event", "branch"]),
				sha: jsonRead(db, work.metadata, ["event", "sha"]),
				workItemId: jsonRead(db, work.metadata, ["event", "workItemId"]),
				occurredAt: jsonRead(db, work.metadata, ["event", "occurredAt"]),
				commits: jsonRead(
					db,
					work.metadata,
					["event", "commits"],
					"json",
				).mapWith((value) =>
					typeof value === "string" ? JSON.parse(value) : value,
				),
			})
			.from(work)
			.where(
				and(
					eq(work.orgId, input.orgId),
					eq(work.repositoryObserver, 1),
					inWindow(work.createdAt),
				),
			),
	]);
	return { rows, observations };
}

/** Lean execution and usage facts; each source retains its own identity. */
export async function readAgentScorecardActivity(
	db: DbQueryClient,
	input: {
		orgId: string;
		projectId?: string;
		projectIds?: string[];
		viewerUserId?: string;
		since: string;
		now: string;
	},
) {
	const home = coreTable(db, d1Home);
	const skills = coreTable(db, d1Skills);
	const machines = coreTable(db, d1Machines);
	const tedis = coreTable(db, d1Tedis);
	const costs = coreTable(db, d1Costs);
	const charges = coreTable(db, d1Charges);
	const sessions = coreTable(db, d1Sessions);
	const attempts = coreTable(db, d1Attempts);
	const work = coreTable(db, d1Work);
	const visibleWork = (workId: SQLWrapper) =>
		exists(
			db
				.select({ id: work.id })
				.from(work)
				.where(
					and(
						eq(work.orgId, input.orgId),
						eq(work.id, workId),
						input.projectId ? eq(work.projectId, input.projectId) : undefined,
						input.projectIds
							? anyIds(db, work.projectId, input.projectIds)
							: undefined,
						input.viewerUserId
							? personalWorkFeedPredicate(input.viewerUserId)
							: undefined,
					),
				),
		);
	const scope = (workId: SQLWrapper) =>
		input.projectId || input.projectIds
			? visibleWork(workId)
			: or(sql`${workId} IS NULL`, visibleWork(workId));
	const window = (at: SQLWrapper) =>
		and(
			// Keep the raw date range available to indexes for mixed ISO/SQLite timestamps.
			gte(at, input.since.slice(0, 10)),
			gte(unixTime(db, at), Math.ceil(Date.parse(input.since) / 1000)),
			lte(unixTime(db, at), Math.floor(Date.parse(input.now) / 1000)),
		);
	const [
		agents,
		homeRuns,
		codeRuns,
		machineCalls,
		usage,
		ledger,
		localMetrics,
	] = await Promise.all([
		db
			.select({
				id: tedis.id,
				name: tedis.displayName,
				fallbackName: tedis.name,
			})
			.from(tedis)
			.where(
				and(
					eq(tedis.organizationId, input.orgId),
					input.viewerUserId
						? or(
								eq(tedis.scope, "organization"),
								eq(tedis.ownerUserId, input.viewerUserId),
							)
						: undefined,
				),
			),
		db
			.select({
				id: home.id,
				tediId: sql<
					string | null
				>`coalesce(${home.delegatedTediId}, ${home.targetTediId})`.as(
					"scorecard_tedi_id",
				),
				childRunId: home.childRunId,
				status: home.status,
				startedAt: home.startedAt,
				createdAt: home.createdAt,
				finishedAt: home.completedAt,
			})
			.from(home)
			.where(
				and(
					eq(home.organizationId, input.orgId),
					window(home.createdAt),
					scope(home.workItemId),
				),
			),
		db
			.select({
				id: skills.id,
				tediId: skills.tediId,
				status: skills.status,
				startedAt: skills.startedAt,
				finishedAt: skills.completedAt,
			})
			.from(skills)
			.where(
				and(
					eq(skills.organizationId, input.orgId),
					window(skills.startedAt),
					scope(skills.workItemId),
				),
			),
		input.projectId || input.projectIds
			? Promise.resolve([])
			: db
					.select({
						id: machines.id,
						tediId: machines.requestedById,
						status: machines.status,
						startedAt: machines.createdAt,
						finishedAt: machines.finishedAt,
					})
					.from(machines)
					.where(
						and(
							eq(machines.orgId, input.orgId),
							eq(machines.requestedByType, "tedi"),
							window(machines.createdAt),
						),
					),
		db
			.select({
				id: costs.gatewayLogId,
				runId: costs.runId,
				tediId: costs.tediId,
				workItemId: costs.workItemId,
				tokens: costs.totalTokens,
				costUsd: costs.estimatedCostUsd,
				quality: costs.dataQuality,
				basis: costs.costBasis,
			})
			.from(costs)
			.where(
				and(
					eq(costs.orgId, input.orgId),
					window(costs.snapshotAt),
					scope(costs.workItemId),
				),
			),
		// A ledger charge supersedes the matching Gateway row; never add both.
		db
			.select({
				id: charges.gatewayLogId,
				runId: sql<
					string | null
				>`${jsonRead(db, charges.metadata, ["runId"])}`.as("scorecard_run_id"),
				tediId: charges.tediId,
				tokens:
					sql<number>`${charges.inputTokens} + ${charges.outputTokens}`.as(
						"scorecard_tokens",
					),
				costUsd: sql<number>`${charges.providerCostMicros} / 1000000.0`.as(
					"scorecard_cost_usd",
				),
				quality: charges.providerCostQuality,
			})
			.from(charges)
			.where(
				and(
					eq(charges.organizationId, input.orgId),
					window(charges.occurredAt),
					scope(jsonRead(db, charges.metadata, ["workItemId"])),
				),
			),
		db
			.select({
				attemptId: attempts.id,
				telemetryStartedAt: jsonRead(db, sessions.telemetry, ["startedAt"]),
				inputTokens: jsonRead(
					db,
					sessions.telemetry,
					["usage", "input"],
					"number",
				),
				outputTokens: jsonRead(
					db,
					sessions.telemetry,
					["usage", "output"],
					"number",
				),
				costUsd: jsonRead(
					db,
					sessions.telemetry,
					["estimatedCostUsd"],
					"number",
				),
			})
			.from(attempts)
			.innerJoin(
				sessions,
				and(
					eq(sessions.organizationId, attempts.orgId),
					eq(sessions.workItemId, attempts.workItemId),
					or(
						eq(sessions.sessionKey, attempts.externalSessionKey),
						eq(
							sql`CASE WHEN ${sessions.harness} = 'claude-code' THEN 'claude' ELSE ${sessions.harness} END || ':' || ${sessions.sessionKey}`,
							attempts.externalSessionKey,
						),
					),
				),
			)
			.where(
				and(
					eq(attempts.orgId, input.orgId),
					window(attempts.startedAt),
					visibleWork(attempts.workItemId),
				),
			),
	]);
	return {
		agents,
		homeRuns,
		codeRuns,
		machineCalls,
		usage,
		ledger,
		localMetrics,
	};
}
