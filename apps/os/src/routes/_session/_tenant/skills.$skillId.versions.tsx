import { createFileRoute } from "@tanstack/react-router";
import { SkillVersionsPage } from "@/components/skill-versions-page";
import { prefetchSkillVersionsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/skills/$skillId/versions",
)({
	loader: ({ context, params }) =>
		prefetchSkillVersionsRoute(context.queryClient, params.skillId),
	component: SkillVersionsPage,
	pendingComponent: ListPending,
});
