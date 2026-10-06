import { createFileRoute } from "@tanstack/react-router";
import { AppDetailLayout } from "@/components/app-detail-layout";
import { prefetchAppDetailRoute } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/apps_/$appId")({
	loader: ({ context, params }) =>
		prefetchAppDetailRoute(context.queryClient, params.appId),
	component: AppDetailLayout,
	pendingComponent: DetailPending,
});
