import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
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
	const rows = aggregateHarnessScorecard(
		selected.flatMap((source) => source?.rows ?? []),
		now,
	);
	const numeric = "w-px text-right tabular-nums";
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
			{incomplete ? (
				<Text tone="secondary">Counting runner attempts…</Text>
			) : rows.length ? (
				<Table
					scrollLabel="Runner scorecard for the last 24 hours"
					className="w-full [&_td]:px-1 [&_th]:px-1 sm:[&_td]:px-2 sm:[&_th]:px-2"
				>
					<TableHeader>
						<TableRow>
							<TableHead scope="col">Runner</TableHead>
							{["Started", "Done", "Failed", "Commits"].map((label) => (
								<TableHead key={label} scope="col" className={numeric}>
									{label}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.runner}>
								<TableCell className="whitespace-normal break-all">
									{row.runner}
								</TableCell>
								{[row.started, row.done, row.failed, row.commits].map(
									(value, index) => (
										<TableCell key={index} className={numeric}>
											{value}
										</TableCell>
									),
								)}
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<Text tone="secondary">
					No runner started work in the last 24 hours.
				</Text>
			)}
		</section>
	);
}
