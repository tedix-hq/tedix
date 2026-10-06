import { createFileRoute } from "@tanstack/react-router";
import { SkillDetailLayout } from "@/components/skill-detail-layout";
import { OsRouteError } from "@/components/os-route-boundaries";
import { prefetchSkillDetailRoute } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/skills/$skillId")({
	loader: ({ context, params }) =>
		prefetchSkillDetailRoute(context.queryClient, params.skillId),
	component: SkillDetailLayout,
	pendingComponent: DetailPending,
	errorComponent: OsRouteError,
});
