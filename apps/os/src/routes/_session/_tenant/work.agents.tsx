import { createFileRoute } from "@tanstack/react-router";
import { WorkAgentsPage } from "@/components/work-agents-page";
import { workAgentSessionsQueryOptions } from "@/lib/os-query-options";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/agents")({
	loader: ({ context }) =>
		context.queryClient
			.ensureQueryData(workAgentSessionsQueryOptions())
			.catch(() => undefined),
	component: WorkAgentsPage,
	pendingComponent: ListPending,
});
