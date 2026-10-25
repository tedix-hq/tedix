import { createFileRoute } from "@tanstack/react-router";
import { SharedWorkspacePage } from "@/components/shared-workspace-page";
import { requireUuidRouteParam } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_chrome-free/shared_/workspace/$workspaceId",
)({
	component: SharedWorkspaceRoute,
	pendingComponent: DetailPending,
});

function SharedWorkspaceRoute() {
	const { workspaceId } = Route.useParams();
	return (
		<SharedWorkspacePage workspaceId={requireUuidRouteParam(workspaceId)} />
	);
}
