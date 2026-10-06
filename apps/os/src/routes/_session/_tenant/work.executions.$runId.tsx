import { createFileRoute } from "@tanstack/react-router";
import { HomeExecutionDetailPage } from "@/components/home-execution-detail";
import { prefetchHomeExecutionRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute(
	"/_session/_tenant/work/executions/$runId",
)({
	validateSearch: (search: Record<string, unknown>) => ({
		branch:
			typeof search.branch === "string" && search.branch.trim()
				? search.branch
				: undefined,
	}),
	loader: ({ context, params }) =>
		prefetchHomeExecutionRoute(context.queryClient, params.runId),
	component: HomeExecutionRoute,
});

function HomeExecutionRoute() {
	const { runId } = Route.useParams();
	const { branch } = Route.useSearch();
	return <HomeExecutionDetailPage runId={runId} branchId={branch} />;
}
