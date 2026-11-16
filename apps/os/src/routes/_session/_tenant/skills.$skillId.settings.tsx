import { createFileRoute } from "@tanstack/react-router";
import { SkillSettingsPage } from "@/components/skill-settings-page";
import { prefetchSkillSettingsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/skills/$skillId/settings",
)({
	loader: ({ context, params }) =>
		prefetchSkillSettingsRoute(context.queryClient, params.skillId),
	component: SkillSettingsPage,
	pendingComponent: ListPending,
});
