import { createFileRoute } from "@tanstack/react-router";
import { SkillSchedulePage } from "@/components/skill-schedule-page";
import { prefetchSkillScheduleRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/skills/$skillId/schedule",
)({
	loader: ({ context, params }) =>
		prefetchSkillScheduleRoute(context.queryClient, params.skillId),
	component: SkillSchedulePage,
	pendingComponent: ListPending,
});
