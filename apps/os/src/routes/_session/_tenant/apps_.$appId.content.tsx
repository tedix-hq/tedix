import { createFileRoute } from "@tanstack/react-router";
import { AppContentPage } from "@/components/app-content-page";
import { prefetchAppContentRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute("/_session/_tenant/apps_/$appId/content")({
	loader: ({ context, params }) =>
		prefetchAppContentRoute(context.queryClient, params.appId),
	component: AppContentPage,
});
