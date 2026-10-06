import { createFileRoute } from "@tanstack/react-router";
import { WorkProjectPage } from "@/components/work-factory-pages";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/work/projects/$projectId",
)({
	component: WorkProjectRoute,
	pendingComponent: ListPending,
});
function WorkProjectRoute() {
	return <WorkProjectPage projectId={Route.useParams().projectId} />;
}
