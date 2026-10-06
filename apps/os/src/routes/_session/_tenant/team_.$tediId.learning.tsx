import { createFileRoute } from "@tanstack/react-router";
import { LearningEvidence } from "@/components/learning-evidence";
import { prefetchTediLearningRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute(
	"/_session/_tenant/team_/$tediId/learning",
)({
	loader: ({ context, params }) =>
		prefetchTediLearningRoute(context.queryClient, params.tediId),
	component: LearningRoute,
});

function LearningRoute() {
	return <LearningEvidence tediId={Route.useParams().tediId} />;
}
