import type { readAgentScorecardHistory } from "@tedix/db/queries/work-items/agent-scorecard";
import {
	AgentHistorySchema,
	WorkAttemptSettlementSchema,
	workSettlementCommits,
} from "@tedix/api-contract/schemas/work-items";
import { RepositoryEventSchema } from "@tedix/api-contract/schemas/repository-observer";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type * as z from "zod";

type Facts = Awaited<ReturnType<typeof readAgentScorecardHistory>>;
type History = z.infer<typeof AgentHistorySchema>;
type Row = History["windows"][number]["rows"][number];
const DAY = 86_400_000;
const number = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;

export function agentHistoryEvidence(
	history: History,
	executor: string,
): string {
	const format = (value: number | null) =>
		value === null ? "unknown" : Number(value.toFixed(3));
	return (
		`Activity scorecard observed ${history.observedAt}. ` +
		history.windows
			.map((window) => {
				const rows = window.rows.filter((row) => row.executor === executor);
				return rows.length
					? rows
							.map(
								(row) =>
									`${window.days}d ${row.executor}/${row.model ?? "unknown model"}: ${row.attempts} attempts/${row.items} items; succeeded=${row.succeeded}, unverified=${row.landedUnverified}, failed=${row.failed}, cancelled=${row.cancelled}, expired=${row.expired}, rejected=${row.rejected}, unsettled=${row.unsettled}; success=${format(row.successRate)}; median/p90 ms=${format(row.medianSettleMs)}/${format(row.p90SettleMs)}; attempts/item=${format(row.attemptsPerItem)}; landed=${row.landedItems}; USD/tokens per landed=${format(row.costPerLandedItemUsd)}/${format(row.tokensPerLandedItem)}; reverts/red CI=${format(row.reverts)}/${format(row.redCi)}; quality coverage=${row.qualityObservedCommits}/${row.landedCommits}`,
							)
							.join(". ")
					: `${window.days}d: no recorded Attempts for ${executor}`;
			})
			.join(". ")
	);
}

