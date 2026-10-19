import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { workRefreshOptions } from "@/lib/work-refresh";
import { WorkReadReporter } from "@/components/work-read-region";
import { useEffect, useMemo, useRef } from "react";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import {
	osQuery,
	operationalContextQueryOptions,
} from "@/lib/os-query-options";
import { useWorkPrincipalNames } from "@/components/work-operations-pages";
import { useOsLocale } from "@/lib/use-os-locale";
import { resultFeedItems, workFeedItems } from "@/lib/activity-feed";

type Cursor = { at: string; id: string } | undefined;
export interface FeedSourceState {
	items: ActivityFeedItem[];
	loading: boolean;
	failed: boolean;
	more: boolean;
}

/** Each reader retains its own canonical cursor; rank never becomes a pagination cursor. */
export function ActivityFeedSources({
	projectId,
	pageSize,
	request,
	onUpdate,
}: {
	projectId?: string;
	pageSize: number;
	request: number;
	onUpdate: (projectId: string, state: FeedSourceState) => void;
}) {
	const locale = useOsLocale();
	const context = useQuery(operationalContextQueryOptions());
	const names = useWorkPrincipalNames(context.data?.organization.id);
	const work = useInfiniteQuery({
		...osQuery.workItems.listActivity.infiniteOptions({
			input: (cursor: Cursor) => ({ projectId, limit: pageSize, cursor }),
			initialPageParam: undefined as Cursor,
			getNextPageParam: (page) => page.nextCursor ?? undefined,
		}),
		...workRefreshOptions,
	});
	const results = useInfiniteQuery({
		...osQuery.workItems.listAttemptProjection.infiniteOptions({
			input: (cursor: Cursor) => ({
				projectId,
				limit: pageSize,
				cursor,
				outcomes: ["succeeded", "failed", "expired", "cancelled"],
			}),
			initialPageParam: undefined as Cursor,
			getNextPageParam: (page) => page.nextCursor ?? undefined,
		}),
		...workRefreshOptions,
	});
	const items = useMemo(
		() => [
			...workFeedItems(
				work.data?.pages.flatMap((p) => p.events) ?? [],
				projectId ?? null,
				names,
			),
			...resultFeedItems(results.data?.pages.flatMap((p) => p.data) ?? []),
		],
		[work.data, results.data, projectId, locale, names],
	);
	const queries = [work, results];
	const loading = queries.some((q) => q.isFetching);
	const failed = queries.some((q) => q.isError);
	const more = queries.some((q) => q.hasNextPage);
	useEffect(
		() =>
			onUpdate(projectId ?? "organization", { items, loading, failed, more }),
		[projectId, items, loading, failed, more, onUpdate],
	);
	const lastRequest = useRef(0);
	useEffect(() => {
		if (request <= lastRequest.current) return;
		lastRequest.current = request;
		for (const query of queries) {
			if (query.isError) void query.refetch();
			else if (query.hasNextPage && !query.isFetching)
				void query.fetchNextPage();
		}
	}, [request]);
	return (
		<>
			<WorkReadReporter query={work} />
			<WorkReadReporter query={results} />
		</>
	);
}
