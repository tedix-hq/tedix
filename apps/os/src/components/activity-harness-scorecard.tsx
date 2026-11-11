import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { DispatcherHealthReport } from "@tedix/api-contract/schemas/dispatcher-health";
import { osQuery } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";
import {
	aggregateHarnessScorecard,
	SCORECARD_WINDOW_MS,
	type ScorecardAttempt,
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

type ScopeState = { rows: ScorecardAttempt[]; incomplete: boolean };
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
	const rows = useMemo(
		() => query.data?.pages.flatMap((page) => page.data) ?? [],
		[query.data],
	);
	const failed = query.isError || query.failureCount > 0;
	const incomplete =
		query.isPending ||
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
			}),
		[projectId, rows, incomplete, onUpdate],
	);
	return failed ? (
		<WorkReadFailure
			title="Runner scorecard unavailable"
			error={query.error ?? query.failureReason}
			onRetry={() => query.refetch()}
			retrying={query.isFetching}
		/>
	) : null;
}

export function ActivityHarnessScorecard({
	scopes,
	reports,
	now,
}: {
	scopes: (string | undefined)[];
	reports: DispatcherHealthReport[];
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
	const fleetScope = scopes.length === 1 && scopes[0] === undefined;
	const rows = aggregateHarnessScorecard(
		selected.flatMap((source) => source?.rows ?? []),
		reports,
		now,
	);
	return (
		<section aria-label="Runner scorecard" className="grid min-w-0 gap-2">
			{scopes.map((projectId) => (
				<ScorecardSource
					key={projectId ?? "organization"}
					projectId={projectId}
					now={now}
					onUpdate={onUpdate}
				/>
			))}
			<Table
				scrollLabel="Runner scorecard for the last 24 hours"
				className="w-full table-fixed [&_th]:whitespace-normal [&_th]:break-words [&_th]:px-1 [&_td]:whitespace-normal [&_td]:break-words [&_td]:px-1"
			>
				<TableHeader>
					<TableRow>
						{[
							["Runner", "10%"],
							["Started", "8%"],
							["Succeeded", "14%"],
							["Failed", "7%"],
							["Orphaned*", "11%"],
							["Held", "7%"],
							["Supervisor kills", "12%"],
							["Commits on main†", "13%"],
							["Idle · current blockers", "18%"],
						].map(([label, width]) => (
							<TableHead key={label} scope="col" style={{ width }}>
								{label}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.runner}>
							<TableCell>{row.runner}</TableCell>
							{[row.started, row.succeeded, row.failed, row.orphaned].map(
								(value, index) => (
									<TableCell key={index}>
										{incomplete ? "Unknown" : value}
									</TableCell>
								),
							)}
							<TableCell>
								{fleetScope ? (row.held ?? "Unknown") : "Unknown"}
							</TableCell>
							<TableCell>
								{fleetScope ? (row.supervisorKills ?? "Unknown") : "Unknown"}
							</TableCell>
							<TableCell>{incomplete ? "Unknown" : row.commits}</TableCell>
							<TableCell>
								{fleetScope && row.idle
									? `${row.idle.held} held; ${row.idle.waitingOnPerson} waiting on person; ${row.idle.noCoordinator} no coordinator; ${row.idle.other} other`
									: "Unknown"}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{!rows.length && (
				<Text tone="secondary">
					{incomplete
						? "Checking runner attempts…"
						: "No runner attempts or reports in the last 24 hours."}
				</Text>
			)}
			{incomplete && (
				<Text role="caption">
					Counts are unknown until all pages load successfully.
				</Text>
			)}
			<Text role="caption" tone="secondary">
				Attempts started in the last 24 h; outcomes as of now. *Orphaned counts
				expired Attempts and unsettled Attempts with elapsed leases, not
				confirmed process exits. Fleet held counts Work revisions placed on
				hold; supervisor kills count lease-guard stop signals. These require
				fresh health reports covering 24 h; legacy, warming and project-scoped
				counts are unknown. †Unique dispatcher settlement commit receipts for
				these Attempts; existing fixes are excluded. Idle blockers use the
				latest complete runner report.
			</Text>
		</section>
	);
}
