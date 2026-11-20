import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceInspectionPage } from "@/components/workspace-inspection";
import { requireUuidRouteParam } from "@/lib/os-route-loaders";

export const Route = createFileRoute(
	"/_session/_tenant/admin/workspaces_/$workspaceId",
)({
	component: WorkspaceInspectionRoute,
});

function WorkspaceInspectionRoute() {
	const { workspaceId } = Route.useParams();
	return (
		<WorkspaceInspectionPage workspaceId={requireUuidRouteParam(workspaceId)} />
	);
}
