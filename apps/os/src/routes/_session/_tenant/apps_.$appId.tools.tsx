import { createFileRoute } from "@tanstack/react-router";
import { AppToolsPage } from "@/components/app-tools-page";
import { prefetchAppToolsRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute("/_session/_tenant/apps_/$appId/tools")({
	loader: ({ context, params }) =>
		prefetchAppToolsRoute(context.queryClient, params.appId),
	component: AppToolsPage,
});
