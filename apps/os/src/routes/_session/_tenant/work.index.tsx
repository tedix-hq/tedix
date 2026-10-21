import { createFileRoute } from "@tanstack/react-router";
import { prefetchWorkDeck } from "@/lib/prefetch-work-deck";
import { WorkHome } from "@/components/work-home";
import { workHomeSearch } from "@/lib/work-home-search";

export const Route = createFileRoute("/_session/_tenant/work/")({
	validateSearch: workHomeSearch,
	loader: ({ context }) => {
		prefetchWorkDeck(context.queryClient);
	},
	component: WorkLanding,
});

function WorkLanding() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<WorkHome
			search={search}
			onFilterChange={(filter) =>
				void navigate({
					search: (previous) => ({ ...previous, view: "feed", filter }),
				})
			}
		/>
	);
}
