import { createFileRoute, redirect } from "@tanstack/react-router";
import { homeRunQueryOptions } from "@/lib/os-query-options";
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
	loaderDeps: ({ search }) => ({ branch: search.branch }),
	loader: async ({ context, params, deps }) => {
		await prefetchHomeExecutionRoute(context.queryClient, params.runId);
		const result = await context.queryClient.ensureQueryData(
			homeRunQueryOptions(params.runId),
		);
		throw redirect({
			to: "/chat",
			search: {
				conversation: result.run.conversationId,
				details: params.runId,
				branch: deps.branch,
			},
			replace: true,
		});
	},
});
