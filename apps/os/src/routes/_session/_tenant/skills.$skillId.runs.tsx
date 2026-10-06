import { createFileRoute } from "@tanstack/react-router";
import { SkillRunsPage } from "@/components/skill-runs-page";
import { prefetchSkillRunsRoute } from "@/lib/os-route-loaders";
import { skillRunsSearchSchema } from "@/lib/skill-runs-search";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/skills/$skillId/runs")({
	validateSearch: skillRunsSearchSchema,
	loaderDeps: ({ search }) => search,
	loader: ({ context, params, deps }) =>
		prefetchSkillRunsRoute(context.queryClient, params.skillId, deps.status),
	component: RunsRoute,
	pendingComponent: ListPending,
});

function RunsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<SkillRunsPage
			search={search}
			updateSearch={(patch) =>
				void navigate({ search: (previous) => ({ ...previous, ...patch }) })
			}
		/>
	);
}
