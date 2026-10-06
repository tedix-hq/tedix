import { createFileRoute } from "@tanstack/react-router";
import { AppOverviewPage } from "@/components/app-detail";
import { prefetchAppOverviewRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute("/_session/_tenant/apps_/$appId/")({
	loader: ({ context, params }) =>
		prefetchAppOverviewRoute(context.queryClient, params.appId),
	component: AppOverviewPage,
});
