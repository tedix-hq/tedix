/**
 * Turns the stored facts about agent runs into what a supervising tedi reads:
 * each run's state and, when it is not running, the reason the platform
 * knows. A reason is only ever read from stored rows; where a runner keeps a
 * fact on its own machine, the run says so in `unknown` instead of guessing.
 */

import type {
	AgentRun,
	AgentRunReason,
} from "@tedix/api-contract/schemas/work-agent-runs";
import { WorkExecutorSchema } from "@tedix/api-contract/schemas/work-items";
import {
	AGENT_RUN_LIST_WINDOW_DAYS,
	type AgentRunRow,
	type ListAgentRunsParams,
	listAgentRuns,
} from "@tedix/db/queries/work-items/agent-runs";
import { listDispatcherHealthReports } from "@tedix/db/queries/work-items/dispatcher-health";
import {
	deriveWorkItemReadiness,
	type WorkItemReadinessResult,
} from "@tedix/db/queries/work-items/readiness";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { DispatcherHealthReportRow } from "@tedix/db/schema/dispatcher-health";

/** A runner report older than this no longer shows a connected machine. */
export const RUNNER_REPORT_STALE_MS = 300_000;
/** Readiness is derived for at most this many waiting runs per call. */
const READINESS_LIMIT = 5;
const DETAIL_LIMIT = 700;
const SUMMARY_LIMIT = 500;
const LocalExecutorSchema = WorkExecutorSchema.exclude(["human", "tedi"]);

const RUNNER_WAIT_REASONS: Record<string, string> = {
	retry: "it will retry the task",
	confirmation: "it waits for a confirmation",
	reply: "it waits for a reply",
	completion: "it waits for the task to be completed",
	held: "it holds the task",
};

const UNKNOWN_QUEUED =
	"No connected runner has reported a current hold or repeated skip for this task.";
const UNKNOWN_LEASE =
	"The platform does not record why a run stopped reporting.";

