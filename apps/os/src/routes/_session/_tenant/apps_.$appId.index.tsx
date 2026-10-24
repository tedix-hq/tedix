import { createFileRoute } from "@tanstack/react-router";
import { AppOverviewRoute } from "@/components/app-gateway-overview";
import { prefetchAppOverviewRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute("/_session/_tenant/apps_/$appId/")({
	loader: ({ context, params }) =>
		prefetchAppOverviewRoute(context.queryClient, params.appId),
	component: AppOverviewRoute,
});
