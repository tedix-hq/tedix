import type { readAgentScorecardHistory } from "@tedix/db/queries/work-items/agent-scorecard";
import {
	WorkAttemptSettlementSchema,
	workSettlementCommits,
} from "@tedix/api-contract/schemas/work-items";
import { RepositoryEventSchema } from "@tedix/api-contract/schemas/repository-observer";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { AgentWeeklyScorecardSchema } from "@tedix/api-contract/schemas/work-items";
import type * as z from "zod";

type Facts = Awaited<ReturnType<typeof readAgentScorecardHistory>>;
type Weekly = z.infer<typeof AgentWeeklyScorecardSchema>;
type Row = Weekly["rows"][number];
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const FIX_WINDOW = 7 * DAY;
const number = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;

const asTags = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((tag): tag is string => typeof tag === "string")
		: [];

/**
 * The weekly scorecard: per agent and per kind of task (the router's size,
 * risk and tags), how the week's Attempts landed, verified, cost and needed
 * people, and how many landed changes were fixed or reverted within 7 days.
 * Rates divide by the items the agent attempted; null means unknown.
 */
export function summarizeAgentWeeklyScorecard(
	facts: Facts,
	now: number,
): Weekly {
	const since = now - WEEK;
	const eventSchema = RepositoryEventSchema.pick({
		kind: true,
		repository: true,
		branch: true,
		sha: true,
		workItemId: true,
		occurredAt: true,
		commits: true,
	});
	const events = facts.observations
		.flatMap((observation) => {
			const { createdAt, ...data } = observation;
			const event = eventSchema.safeParse({
				...data,
				workItemId: observation.workItemId ?? undefined,
				occurredAt: observation.occurredAt ?? undefined,
				commits: observation.commits ?? undefined,
			}).data;
			return event
				? [{ ...event, at: Date.parse(event.occurredAt ?? createdAt) }]
				: [];
		})
		.filter((event) => event.at <= now);
	type Event = (typeof events)[number];
	const pushes = new Map<string, Event[]>();
	const reversals = new Map<string, Event[]>();
	const key = (repository: string, branch: string, sha: string) =>
		JSON.stringify([repository, branch, sha]);
	const add = (index: Map<string, Event[]>, id: string, event: Event) =>
		index.set(id, [...(index.get(id) ?? []), event]);
	for (const event of events) {
		if (event.kind !== "push") continue;
		if (event.workItemId)
			add(pushes, JSON.stringify([event.sha, event.workItemId]), event);
		for (const commit of event.commits ?? []) {
			if (commit.workItemId)
				add(pushes, JSON.stringify([commit.sha, commit.workItemId]), event);
			if (commit.revertsSha)
				add(
					reversals,
					key(event.repository, event.branch, commit.revertsSha),
					event,
				);
		}
	}
	// Human asks on each Work item inside the week, keyed for per-item counts.
	const asksByItem = new Map<string, number>();
	for (const ask of facts.interactions) {
		if (!ask.workItemId) continue;
		const at = Date.parse(ask.createdAt);
		if (!Number.isFinite(at) || at < since || at > now) continue;
		asksByItem.set(ask.workItemId, (asksByItem.get(ask.workItemId) ?? 0) + 1);
	}
	// Multiple reports of one host session must never multiply Attempts or usage.
	const attempts = new Map<string, Facts["rows"][number]>();
	for (const attempt of facts.rows) {
		const telemetryAt =
			typeof attempt.telemetryStartedAt === "string"
				? Date.parse(attempt.telemetryStartedAt)
				: NaN;
		const matches =
			telemetryAt >= Date.parse(attempt.startedAt) &&
			telemetryAt <=
				(attempt.finishedAt ? Date.parse(attempt.finishedAt) : now);
		const candidate = matches
			? attempt
			: {
					...attempt,
					sessionId: null,
					model: null,
					costUsd: null,
					inputTokens: null,
					outputTokens: null,
				};
		const previous = attempts.get(attempt.id);
		if (!previous || (!previous.sessionId && candidate.sessionId))
			attempts.set(attempt.id, candidate);
	}
	const groups = new Map<
		string,
		{
			row: Row;
			items: Set<string>;
			landed: Map<string, { verified: boolean; commits: string[] }>;
			firstAttemptLanded: Set<string>;
			landedAt: Map<string, number[]>;
			firstStarted: Map<string, number>;
			cost: number | null;
			tokens: number | null;
		}
	>();
	for (const attempt of attempts.values()) {
		const started = Date.parse(attempt.startedAt);
		if (!Number.isFinite(started) || started < since || started > now) continue;
		const metrics = isRecord(attempt.metadata.runnerMetrics)
			? attempt.metadata.runnerMetrics
			: {};
		const harness = attempt.externalSessionKey?.split(":")[0];
		const executor =
			harness === "claude" ? "claude-code" : harness || attempt.executorType;
		const model =
			typeof metrics.modelId === "string"
				? metrics.modelId
				: typeof attempt.model === "string"
					? attempt.model
					: null;
		const size = typeof attempt.size === "string" ? attempt.size : null;
		const risk =
			typeof attempt.riskLevel === "string" ? attempt.riskLevel : null;
		const tags = [...new Set(asTags(attempt.tags))].sort();
		const groupKey = JSON.stringify([executor, model, size, risk, tags]);
		let group = groups.get(groupKey);
		if (!group) {
			group = {
				row: {
					executor,
					model,
					size,
					risk,
					tags,
					items: 0,
					attempts: 0,
					landedItems: 0,
					landedRate: null,
					verifiedRate: null,
					firstAttemptLandedRate: null,
					medianTimeToLandMs: null,
					tokensPerLanded: null,
					costPerLandedUsd: null,
					humanInterventions: 0,
					fixedOrRevertedWithin7d: null,
				},
				items: new Set(),
				landed: new Map(),
				firstAttemptLanded: new Set(),
				landedAt: new Map(),
				firstStarted: new Map(),
				cost: 0,
				tokens: 0,
			};
			groups.set(groupKey, group);
		}
		const { row } = group;
		row.attempts++;
		group.items.add(attempt.workItemId);
		group.firstStarted.set(
			attempt.workItemId,
			Math.min(group.firstStarted.get(attempt.workItemId) ?? started, started),
		);
		const cost = number(metrics.estimatedCostUsd) ?? number(attempt.costUsd);
		const input = number(metrics.tokensIn) ?? number(attempt.inputTokens);
		const output = number(metrics.tokensOut) ?? number(attempt.outputTokens);
		group.cost =
			group.cost !== null && cost !== null ? group.cost + cost : null;
		group.tokens =
			group.tokens !== null && input !== null && output !== null
				? group.tokens + input + output
				: null;
		const settlement = WorkAttemptSettlementSchema.safeParse(
			attempt.metadata.settlement,
		).data;
		const lands =
			(attempt.outcome === "succeeded" ||
				attempt.outcome === "landed_unverified") &&
			(settlement?.mode === "commit" ||
				settlement?.mode === "repository_commit");
		if (lands) {
			const finished = attempt.finishedAt
				? Date.parse(attempt.finishedAt)
				: NaN;
			const entry = group.landed.get(attempt.workItemId) ?? {
				verified: false,
				commits: [],
			};
			entry.verified ||= attempt.outcome === "succeeded";
			for (const sha of workSettlementCommits(settlement))
				if (!entry.commits.includes(sha)) entry.commits.push(sha);
			group.landed.set(attempt.workItemId, entry);
			if (Number.isFinite(finished) && finished <= now)
				group.landedAt.set(attempt.workItemId, [
					...(group.landedAt.get(attempt.workItemId) ?? []),
					finished,
				]);
			// A first-attempt landing: the item's first-ever Attempt landed.
			if (attempt.attemptNumber === 1)
				group.firstAttemptLanded.add(attempt.workItemId);
		}
	}
	const rows: Row[] = [];
	for (const group of groups.values()) {
		const { row } = group;
		row.items = group.items.size;
		row.landedItems = group.landed.size;
		row.landedRate = row.items ? row.landedItems / row.items : null;
		const verified = [...group.landed.values()].filter(
			(entry) => entry.verified,
		).length;
		row.verifiedRate = row.landedItems ? verified / row.landedItems : null;
		row.firstAttemptLandedRate = row.items
			? group.firstAttemptLanded.size / row.items
			: null;
		// Median time to land: each landed item's first in-week Attempt start
		// to its last landing finish inside the week.
		const durations = [...group.landed.keys()].flatMap((workItemId) => {
			const first = group.firstStarted.get(workItemId);
			const finishes = group.landedAt.get(workItemId);
			return first !== undefined && finishes?.length
				? [Math.max(...finishes) - first]
				: [];
		});
		durations.sort((a, b) => a - b);
		if (durations.length) {
			const middle = Math.floor(durations.length / 2);
			row.medianTimeToLandMs =
				durations.length % 2
					? durations[middle]!
					: (durations[middle - 1]! + durations[middle]!) / 2;
		}
		row.costPerLandedUsd =
			row.landedItems && group.cost !== null
				? group.cost / row.landedItems
				: null;
		row.tokensPerLanded =
			row.landedItems && group.tokens !== null
				? group.tokens / row.landedItems
				: null;
		for (const workItemId of group.items)
			row.humanInterventions += asksByItem.get(workItemId) ?? 0;
		// Changes fixed or reverted within 7 days of landing: a landed commit
		// reverted inside the week, or an item landed again within 7 days.
		let fixedOrReverted = 0;
		for (const [workItemId, entry] of group.landed) {
			const finishes = group.landedAt.get(workItemId) ?? [];
			const firstLand = finishes.length ? Math.min(...finishes) : NaN;
			const refixed =
				Number.isFinite(firstLand) &&
				finishes.some(
					(finished) =>
						finished > firstLand && finished - firstLand <= FIX_WINDOW,
				);
			let reverted = false;
			for (const sha of entry.commits) {
				for (const push of pushes.get(JSON.stringify([sha, workItemId])) ??
					[]) {
					const id = key(push.repository, push.branch, sha);
					if (
						reversals
							.get(id)
							?.some(
								(event) =>
									event.at >= push.at && event.at - push.at <= FIX_WINDOW,
							)
					)
						reverted = true;
				}
			}
			if (refixed || reverted) fixedOrReverted++;
		}
		row.fixedOrRevertedWithin7d = row.landedItems ? fixedOrReverted : null;
		rows.push(row);
	}
	rows.sort(
		(a, b) =>
			a.executor.localeCompare(b.executor) ||
			(a.model ?? "").localeCompare(b.model ?? "") ||
			(a.size ?? "").localeCompare(b.size ?? "") ||
			(a.risk ?? "").localeCompare(b.risk ?? "") ||
			a.tags.join(",").localeCompare(b.tags.join(",")),
	);
	return {
		observedAt: new Date(now).toISOString(),
		since: new Date(since).toISOString(),
		rows,
	};
}
