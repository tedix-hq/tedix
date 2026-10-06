import { createFileRoute } from "@tanstack/react-router";
import { TediDetailPage } from "@/components/tedi-detail";
import { OsRouteError } from "@/components/os-route-boundaries";
import { prefetchTediDetailRoute } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/team_/$tediId")({
	loader: ({ context, params }) =>
		prefetchTediDetailRoute(context.queryClient, params.tediId),
	component: TediDetailPage,
	pendingComponent: DetailPending,
	errorComponent: OsRouteError,
});