function bounded(text: string, limit = DETAIL_LIMIT) {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function sender(stop: NonNullable<AgentRunRow["stop"]>) {
	const kind =
		stop.senderType === "user"
			? "a person"
			: stop.senderType === "tedi"
				? "a tedi"
				: "an agent";
	return `Stopped by ${kind} (${stop.senderId}) at ${stop.createdAt}.`;
}

function holdReason(row: AgentRunRow): AgentRunReason | null {
	if (row.workItem.dispatchState !== "held") return null;
	const stored = (
		row.workItem.metadata?.laneDispatch as { reason?: unknown } | undefined
	)?.reason;
	return {
		code: "held",
		detail: bounded(
			typeof stored === "string" && stored.trim()
				? stored
				: "The task is on hold and no reason was stored. Editing the task makes it ready again.",
		),
	};
}

/**
 * Why a run is not running. `readiness` is the task's derived readiness when
 * the caller had it; `reports` are the organization's current runner reports.
 */
export function agentRunReason(
	row: AgentRunRow,
	facts: {
		readiness?: WorkItemReadinessResult;
		reports: readonly DispatcherHealthReportRow[];
		now: number;
	},
): { reason: AgentRunReason | null; unknown: string | null } {
	const known = (reason: AgentRunReason | null) => ({ reason, unknown: null });
	if (row.state === "running") return known(null);
	if (
		row.stop &&
		(row.state !== "ended" || row.attempt?.outcome === "cancelled")
	)
		return known({ code: "stopped", detail: sender(row.stop) });
	const hold = holdReason(row);
	if (row.state === "ended") return known(hold);
	if (hold) return known(hold);
	if (row.refusedStart)
		return known({
			code: "start_refused",
			detail: bounded(
				`A runner tried to start the task at ${row.refusedStart.decidedAt} and the platform refused it: ${row.refusedStart.code}${row.refusedStart.reason ? `: ${row.refusedStart.reason}` : ""}`,
			),
		});
	if (row.attempt)
		return {
			reason: {
				code: "lease_lost",
				detail: `Run ${row.attempt.attemptNumber} last reported at ${row.attempt.heartbeatAt} and was not settled. A runner may resume it.`,
			},
			unknown: UNKNOWN_LEASE,
		};
	if (row.workItem.disposition !== "accepted")
		return known({
			code: "not_accepted",
			detail: "The task has not been accepted, so no runner picks it up.",
		});
	const { readiness } = facts;
	if (readiness && !readiness.ready) {
		const first = readiness.reasons[0];
		return known({
			code: readiness.state === "not_before" ? "not_before" : "not_ready",
			detail: bounded(
				first ? `${first.code}: ${first.detail}` : readiness.state,
			),
		});
	}
	const executor = row.workItem.executorId ?? "";
	const lanes = facts.reports.filter((report) => report.executor === executor);
	for (const report of facts.reports) {
		const waiting = report.duty?.activity?.waiting.find(
			(entry) => entry.id === row.workItem.id,
		);
		if (waiting)
			return known({
				code: "runner_waiting",
				detail: `A runner has the task and has not started it: ${RUNNER_WAIT_REASONS[waiting.reason] ?? waiting.reason}${waiting.retryAt ? `, next at ${waiting.retryAt}` : ""}.`,
			});
	}
	const connected = lanes.filter(
		(report) =>
			report.running &&
			facts.now - Date.parse(report.reportedAt) <= RUNNER_REPORT_STALE_MS,
	);
	const localExecutor = LocalExecutorSchema.safeParse(executor).success;
	const skip = facts.reports
		.filter((report) => {
			const observedAt = Date.parse(report.duty?.skips?.observedAt ?? "");
			return (
				report.running &&
				(report.executor === executor ||
					(report.executor === "any-local" && localExecutor)) &&
				facts.now - Date.parse(report.reportedAt) <= RUNNER_REPORT_STALE_MS &&
				observedAt <= facts.now &&
				facts.now - observedAt <= RUNNER_REPORT_STALE_MS
			);
		})
		.sort((a, b) => b.observedAt.localeCompare(a.observedAt))
		.flatMap((report) => report.duty?.skips?.entries ?? [])
		.find((entry) => entry.workItemId === row.workItem.id);
	if (skip)
		return known({
			code: "runner_skipped",
			detail: bounded(
				`A runner has skipped this task since ${skip.since}: ${skip.reason}`,
			),
		});
	if (connected.length === 0) {
		const newest = lanes
			.map((report) => report.reportedAt)
			.sort()
			.at(-1);
		return known({
			code: "no_runner",
			detail: newest
				? `No connected machine reports a running ${executor} runner. The newest report is from ${newest}.`
				: `No machine has reported a ${executor} runner in this organization.`,
		});
	}
	const admitted = connected
		.flatMap((report) =>
			report.lastAdmissionAt ? [report.lastAdmissionAt] : [],
		)
		.sort()
		.at(-1);
	const top = connected.find((report) => report.topReason);
	return {
		reason: {
			code: "queued",
			detail: bounded(
				`Nothing stored blocks the task. ${connected.length} ${executor} runner ${connected.length === 1 ? "lane is" : "lanes are"} connected${admitted ? `; the newest task was taken at ${admitted}` : ""}.${top?.topReason ? ` Most frequent recent reason a runner gave for not starting work: ${top.topReason}` : ""}`,
			),
		},
		unknown: UNKNOWN_QUEUED,
	};
}

function describeRun(
	row: AgentRunRow,
	facts: Parameters<typeof agentRunReason>[1],
): AgentRun {
	const { workItem, attempt, lastStep } = row;
	const since =
		lastStep?.at ?? (attempt ? Date.parse(attempt.startedAt) : null);
	return {
		workItemId: workItem.id,
		title: workItem.title,
		executor: workItem.executorId ?? "",
		tediId: workItem.stewardId ?? "",
		projectId: workItem.projectId,
		state: row.state,
		outcome: attempt?.outcome ?? null,
		createdAt: workItem.createdAt,
		attemptId: attempt?.id ?? null,
		attempts: row.attemptCount,
		startedAt: attempt?.startedAt ?? null,
		endedAt: attempt?.finishedAt ?? null,
		summary: attempt?.summary ? bounded(attempt.summary, SUMMARY_LIMIT) : null,
		lastStep: lastStep
			? {
					seq: lastStep.seq,
					at: new Date(lastStep.at).toISOString(),
					kind: lastStep.kind,
					text: lastStep.text.slice(0, 500),
				}
			: null,
		minutesSinceLastStep:
			row.state === "ended" || since === null
				? null
				: Math.max(0, Math.floor((facts.now - since) / 60_000)),
		pendingFollowUps: row.pendingFollowUps,
		...agentRunReason(row, facts),
	};
}

/** The stored rows beside what a tedi reads of them, newest first. */
export async function describeAgentRunRows(
	db: DbQueryClient,
	params: ListAgentRunsParams,
): Promise<{
	listedAt: string;
	described: { row: AgentRunRow; run: AgentRun }[];
}> {
	const listedAt = params.at ?? new Date().toISOString();
	const rows = await listAgentRuns(db, { ...params, at: listedAt });
	const waiting = rows.filter((row) => row.state === "waiting_for_runner");
	const reports =
		waiting.length > 0
			? await listDispatcherHealthReports(db, params.orgId)
			: [];
	const readiness = new Map<string, WorkItemReadinessResult>();
	for (const row of waiting
		.filter(
			(candidate) =>
				!candidate.attempt &&
				!candidate.refusedStart &&
				candidate.workItem.disposition === "accepted" &&
				candidate.workItem.dispatchState !== "held",
		)
		.slice(0, READINESS_LIMIT))
		readiness.set(
			row.workItem.id,
			await deriveWorkItemReadiness(db, {
				orgId: params.orgId,
				workItemId: row.workItem.id,
				derivedAt: listedAt,
			}),
		);
	const now = Date.parse(listedAt);
	return {
		listedAt,
		described: rows.map((row) => ({
			row,
			run: describeRun(row, {
				readiness: readiness.get(row.workItem.id),
				reports,
				now,
			}),
		})),
	};
}

/** The runs with their reasons, newest first. */
export async function describeAgentRuns(
	db: DbQueryClient,
	params: ListAgentRunsParams,
): Promise<{ listedAt: string; windowDays: number; runs: AgentRun[] }> {
	const { listedAt, described } = await describeAgentRunRows(db, params);
	return {
		listedAt,
		windowDays: AGENT_RUN_LIST_WINDOW_DAYS,
		runs: described.map(({ run }) => run),
	};
}
