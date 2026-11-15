import { createFileRoute } from "@tanstack/react-router";
import { WorkProjectGoalsPage } from "@/components/work-project-goals-page";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/work/projects/$projectId",
)({
	component: WorkProjectRoute,
	pendingComponent: ListPending,
});
function WorkProjectRoute() {
	return <WorkProjectGoalsPage projectId={Route.useParams().projectId} />;
}
