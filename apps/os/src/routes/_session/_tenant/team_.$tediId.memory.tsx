import { createFileRoute } from "@tanstack/react-router";
import { MemoryExplorer } from "@/components/memory-explorer";
import { prefetchTediMemoryRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute("/_session/_tenant/team_/$tediId/memory")({
	loader: ({ context, params }) =>
		prefetchTediMemoryRoute(context.queryClient, params.tediId),
	component: MemoryRoute,
});

function MemoryRoute() {
	return <MemoryExplorer tediId={Route.useParams().tediId} />;
}
