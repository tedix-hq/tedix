import { createFileRoute } from "@tanstack/react-router";
import { SkillOverviewPage } from "@/components/skill-overview-page";
import { prefetchSkillOverviewRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/skills/$skillId/")({
	loader: ({ context, params }) =>
		prefetchSkillOverviewRoute(context.queryClient, params.skillId),
	component: SkillOverviewPage,
	pendingComponent: ListPending,
});
