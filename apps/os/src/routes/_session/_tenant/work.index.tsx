import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { prefetchWorkDeck } from "@/lib/prefetch-work-deck";
import { WorkHome } from "@/components/work-home";
import { workHomeSearch } from "@/lib/work-home-search";

const WorkItemsView = lazy(() =>
	import("@/components/work-items-view").then((module) => ({
		default: module.WorkItemsView,
	})),
);

const WorkTriageView = lazy(() =>
	import("@/components/work-triage-view").then((module) => ({
		default: module.WorkTriageView,
	})),
);

export const Route = createFileRoute("/_session/_tenant/work/")({
	validateSearch: workHomeSearch,
	loaderDeps: ({ search }) => ({ view: search.view }),
	loader: ({ context, deps }) => {
		if (deps.view !== "items" && deps.view !== "triage")
			prefetchWorkDeck(context.queryClient, deps.view);
	},
	component: WorkLanding,
});

function WorkLanding() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	if (search.view === "items")
		return (
			<Suspense fallback={null}>
				<WorkItemsView
					filters={search}
					onFiltersChange={(filters) =>
						void navigate({
							search: { view: "items", ...filters },
							replace: true,
						})
					}
				/>
			</Suspense>
		);
	if (search.view === "triage")
		return (
			<Suspense fallback={null}>
				<WorkTriageView
					project={search.project}
					onProjectChange={(project) =>
						void navigate({
							search: { view: "triage", ...(project ? { project } : {}) },
							replace: true,
						})
					}
				/>
			</Suspense>
		);
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
