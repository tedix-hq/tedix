import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";
import {
	aggregateHarnessScorecard,
	SCORECARD_WINDOW_MS,
	type ScorecardAttempt,
	type ScorecardMetrics,
} from "@/lib/harness-scorecard";
import { WorkReadFailure } from "./work-surface-primitives";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./kumo/table";
import { Text } from "./kumo/text";

const measureLabels = [
	"Runs",
	"Done",
	"Failed",
	"Commits",
	"Time",
	"USD",
	"Tokens",
];

const compact = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 2,
});

type ScopeState = {
	rows: ScorecardAttempt[];
	incomplete: boolean;
	metrics?: ScorecardMetrics;
};
type Cursor = { at: string; id: string } | undefined;

function ScorecardSource({
	projectId,
	now,
	onUpdate,
}: {
	projectId?: string;
	now: number;
	onUpdate: (scope: string, state: ScopeState) => void;
}) {
	const query = useInfiniteQuery({
		...osQuery.workItems.listAttemptProjection.infiniteOptions({
			input: (cursor: Cursor) => ({ projectId, limit: 100, cursor }),
			initialPageParam: undefined as Cursor,
			getNextPageParam: (page) =>
				page.hasMore &&
				page.nextCursor &&
				Date.parse(page.nextCursor.at) >= now - SCORECARD_WINDOW_MS
					? page.nextCursor
					: undefined,
		}),
		...workRefreshOptions,
		refetchInterval: 30_000,
	});
	const metrics = useQuery({
		...osQuery.workItems.getAgentScorecard.queryOptions({
			input: { projectId },
		}),
		...workRefreshOptions,
		refetchInterval: 30_000,
	});
	const rows = useMemo(
		() => query.data?.pages.flatMap((page) => page.data) ?? [],
		[query.data],
	);
	const failed =
		query.isError ||
		query.failureCount > 0 ||
		metrics.isError ||
		metrics.failureCount > 0;
	const incomplete =
		query.isPending ||
		metrics.isPending ||
		failed ||
		!!query.hasNextPage ||
		query.data?.pages.some((page) => page.hasMore && !page.nextCursor) === true;
	useEffect(() => {
		if (query.hasNextPage && !query.isFetching && !failed)
			void query.fetchNextPage();
	}, [query.hasNextPage, query.isFetching, failed, query.fetchNextPage]);
	useEffect(
		() =>
			onUpdate(projectId ?? "organization", {
				rows,
				incomplete,
				metrics: metrics.data,
			}),
		[projectId, rows, incomplete, metrics.data, onUpdate],
	);
	return failed ? (
		<WorkReadFailure
			title="Agent scorecard unavailable"
			error={
				query.error ??
				query.failureReason ??
				metrics.error ??
				metrics.failureReason
			}
			onRetry={() => Promise.all([query.refetch(), metrics.refetch()])}
			retrying={query.isFetching}
		/>
	) : null;
}

export function ActivityHarnessScorecard({
	scopes,
	now,
}: {
	scopes: (string | undefined)[];
	now: number;
}) {
	const [sources, setSources] = useState<Record<string, ScopeState>>({});
	const onUpdate = useCallback(
		(scope: string, state: ScopeState) =>
			setSources((previous) => ({ ...previous, [scope]: state })),
		[],
	);
	const selected = scopes.map((scope) => sources[scope ?? "organization"]);
	const incomplete = selected.some((source) => !source || source.incomplete);
	const combined: ScorecardMetrics = {
		tedis: [],
		localMetrics: selected.flatMap(
			(source) => source?.metrics?.localMetrics ?? [],
		),
	};
	const tedis = new Map<string, ScorecardMetrics["tedis"][number]>();
	for (const source of selected)
		for (const row of source?.metrics?.tedis ?? []) {
			const prior = tedis.get(row.id);
			if (!prior) tedis.set(row.id, { ...row });
			else {
				prior.started += row.started;
				prior.done += row.done;
				prior.failed += row.failed;
				for (const key of ["durationMs", "costUsd", "tokens"] as const)
					prior[key] =
						prior[key] === null || row[key] === null
							? null
							: prior[key] + row[key];
			}
		}
	combined.tedis = [...tedis.values()];
	const rows = aggregateHarnessScorecard(
		selected.flatMap((source) => source?.rows ?? []),
		now,
		combined,
	);
	const numeric = "w-px text-right tabular-nums max-sm:w-auto";
	return (
		<section aria-label="Agent scorecard" className="grid min-w-0 gap-2">
			{scopes.map((projectId) => (
				<ScorecardSource
					key={projectId ?? "organization"}
					projectId={projectId}
					now={now}
					onUpdate={onUpdate}
				/>
			))}
			{incomplete ? (
				<Text tone="secondary">Counting agents…</Text>
			) : rows.length ? (
				<Table
					scrollLabel="Agent scorecard for the last 24 hours"
					mobileLayout="stacked"
					className="w-full [&_td]:px-1 [&_th]:px-1 sm:[&_td]:px-2 sm:[&_th]:px-2"
				>
					<TableHeader>
						<TableRow>
							<TableHead scope="col">Agent</TableHead>
							{measureLabels.map((label) => (
								<TableHead key={label} scope="col" className={numeric}>
									{label}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow
								key={row.id ?? row.runner}
								className="max-sm:grid-cols-2"
							>
								<TableCell className="whitespace-normal break-words max-sm:col-span-2">
									{(
										{
											codex: "Codex",
											"claude-code": "Claude Code",
											opencode: "OpenCode",
											devin: "Devin",
										} as Record<string, string>
									)[row.runner] ?? row.runner}
								</TableCell>
								{[
									row.started,
									row.done,
									row.failed,
									row.commits ?? "—",
									row.durationMs === null
										? "—"
										: `${Math.round(row.durationMs / 60_000)}m`,
									row.costUsd === null ? "—" : compact.format(row.costUsd),
									row.tokens === null ? "—" : compact.format(row.tokens),
								].map((value, index) => (
									<TableCell
										key={index}
										label={measureLabels[index]}
										className={numeric}
									>
										{value}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<Text tone="secondary">
					No agent started work in the last 24 hours.
				</Text>
			)}
			<Text tone="secondary">
				Runs include Home delegations, code executions and machine calls. Done
				includes landed results awaiting verification. Time sums elapsed
				execution time; USD estimates and tokens cover the last 24 hours. —
				means unknown. Machine calls appear only in the organization view.
			</Text>
		</section>
	);
}
