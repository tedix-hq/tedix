import { createFileRoute } from "@tanstack/react-router";
import { WorkItemPage } from "@/components/work-factory-pages";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/work/items/$workItemId",
)({
	component: WorkItemRoute,
	pendingComponent: ListPending,
});
function WorkItemRoute() {
	return <WorkItemPage itemId={Route.useParams().workItemId} />;
}
