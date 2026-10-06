import { createFileRoute } from "@tanstack/react-router";
import { AppSettingsPage } from "@/components/app-settings-page";
import { prefetchAppSettingsRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute("/_session/_tenant/apps_/$appId/settings")(
	{
		loader: ({ context, params }) =>
			prefetchAppSettingsRoute(context.queryClient, params.appId),
		component: AppSettingsPage,
	},
);
