import type { readAgentScorecardActivity } from "@tedix/db/queries/work-items/agent-scorecard";
import type { GetAgentScorecardResultSchema } from "@tedix/api-contract/schemas/work-items";
import type * as z from "zod";

type Activity = Awaited<ReturnType<typeof readAgentScorecardActivity>>;
type Row = z.infer<typeof GetAgentScorecardResultSchema>["tedis"][number];

export function summarizeTediScorecard(activity: Activity, now: number): Row[] {
	const rows = new Map<string, Row>(
		activity.agents.map((agent) => [
			agent.id,
			{
				id: agent.id,
				runner: agent.name || agent.fallbackName,
				started: 0,
				done: 0,
				failed: 0,
				durationMs: 0,
				costUsd: null,
				tokens: null,
			},
		]),
	);
	const add = (run: {
		tediId: string | null;
		status: string;
		startedAt: string | null;
		finishedAt: string | null;
	}) => {
		const row = run.tediId ? rows.get(run.tediId) : undefined;
		if (!row) return;
		row.started++;
		if (run.status === "completed" || run.status === "done") row.done++;
		if (run.status === "failed" || run.status === "expired") row.failed++;
		if (run.startedAt && row.durationMs !== null) {
			const duration =
				(run.finishedAt ? Date.parse(run.finishedAt) : now) -
				Date.parse(run.startedAt);
			row.durationMs =
				Number.isFinite(duration) && duration >= 0
					? row.durationMs + duration
					: null;
		} else row.durationMs = null;
	};
	// A Home delegation represents its child once, even when several mirrors name it.
	const children = new Set<string>();
	for (const run of activity.homeRuns) {
		const key = `${run.tediId}:${run.childRunId ?? run.id}`;
		if (children.has(key)) continue;
		children.add(key);
		add({ ...run, startedAt: run.startedAt ?? run.createdAt });
	}
	activity.codeRuns.forEach(add);
	activity.machineCalls.forEach(add);
	const runOwners = new Map<string, string>();
	for (const run of activity.homeRuns)
		if (run.tediId) {
			runOwners.set(run.id, run.tediId);
			if (run.childRunId) runOwners.set(run.childRunId, run.tediId);
		}
	for (const run of activity.codeRuns) runOwners.set(run.id, run.tediId);
	const usageOwners = new Map(
		activity.usage.map((call) => [
			call.id,
			call.tediId ?? (call.runId ? runOwners.get(call.runId) : null),
		]),
	);
	const charged = new Set(
		activity.ledger.flatMap((charge) => (charge.id ? [charge.id] : [])),
	);
	const usage = [
		...activity.ledger.map((charge) => ({
			...charge,
			tediId:
				charge.tediId ??
				(charge.runId ? runOwners.get(charge.runId) : null) ??
				(charge.id ? usageOwners.get(charge.id) : null),
			known: true,
		})),
		...activity.usage
			.filter((call) => !charged.has(call.id))
			.map((call) => ({
				...call,
				tediId: call.tediId ?? (call.runId ? runOwners.get(call.runId) : null),
				known:
					call.quality === "ok" &&
					call.basis !== "unknown" &&
					call.costUsd !== null,
			})),
	];
	const unknownCosts = new Set<string>();
	for (const call of usage) {
		const row = call.tediId ? rows.get(call.tediId) : undefined;
		if (!row) continue;
		row.tokens = (row.tokens ?? 0) + call.tokens;
		if (!call.known || call.costUsd === null) unknownCosts.add(row.id);
		else row.costUsd = (row.costUsd ?? 0) + call.costUsd;
	}
	for (const id of unknownCosts) rows.get(id)!.costUsd = null;
	return [...rows.values()];
}
