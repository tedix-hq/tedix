import { createFileRoute } from "@tanstack/react-router";
import { SkillSourcePage } from "@/components/skill-source-page";
import { prefetchSkillSourceRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/skills/$skillId/source",
)({
	loader: ({ context, params }) =>
		prefetchSkillSourceRoute(context.queryClient, params.skillId),
	component: SkillSourcePage,
	pendingComponent: ListPending,
});
