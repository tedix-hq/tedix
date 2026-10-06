import { createFileRoute } from "@tanstack/react-router";
import { TediOverview } from "@/components/tedi-detail";

export const Route = createFileRoute("/_session/_tenant/team_/$tediId/")({
	component: OverviewRoute,
});

function OverviewRoute() {
	const { tediId } = Route.useParams();
	return <TediOverview tediId={tediId} />;
}
