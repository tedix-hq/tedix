import { createFileRoute } from "@tanstack/react-router";
import { TeamPage } from "@/components/team-page";
import { prefetchTeamRoute } from "@/lib/os-route-loaders";
import { validateTeamSearch } from "@/lib/team-tabs";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/team")({
	validateSearch: validateTeamSearch,
	loaderDeps: ({ search }) => ({ tab: search.tab, page: search.page }),
	loader: ({ context, deps }) => prefetchTeamRoute(context.queryClient, deps),
	component: TeamRoute,
	pendingComponent: ListPending,
});

function TeamRoute() {
	const { tab, page } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<TeamPage
			tab={tab}
			page={page}
			onTabChange={(nextTab) =>
				void navigate({ search: { tab: nextTab, page: 1 } })
			}
			onPageChange={(nextPage) =>
				void navigate({
					search: (previous) => ({ ...previous, page: nextPage }),
				})
			}
		/>
	);
}
