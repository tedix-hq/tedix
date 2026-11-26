import { osQuery } from "@/lib/os-query-options";

type Cursor = { at: string; id: string } | undefined;

export function activityWorkPagesQueryOptions(
	projectId: string | undefined,
	pageSize: number,
) {
	return osQuery.workItems.listActivity.infiniteOptions({
		input: (cursor: Cursor) => ({ projectId, limit: pageSize, cursor }),
		initialPageParam: undefined as Cursor,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
}

export function activityResultPagesQueryOptions(
	projectId: string | undefined,
	pageSize: number,
) {
	return osQuery.workItems.listAttemptProjection.infiniteOptions({
		input: (cursor: Cursor) => ({
			projectId,
			limit: pageSize,
			cursor,
			outcomes: [
				"succeeded",
				"landed_unverified",
				"failed",
				"rejected",
				"expired",
				"cancelled",
			],
		}),
		initialPageParam: undefined as Cursor,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
}
