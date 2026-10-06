import { createFileRoute } from "@tanstack/react-router";
import { SkillsPage } from "@/components/skills-page";
import { prefetchSkillsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";
import { validateSkillsSearch } from "@/lib/skills-search";

export const Route = createFileRoute("/_session/_tenant/skills/")({
	validateSearch: validateSkillsSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => prefetchSkillsRoute(context.queryClient, deps),
	component: SkillsRoute,
	pendingComponent: ListPending,
});

function SkillsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<SkillsPage
			search={search}
			onSearchChange={(patch) =>
				void navigate({
					search: (current) => ({ ...current, ...patch }),
					replace: true,
				})
			}
		/>
	);
}
