import { createFileRoute } from "@tanstack/react-router";
import { AppAnalyticsPage } from "@/components/app-analytics-page";
import { prefetchAppAnalyticsRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute(
	"/_session/_tenant/apps_/$appId/analytics",
)({
	loader: ({ context, params }) =>
		prefetchAppAnalyticsRoute(context.queryClient, params.appId),
	component: AppAnalyticsPage,
});
