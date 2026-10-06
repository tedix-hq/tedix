import { createFileRoute } from "@tanstack/react-router";
import {
	WorkCapacityPage,
	workCapacitySearch,
} from "@/components/work-operations-pages";
import { prefetchWorkCapacityRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/capacity")({
	loader: ({ context }) => prefetchWorkCapacityRoute(context.queryClient),
	validateSearch: workCapacitySearch,
	component: WorkCapacityRoute,
	pendingComponent: ListPending,
});

function WorkCapacityRoute() {
	const search = Route.useSearch();
	return (
		<WorkCapacityPage
			resourceKey={search.resourceKey}
			saturatedOnly={search.saturated}
			view={search.view}
			exhaustedOnly={search.exhausted}
		/>
	);
}
