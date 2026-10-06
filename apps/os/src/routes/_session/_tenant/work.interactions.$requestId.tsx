import { createFileRoute } from "@tanstack/react-router";
import { WorkInteractionPage } from "@/components/work-operations-pages";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/work/interactions/$requestId",
)({
	component: WorkInteractionRoute,
	pendingComponent: ListPending,
});

function WorkInteractionRoute() {
	return <WorkInteractionPage requestId={Route.useParams().requestId} />;
}
