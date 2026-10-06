import { createFileRoute } from "@tanstack/react-router";
import {
	WorkQueuePage,
	WorkCompletedPage,
	workQueueSearch,
} from "@/components/work-factory-pages";
import { prefetchWorkQueueRoute } from "@/lib/os-route-loaders";
import { workItemListQueryOptions } from "@/lib/os-query-options";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/")({
	validateSearch: workQueueSearch,
	loaderDeps: ({ search }) => ({ disposition: search.disposition }),
	loader: ({ context, deps }) =>
		deps.disposition === "completed"
			? context.queryClient
					.ensureQueryData(
						workItemListQueryOptions({
							disposition: "completed",
							limit: 25,
							offset: 0,
						}),
					)
					.catch(() => undefined)
			: prefetchWorkQueueRoute(context.queryClient),
	component: WorkQueueRoute,
	pendingComponent: ListPending,
});

function WorkQueueRoute() {
	const { disposition } = Route.useSearch();
	return disposition === "completed" ? (
		<WorkCompletedPage />
	) : (
		<WorkQueuePage />
	);
}
