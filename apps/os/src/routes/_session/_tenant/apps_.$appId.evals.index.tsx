import { createFileRoute } from "@tanstack/react-router";
import { AppEvalsPage } from "@/components/app-evals-page";
import { prefetchAppEvalsRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute("/_session/_tenant/apps_/$appId/evals/")({
	loader: ({ context, params }) =>
		prefetchAppEvalsRoute(context.queryClient, params.appId),
	component: AppEvalsPage,
});
