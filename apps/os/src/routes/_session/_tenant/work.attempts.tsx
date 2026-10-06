import { createFileRoute } from "@tanstack/react-router";
import {
	WorkAttemptsPage,
	workActivitySearch,
} from "@/components/work-factory-pages";
import { workAttemptProjectionQueryOptions } from "@/lib/os-query-options";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/attempts")({
	validateSearch: workActivitySearch,
	loaderDeps: ({ search }) => ({ view: search.view }),
	loader: ({ context, deps }) =>
		context.queryClient
			.ensureQueryData(workAttemptProjectionQueryOptions(undefined, deps.view))
			.catch(() => undefined),
	component: WorkActivityRoute,
	pendingComponent: ListPending,
});

function WorkActivityRoute() {
	const { view } = Route.useSearch();
	return <WorkAttemptsPage key={view} view={view} />;
}
