import { createFileRoute } from "@tanstack/react-router";
import { TediSettingsPage } from "@/components/tedi-settings-page";
import { prefetchTediSettingsRoute } from "@/lib/os-route-loaders";
import { NestedDetailPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/team_/$tediId/settings",
)({
	loader: ({ context, params }) =>
		prefetchTediSettingsRoute(context.queryClient, params.tediId),
	component: SettingsRoute,
	pendingComponent: NestedDetailPending,
});

function SettingsRoute() {
	return <TediSettingsPage tediId={Route.useParams().tediId} />;
}
