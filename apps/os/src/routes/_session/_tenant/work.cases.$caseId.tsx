import { createFileRoute } from "@tanstack/react-router";
import { WorkCasePage } from "@/components/work-operations-pages";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/cases/$caseId")({
	component: WorkCaseRoute,
	pendingComponent: ListPending,
});

function WorkCaseRoute() {
	return <WorkCasePage caseId={Route.useParams().caseId} />;
}