export function summarizeAgentHistory(facts: Facts, now: number): History {
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
	const checks = new Map<string, Event[]>();
	const reversals = new Map<string, Event[]>();
	const key = (repository: string, branch: string, sha: string) =>
		JSON.stringify([repository, branch, sha]);
	const add = (index: Map<string, Event[]>, id: string, event: Event) =>
		index.set(id, [...(index.get(id) ?? []), event]);
	for (const event of events) {
		if (event.kind === "push") {
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
		} else if (event.kind === "ci_red" || event.kind === "ci_green")
			add(checks, key(event.repository, event.branch, event.sha), event);
	}
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
		// Multiple reports of one host session must never multiply Attempts or usage.
		if (!previous || (!previous.sessionId && candidate.sessionId))
			attempts.set(attempt.id, candidate);
	}
	return {
		observedAt: new Date(now).toISOString(),
		windows: ([7, 30] as const).map((days) => {
			const since = now - days * DAY;
			const groups = new Map<
				string,
				{
					row: Row;
					items: Set<string>;
					landed: Set<string>;
					durations: number[];
					cost: number | null;
					tokens: number | null;
					commits: Map<string, string>;
				}
			>();
			for (const attempt of attempts.values()) {
				const started = Date.parse(attempt.startedAt);
				if (!Number.isFinite(started) || started < since || started > now)
					continue;
				const metrics = isRecord(attempt.metadata.runnerMetrics)
					? attempt.metadata.runnerMetrics
					: {};
				const harness = attempt.externalSessionKey?.split(":")[0];
				const executor =
					harness === "claude"
						? "claude-code"
						: harness || attempt.executorType;
				const model =
					typeof metrics.modelId === "string"
						? metrics.modelId
						: typeof attempt.model === "string"
							? attempt.model
							: null;
				const key = JSON.stringify([executor, model]);
				let group = groups.get(key);
				if (!group) {
					group = {
						row: {
							executor,
							model,
							attempts: 0,
							items: 0,
							succeeded: 0,
							landedUnverified: 0,
							failed: 0,
							cancelled: 0,
							expired: 0,
							rejected: 0,
							unsettled: 0,
							successRate: null,
							medianSettleMs: null,
							p90SettleMs: null,
							attemptsPerItem: 0,
							landedItems: 0,
							costPerLandedItemUsd: null,
							tokensPerLandedItem: null,
							reverts: null,
							redCi: null,
							qualityObservedCommits: 0,
							landedCommits: 0,
						},
						items: new Set(),
						landed: new Set(),
						durations: [],
						cost: 0,
						tokens: 0,
						commits: new Map(),
					};
					groups.set(key, group);
				}
				const { row } = group;
				row.attempts++;
				group.items.add(attempt.workItemId);
				if (attempt.outcome === "landed_unverified") row.landedUnverified++;
				else if (attempt.outcome) row[attempt.outcome]++;
				else row.unsettled++;
				const finished = attempt.finishedAt
					? Date.parse(attempt.finishedAt)
					: NaN;
				if (attempt.outcome && finished >= started && finished <= now)
					group.durations.push(finished - started);
				const cost =
					number(metrics.estimatedCostUsd) ?? number(attempt.costUsd);
				const input = number(metrics.tokensIn) ?? number(attempt.inputTokens);
				const output =
					number(metrics.tokensOut) ?? number(attempt.outputTokens);
				group.cost =
					group.cost !== null && cost !== null ? group.cost + cost : null;
				group.tokens =
					group.tokens !== null && input !== null && output !== null
						? group.tokens + input + output
						: null;
				const settlement = WorkAttemptSettlementSchema.safeParse(
					attempt.metadata.settlement,
				).data;
				// Recovery/verification of old source is not a new landed item.
				if (
					(attempt.outcome === "succeeded" ||
						attempt.outcome === "landed_unverified") &&
					(settlement?.mode === "commit" ||
						settlement?.mode === "repository_commit")
				) {
					group.landed.add(attempt.workItemId);
					for (const sha of workSettlementCommits(settlement))
						group.commits.set(sha, attempt.workItemId);
				}
			}
			for (const group of groups.values()) {
				const { row, durations } = group;
				row.items = group.items.size;
				row.landedItems = group.landed.size;
				row.attemptsPerItem = row.attempts / row.items;
				const settled = row.attempts - row.unsettled;
				row.successRate = settled ? row.succeeded / settled : null;
				durations.sort((a, b) => a - b);
				if (durations.length && durations.length === settled) {
					const middle = Math.floor(durations.length / 2);
					row.medianSettleMs =
						durations.length % 2
							? durations[middle]!
							: (durations[middle - 1]! + durations[middle]!) / 2;
					row.p90SettleMs = durations[Math.ceil(durations.length * 0.9) - 1]!;
				}
				row.costPerLandedItemUsd =
					row.landedItems && group.cost !== null
						? group.cost / row.landedItems
						: null;
				row.tokensPerLandedItem =
					row.landedItems && group.tokens !== null
						? group.tokens / row.landedItems
						: null;
				row.landedCommits = group.commits.size;
				const reverted = new Set<string>();
				const red = new Set<string>();
				const observed = new Set<string>();
				for (const [sha, workId] of group.commits) {
					for (const push of pushes.get(JSON.stringify([sha, workId])) ?? []) {
						const id = key(push.repository, push.branch, sha);
						if (reversals.get(id)?.some((event) => event.at >= push.at))
							reverted.add(sha);
						const matching =
							checks
								.get(id)
								?.filter(
									(event) => event.at >= push.at && event.workItemId === workId,
								) ?? [];
						if (matching.some((event) => event.kind === "ci_red")) red.add(sha);
						if (matching.length) observed.add(sha);
					}
				}
				row.qualityObservedCommits = observed.size;
				// A positive receipt is useful with partial coverage; absence is not zero.
				row.reverts =
					reverted.size ||
					(observed.size === group.commits.size && observed.size ? 0 : null);
				row.redCi =
					red.size ||
					(observed.size === group.commits.size && observed.size ? 0 : null);
			}
			return {
				days,
				since: new Date(since).toISOString(),
				rows: [...groups.values()]
					.map((group) => group.row)
					.sort(
						(a, b) =>
							a.executor.localeCompare(b.executor) ||
							(a.model ?? "").localeCompare(b.model ?? ""),
					),
			};
		}),
	};
}
